import { request } from 'undici';
import { createParser, type EventSourceMessage } from 'eventsource-parser';
import { getToken } from './auth.js';
import { isTrustedTokenHost, normalizeApiBase, resolveApiUrl } from './config.js';
import {
  EXIT_AUTH_ERROR,
  EXIT_NETWORK_ERROR,
  EXIT_SERVER_ERROR,
  EXIT_USER_ERROR,
  SpycoreCliError,
} from './errors.js';

/**
 * One SSE event surfaced to a consumer. The server speaks "data-only" SSE
 * (no `event:` line) and embeds a typed JSON payload, so callers will
 * almost always reach for `data` and inspect the `type` field. We still
 * keep the optional fields for completeness.
 */
export interface StreamEvent {
  /** SSE event name. Defaults to "message" per the spec when no `event:` line was sent. */
  event: string;
  /**
   * Parsed JSON when the data line decoded cleanly, otherwise the raw
   * string. Consumers that expect typed payloads should narrow with
   * `typeof data === 'object'`.
   */
  data: unknown;
  id?: string | undefined;
  retry?: number | undefined;
}

/**
 * Iterable view over a Node `Readable` (or an undici stream body) emitting
 * SSE events. Decodes UTF-8 chunks (multi-byte safe), feeds them through
 * eventsource-parser, and yields one `StreamEvent` per parsed event. JSON
 * decoding is best-effort: malformed payloads are surfaced as raw strings
 * with a warning rather than terminating the iterator, matching how the
 * web client handles transient malformed frames mid-stream.
 */
export async function* parseSSEStream(
  body: AsyncIterable<Buffer | Uint8Array> | NodeJS.ReadableStream,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder('utf-8');
  // eventsource-parser delivers events synchronously through a callback,
  // so we buffer them inside this generator and yield in order.
  const queue: StreamEvent[] = [];
  const parser = createParser({
    onEvent: (event: EventSourceMessage) => {
      const raw = event.data;
      let payload: unknown = raw;
      if (raw && raw.length > 0) {
        try {
          payload = JSON.parse(raw);
        } catch {
          payload = raw;
        }
      }
      queue.push({
        event: event.event ?? 'message',
        data: payload,
        id: event.id,
      });
    },
    onRetry: (retry: number) => {
      queue.push({
        event: 'reconnect-interval',
        data: retry,
        retry,
      });
    },
  });

  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array>) {
    const text = decoder.decode(
      chunk instanceof Buffer ? chunk : Buffer.from(chunk),
      { stream: true },
    );
    parser.feed(text);
    while (queue.length > 0) {
      const next = queue.shift();
      if (next) yield next;
    }
  }
  // Flush trailing decoder bytes (rare but possible at exact UTF-8 boundary).
  const tail = decoder.decode();
  if (tail.length > 0) parser.feed(tail);
  while (queue.length > 0) {
    const next = queue.shift();
    if (next) yield next;
  }
}

/**
 * Streaming options for `streamWithRetry`. Auth headers and JSON body
 * encoding live in `streamRequest`; this lower-level helper takes the
 * already-prepared headers and serialised body so it can be reused for
 * non-/api streams (e.g. /api/health) if we ever need it.
 */
export interface StreamWithRetryOpts {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  /** Pre-serialised body (string or Buffer). Pass undefined for GET. */
  body?: string | Buffer | undefined;
  onEvent: (event: StreamEvent) => void | Promise<void>;
  /** AbortSignal for Ctrl+C / cancellation. */
  signal?: AbortSignal | undefined;
  /** How many reconnect attempts after an interrupted stream. Default 3. */
  maxRetries?: number | undefined;
}

const RETRY_BASE_MS = 1_000;

/**
 * Connect to an SSE endpoint and dispatch each parsed event to `onEvent`.
 *
 * Reconnect strategy: when the underlying stream errors *after* receiving
 * `done` we return cleanly; if it errors mid-stream we wait
 * (1s, 2s, 4s …) and reconnect, passing through `Last-Event-ID` for
 * resumption per the SSE spec. We cap at `maxRetries` (default 3) to
 * avoid infinite loops in a totally broken network.
 *
 * The function never throws on a transient network error if the retry
 * budget is non-empty — it logs (via the caller's onEvent contract) and
 * carries on. It DOES throw on auth/4xx errors, since retrying those
 * will not help.
 */
export async function streamWithRetry(opts: StreamWithRetryOpts): Promise<void> {
  const maxRetries = opts.maxRetries ?? 3;
  let attempt = 0;
  let lastEventId: string | undefined;
  let sawDone = false;

  while (true) {
    if (opts.signal?.aborted) {
      throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
    }
    const headers: Record<string, string> = {
      ...opts.headers,
      accept: 'text/event-stream',
      'cache-control': 'no-cache',
    };
    if (lastEventId) headers['last-event-id'] = lastEventId;

    let res;
    try {
      res = await request(opts.url, {
        method: opts.method ?? 'POST',
        headers,
        body: opts.body,
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) {
        throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
      }
      if (attempt >= maxRetries) {
        const message = err instanceof Error ? err.message : String(err);
        throw new SpycoreCliError(
          `Cannot reach API: ${message}`,
          EXIT_NETWORK_ERROR,
          `Tried ${opts.url}. Check your connection.`,
        );
      }
      await sleep(backoff(attempt));
      attempt += 1;
      continue;
    }

    const status = res.statusCode;
    if (status >= 400) {
      const failureBody = await safeReadJson(res.body);
      throw mapHttpFailure(status, failureBody, res.headers);
    }

    try {
      for await (const event of parseSSEStream(
        res.body as unknown as AsyncIterable<Buffer>,
      )) {
        if (event.id) lastEventId = event.id;
        // Detect `done` so a clean close after it is not retried.
        if (
          typeof event.data === 'object' &&
          event.data !== null &&
          (event.data as { type?: unknown }).type === 'done'
        ) {
          sawDone = true;
        }
        await opts.onEvent(event);
      }
      // Stream ended cleanly. If we saw `done` we're finished. If we
      // didn't, treat it as a mid-stream disconnect and retry.
      if (sawDone) return;
      if (attempt >= maxRetries) return;
      await sleep(backoff(attempt));
      attempt += 1;
      continue;
    } catch (err) {
      if (opts.signal?.aborted) {
        throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
      }
      if (attempt >= maxRetries) {
        if (err instanceof SpycoreCliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SpycoreCliError(
          `Stream interrupted: ${message}`,
          EXIT_NETWORK_ERROR,
        );
      }
      await sleep(backoff(attempt));
      attempt += 1;
      continue;
    }
  }
}

function backoff(attempt: number): number {
  return RETRY_BASE_MS * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeReadJson(body: { json: () => Promise<unknown> }): Promise<{
  error?: string;
  message?: string;
} | null> {
  try {
    return (await body.json()) as { error?: string; message?: string };
  } catch {
    return null;
  }
}

function mapHttpFailure(
  status: number,
  body: { error?: string; message?: string } | null,
  headers: Record<string, string | string[] | undefined>,
): SpycoreCliError {
  const errMsg = body?.error || body?.message || `HTTP ${status}`;
  if (status === 401) {
    return new SpycoreCliError(
      `Authentication failed: ${errMsg}`,
      EXIT_AUTH_ERROR,
      "Run `spycore login` to re-authenticate.",
    );
  }
  if (status === 403) {
    return new SpycoreCliError(
      `Permission denied: ${errMsg}`,
      EXIT_AUTH_ERROR,
      'This action may require a higher plan or a different account.',
    );
  }
  if (status === 429) {
    const retryAfter = headers['retry-after'];
    const hint =
      typeof retryAfter === 'string' && retryAfter.length > 0
        ? `Retry after ${retryAfter}s.`
        : 'Wait a moment and try again.';
    return new SpycoreCliError(
      `Rate limit exceeded: ${errMsg}`,
      EXIT_NETWORK_ERROR,
      hint,
    );
  }
  if (status >= 500) {
    return new SpycoreCliError(
      `Server error: ${errMsg}`,
      EXIT_SERVER_ERROR,
      'The SpyCore API is having trouble. Try again in a moment.',
    );
  }
  return new SpycoreCliError(errMsg, EXIT_USER_ERROR);
}

/**
 * Higher-level helper: hit a SpyCore API endpoint, attach the auth Bearer
 * automatically, and yield SSE events as they arrive. This is the function
 * commands like `chat` should use.
 */
export interface StreamRequestOpts {
  apiUrlOverride?: string | undefined;
  signal?: AbortSignal | undefined;
  maxRetries?: number | undefined;
  /** Extra headers (e.g. Idempotency-Key). */
  headers?: Record<string, string> | undefined;
}

export async function* streamRequest<T = unknown>(
  path: string,
  body: T,
  opts: StreamRequestOpts = {},
): AsyncGenerator<StreamEvent> {
  const base = normalizeApiBase(resolveApiUrl(opts.apiUrlOverride));
  // `base` is guaranteed to end in exactly one `/api` (normalizeApiBase).
  // Some call sites also prefix their path with `/api/` — strip the redundant
  // segment so the URL never doubles up (`…/api/api/chat/stream`). Both
  // `/api/x` and `/x` path forms resolve.
  let rel = path.startsWith('/') ? path : `/${path}`;
  if (rel.startsWith('/api/')) rel = rel.slice(4);
  const url = `${base}${rel}`;

  const headers: Record<string, string> = {
    'user-agent': '@spycore/cli',
    'content-type': 'application/json',
    ...opts.headers,
  };
  // Attach the bearer token ONLY to trusted SpyCore hosts (+ localhost) — same
  // exfil guard as lib/api.ts, applied to the streaming transport too.
  if (isTrustedTokenHost(url)) {
    const token = await getToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  const queue: StreamEvent[] = [];
  let done = false;
  let resolveNext: ((value: StreamEvent | null) => void) | null = null;
  let pendingError: unknown = null;

  // streamWithRetry pushes events through onEvent; we bridge them to a
  // pull-based async iterator so callers can `for await ... of`.
  const work = streamWithRetry({
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
    maxRetries: opts.maxRetries,
    onEvent: (event) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(event);
      } else {
        queue.push(event);
      }
    },
  })
    .then(() => {
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(null);
      }
    })
    .catch((err: unknown) => {
      pendingError = err;
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r(null);
      }
    });

  try {
    while (true) {
      if (queue.length > 0) {
        const next = queue.shift();
        if (next) yield next;
        continue;
      }
      if (done) break;
      const next = await new Promise<StreamEvent | null>((resolve) => {
        resolveNext = resolve;
      });
      if (next === null) break;
      yield next;
    }
    await work;
    if (pendingError) throw pendingError;
  } finally {
    // Ensure the underlying promise is awaited before returning so any
    // late-arriving error surfaces to the caller.
    await work.catch(() => {});
  }
}
