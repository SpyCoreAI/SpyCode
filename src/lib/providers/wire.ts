/**
 * Shared low-level wire helpers for the BYOK provider adapters (error-body
 * reading, errno extraction, connection-failure wording). Extracted from the
 * OpenAI-compatible adapter so the Anthropic and Google adapters reuse the same
 * behaviour instead of forking it. No keys ever pass through here - error
 * detail comes only from response BODIES, never request headers.
 */
import { ERROR_BODY_MAX_BYTES } from '../sse.js';
import { redactUrlCredentials } from '../redact.js';


/**
 * Explicit per-request timeouts for BYOK adapters. These pin the undici
 * defaults (30s to first byte, 300s for the body) so a hung endpoint is a
 * decision, not an accident of whatever the HTTP client ships. The body
 * bound stays at the undici default on purpose: a slow-streaming turn must
 * not die mid-reply; the agent's own abort signal is what cuts a run short.
 */
export const BYOK_REQUEST_HEADERS_TIMEOUT_MS = 30_000;
export const BYOK_REQUEST_BODY_TIMEOUT_MS = 300_000;

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Walk the error → cause chain for a Node errno code (ECONNREFUSED, …). */
export function extractCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export function connectionErrorMessage(err: unknown, url: string): string {
  // Strip any userinfo credentials from the base URL before it reaches
  // an error message: a stored / --base-url value carrying
  // `https://user:pass@host/…` used to print its credentials to stderr
  // on any connection failure.
  const safeUrl = redactUrlCredentials(url);
  const code = extractCode(err);
  if (code === 'ECONNREFUSED') {
    return `Cannot reach the model endpoint at ${safeUrl} - is the server running? (connection refused)`;
  }
  if (code === 'ENOTFOUND') {
    return `Cannot resolve the model endpoint host for ${safeUrl} - check --base-url.`;
  }
  return `Cannot reach the model endpoint at ${safeUrl}: ${errText(err)}`;
}

/**
 * Best-effort short detail from an error response body. Prefers the common
 * `{ error: { message } }` shape (OpenAI-compatible, Anthropic, and Google all
 * use it), falls back to a clipped raw snippet. Never includes request
 * headers, so the API key can't leak here. The read itself is capped at
 * ERROR_BODY_MAX_BYTES (the same 1 MB bound readCappedJson uses): the
 * clipped output is 200 chars, but the full body used to be buffered first,
 * so a multi-MB error page from a proxy/misbehaving endpoint was read into
 * memory in full.
 */
export async function readErrorDetail(body: unknown): Promise<string | undefined> {
  try {
    let text = '';
    const b = body as
      | ({ text?: () => Promise<string> } & AsyncIterable<Buffer | Uint8Array>)
      | undefined;
    if (b && typeof b.text === 'function') {
      // .text() resolves with the whole body already buffered by the
      // transport - truncate before parsing so no downstream work scales
      // with a hostile body size.
      text = (await b.text()).slice(0, ERROR_BODY_MAX_BYTES);
    } else if (b && typeof (b as AsyncIterable<Buffer>)[Symbol.asyncIterator] === 'function') {
      const dec = new TextDecoder();
      for await (const chunk of b as AsyncIterable<Buffer | Uint8Array>) {
        text += dec.decode(chunk instanceof Buffer ? chunk : Buffer.from(chunk), { stream: true });
        if (text.length > ERROR_BODY_MAX_BYTES) {
          text = text.slice(0, ERROR_BODY_MAX_BYTES);
          break;
        }
      }
      text += dec.decode();
      if (text.length > ERROR_BODY_MAX_BYTES) text = text.slice(0, ERROR_BODY_MAX_BYTES);
    }
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
      const e = parsed?.error;
      if (typeof e === 'string') return clip(e);
      if (e && typeof e === 'object' && typeof e.message === 'string') return clip(e.message);
    } catch {
      /* not JSON - fall through to the raw snippet */
    }
    return clip(text);
  } catch {
    return undefined;
  }
}

export function clip(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}
