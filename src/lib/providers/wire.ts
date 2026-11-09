/**
 * Shared low-level wire helpers for the BYOK provider adapters (error-body
 * reading, errno extraction, connection-failure wording). Extracted from the
 * OpenAI-compatible adapter so the Anthropic and Google adapters reuse the same
 * behaviour instead of forking it. No keys ever pass through here - error
 * detail comes only from response BODIES, never request headers.
 */
import { ERROR_BODY_MAX_BYTES } from '../sse.js';
import { redactUrlCredentials } from '../redact.js';
import { truncateSafe } from '../text.js';


/**
 * Explicit per-request timeouts for BYOK adapters. These pin the undici
 * defaults (30s to first byte, 300s for the body) so a hung endpoint is a
 * decision, not an accident of whatever the HTTP client ships. The body
 * bound stays at the undici default on purpose: a slow-streaming turn must
 * not die mid-reply; the agent's own abort signal is what cuts a run short.
 */
export const BYOK_REQUEST_HEADERS_TIMEOUT_MS = 30_000;
export const BYOK_REQUEST_BODY_TIMEOUT_MS = 300_000;

/**
 * Cap on one streamed BYOK turn's accumulated reply (assistant text +
 * assembled tool-call arguments, counted in UTF-8 bytes). The error body
 * was already capped at 1 MB while the SUCCESS body was unbounded: a
 * misbehaving endpoint could stream gigabytes inside the 300 s body
 * timeout, and the history trim counts messages (100), not bytes, so one
 * giant assistant message was never trimmed and was replayed in full on
 * every later turn. Same 1 MB bound as ERROR_BODY_MAX_BYTES, counted
 * incrementally per fragment so the check itself is O(fragment), never
 * O(accumulated reply).
 */
export const BYOK_STREAM_MAX_BYTES = ERROR_BODY_MAX_BYTES;

/** Incremental byte budget for one streamed turn (see BYOK_STREAM_MAX_BYTES). */
export class StreamByteBudget {
  private used = 0;
  /** Bytes accepted so far. */
  get usedBytes(): number {
    return this.used;
  }
  /**
   * Accept `text` if it still fits under the cap. Returns false (and
   * accepts nothing) when the fragment would take the turn past the cap -
   * the caller then ends the turn with the cap error instead.
   */
  tryAdd(text: string): boolean {
    const n = Buffer.byteLength(text, 'utf8');
    if (this.used + n > BYOK_STREAM_MAX_BYTES) return false;
    this.used += n;
    return true;
  }
}

/** Error text for a turn that trips the stream cap (names the cap). */
export function streamCapErrorMessage(): string {
  return (
    `Model reply exceeded the ${BYOK_STREAM_MAX_BYTES.toLocaleString('en-US')} byte stream cap - ` +
    'the endpoint streamed more than the allowed reply size for one turn.'
  );
}

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
 * ERROR_BODY_MAX_BYTES (the same 1 MB bound readCappedJson uses): real
 * undici bodies are streamed through the async iterator under a byte
 * budget (with the transport destroyed past the cap), so a multi-MB error
 * page from a proxy/misbehaving endpoint is never buffered in full. Only
 * bodies with no async iterator fall back to `.text()`, where the cap can
 * bound just the parse/clip work.
 */
export async function readErrorDetail(body: unknown): Promise<string | undefined> {
  try {
    let text = '';
    const b = body as
      | ({ text?: () => Promise<string>; destroy?: (err?: Error) => void } & AsyncIterable<Buffer | Uint8Array>)
      | undefined;
    if (b && typeof (b as AsyncIterable<Buffer>)[Symbol.asyncIterator] === 'function') {
      // Stream through the async iterator with a BYTE budget: `.text()`
      // resolves only after the transport has buffered the whole body,
      // so a `.text()` + slice cap never binds for real undici bodies
      // (they expose both, and the old code checked `.text()` first).
      // Reading the iterator is the only branch that actually stops a
      // multi-MB error page from landing in memory in full.
      const chunks: Buffer[] = [];
      let total = 0;
      let overCap = false;
      for await (const chunk of b as AsyncIterable<Buffer | Uint8Array>) {
        const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > ERROR_BODY_MAX_BYTES) {
          overCap = true;
          break;
        }
        chunks.push(buf);
      }
      if (overCap) {
        // Stop the transport producing more: without this the producer
        // keeps buffering behind our back.
        try {
          b.destroy?.();
        } catch {
          /* best-effort */
        }
      }
      text = Buffer.concat(chunks).toString('utf8');
    } else if (b && typeof b.text === 'function') {
      // Bodies that offer no async iterator (test doubles, non-streaming
      // transports) can only be read via `.text()` - already buffered by
      // the transport, so the slice below bounds only the parse/clip work.
      text = (await b.text()).slice(0, ERROR_BODY_MAX_BYTES);
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
  return t.length > 200 ? `${truncateSafe(t, 200)}…` : t;
}
