/**
 * AnthropicProvider — native BYOK adapter for the Anthropic Messages API
 * (`POST {baseURL}/v1/messages`, default https://api.anthropic.com). Not
 * OpenAI-compatible: auth is `x-api-key` (+ `anthropic-version`), the system
 * prompt is a TOP-LEVEL `system` field (not a message), `max_tokens` is
 * required, and the SSE framing is typed events (message_start /
 * content_block_delta / message_delta / message_stop / error).
 *
 * Same contract as the other BYOK adapters: lazy-loaded, stateless endpoint →
 * client-side history per session (system remembered from turn 1 and resent
 * top-level on every request), key never logged/echoed (error detail comes
 * only from response bodies), no identity scrub (the user's own model).
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

/** Current stable Messages API version header. */
const ANTHROPIC_VERSION = '2023-06-01';
/** Sane default — the Messages API requires max_tokens on every request. */
const DEFAULT_MAX_TOKENS = 8192;

/** Typed views of the SSE payloads we consume (each `data:` mirrors its event name in `type`). */
interface AnthropicUsage {
  input_tokens?: unknown;
  output_tokens?: unknown;
}
interface AnthropicStreamData {
  type?: unknown;
  /** message_start */
  message?: { usage?: AnthropicUsage };
  /** content_block_delta */
  delta?: { type?: unknown; text?: unknown };
  /** message_delta */
  usage?: AnthropicUsage;
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
  /** Required — this endpoint has no keyless mode (resolution errors before here). */
  apiKey: string;
}

export class AnthropicProvider implements Provider {
  readonly id = 'anthropic' as const;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly sessions = new Map<string, Session>();
  private counter = 0;

  constructor(opts: AnthropicProviderOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
  }

  createConversation(_params: CreateConversationParams): Promise<string> {
    this.counter += 1;
    const id = `byok-anthropic-${this.counter}`;
    this.sessions.set(id, { system: undefined, messages: [] });
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

    const url = `${this.baseURL}/v1/messages`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
    const body = JSON.stringify({
      model: params.model,
      max_tokens: DEFAULT_MAX_TOKENS,
      ...(session.system ? { system: session.system } : {}),
      messages: session.messages,
      stream: true,
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
        if (typeof data !== 'object' || data === null) continue;
        const chunk = data as AnthropicStreamData;
        switch (chunk.type) {
          case 'content_block_delta': {
            // Only text deltas become output (thinking/tool-input deltas are skipped).
            if (chunk.delta?.type === 'text_delta' && typeof chunk.delta.text === 'string') {
              assistantText += chunk.delta.text;
              yield { type: 'text', text: chunk.delta.text };
              if (params.shouldStop?.()) {
                session.messages.push({ role: 'assistant', content: assistantText });
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
            // Carries the cumulative output_tokens — the final value wins.
            const u = chunk.usage;
            if (u) {
              usageOutput = Number(u.output_tokens ?? 0) || usageOutput;
              sawUsage = true;
            }
            break;
          }
          case 'error': {
            const msg = typeof chunk.error?.message === 'string' ? chunk.error.message : 'model stream error';
            yield { type: 'error', message: `Model endpoint reported an error: ${msg}` };
            return;
          }
          case 'message_stop': {
            session.messages.push({ role: 'assistant', content: assistantText });
            if (sawUsage) yield { type: 'usage', input: usageInput, output: usageOutput };
            yield { type: 'done' };
            return;
          }
          default:
            break; // ping, content_block_start/stop, …
        }
      }
    } catch (err) {
      if (params.signal?.aborted) throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
      yield { type: 'error', message: `Model stream interrupted: ${errText(err)}` };
      return;
    }

    // Stream ended without message_stop (unusual) — still finish gracefully.
    session.messages.push({ role: 'assistant', content: assistantText });
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
