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
 * Options for {@link parseSSEStream}.
 */
export interface ParseSSEOpts {
  /**
   * Abort the stream when no chunk arrives within this many milliseconds.
   * A quiet-but-open socket otherwise hangs silently forever. Defaults to
   * {@link DEFAULT_SSE_IDLE_TIMEOUT_MS}. Pass 0 or a negative number to
   * disable (not recommended for network streams).
   */
  idleTimeoutMs?: number | undefined;
}

/**
 * Default idle timeout for SSE streams: 60 s with no data aborts the
 * stream. Long enough for slow model backends, short enough that a wedged
 * socket surfaces instead of hanging the CLI.
 */
export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 60_000;

/**
 * Idle-timeout wrapper for SSE chunk iteration. Each chunk resets the
 * clock; when no chunk arrives within `idleMs` the wait is abandoned and a
 * `SpycoreCliError` (`EXIT_NETWORK_ERROR`) is thrown so a quiet-but-open
 * socket surfaces instead of hanging the CLI forever.
 *
 * Teardown is best-effort by design: the underlying body is destroyed when
 * it supports it (undici stream bodies do), but `it.return()` is NEVER
 * awaited - on a stalled generator that call queues behind the
 * never-settling `next()` and hangs forever, which is the defect this
 * wrapper exists to avoid. A plain async iterable that never settles is
 * simply abandoned; `Promise.race` already handles its late rejection.
 */
async function* iterateWithIdleTimeout(
  body: AsyncIterable<Buffer | Uint8Array> | NodeJS.ReadableStream,
  idleMs: number,
): AsyncGenerator<Buffer | Uint8Array> {
  const it = (body as AsyncIterable<Buffer | Uint8Array>)[Symbol.asyncIterator]();
  try {
    while (true) {
      const wait = it.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const chunk = await Promise.race([
          wait,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                new SpycoreCliError(
                  `Stream stalled: no data for ${describeIdleMs(idleMs)}`,
                  EXIT_NETWORK_ERROR,
                  'The connection stayed open but silent. Check your network and try again.',
                ),
              );
            }, idleMs);
            // The watchdog must not hold the process open on its own.
            timer.unref?.();
          }),
        ]);
        if (chunk.done) return;
        yield chunk.value;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } finally {
    // Destroy the body when possible; never await the iterator's return().
    try {
      (body as { destroy?: (err?: Error) => void }).destroy?.();
    } catch {
      /* best-effort */
    }
  }
}

/** Human rendering of an idle-timeout duration: ms below one second. */
function describeIdleMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

/**
 * Iterable view over a Node `Readable` (or an undici stream body) emitting
 * SSE events. Decodes UTF-8 chunks (multi-byte safe), feeds them through
 * eventsource-parser, and yields one `StreamEvent` per parsed event. JSON
 * decoding is best-effort: malformed payloads are surfaced as raw strings
 * with a warning rather than terminating the iterator, matching how the
 * web client handles transient malformed frames mid-stream.
 *
 * Chunk iteration is guarded by an idle timeout (default
 * {@link DEFAULT_SSE_IDLE_TIMEOUT_MS}): a stream that goes quiet for too
 * long is aborted with a `SpycoreCliError` instead of hanging silently.
 * The retry layer in {@link streamWithRetry} treats that like any other
 * mid-stream fault.
 */
export async function* parseSSEStream(
  body: AsyncIterable<Buffer | Uint8Array> | NodeJS.ReadableStream,
  opts: ParseSSEOpts = {},
): AsyncGenerator<StreamEvent> {
  const idleMs = opts.idleTimeoutMs ?? DEFAULT_SSE_IDLE_TIMEOUT_MS;
  const chunks =
    idleMs > 0
      ? iterateWithIdleTimeout(body, idleMs)
      : (body as AsyncIterable<Buffer | Uint8Array>);
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

  for await (const chunk of chunks) {
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
  /**
   * Abort the stream when no chunk arrives within this many milliseconds.
   * Defaults to {@link DEFAULT_SSE_IDLE_TIMEOUT_MS}; 0 or negative disables.
   */
  idleTimeoutMs?: number | undefined;
}

const RETRY_BASE_MS = 1_000;

/**
 * Connect to an SSE endpoint and dispatch each parsed event to `onEvent`.
 *
 * Reconnect strategy: once a TERMINAL event - `done` or an application `error` -
 * has been delivered, the stream is finished and we return, whether it then ends
 * cleanly OR faults on the way out. A stream that ends any other way is a
 * mid-stream disconnect: we wait (1s, 2s, 4s …) and reconnect, passing through
 * `Last-Event-ID` for resumption per the SSE spec. We cap at `maxRetries`
 * (default 3) to avoid infinite loops in a totally broken network.
 *
 * WHY AN APPLICATION `error` IS TERMINAL. It used to count only
 * `done`, so a stream the server ended by refusing the request was read as a
 * dropped connection and reconnected three more times.  cancels that for
 * a consumer that ABANDONS the generator, but a consumer that records the error
 * and keeps iterating never runs the generator's `finally`, so there is nothing
 * to cancel: `commands/image.ts:235` and `:467` are that shape, and there each
 * retry is a FRESH PAID IMAGE GENERATION. Measured at 4 requests / 7 006 ms for
 * one refusal.
 *
 * This costs no legitimate retry. The two real retry features - a transport
 * fault and a truncated stream - both end WITHOUT an `error` event, so neither
 * is reachable from this branch. And a retry after an `error` could never have
 * helped the two image sites anyway: both check `errorMessage` first and never
 * clear it, so a later attempt's image is discarded. Driven in
 * `tests/sse-terminal-error.test.ts` T3/T4/T5 and T10.
 *
 * AND THE SAME RULE ON THE `catch` PATH. That path used to consult
 * NEITHER flag, so a transport fault arriving after a terminal event was read as
 * a dropped connection. It had three measured symptoms, all on the paid image
 * path: with budget left, a second generation and the image and `done` delivered
 * TWICE (2 requests); after an `error`, a paid generation against a server that
 * had just refused (2 requests); and - needing no override to reach, because
 * `image.ts` passes no `maxRetries` - with the budget already spent by three
 * legitimate truncations, the throw branch below fired on a stream that had
 * ALREADY delivered the image and `done`, DESTROYING a paid result
 * (4 requests, `USER_GETS_IMAGE=false`). Both exits now honour the terminal state.
 *
 * The rule is one sentence: a fault is retried IF AND ONLY IF no terminal event
 * has yet been delivered on this stream. The three real retry features -
 * connect-time faults, mid-stream faults and truncation - all arrive with no
 * terminal event delivered, so none of them can reach either guard. Driven in
 * `tests/sse-post-terminal-fault.test.ts` C4/C9/C10.
 *
 * The flags are declared outside the retry loop, but do NOT read that as "they
 * span attempts": a mutation that resets both at the top of every attempt was
 * proved applied and changed NOTHING across all 1 772 tests. Both guards fire at
 * the end of the very attempt that set the flag - a terminal event is followed
 * either by the clean end or by the `catch`, and both return - so no reachable
 * sequence sets a flag on one attempt and reads it on the next. The same fact is
 * why the connect-time `continue` above needs no guard: the loop cannot be
 * re-entered with a flag set.
 *
 * ORDER MATTERS AND IS PINNED. Moving this guard ABOVE the abort check was
 * proved applied and reddened nothing - until an arm was written for it. It is
 * not inert: it turns a Ctrl+C on a completed-then-faulted stream from
 * `Cancelled` into a silent clean end. `C11` is that arm.
 *
 * The function never throws on a transient network error if the retry
 * budget is non-empty - it logs (via the caller's onEvent contract) and
 * carries on. It DOES throw on auth/4xx errors, since retrying those
 * will not help.
 */
export async function streamWithRetry(opts: StreamWithRetryOpts): Promise<void> {
  const maxRetries = opts.maxRetries ?? 3;
  let attempt = 0;
  let lastEventId: string | undefined;
  let sawDone = false;
  let sawTerminalError = false;

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
      await sleep(backoff(attempt), opts.signal);
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
        { idleTimeoutMs: opts.idleTimeoutMs },
      )) {
        if (event.id) lastEventId = event.id;
        // Detect the two TERMINAL states so a clean close after either is not
        // retried. Both are recorded as the event passes; neither ends the
        // stream here, because events that follow one still belong to the
        // consumer (an `error` may be followed by `done`, and is).
        if (typeof event.data === 'object' && event.data !== null) {
          const type = (event.data as { type?: unknown }).type;
          if (type === 'done') sawDone = true;
          else if (type === 'error') sawTerminalError = true;
        }
        await opts.onEvent(event);
      }
      // Stream ended cleanly. If we saw a terminal event we're finished. If we
      // didn't, treat it as a mid-stream disconnect and retry.
      if (sawDone || sawTerminalError) return;
      if (attempt >= maxRetries) return;
      await sleep(backoff(attempt), opts.signal);
      attempt += 1;
      continue;
    } catch (err) {
      if (opts.signal?.aborted) {
        throw new SpycoreCliError('Cancelled', EXIT_USER_ERROR);
      }
      // a fault arriving AFTER a terminal event is post-completion
      // noise, not a dropped connection: the consumer already has the whole
      // stream. Placed AFTER the abort check so the cancellation still
      // outranks it, and BEFORE the budget check because an exhausted budget
      // here takes the throw branch below and DESTROYS an image the user has
      // already paid for and received.
      if (sawDone || sawTerminalError) return;
      if (attempt >= maxRetries) {
        if (err instanceof SpycoreCliError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new SpycoreCliError(
          `Stream interrupted: ${message}`,
          EXIT_NETWORK_ERROR,
        );
      }
      await sleep(backoff(attempt), opts.signal);
      attempt += 1;
      continue;
    }
  }
}

function backoff(attempt: number): number {
  return RETRY_BASE_MS * 2 ** attempt;
}

/**
 * the backoff MUST be abortable, and it was not.
 *
 * `sleep` used to be a bare `setTimeout`, so an abort raised mid-backoff did
 * nothing until that backoff expired. Measured: an abort fired 102 ms into the
 * first step took effect at 1 004 ms; on the third step that is a 4 s dead wait
 * after Ctrl+C. Every observation point for the signal already existed - the
 * one place it was not observed is the only place the loop actually spends
 * time.
 *
 * Resolving (rather than rejecting) on abort keeps ONE decision site: the caller
 * loops back to its top, where the existing `signal.aborted` check turns it into
 * the same `Cancelled` error it always produced.
 */
function sleep(ms: number, signal?: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
  /**
   * Abort the stream when no chunk arrives within this many milliseconds.
   * Defaults to {@link DEFAULT_SSE_IDLE_TIMEOUT_MS}; 0 or negative disables.
   */
  idleTimeoutMs?: number | undefined;
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
  // Some call sites also prefix their path with `/api/` - strip the redundant
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
  // Attach the bearer token ONLY to trusted SpyCore hosts (+ localhost) - same
  // exfil guard as lib/api.ts, applied to the streaming transport too.
  if (isTrustedTokenHost(url)) {
    const token = await getToken();
    if (token) headers.authorization = `Bearer ${token}`;
  }

  const queue: StreamEvent[] = [];
  let done = false;
  let resolveNext: ((value: StreamEvent | null) => void) | null = null;
  let pendingError: unknown = null;

  /**
   * CANCELLATION ON ABANDONMENT.
   *
   * The retry loop below outlives this generator: `finally` awaits it, so a
   * consumer that throws (`commands/chat.ts`, `ui/chat/stream.ts`,
   * `lib/git-generate.ts`) or simply breaks out early is held behind reconnect
   * attempts nobody is consuming - measured at 4 requests and 7 018 ms for one
   * `error` event, and the same 4 / 7 007 ms for a plain `break` with no error
   * involved at all.
   *
   * A retry exists to deliver events to a consumer. `finally` runs ONLY once the
   * consumer has thrown, broken or returned, so by construction there is nobody
   * left to deliver to - which is why cancelling here cannot cost a legitimate
   * retry. A consumer that keeps iterating never reaches `finally`, and its
   * reconnects are untouched.
   *
   * The controller is INTERNAL and the link is ONE-WAY (caller → internal).
   * Aborting the caller's own controller would poison a signal it still owns:
   * `commands/agent.ts:709` holds one SIGINT controller for a whole run and
   * `ui/agent/AgentApp.tsx:529` holds one across turns, so the first abandonment
   * would abort every stream after it.
   */
  const cancel = new AbortController();
  const onCallerAbort = (): void => cancel.abort();
  if (opts.signal) {
    if (opts.signal.aborted) cancel.abort();
    else opts.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  // streamWithRetry pushes events through onEvent; we bridge them to a
  // pull-based async iterator so callers can `for await ... of`.
  const work = streamWithRetry({
    url,
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: cancel.signal,
    maxRetries: opts.maxRetries,
    idleTimeoutMs: opts.idleTimeoutMs,
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
    // Cancel BEFORE awaiting. Awaiting first is the whole defect: it is what
    // holds an abandoned consumer behind a retry loop. On the normal-completion
    // path `work` has already settled and this abort is a no-op.
    cancel.abort();
    opts.signal?.removeEventListener('abort', onCallerAbort);
    // Ensure the underlying promise is awaited before returning so any
    // late-arriving error surfaces to the caller.
    await work.catch(() => {});
  }
}
