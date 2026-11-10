import { request, type Dispatcher } from 'undici';
import { EXIT_NETWORK_ERROR, SpycoreCliError } from './errors.js';

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
 * the show preview only renders 2xx). A redirect that would downgrade
 * `https:` to `http:` is refused outright with an error naming the
 * downgrade (R3-16) — the downloaded bytes would otherwise travel over
 * plaintext, where a network attacker can substitute them, and `files
 * download` would save the substituted body as complete. Intermediate
 * bodies are drained with a hard byte cap and then destroyed (R3-14), so
 * a 302 carrying a multi-GB body can never OOM the CLI the way the old
 * unbounded `body.text()` drain could; a drain failure never masks the
 * redirect itself.
 */

/** Hard cap on how much of a redirect body is ever read (R3-14). */
const MAX_REDIRECT_BODY_DRAIN_BYTES = 64 * 1024;

/** Best-effort abandon of a response body: swallow the abort error undici
 * emits when a body is destroyed mid-stream, so dropping a redirect body
 * can never crash the process with an unhandled `error` event. */
function destroyBody(body: unknown): void {
  try {
    const stream = body as unknown as {
      on?: (event: string, listener: () => void) => void;
      destroy?: () => void;
    };
    if (typeof stream?.on === 'function') {
      stream.on('error', () => {
        /* abandoned body - its abort error is expected, not a failure */
      });
    }
    if (typeof stream?.destroy === 'function') stream.destroy();
  } catch {
    /* best-effort only */
  }
}

/**
 * Read at most `MAX_REDIRECT_BODY_DRAIN_BYTES` of an intermediate redirect
 * body, then destroy it so the rest never arrives. Reading the body at all
 * (rather than destroying it outright) keeps connection reuse for the
 * common empty/small-body 302; the cap keeps a hostile 302 from growing
 * memory without bound. A single yielded chunk can exceed the cap by
 * itself (undici yields socket-sized chunks, observed up to 1 MB), so the
 * transient peak is bounded by one chunk plus the cap, never by the body.
 */
async function drainRedirectBody(body: unknown): Promise<void> {
  try {
    const stream = body as unknown as {
      on?: (event: string, listener: () => void) => void;
      destroy?: () => void;
      [Symbol.asyncIterator]?: () => AsyncIterator<unknown>;
    };
    if (typeof stream?.on === 'function') {
      stream.on('error', () => {
        /* abandoned body - its abort error is expected, not a failure */
      });
    }
    if (typeof stream?.[Symbol.asyncIterator] === 'function') {
      let drained = 0;
      for await (const chunk of stream as AsyncIterable<unknown>) {
        drained +=
          typeof chunk === 'string'
            ? Buffer.byteLength(chunk)
            : ((chunk as Uint8Array | undefined)?.length ?? 0);
        if (drained >= MAX_REDIRECT_BODY_DRAIN_BYTES) break;
      }
    }
    // Breaking out of the iterator destroys the stream, but destroy
    // explicitly too so a body that already ended (or never yielded) is
    // closed as well and the socket does not linger.
    if (typeof stream?.destroy === 'function') stream.destroy();
  } catch {
    /* best-effort drain only */
  }
}

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
    // R3-16: refuse a redirect that downgrades https to plain http.
    // Upgrades (http to https) and same-scheme hops are still followed.
    // No Authorization header is ever sent on a hop, so nothing secret
    // leaks — the exposure is the downloaded content itself, which would
    // travel over plaintext and could be substituted in transit.
    if (
      new URL(current).protocol === 'https:' &&
      new URL(next).protocol === 'http:'
    ) {
      destroyBody(res.body);
      throw new SpycoreCliError(
        `Refusing to follow redirect from ${current} to ${next}: the redirect downgrades HTTPS to plain HTTP.`,
        EXIT_NETWORK_ERROR,
        'The server answered with a redirect to a plain-HTTP URL; the download was stopped instead of fetching content over an unencrypted connection.',
      );
    }
    // Drain the redirect body (usually empty) before the next hop.
    await drainRedirectBody(res.body);
    current = next;
    res = await request(current, { signal: opts?.signal });
  }
  return res;
}
