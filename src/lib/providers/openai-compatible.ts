/**
 * OpenAICompatibleProvider - the first BYOK provider. One implementation covers
 * any endpoint that speaks the OpenAI `/chat/completions` streaming wire:
 * OpenAI itself, aggregators, hosted inference, and local servers - repoint via
 * `--base-url`.
 *
 * BYOK bypasses the SpyCore backend, so the server features (skills, memory,
 * search, quota) are inherently absent and the user's own model
 * name is shown verbatim.
 * The CLI still sends its OWN agent system prompt (tool protocol + plan
 * instructions) as the first message.
 *
 * The endpoint is stateless, so this provider accumulates the conversation
 * client-side, keyed by the session handle, and replays the full message array
 * on every turn. Keys come only from the caller (an env var) - never logged,
 * never echoed, and redacted out of any error surface (we never put the key in
 * a message).
 */
import { request } from 'undici';
import { parseSSEStream } from '../sse.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';
import {
  BYOK_REQUEST_BODY_TIMEOUT_MS,
  BYOK_REQUEST_HEADERS_TIMEOUT_MS,
  StreamByteBudget,
  connectionErrorMessage,
  errText,
  readErrorDetail,
  streamCapErrorMessage,
} from './wire.js';
import { pruneByokSessions, trimHistoryMessages } from './history.js';
import type {
  CreateConversationParams,
  Provider,
  ProviderEvent,
  ProviderMessage,
  StreamChatParams,
} from './types.js';

interface OpenAIToolCallDelta {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}
interface OpenAIDelta {
  content?: unknown;
  tool_calls?: OpenAIToolCallDelta[];
}
interface OpenAIChoice {
  delta?: OpenAIDelta;
  /** Why the model stopped: 'stop' | 'length' | 'tool_calls' | 'content_filter' | … */
  finish_reason?: unknown;
  /** Some servers put completed calls on the final (non-delta) choice. */
  message?: { tool_calls?: OpenAIToolCallDelta[] };
}
interface OpenAIUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
}
interface OpenAIStreamChunk {
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage | null;
}

export interface OpenAICompatibleOptions {
  /** Base URL (a trailing slash, if any, is trimmed by the constructor). */
  baseURL: string;
  /** Bearer key, or undefined → send NO Authorization header (local servers). */
  apiKey?: string | undefined;
}

export class OpenAICompatibleProvider implements Provider {
  readonly id = 'openai' as const;
  private readonly baseURL: string;
  private readonly apiKey: string | undefined;
  /** Stateless endpoint → keep the conversation client-side per session handle. */
  private readonly sessions = new Map<string, ProviderMessage[]>();
  /** Last use per session, for the idle-session prune (see history.ts). */
  private readonly lastUsed = new Map<string, number>();
  private counter = 0;

  constructor(opts: OpenAICompatibleOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey && opts.apiKey.length > 0 ? opts.apiKey : undefined;
  }

  createConversation(_params: CreateConversationParams): Promise<string> {
    this.counter += 1;
    const id = `byok-${this.counter}`;
    this.sessions.set(id, []);
    this.lastUsed.set(id, Date.now());
    pruneByokSessions(this.sessions, this.lastUsed);
    return Promise.resolve(id);
  }

  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    // Append this turn's input to the (client-side) history, then replay it all.
    // `?? []` is defensive: a continuation always reuses an existing session id,
    // but a missing entry degrades to an empty history rather than crashing.
    // A separately-passed system prompt is folded back into this first user
    // message - the exact concatenation the loop used to send - so this wire is
    // byte-identical to before the seam carried `system` (the native Anthropic /
    // Google adapters are the ones that place it top-level).
    const history = this.sessions.get(params.conversationId) ?? [];
    const content =
      params.system && params.system.length > 0
        ? `${params.system}\n\n${params.message}`
        : params.message;
    history.push({ role: 'user', content });
    // Bound the replay: the full array is resent every turn, so an unbounded
    // history is quadratic cost and an eventual context overflow. Oldest
    // pair first - the alternation survives, and the system prompt is
    // re-folded into each turn above, so trimming never drops it.
    trimHistoryMessages(history);
    this.lastUsed.set(params.conversationId, Date.now());
    this.sessions.set(params.conversationId, history);

    const url = `${this.baseURL}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    // Auth header ONLY when a key is present - omit entirely for local servers.
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    // `stream_options` rides the first attempt only: several
    // OpenAI-compatible servers (Ollama, llama.cpp, LM Studio, old vLLM)
    // reject the unknown field with 400. A 400 on the first attempt is
    // retried once without it - usage accounting then degrades gracefully
    // (the loop already tolerates a missing usage event).
    let res: Awaited<ReturnType<typeof request>> | undefined;
    let usedStreamOptions = true;
    for (let attempt = 0; attempt < 2 && !res; attempt += 1) {
      const body = JSON.stringify({
        model: params.model,
        messages: history,
        stream: true,
        ...(usedStreamOptions ? { stream_options: { include_usage: true } } : {}),
      });
      let attemptRes: Awaited<ReturnType<typeof request>>;
      try {
        attemptRes = await request(url, {
          method: 'POST',
          headers,
          body,
          signal: params.signal,
          headersTimeout: BYOK_REQUEST_HEADERS_TIMEOUT_MS,
          bodyTimeout: BYOK_REQUEST_BODY_TIMEOUT_MS,
        });
      } catch (err) {
        if (params.signal?.aborted) {
          history.pop();
          throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
        }
        history.pop();
        yield { type: 'error', message: connectionErrorMessage(err, url) };
        return;
      }
      if (attemptRes.statusCode === 400 && usedStreamOptions) {
        await readErrorDetail(attemptRes.body); // drain, so the connection can be reused
        usedStreamOptions = false;
        continue;
      }
      res = attemptRes;
    }
    if (!res) {
      history.pop();
      yield { type: 'error', message: 'Model endpoint did not answer the request.' };
      return;
    }

    if (res.statusCode >= 400) {
      const detail = await readErrorDetail(res.body);
      // No assistant reply was produced: roll the user message back
      // rather than leave a dangling user turn in the history. OpenAI
      // tolerates consecutive user messages, so this is consistency with
      // the Anthropic/Google adapters, not a wire requirement.
      history.pop();
      yield {
        type: 'error',
        message: httpErrorMessage(res.statusCode, params.model, this.baseURL, detail),
      };
      return;
    }

    // Anything other than a 200 SSE stream is not a turn: a 3xx (undici
    // does not follow redirects) or a non-SSE 2xx body (an HTML error
    // page from a proxy, a plain JSON blob) used to parse as zero events
    // and end the turn "done" with empty output - indistinguishable from
    // a genuinely empty reply. Fail loudly instead.
    if (res.statusCode !== 200) {
      history.pop();
      yield {
        type: 'error',
        message: `Model endpoint returned HTTP ${res.statusCode} (expected a 200 SSE stream). Check --base-url (${this.baseURL}) - a redirect or a proxy error page is not a chat stream.`,
      };
      return;
    }
    const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
    if (contentType.length > 0 && !contentType.includes('text/event-stream')) {
      history.pop();
      yield {
        type: 'error',
        message: `Model endpoint returned HTTP 200 with content-type "${contentType}" (expected text/event-stream). Check --base-url (${this.baseURL}) - the endpoint did not return a chat stream.`,
      };
      return;
    }

    let assistantText = '';
    let sawUsage = false;
    let usageInput = 0;
    let usageOutput = 0;
    // One byte budget for the whole turn's streamed reply (assistant text
    // + assembled tool-call arguments, R2-2): the error body was capped
    // at 1 MB while the success body was unbounded, so a misbehaving
    // endpoint could grow memory without bound inside the 300 s timeout.
    const budget = new StreamByteBudget();
    // Why the model stopped - surfaced as a warning when the reply was
    // cut off, instead of ending the turn `done` with no explanation.
    let finishReason: string | undefined;
    // Streamed tool calls arrive as per-index fragments (id + name on
    // the first, arguments in pieces); assembled here and yielded once
    // the stream ends so native dispatch can run them. Returns false
    // when a fragment would take the turn past the stream cap.
    const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();
    const absorbToolCallDeltas = (deltas: OpenAIToolCallDelta[] | undefined): boolean => {
      if (!deltas) return true;
      for (const d of deltas) {
        const index = typeof d.index === 'number' ? d.index : 0;
        const cur = toolCallParts.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof d.id === 'string' && d.id.length > 0) cur.id = d.id;
        if (typeof d.function?.name === 'string' && d.function.name.length > 0) cur.name = d.function.name;
        if (typeof d.function?.arguments === 'string') {
          if (!budget.tryAdd(d.function.arguments)) return false;
          cur.arguments += d.function.arguments;
        }
        toolCallParts.set(index, cur);
      }
      return true;
    };
    /**
     * A turn that ends in error must still leave the history alternating:
     * keep the partial assistant reply when one exists, otherwise take
     * the user message back.
     */
    const settleErroredTurn = (): void => {
      if (assistantText.length > 0) {
        history.push({ role: 'assistant', content: assistantText });
      } else {
        history.pop();
      }
    };
    try {
      for await (const event of parseSSEStream(res.body as AsyncIterable<Buffer>)) {
        if (params.signal?.aborted) {
          settleErroredTurn();
          throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
        }
        const data = event.data;
        // OpenAI terminates the stream with a literal `data: [DONE]` (a raw
        // string, so parseSSEStream surfaces it verbatim rather than as JSON).
        if (data === '[DONE]') break;
        if (typeof data !== 'object' || data === null) continue;
        const chunk = data as OpenAIStreamChunk;
        const choice = chunk.choices?.[0];
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
        if (!absorbToolCallDeltas(choice?.delta?.tool_calls)) {
          settleErroredTurn();
          yield { type: 'error', message: streamCapErrorMessage() };
          return;
        }
        if (!absorbToolCallDeltas(choice?.message?.tool_calls)) {
          settleErroredTurn();
          yield { type: 'error', message: streamCapErrorMessage() };
          return;
        }
        const delta = choice?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          if (!budget.tryAdd(delta)) {
            settleErroredTurn();
            yield { type: 'error', message: streamCapErrorMessage() };
            return;
          }
          assistantText += delta;
          yield { type: 'text', text: delta };
          if (params.shouldStop?.()) {
            history.push({ role: 'assistant', content: assistantText });
            return;
          }
        }
        // With `include_usage`, the final chunk carries token totals.
        if (chunk.usage) {
          usageInput = Number(chunk.usage.prompt_tokens ?? 0) || 0;
          usageOutput = Number(chunk.usage.completion_tokens ?? 0) || 0;
          sawUsage = true;
        }
        // R2-11: poll the (time) budget after EVERY event, not just text
        // chunks - a turn streaming only tool calls used to never check
        // shouldStop and ran past its budget (mirrors spycore.ts). On
        // trip, settle the turn the same way the text branch does and
        // return without `done`. (No R2-10 change here: `content: ''` is
        // valid on this wire, and recording the calls would need tool
        // result messages the loop never sends - see the fix log.)
        if (params.shouldStop?.()) {
          settleErroredTurn();
          return;
        }
      }
    } catch (err) {
      if (params.signal?.aborted) {
        settleErroredTurn();
        throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
      }
      settleErroredTurn();
      yield { type: 'error', message: `Model stream interrupted: ${errText(err)}` };
      return;
    }

    history.push({ role: 'assistant', content: assistantText });
    // Emit usage BEFORE done so the loop records it for the token budget. When
    // the endpoint omits usage, the loop degrades gracefully (time/turn budgets
    // still apply; token accounting is simply skipped).
    if (sawUsage) yield { type: 'usage', input: usageInput, output: usageOutput };
    // Streamed tool calls, assembled from their fragments. Only complete
    // calls (id + name) are yielded; a fragment without both is dropped
    // rather than dispatched half-formed.
    const toolCalls = [...toolCallParts.values()].filter((c) => c.id.length > 0 && c.name.length > 0);
    if (toolCalls.length > 0) {
      yield {
        type: 'tool_calls',
        calls: toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
      };
    }
    if (finishReason === 'length') {
      yield {
        type: 'warning',
        message: 'Response truncated (max tokens hit) - the reply may be incomplete.',
      };
    } else if (finishReason !== undefined && finishReason !== 'stop' && finishReason !== 'tool_calls') {
      yield { type: 'warning', message: `Model stopped early (finish_reason: ${finishReason}).` };
    }
    yield { type: 'done' };
  }
}

function httpErrorMessage(
  status: number,
  model: string,
  baseURL: string,
  detail: string | undefined,
): string {
  const suffix = detail ? ` - ${detail}` : '';
  if (status === 401) {
    return `Model endpoint rejected the credentials (401)${suffix}. Check the key in your --api-key-env variable.`;
  }
  if (status === 404) {
    return `Model endpoint returned 404${suffix}. Check --base-url (${baseURL}) and --model (${model}).`;
  }
  if (status === 429) {
    return `Model provider rate-limited the request (429)${suffix}. Wait and retry.`;
  }
  return `Model endpoint returned HTTP ${status}${suffix}.`;
}

