/**
 * AnthropicProvider - native BYOK adapter for the Anthropic Messages API
 * (`POST {baseURL}/v1/messages`, default https://api.anthropic.com). Not
 * OpenAI-compatible: auth is `x-api-key` (+ `anthropic-version`), the system
 * prompt is a TOP-LEVEL `system` field (not a message), `max_tokens` is
 * required, and the SSE framing is typed events (message_start /
 * content_block_delta / message_delta / message_stop / error).
 *
 * Same contract as the other BYOK adapters: lazy-loaded, stateless endpoint →
 * client-side history per session (system remembered from turn 1 and resent
 * top-level on every request), key never logged/echoed (error detail comes
 * only from response bodies), and the user's own model name is shown verbatim.
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
import { pruneByokSessions, recordAssistantMessage, trimHistoryMessages } from './history.js';
import type {
  CreateConversationParams,
  Provider,
  ProviderEvent,
  ProviderMessage,
  StreamChatParams,
} from './types.js';

/** Current stable Messages API version header. */
const ANTHROPIC_VERSION = '2023-06-01';
/** Sane default - the Messages API requires max_tokens on every request. */
const DEFAULT_MAX_TOKENS = 8192;
/**
 * Output cap of the original Claude 3 family (Haiku/Sonnet/Opus): sending
 * the 8192 default to one of these 400s every request, because the cap is
 * a hard model limit, not a request preference.
 */
const CLAUDE_3_MAX_TOKENS = 4096;

/**
 * Resolve the max_tokens for a request: the model's known output cap
 * (Claude 3 family: 4096), else the 8192 default. The old code sent 8192
 * unconditionally, so low-cap models failed every request and newer
 * large-budget models could never use a bigger budget.
 *
 * There is deliberately no override parameter: the provider option that
 * used to feed one was dead in production (the factory never passed it,
 * no CLI flag or stored field set it), so it was removed rather than
 * left misleading future work.
 */
export function resolveAnthropicMaxTokens(model: string): number {
  if (/claude-3[-_](haiku|sonnet|opus)|claude-instant/i.test(model)) return CLAUDE_3_MAX_TOKENS;
  return DEFAULT_MAX_TOKENS;
}

/** Typed views of the SSE payloads we consume (each `data:` mirrors its event name in `type`). */
interface AnthropicUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
}
interface AnthropicStreamData {
  type?: unknown;
  /** message_start */
  message?: { usage?: AnthropicUsage };
  /** content_block_start: the block being opened (text | tool_use | …). */
  content_block?: { type?: unknown; id?: unknown; name?: unknown };
  /** content_block_start / content_block_delta: which block this is. */
  index?: unknown;
  /** content_block_delta */
  delta?: { type?: unknown; text?: unknown; partial_json?: unknown };
  /** message_delta */
  usage?: AnthropicUsage;
  /** message_delta: why the model stopped ('end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use'). */
  stop_reason?: unknown;
  /** error */
  error?: { message?: unknown };
}

interface Session {
  system: string | undefined;
  messages: ProviderMessage[];
}

export interface AnthropicProviderOptions {
  /** API root (the adapter appends /v1/messages). Trailing slashes are trimmed. */
  baseURL: string;
  /** Required - this endpoint has no keyless mode (resolution errors before here). */
  apiKey: string;
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly sessions = new Map<string, Session>();
  /** Last use per session, for the idle-session prune (see history.ts). */
  private readonly lastUsed = new Map<string, number>();
  private counter = 0;

  constructor(opts: AnthropicProviderOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
  }

  createConversation(_params: CreateConversationParams): Promise<string> {
    this.counter += 1;
    const id = `byok-anthropic-${this.counter}`;
    this.sessions.set(id, { system: undefined, messages: [] });
    this.lastUsed.set(id, Date.now());
    pruneByokSessions(this.sessions, this.lastUsed);
    return Promise.resolve(id);
  }

  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    const session = this.sessions.get(params.conversationId) ?? {
      system: undefined,
      messages: [],
    };
    this.sessions.set(params.conversationId, session);
    // The system prompt arrives once (turn 1) but this API is stateless, so the
    // session remembers it and every request carries it in the TOP-LEVEL field.
    if (params.system && params.system.length > 0) session.system = params.system;
    session.messages.push({ role: 'user', content: params.message });
    // Bound the replay (see history.ts): oldest pair first, so the
    // alternation this API requires survives. The system prompt lives
    // outside the message array, so trimming never drops it.
    trimHistoryMessages(session.messages);
    this.lastUsed.set(params.conversationId, Date.now());

    const url = `${this.baseURL}/v1/messages`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    const body = JSON.stringify({
      model: params.model,
      max_tokens: resolveAnthropicMaxTokens(params.model),
      ...(session.system ? { system: session.system } : {}),
      messages: session.messages,
      stream: true,
    });

    let res;
    try {
      res = await request(url, {
        method: 'POST',
        headers,
        body,
        signal: params.signal,
        headersTimeout: BYOK_REQUEST_HEADERS_TIMEOUT_MS,
        bodyTimeout: BYOK_REQUEST_BODY_TIMEOUT_MS,
      });
    } catch (err) {
      if (params.signal?.aborted) {
        // The user message was already pushed with no assistant reply to
        // alternate with - take it back so a later turn on this session
        // does not send two user messages in a row (400).
        session.messages.pop();
        throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
      }
      session.messages.pop();
      yield { type: 'error', message: connectionErrorMessage(err, url) };
      return;
    }

    if (res.statusCode >= 400) {
      const detail = await readErrorDetail(res.body);
      // No assistant reply was produced: roll the user message back
      // rather than leave a dangling user turn in the history.
      session.messages.pop();
      yield {
        type: 'error',
        message: httpErrorMessage(res.statusCode, params.model, this.baseURL, detail),
      };
      return;
    }

    // Anything other than a 200 SSE stream is not a turn: a 3xx (undici
    // does not follow redirects) or a non-SSE 2xx body used to parse as
    // zero events and end the turn "done" with empty output. Fail loudly.
    if (res.statusCode !== 200) {
      session.messages.pop();
      yield {
        type: 'error',
        message: `Model endpoint returned HTTP ${res.statusCode} (expected a 200 SSE stream). Check --base-url (${this.baseURL}) - a redirect or a proxy error page is not a chat stream.`,
      };
      return;
    }
    const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
    if (contentType.length > 0 && !contentType.includes('text/event-stream')) {
      session.messages.pop();
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
    // + assembled tool-call arguments, R2-2): same 1 MB bound as the
    // error body, counted incrementally per fragment.
    const budget = new StreamByteBudget();
    // Why the model stopped - 'max_tokens' means the reply was cut off.
    let stopReason: string | undefined;
    // Streamed tool_use blocks arrive as `content_block_start` (id +
    // name) followed by `input_json_delta` fragments; assembled here and
    // yielded as one `tool_calls` event when the turn ends, mirroring the
    // OpenAI adapter - a tool-use-only reply used to end `done` with no
    // text, no warning and no tool_calls (R2-1). Arguments are never
    // echoed to the terminal (chat.ts prints names only).
    const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();
    const toolCalls = (): Array<{ id: string; name: string; arguments: string }> =>
      [...toolCallParts.values()].filter((c) => c.id.length > 0 && c.name.length > 0);
    /**
     * A turn that ends in error must still leave the history alternating:
     * keep the partial assistant reply when one exists, otherwise take
     * the user message back. Without this the next streamChat on the
     * session sends two user messages in a row and the API rejects it.
     */
    const settleErroredTurn = (): void => {
      if (assistantText.length > 0) {
        session.messages.push({ role: 'assistant', content: assistantText });
      } else {
        session.messages.pop();
      }
    };
    try {
      for await (const event of parseSSEStream(res.body as AsyncIterable<Buffer>)) {
        if (params.signal?.aborted) {
          settleErroredTurn();
          throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
        }
        const data = event.data;
        if (typeof data !== 'object' || data === null) continue;
        const chunk = data as AnthropicStreamData;
        switch (chunk.type) {
          case 'content_block_start': {
            // A tool_use block opens with its id + name; the arguments
            // arrive later as input_json_delta fragments.
            if (chunk.content_block?.type === 'tool_use') {
              const index = typeof chunk.index === 'number' ? chunk.index : 0;
              const id = typeof chunk.content_block.id === 'string' ? chunk.content_block.id : '';
              const name = typeof chunk.content_block.name === 'string' ? chunk.content_block.name : '';
              if (id.length > 0 || name.length > 0) {
                toolCallParts.set(index, { id, name, arguments: '' });
              }
              // R2-11: poll here too - a no-argument call may never send a
              // delta, so the block opening is the only trip point on its
              // path. Text blocks do NOT poll here: tripping before the
              // first text chunk would change the text path's pinned
              // behaviour (yield the first chunk, then stop).
              if (params.shouldStop?.()) {
                recordAssistantMessage(session.messages, assistantText, toolCalls());
                return;
              }
            }
            break;
          }
          case 'content_block_delta': {
            if (chunk.delta?.type === 'text_delta' && typeof chunk.delta.text === 'string') {
              if (!budget.tryAdd(chunk.delta.text)) {
                settleErroredTurn();
                yield { type: 'error', message: streamCapErrorMessage() };
                return;
              }
              assistantText += chunk.delta.text;
              yield { type: 'text', text: chunk.delta.text };
              if (params.shouldStop?.()) {
                session.messages.push({ role: 'assistant', content: assistantText });
                return;
              }
            } else if (chunk.delta?.type === 'input_json_delta' && typeof chunk.delta.partial_json === 'string') {
              // Tool-input fragments are skipped as output but still
              // assembled (and still count toward the turn's byte cap).
              const index = typeof chunk.index === 'number' ? chunk.index : 0;
              const cur = toolCallParts.get(index) ?? { id: '', name: '', arguments: '' };
              if (!budget.tryAdd(chunk.delta.partial_json)) {
                settleErroredTurn();
                yield { type: 'error', message: streamCapErrorMessage() };
                return;
              }
              cur.arguments += chunk.delta.partial_json;
              toolCallParts.set(index, cur);
              // R2-11: poll the (time) budget after tool-call fragments, not
              // only after text - a tool-call-only turn used to never check
              // shouldStop and ran past its budget (mirrors spycore.ts).
              // On trip, settle the turn the same way the text branch does
              // and return without `done`.
              if (params.shouldStop?.()) {
                recordAssistantMessage(session.messages, assistantText, toolCalls());
                return;
              }
            }
            break;
          }
          case 'message_start': {
            // Carries input_tokens (+ the initial output count).
            const u = chunk.message?.usage;
            if (u) {
              usageInput = Number(u.input_tokens ?? 0) || 0;
              usageOutput = Number(u.output_tokens ?? 0) || usageOutput;
              sawUsage = true;
            }
            break;
          }
          case 'message_delta': {
            // Carries the cumulative output_tokens - the final value wins.
            const u = chunk.usage;
            if (u) {
              usageOutput = Number(u.output_tokens ?? 0) || usageOutput;
              sawUsage = true;
            }
            if (typeof chunk.stop_reason === 'string') stopReason = chunk.stop_reason;
            // R2-11: poll after this usage/metadata event too (a turn whose
            // only late events are deltas still stops promptly).
            if (params.shouldStop?.()) {
              recordAssistantMessage(session.messages, assistantText, toolCalls());
              return;
            }
            break;
          }
          case 'error': {
            const msg = typeof chunk.error?.message === 'string' ? chunk.error.message : 'model stream error';
            settleErroredTurn();
            yield { type: 'error', message: `Model endpoint reported an error: ${msg}` };
            return;
          }
          case 'message_stop': {
            // R2-10: never record an empty assistant message - the API
            // rejects it on the next turn, and the error path keeps it, so
            // the session can never self-heal. A tool-call-only turn is
            // recorded as its calls; a no-text, no-call turn as a marker.
            const calls = toolCalls();
            recordAssistantMessage(session.messages, assistantText, calls);
            if (sawUsage) yield { type: 'usage', input: usageInput, output: usageOutput };
            if (calls.length > 0) {
              yield { type: 'tool_calls', calls };
            }
            if (stopReason === 'max_tokens') {
              yield {
                type: 'warning',
                message: 'Response truncated (max tokens hit) - the reply may be incomplete.',
              };
            }
            yield { type: 'done' };
            return;
          }
          default:
            break; // ping, content_block_start/stop, …
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

    // Stream ended without message_stop (unusual) - still finish gracefully.
    // R2-10: same guard as message_stop - never record an empty message.
    recordAssistantMessage(session.messages, assistantText, toolCalls());
    if (sawUsage) yield { type: 'usage', input: usageInput, output: usageOutput };
    const calls = toolCalls();
    if (calls.length > 0) {
      yield { type: 'tool_calls', calls };
    }
    if (stopReason === 'max_tokens') {
      yield {
        type: 'warning',
        message: 'Response truncated (max tokens hit) - the reply may be incomplete.',
      };
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
  if (status === 401 || status === 403) {
    return `Model endpoint rejected the credentials (${status})${suffix}. Check the key in your API-key env var (--api-key-env, default ANTHROPIC_API_KEY).`;
  }
  if (status === 404) {
    return `Model endpoint returned 404${suffix}. Check --model (${model}) and --base-url (${baseURL}).`;
  }
  if (status === 429) {
    return `Model provider rate-limited the request (429)${suffix}. Wait and retry.`;
  }
  return `Model endpoint returned HTTP ${status}${suffix}.`;
}
