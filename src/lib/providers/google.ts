/**
 * GoogleProvider - native BYOK adapter for the Google AI Generative Language
 * API (`POST {baseURL}/v1beta/models/{model}:streamGenerateContent?alt=sse`,
 * default https://generativelanguage.googleapis.com). Not OpenAI-compatible:
 * auth is `x-goog-api-key`, the system prompt is a top-level
 * `systemInstruction`, history is `contents` with roles 'user' | 'model'
 * (assistant → 'model'), and `alt=sse` streams data-only SSE lines each
 * holding a full GenerateContentResponse JSON object (no [DONE] marker - the
 * stream just ends).
 *
 * Same contract as the other BYOK adapters: lazy-loaded, stateless endpoint →
 * client-side history per session (system remembered from turn 1), key never
 * logged/echoed (error detail comes only from response bodies), and the user's
 * own model name is shown verbatim.
 */
import { request } from 'undici';
import { parseSSEStream } from '../sse.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';
import {
  BYOK_REQUEST_BODY_TIMEOUT_MS,
  BYOK_REQUEST_HEADERS_TIMEOUT_MS,
  connectionErrorMessage,
  errText,
  readErrorDetail,
} from './wire.js';
import { pruneByokSessions, trimHistoryMessages } from './history.js';
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
  finishReason?: unknown;
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
  /** API key for x-goog-api-key header (mutually exclusive with oauthAccessToken). */
  apiKey?: string;
  /** OAuth access token for Authorization: Bearer header (mutually exclusive with apiKey). */
  oauthAccessToken?: string;
  /**
   * Refresh the OAuth access token on demand: called with no arguments
   * whenever the stored token is missing or a request comes back 401.
   * When absent, the provider behaves as before (fixed token for the
   * process lifetime). The factory wires the stored refresh token here
   * so long agent runs survive the ~1h access-token expiry.
   */
  refreshOAuthToken?: (() => Promise<string>) | undefined;
}

export class GoogleProvider implements Provider {
  readonly id = 'google' as const;
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private oauthAccessToken?: string;
  private readonly refreshOAuthToken?: (() => Promise<string>) | undefined;
  private oauthRefreshInFlight: Promise<string> | null = null;
  private readonly sessions = new Map<string, Session>();
  /** Last use per session, for the idle-session prune (see history.ts). */
  private readonly lastUsed = new Map<string, number>();
  private counter = 0;

  constructor(opts: GoogleProviderOptions) {
    this.baseURL = opts.baseURL.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.oauthAccessToken = opts.oauthAccessToken;
    this.refreshOAuthToken = opts.refreshOAuthToken;
    if (!this.apiKey && !this.oauthAccessToken && !this.refreshOAuthToken) {
      throw new SpycoreCliError(
        'GoogleProvider requires either apiKey or oauthAccessToken',
        EXIT_USER_ERROR,
        'Save a key with `spycore provider add --type google --api-key-env GEMINI_API_KEY`, or use --oauth.',
      );
    }
  }

  /**
   * One refresh at a time: concurrent turns share the in-flight refresh
   * instead of each minting a token. The fresh token replaces the stored
   * one; a failed refresh leaves the old token in place and throws.
   */
  private async refreshAccessToken(): Promise<string> {
    if (!this.refreshOAuthToken) {
      throw new Error('Google OAuth token refresh is not configured for this provider');
    }
    if (!this.oauthRefreshInFlight) {
      this.oauthRefreshInFlight = this.refreshOAuthToken().then((token) => {
        this.oauthAccessToken = token;
        return token;
      });
      try {
        await this.oauthRefreshInFlight;
      } finally {
        this.oauthRefreshInFlight = null;
      }
    } else {
      await this.oauthRefreshInFlight;
    }
    return this.oauthAccessToken as string;
  }

  createConversation(_params: CreateConversationParams): Promise<string> {
    this.counter += 1;
    const id = `byok-google-${this.counter}`;
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
    if (params.system && params.system.length > 0) session.system = params.system;
    session.messages.push({ role: 'user', content: params.message });
    // Bound the replay (see history.ts): oldest pair first, so the
    // alternation this API requires survives. The system prompt lives
    // outside the message array, so trimming never drops it.
    trimHistoryMessages(session.messages);
    this.lastUsed.set(params.conversationId, Date.now());

    // Model ids may carry a path segment (`models/gemini-2.0-flash` is
    // the resource name Google documents). Encode per segment: a blanket
    // encodeURIComponent turns the slash into %2F and the API 404s. A
    // leading `models/` is stripped first - the URL already carries it.
    const modelPath = params.model
      .replace(/^models\//, '')
      .split('/')
      .map((seg) => encodeURIComponent(seg))
      .join('/');
    const url = `${this.baseURL}/v1beta/models/${modelPath}:streamGenerateContent?alt=sse`;
    const buildHeaders = (): Record<string, string> => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      };
      // Use OAuth Bearer token if available, otherwise API key header.
      if (this.oauthAccessToken) {
        headers['authorization'] = `Bearer ${this.oauthAccessToken}`;
      } else if (this.apiKey) {
        headers['x-goog-api-key'] = this.apiKey;
      }
      return headers;
    };
    const body = JSON.stringify({
      ...(session.system ? { systemInstruction: { parts: [{ text: session.system }] } } : {}),
      // History maps directly, except the role name: assistant → 'model'.
      contents: session.messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
    });

    // One request, plus ONE retry after an OAuth refresh: access tokens
    // expire after ~1h, so a long agent run used to die mid-run with 401
    // on a token minted at provider construction. A 401 refreshes the
    // token (when a refresher is wired) and replays the request once.
    let res: Awaited<ReturnType<typeof request>> | undefined;
    let refreshed = false;
    for (let attempt = 0; attempt < 2 && !res; attempt += 1) {
      let attemptRes: Awaited<ReturnType<typeof request>>;
      try {
        attemptRes = await request(url, {
          method: 'POST',
          headers: buildHeaders(),
          body,
          signal: params.signal,
          headersTimeout: BYOK_REQUEST_HEADERS_TIMEOUT_MS,
          bodyTimeout: BYOK_REQUEST_BODY_TIMEOUT_MS,
        });
      } catch (err) {
        if (params.signal?.aborted) {
          session.messages.pop();
          throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
        }
        session.messages.pop();
        yield { type: 'error', message: connectionErrorMessage(err, url) };
        return;
      }
      if (attemptRes.statusCode === 401 && this.refreshOAuthToken && !refreshed) {
        refreshed = true;
        await readErrorDetail(attemptRes.body); // drain, so the connection can be reused
        try {
          await this.refreshAccessToken();
        } catch (err) {
          session.messages.pop();
          yield {
            type: 'error',
            message: `Google OAuth token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
          };
          return;
        }
        continue;
      }
      res = attemptRes;
    }
    if (!res) {
      session.messages.pop();
      yield { type: 'error', message: 'Model endpoint did not answer the request.' };
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
    // The API reports why generation stopped per candidate; MAX_TOKENS
    // means the reply was cut off mid-thought.
    let finishReason: string | undefined;
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
        const chunk = data as GoogleStreamData;
        // A mid-stream error object ends the turn.
        if (chunk.error) {
          const msg = typeof chunk.error.message === 'string' ? chunk.error.message : 'model stream error';
          settleErroredTurn();
          yield { type: 'error', message: `Model endpoint reported an error: ${msg}` };
          return;
        }
        const parts = chunk.candidates?.[0]?.content?.parts ?? [];
        const reason = chunk.candidates?.[0]?.finishReason;
        if (typeof reason === 'string' && reason.length > 0) finishReason = reason;
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
        // usageMetadata grows as the stream progresses - the final chunk wins.
        const u = chunk.usageMetadata;
        if (u) {
          usageInput = Number(u.promptTokenCount ?? 0) || usageInput;
          usageOutput = Number(u.candidatesTokenCount ?? 0) || usageOutput;
          sawUsage = true;
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

    // alt=sse has no terminator event - a clean stream end IS completion.
    session.messages.push({ role: 'assistant', content: assistantText });
    if (sawUsage) yield { type: 'usage', input: usageInput, output: usageOutput };
    if (finishReason === 'MAX_TOKENS') {
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
