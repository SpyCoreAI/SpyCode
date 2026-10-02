/**
 * GoogleProvider — native BYOK adapter for the Google AI Generative Language
 * API (`POST {baseURL}/v1beta/models/{model}:streamGenerateContent?alt=sse`,
 * default https://generativelanguage.googleapis.com). Not OpenAI-compatible:
 * auth is `x-goog-api-key`, the system prompt is a top-level
 * `systemInstruction`, history is `contents` with roles 'user' | 'model'
 * (assistant → 'model'), and `alt=sse` streams data-only SSE lines each
 * holding a full GenerateContentResponse JSON object (no [DONE] marker — the
 * stream just ends).
 *
 * Same contract as the other BYOK adapters: lazy-loaded, stateless endpoint →
 * client-side history per session (system remembered from turn 1), key never
 * logged/echoed (error detail comes only from response bodies), no identity
 * scrub (the user's own model).
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

/** Typed views of the alt=sse payloads we consume. */
interface GooglePart {
  text?: unknown;
}
interface GoogleCandidate {
  content?: { parts?: GooglePart[] };
}
interface GoogleUsageMetadata {
  promptTokenCount?: unknown;
  candidatesTokenCount?: unknown;
}
interface GoogleStreamData {
  candidates?: GoogleCandidate[];
  usageMetadata?: GoogleUsageMetadata;
  error?: { message?: unknown };
}

interface Session {
  system: string | undefined;
  messages: ProviderMessage[];
}

export interface GoogleProviderOptions {
  /** API root (the adapter appends /v1beta/models/…). Trailing slashes are trimmed. */
  baseURL: string;
  /** Required — this endpoint has no keyless mode (resolution errors before here). */
  apiKey: string;
}

export class GoogleProvider implements Provider {
  readonly id = 'google' as const;
  private readonly baseURL: string;
  private readonly apiKey: string;
  private readonly sessions = new Map<string, Session>();
  private counter = 0;

  constructor(opts: GoogleProviderOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
  }

  createConversation(_params: CreateConversationParams): Promise<string> {
    this.counter += 1;
    const id = `byok-google-${this.counter}`;
    this.sessions.set(id, { system: undefined, messages: [] });
    return Promise.resolve(id);
  }

  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    const session = this.sessions.get(params.conversationId) ?? {
      system: undefined,
      messages: [],
    };
    this.sessions.set(params.conversationId, session);
    if (params.system && params.system.length > 0) session.system = params.system;
    session.messages.push({ role: 'user', content: params.message });

    const url = `${this.baseURL}/v1beta/models/${encodeURIComponent(params.model)}:streamGenerateContent?alt=sse`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-goog-api-key': this.apiKey,
    };
    const body = JSON.stringify({
      ...(session.system ? { systemInstruction: { parts: [{ text: session.system }] } } : {}),
      // History maps directly, except the role name: assistant → 'model'.
      contents: session.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
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
        const chunk = data as GoogleStreamData;
        // A mid-stream error object ends the turn.
        if (chunk.error) {
          const msg = typeof chunk.error.message === 'string' ? chunk.error.message : 'model stream error';
          yield { type: 'error', message: `Model endpoint reported an error: ${msg}` };
          return;
        }
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          if (typeof part.text === 'string' && part.text.length > 0) {
            assistantText += part.text;
            yield { type: 'text', text: part.text };
            if (params.shouldStop?.()) {
              session.messages.push({ role: 'assistant', content: assistantText });
              return;
            }
          }
        }
        // usageMetadata grows as the stream progresses — the final chunk wins.
        const u = chunk.usageMetadata;
        if (u) {
          usageInput = Number(u.promptTokenCount ?? 0) || usageInput;
          usageOutput = Number(u.candidatesTokenCount ?? 0) || usageOutput;
          sawUsage = true;
        }
      }
    } catch (err) {
      if (params.signal?.aborted) throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
      yield { type: 'error', message: `Model stream interrupted: ${errText(err)}` };
      return;
    }

    // alt=sse has no terminator event — a clean stream end IS completion.
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
  if (status === 400 || status === 401 || status === 403) {
    // This API reports an invalid key as 400 INVALID_ARGUMENT or 403; the
    // detail (from the response body) says which. Point at the key first.
    return `Model endpoint rejected the request (${status})${suffix}. Check the key in your API-key env var (--api-key-env, default GEMINI_API_KEY).`;
  }
  if (status === 404) {
    return `Model endpoint returned 404${suffix}. Check --model (${model}) and --base-url (${baseURL}).`;
  }
  if (status === 429) {
    return `Model provider rate-limited the request (429)${suffix}. Wait and retry.`;
  }
  return `Model endpoint returned HTTP ${status}${suffix}.`;
}
