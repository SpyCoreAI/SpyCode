/**
 * Shared low-level wire helpers for the BYOK provider adapters (error-body
 * reading, errno extraction, connection-failure wording). Extracted from the
 * OpenAI-compatible adapter so the Anthropic and Google adapters reuse the same
 * behaviour instead of forking it. No keys ever pass through here — error
 * detail comes only from response BODIES, never request headers.
 */

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
  const code = extractCode(err);
  if (code === 'ECONNREFUSED') {
    return `Cannot reach the model endpoint at ${url} — is the server running? (connection refused)`;
  }
  if (code === 'ENOTFOUND') {
    return `Cannot resolve the model endpoint host for ${url} — check --base-url.`;
  }
  return `Cannot reach the model endpoint at ${url}: ${errText(err)}`;
}

/**
 * Best-effort short detail from an error response body. Prefers the common
 * `{ error: { message } }` shape (OpenAI-compatible, Anthropic, and Google all
 * use it), falls back to a clipped raw snippet. Never includes request
 * headers, so the API key can't leak here.
 */
export async function readErrorDetail(body: unknown): Promise<string | undefined> {
  try {
    let text = '';
    const b = body as
      | ({ text?: () => Promise<string> } & AsyncIterable<Buffer | Uint8Array>)
      | undefined;
    if (b && typeof b.text === 'function') {
      text = await b.text();
    } else if (b && typeof (b as AsyncIterable<Buffer>)[Symbol.asyncIterator] === 'function') {
      const dec = new TextDecoder();
      for await (const chunk of b as AsyncIterable<Buffer | Uint8Array>) {
        text += dec.decode(chunk instanceof Buffer ? chunk : Buffer.from(chunk), { stream: true });
      }
      text += dec.decode();
    }
    if (!text) return undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown } | string };
      const e = parsed?.error;
      if (typeof e === 'string') return clip(e);
      if (e && typeof e === 'object' && typeof e.message === 'string') return clip(e.message);
    } catch {
      /* not JSON — fall through to the raw snippet */
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
