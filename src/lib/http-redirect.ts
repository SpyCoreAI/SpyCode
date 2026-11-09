import { request, type Dispatcher } from 'undici';

/**
 * GET `url`, following redirects manually (bounded loop on 3xx `Location`).
 *
 * undici 6.29.1 does NOT support `maxRedirections` on `request()` — passing
 * it throws `maxRedirections is not supported, use the redirect interceptor`
 * before any I/O, which broke `files download`, `files show` preview, and
 * `image` download outright (presigned S3/R2 URLs 302 to the object). The
 * redirect interceptor needs an `Agent` dispatcher whose lifecycle outlives
 * the streamed body, so the manual loop is the smaller, safer shape: every
 * hop is a plain `request()` on the shared global dispatcher, and the
 * returned response is the FINAL hop's, streamed by the caller exactly as
 * before.
 *
 * Behaviour: follows 301/302/303/307/308 with a `Location` header, up to
 * `maxRedirections` hops (default 5). Relative locations resolve against the
 * current hop's URL. When the hop budget is spent, or a 3xx carries no (or
 * an unparseable) `Location`, the last response is returned as-is and the
 * caller applies its own status check (download/image throw on non-2xx;
 * the show preview only renders 2xx). Intermediate bodies are drained
 * best-effort so the connection can be reused; a drain failure never masks
 * the redirect itself.
 */
export async function requestWithRedirects(
  url: string,
  opts?: { signal?: AbortSignal; maxRedirections?: number },
): Promise<Dispatcher.ResponseData> {
  const maxRedirections = opts?.maxRedirections ?? 5;
  let current = url;
  let res = await request(current, { signal: opts?.signal });
  for (let hops = 0; hops < maxRedirections; hops += 1) {
    if (
      res.statusCode !== 301 &&
      res.statusCode !== 302 &&
      res.statusCode !== 303 &&
      res.statusCode !== 307 &&
      res.statusCode !== 308
    ) {
      return res;
    }
    const location = res.headers['location'];
    const target = Array.isArray(location) ? location[0] : location;
    if (!target) return res;
    let next: string;
    try {
      next = new URL(target, current).toString();
    } catch {
      return res;
    }
    // Drain the redirect body (usually empty) before the next hop.
    try {
      const body = res.body as unknown as {
        text?: () => Promise<string>;
        [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
      };
      if (typeof body.text === 'function') {
        await body.text();
      } else if (typeof body[Symbol.asyncIterator] === 'function') {
        for await (const _chunk of body as AsyncIterable<unknown>) {
          /* drain */
        }
      }
    } catch {
      /* best-effort drain only */
    }
    current = next;
    res = await request(current, { signal: opts?.signal });
  }
  return res;
}
