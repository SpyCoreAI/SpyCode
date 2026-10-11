import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

/**
 * F-16 §F1–F3 - : AN APPLICATION `error` THAT ENDS THE STREAM IS A
 * TERMINAL STATE, NOT A DROPPED CONNECTION - AND EVERY LEGITIMATE RETRY MUST
 * SURVIVE THE FIX THAT SAYS SO.
 *
 * `streamWithRetry` sets its completion flag ONLY on a `done` event, so a stream
 * that ends on an application `error` is read as a mid-stream disconnect and
 * reconnected with 1 s / 2 s / 4 s backoff.  closed that for consumers
 * that ABANDON the generator - they throw, break or return, `finally` runs, and
 * the loop is cancelled. It provably cannot reach a consumer that records the
 * error and keeps iterating to the end: such a consumer never runs `finally`,
 * so there is nothing to cancel. `commands/image.ts:235` and `:467` are exactly
 * that shape, and there each retry is a FRESH PAID IMAGE GENERATION.
 *
 * Measured at HEAD `43eb4fe9` against a mocked transport, production call shape:
 *
 * polite consumer, error ends the stream    4 requests   7 006 ms
 *
 * WHY THIS COSTS NO LEGITIMATE RETRY, MEASURED RATHER THAN ARGUED. Driving
 * an `error` on attempt 1 and a REAL image plus `done` on attempt 2 showed the
 * retry succeeding and the user still getting an error: both image sites check
 * `errorMessage` FIRST (`image.ts:284`, `:503`) and NEVER clear it, so a
 * post-`error` retry cannot become a user-visible image on any reachable path.
 * The two genuine retry features - transport failure and truncation - end
 * WITHOUT an `error` event and are untouched; T3/T4/T5 are what keep that true.
 *
 * WHAT THIS FILE DOES NOT COVER, AND WHERE IT NOW LIVES. These arms are about
 * the CLEAN-END exit only. The `catch` path around the same event loop was the
 * other half of the class: it consulted neither flag, so a transport fault
 * arriving AFTER a terminal event was retried - and, once the budget was spent,
 * destroyed an already-delivered paid image. That was , and F-17 closed
 * it with the same rule on that path, authorised by Reza's ruling 1 because the
 * user-visible change is a correction rather than a removal. It is pinned in
 * `tests/sse-post-terminal-fault.test.ts` (11 arms), not here.
 *
 * **With both exits guarded, the retry class is closed at the mechanism** - the
 * only remaining `continue` is the connect-time one, which the flags cannot be
 * set at unless the loop was already re-entered through one of the two now-guarded
 * exits. These arms and that file are complementary: neither subsumes the other,
 * and a change to `streamWithRetry` must keep both green.
 */

type MockBody = AsyncIterable<Buffer> & { json?: () => Promise<unknown> };
type MockResp = { statusCode: number; body: MockBody; headers: Record<string, string> };

let nextResp: MockResp[] | null = null;
let callCount = 0;

vi.mock('undici', () => ({
  request: vi.fn(async () => {
    callCount += 1;
    const list = nextResp;
    if (!list) throw new Error('test forgot to set nextResp');
    const r = list[Math.min(callCount - 1, list.length - 1)];
    if (!r) throw new Error('test exhausted nextResp');
    return r;
  }),
}));

beforeEach(() => {
  freshConfigDir();
  nextResp = null;
  callCount = 0;
});

function sseBody(chunks: string[]): MockBody {
  return Readable.from(chunks.map((c) => Buffer.from(c, 'utf8'))) as unknown as MockBody;
}
function okResp(chunks: string[]): MockResp {
  return { statusCode: 200, headers: {}, body: sseBody(chunks) };
}
/** A body that delivers `chunks` and THEN faults - a transport error mid-stream. */
function faultingResp(chunks: string[], err: Error): MockResp {
  async function* gen(): AsyncGenerator<Buffer> {
    for (const c of chunks) yield Buffer.from(c, 'utf8');
    throw err;
  }
  return { statusCode: 200, headers: {}, body: Readable.from(gen()) as unknown as MockBody };
}

const ERR = `data: {"type":"error","message":"quota exceeded"}\n\n`;
const IMG = `data: {"type":"image","urls":["https://cdn/one.png"],"revisedPrompt":"rp"}\n\n`;
const DONE = `data: {"type":"done"}\n\n`;
const TXT = `data: {"type":"text","content":"a"}\n\n`;

/**
 * The bound is 700 ms and the figure is DERIVED, not chosen: it must sit below
 * the SMALLEST backoff step (1 000 ms), because any re-wrap that still performs
 * one reconnect settles at ~1 000 ms and would pass a looser bound. The fixed
 * cost being measured is ~0 ms, so 700 ms is ~140x the observed cost and still
 * catches a single stray retry.
 */
const TERMINAL_MS = 700;
/** Retry arms cross three real backoff steps; the suite default is 5 s. */
const SLOW = 30_000;

/**
 * The production call shape, byte-for-byte as `commands/image.ts` builds it:
 * NO `signal`, NO `maxRetries`, and a consumer that records `errorMessage` and
 * keeps iterating. A corpus that does not resemble the production call shape can
 * pass a half-fix - that is exactly how F-15 nearly shipped one.
 */
async function drivePoliteImageConsumer(
  opts: { signal?: AbortSignal } = {},
): Promise<{ imageUrls: string[]; errorMessage: string | null; events: number }> {
  const { streamRequest } = await import('../src/lib/sse.js');
  const imageUrls: string[] = [];
  let errorMessage: string | null = null;
  let events = 0;
  for await (const event of streamRequest(
    '/api/chat/stream',
    { conversationId: 'c1', message: 'a cat', model: 'HEPHAESTUS' },
    { apiUrlOverride: undefined, ...(opts.signal ? { signal: opts.signal } : {}) },
  )) {
    events += 1;
    const data = event.data as (Record<string, unknown> & { type?: string }) | undefined;
    if (!data || typeof data !== 'object') continue;
    switch (data.type) {
      case 'image':
        imageUrls.push(...(Array.isArray(data.urls) ? (data.urls as string[]) : []));
        break;
      case 'error':
        errorMessage = String(data.message ?? 'Image generation failed');
        break;
      case 'done':
      default:
        break;
    }
  }
  return { imageUrls, errorMessage, events };
}

describe('§F1 an application error that ends the stream is terminal', () => {
  /**
   * T0 THE INSTRUMENT FIRST. Every assertion below is a claim about a REQUEST
   * COUNT and an ELAPSED TIME. If the counter cannot reach a number other than 1,
   * or the clock a number other than ~0, then T1/T2 are green over an instrument
   * that can only report green. This arm forces both to the dirty side using a
   * purely LEGITIMATE retry sequence, so it depends on no defect and cannot rot
   * when one is fixed.
   */
  test(
    'T0 THE INSTRUMENT FIRST: the request counter and the clock can both report dirty',
    async () => {
      nextResp = [okResp([TXT]), okResp([TXT]), okResp([TXT, DONE])];
      const { streamRequest } = await import('../src/lib/sse.js');
      const t0 = performance.now();
      const got: unknown[] = [];
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, { maxRetries: 2 })) {
        got.push(e.data);
      }
      const ms = performance.now() - t0;

      expect(callCount, 'the request counter never left 1 - T1/T2 would be vacuous').toBe(3);
      expect(ms, 'the clock never left ~0 - the elapsed bound in T1/T2 would be vacuous').toBeGreaterThan(
        2_500,
      );
      expect(got.at(-1), 'the legitimate retry sequence did not complete').toEqual({ type: 'done' });
    },
    SLOW,
  );

  /**
   * T1 - THE FILED SHAPE IN THE PRODUCTION CALL SHAPE. No caller signal, no
   * `maxRetries` override, and a polite consumer. Measured at 4 requests / 7 006 ms
   * before the fix.
   */
  test('T1 a POLITE consumer sends ONE request when an error ends the stream', async () => {
    nextResp = [okResp([ERR])];
    const t0 = performance.now();
    const { imageUrls, errorMessage } = await drivePoliteImageConsumer();
    const ms = performance.now() - t0;

    expect(errorMessage, 'the error event was not delivered to the consumer at all').toBe(
      'quota exceeded',
    );
    expect(imageUrls, 'an image appeared out of a stream that only carried an error').toHaveLength(0);
    expect(
      callCount,
      'an application error that ENDED the stream was retried as a dropped connection. On this ' +
        'path every retry is a FRESH PAID IMAGE GENERATION against a server that just refused one',
    ).toBe(1);
    expect(
      ms,
      'the polite consumer still paid the full 1s+2s+4s reconnect budget before its error surfaced',
    ).toBeLessThan(TERMINAL_MS);
  });

  /**
   * T2 - THE LEG A HALF-FIX SURVIVES. T1 passes no signal, so a fix written as
   * "terminate only when the caller supplied no signal of its own" would pass it
   * while leaving `chat.ts`, `ui/chat/stream.ts`, `git-generate.ts`, `spycore.ts`
   * and `router.ts` - every site that DOES thread a signal - exactly as before.
   * This is the arm F-15 discovered its corpus was missing.
   */
  test('T2 the fix holds when the caller ALSO threads a live signal through', async () => {
    const caller = new AbortController(); // live, never aborted - exactly chat.ts
    nextResp = [okResp([ERR])];
    const t0 = performance.now();
    const { errorMessage } = await drivePoliteImageConsumer({ signal: caller.signal });
    const ms = performance.now() - t0;

    expect(errorMessage, 'the error event was not delivered on the caller-signal path').toBe(
      'quota exceeded',
    );
    expect(
      callCount,
      'termination did not happen when the caller supplied its own signal - which is five of the ' +
        'seven production call sites, so the fix would be inert where it matters most',
    ).toBe(1);
    expect(caller.signal.aborted, "the fix aborted the CALLER'S own controller").toBe(false);
    expect(ms, 'the retry loop still ran on the caller-signal path').toBeLessThan(TERMINAL_MS);
  });

  /**
   * T3 - THE OTHER SIDE'S COST. A stream cut short by a proxy, consumer still
   * reading, NO error event. It must still reconnect and deliver the remainder.
   */
  test(
    'T3 LEGITIMATE RETRY SURVIVES: a truncated stream still reconnects and completes',
    async () => {
      nextResp = [okResp([TXT]), okResp([TXT, DONE])];
      const { streamRequest } = await import('../src/lib/sse.js');
      const got: unknown[] = [];
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, {})) got.push(e.data);

      expect(
        callCount,
        'the truncation retry was removed - silently truncated replies now stand. A fix that ' +
          'treats ANY non-done ending as terminal lands here',
      ).toBe(2);
      expect(got.at(-1), 'the reconnected stream did not complete').toEqual({ type: 'done' });
    },
    SLOW,
  );

  /**  T4 - the second legitimate case: a connect-time transport fault. */
  test(
    'T4 LEGITIMATE RETRY SURVIVES: a connect-time transport error still reconnects',
    async () => {
      let n = 0;
      const undici = await import('undici');
      vi.mocked(undici.request).mockImplementation((async () => {
        n += 1;
        if (n === 1) throw new Error('ECONNRESET');
        return okResp([TXT, DONE]);
      }) as unknown as typeof undici.request);

      const { streamRequest } = await import('../src/lib/sse.js');
      const got: unknown[] = [];
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, {})) got.push(e.data);

      expect(n, 'the transport-error retry was removed - a flaky connection now fails outright').toBe(2);
      expect(got.at(-1), 'the reconnected stream did not complete').toEqual({ type: 'done' });
    },
    SLOW,
  );

  /**
   * T5 - the third legitimate case: the fault arrives MID-stream, after events
   * have already been delivered. A fix that sets the terminal flag inside the
   * `catch` branch kills this one and only this one.
   */
  test(
    'T5 LEGITIMATE RETRY SURVIVES: a mid-stream transport fault still reconnects',
    async () => {
      nextResp = [faultingResp([TXT], new Error('ECONNRESET mid')), okResp([TXT, DONE])];
      const { streamRequest } = await import('../src/lib/sse.js');
      const got: unknown[] = [];
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, {})) got.push(e.data);

      expect(
        callCount,
        'the mid-stream transport retry was removed - a fault after partial delivery now stands',
      ).toBe(2);
      expect(got.at(-1), 'the reconnected stream did not complete').toEqual({ type: 'done' });
    },
    SLOW,
  );

  /**
   * T6 - THE LATER-ATTEMPT LEG. A fix that only consults the terminal state on
   * the FIRST attempt passes every arm above. Here attempt 1 truncates
   * legitimately and attempt 2 ends on an error: the budget must stop at 2, not
   * run on to 4.
   */
  test(
    'T6 an error arriving on a LATER attempt is still terminal',
    async () => {
      nextResp = [okResp([TXT]), okResp([ERR])];
      const { streamRequest } = await import('../src/lib/sse.js');
      const got: unknown[] = [];
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, {})) got.push(e.data);

      expect(
        callCount,
        'the terminal state was only consulted on the first attempt, so a legitimate retry that ' +
          'then errors still burns the whole budget',
      ).toBe(2);
      expect(got.at(-1), 'the error event was not delivered').toEqual({
        type: 'error',
        message: 'quota exceeded',
      });
    },
    SLOW,
  );

  /**
   * T7 - THE NOT-THE-LAST-EVENT LEG. A fix that inspects only the FINAL event
   * of a stream passes T1, because there the error IS last. Here the error is
   * followed by more data and then a truncation, so a last-event test reads
   * `text` and retries.
   */
  test(
    'T7 an error is terminal even when it is not the LAST event before the stream ends',
    async () => {
      nextResp = [okResp([ERR, TXT])];
      const { streamRequest } = await import('../src/lib/sse.js');
      const got: unknown[] = [];
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, {})) got.push(e.data);

      expect(
        callCount,
        'the terminal check reads only the final event, so an error followed by any other frame ' +
          'still burns the reconnect budget',
      ).toBe(1);
      expect(got, 'both events should still have reached the consumer').toHaveLength(2);
    },
    SLOW,
  );

  /**
   * T8 - `done` STILL WINS, AND THE STREAM IS NOT CUT SHORT. A fix that
   * `return`s the moment it sees an error stops delivering everything after it.
   * Here an error is followed by a real image and `done`: one request, and the
   * consumer must receive all three events.
   */
  test('T8 an error followed by done is NOT a termination - the stream completes normally', async () => {
    nextResp = [okResp([ERR, IMG, DONE])];
    const { imageUrls, errorMessage, events } = await drivePoliteImageConsumer();

    expect(callCount, 'a stream that reached done was retried').toBe(1);
    expect(
      events,
      'the fix returned as soon as it saw the error and cut the stream short - events after an ' +
        'error must still reach the consumer',
    ).toBe(3);
    expect(errorMessage, 'the error event was dropped').toBe('quota exceeded');
    expect(imageUrls, 'the image delivered after the error was dropped').toHaveLength(1);
  });

  /**
   * T9 - A RAW FRAME IS NOT A TERMINATION. The payload of a malformed frame is
   * a STRING, not an object. A terminal check written without the
   * `typeof data === 'object' && data !== null` guard either throws here or reads
   * a `type` off a string and treats it as terminal.
   */
  test(
    'T9 a malformed/raw frame is not a termination and does not disturb the retry',
    async () => {
      nextResp = [okResp([`data: not-json\n\n`, IMG, DONE])];
      const { streamRequest } = await import('../src/lib/sse.js');
      const got: unknown[] = [];
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, {})) got.push(e.data);

      expect(callCount, 'a raw frame was mistaken for a termination or a disconnect').toBe(1);
      expect(got, 'the raw frame did not pass through to the consumer').toHaveLength(3);
      expect(got[0], 'the raw payload should surface as a string, unchanged').toBe('not-json');
      expect(got.at(-1)).toEqual({ type: 'done' });
    },
    SLOW,
  );

  /**
   * T10 - THE USER-VISIBLE OUTCOME IS UNCHANGED, AND THAT IS THE POINT.
   * Attempt 1 ends on an error; attempt 2 would deliver a REAL image and `done`.
   * Before the fix that retry happened and the user STILL got an error, because
   * `image.ts:284`/`:503` check `errorMessage` first and never clear it. This arm
   * pins that the fix removes the paid request WITHOUT changing what the user
   * sees - the whole basis for "zero legitimate retries lost".
   */
  test(
    'T10 the paid-site outcome is identical, minus the paid retry',
    async () => {
      nextResp = [okResp([ERR]), okResp([IMG, DONE])];
      const { imageUrls, errorMessage } = await drivePoliteImageConsumer();

      // Replays the real post-loop decision at image.ts:284 and :503.
      const userGetsImage = !errorMessage && imageUrls.length > 0;

      expect(
        callCount,
        'the second PAID generation still ran. It cannot help: errorMessage is checked first and ' +
          'never cleared, so its image is discarded on every reachable path',
      ).toBe(1);
      expect(errorMessage, 'the user must still be told about the error').toBe('quota exceeded');
      expect(
        userGetsImage,
        'the user outcome changed - this fix must remove a cost, not a result',
      ).toBe(false);
    },
    SLOW,
  );
});
