/**
 * OpenAICompatibleProvider — the first BYOK provider. One implementation covers
 * any endpoint that speaks the OpenAI `/chat/completions` streaming wire:
 * OpenAI itself, aggregators, hosted inference, and local servers — repoint via
 * `--base-url`.
 *
 * BYOK bypasses the SpyCore backend, so the server features (skills, memory,
 * search, quota, identity scrub) are inherently absent and the user's own model
 * name is shown verbatim (NO identity scrub — that is SpyCore-provider-only).
 * The CLI still sends its OWN agent system prompt (tool protocol + plan
 * instructions) as the first message.
 *
 * The endpoint is stateless, so this provider accumulates the conversation
 * client-side, keyed by the session handle, and replays the full message array
 * on every turn. Keys come only from the caller (an env var) — never logged,
 * never echoed, and redacted out of any error surface (we never put the key in
 * a message).
 */
import { request } from 'undici';
import { parseSSEStream } from '../sse.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';
import { connectionErrorMessage, errText, readErrorDetail } from './wire.js';
import type {
  CreateConversationParams,
  Provider,
  ProviderEvent,
  ProviderMessage,
  StreamChatParams,
} from './types.js';

interface OpenAIDelta {
  content?: unknown;
}
interface OpenAIChoice {
  delta?: OpenAIDelta;
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
  private counter = 0;

  constructor(opts: OpenAICompatibleOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey && opts.apiKey.length > 0 ? opts.apiKey : undefined;
  }

  createConversation(_params: CreateConversationParams): Promise<string> {
    this.counter += 1;
    const id = `byok-${this.counter}`;
    this.sessions.set(id, []);
    return Promise.resolve(id);
  }

  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    // Append this turn's input to the (client-side) history, then replay it all.
    // `?? []` is defensive: a continuation always reuses an existing session id,
    // but a missing entry degrades to an empty history rather than crashing.
    // A separately-passed system prompt is folded back into this first user
    // message — the exact concatenation the loop used to send — so this wire is
    // byte-identical to before the seam carried `system` (the native Anthropic /
    // Google adapters are the ones that place it top-level).
    const history = this.sessions.get(params.conversationId) ?? [];
    const content =
      params.system && params.system.length > 0
        ? `${params.system}\n\n${params.message}`
        : params.message;
    history.push({ role: 'user', content });
    this.sessions.set(params.conversationId, history);

    const url = `${this.baseURL}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    // Auth header ONLY when a key is present — omit entirely for local servers.
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const body = JSON.stringify({
      model: params.model,
      messages: history,
      stream: true,
      stream_options: { include_usage: true },
    });

    let res;
    try {
      res = await request(url, { method: 'POST', headers, body, signal: params.signal });
    } catch (err) {
      if (params.signal?.aborted) throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
      yield { type: 'error', message: connectionErrorMessage(err, url) };
      return;
    }

    if (res.statusCode >= 400) {
      const detail = await readErrorDetail(res.body);
      yield {
        type: 'error',
        message: httpErrorMessage(res.statusCode, params.model, this.baseURL, detail),
      };
      return;
    }

    let assistantText = '';
    let sawUsage = false;
    let usageInput = 0;
    let usageOutput = 0;
    try {
      for await (const event of parseSSEStream(res.body as AsyncIterable<Buffer>)) {
        if (params.signal?.aborted) throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
        const data = event.data;
        // OpenAI terminates the stream with a literal `data: [DONE]` (a raw
        // string, so parseSSEStream surfaces it verbatim rather than as JSON).
        if (data === '[DONE]') break;
        if (typeof data !== 'object' || data === null) continue;
        const chunk = data as OpenAIStreamChunk;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
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
      }
    } catch (err) {
      if (params.signal?.aborted) throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
      yield { type: 'error', message: `Model stream interrupted: ${errText(err)}` };
      return;
    }

    history.push({ role: 'assistant', content: assistantText });
    // Emit usage BEFORE done so the loop records it for the token budget. When
    // the endpoint omits usage, the loop degrades gracefully (time/turn budgets
    // still apply; token accounting is simply skipped).
    if (sawUsage) yield { type: 'usage', input: usageInput, output: usageOutput };
    yield { type: 'done' };
  }
}

function httpErrorMessage(
  status: number,
  model: string,
  baseURL: string,
  detail: string | undefined,
): string {
  const suffix = detail ? ` — ${detail}` : '';
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

