import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

/**
 * F-15 §F1–F3 - : AN ABANDONED CONSUMER MUST NOT LEAVE A RETRY LOOP
 * RUNNING, AND A LEGITIMATE RETRY MUST SURVIVE THE FIX THAT STOPS IT.
 *
 * `streamWithRetry` sets its completion flag ONLY on a `done` event, so a
 * stream that ends any other way is read as a mid-stream disconnect and
 * reconnected with 1 s / 2 s / 4 s backoff. The async generator that bridges it
 * to `for await` awaits that loop in its `finally`, so a consumer that has
 * already thrown - or merely broken out early - waits for retries nobody is
 * consuming. Measured at HEAD `487d1c93` against a mocked transport:
 *
 * consumer throws on an `error` event   4 requests   7 018 ms
 * consumer simply breaks before `done`  4 requests   7 007 ms
 *
 * THE REMEDY IS CANCELLATION, NOT A `return` ON ERROR (Reza's ruling 1). A
 * `return` treats one branch; cancellation addresses why an abandoned consumer
 * leaves a loop running at all - and the measurement agrees, because the
 * `break` shape above involves no error event whatsoever and a `return`-on-error
 * would not have touched it.
 *
 * AND THE MECHANISM THE RULING NAMES WAS ITSELF BROKEN. The `AbortSignal`
 * was already threaded through all four observation points, but `sleep()` was a
 * bare `setTimeout`: an abort fired 102 ms into a backoff did not take effect
 * until **1 004 ms**. Cancellation built on that assumption would have been
 * silently capped at one backoff step. A2/A5 are what keep that fixed.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT PIN. A consumer that reads an
 * `error` event and keeps iterating to the end of the stream never abandons the
 * generator, so no cancellation can reach it; `commands/image.ts:235` and `:467`
 * are that shape. That residual was , and it is still not pinned HERE -
 * F-16 closed it in `streamWithRetry` by making an application `error` a
 * TERMINAL state, and `tests/sse-terminal-error.test.ts` is what pins that.
 * These arms remain about ABANDONMENT and must keep passing on their own terms:
 * A2's `break` shape involves no error event at all, so it is still cancellation
 * and not termination that carries it.
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
    if (r instanceof Error) throw r;
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

/**
 * The bound is 700 ms and the figure is DERIVED, not chosen: it must sit
 * below the SMALLEST backoff step (1 000 ms), because a re-wrap that adds the
 * controller but leaves `sleep()` un-abortable settles at exactly 1 000 ms and
 * would pass any looser bound. The fixed cost being measured is ~0 ms, and the
 * 7.39x load factor measured elsewhere in this suite applies to work, not to a
 * timer, so 700 ms is ~140x the observed cost and still catches the re-wrap.
 */
const CANCELLED_MS = 700;

describe('§F1 abandonment cancels the retry loop', () => {
  /**
   * A0 THE INSTRUMENT FIRST. Every assertion below is a claim about a
   * REQUEST COUNT and an ELAPSED TIME. If the counter cannot reach a number
   * other than 1, or the clock cannot reach a number other than ~0, then A1 and
   * A2 are green over an instrument that can only report green. This arm forces
   * both to the dirty side using a purely LEGITIMATE retry sequence, so it
   * depends on no defect and cannot rot when one is fixed.
   */
  test('A0 THE INSTRUMENT FIRST: the request counter and the clock can both report dirty', async () => {
    nextResp = [
      okResp([`data: {"type":"text","content":"a"}\n\n`]), // truncated -> retry
      okResp([`data: {"type":"text","content":"b"}\n\n`]), // truncated -> retry
      okResp([`data: {"type":"text","content":"c"}\n\n`, `data: {"type":"done"}\n\n`]),
    ];
    const { streamRequest } = await import('../src/lib/sse.js');
    const t0 = performance.now();
    const got: unknown[] = [];
    for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, { maxRetries: 2 })) {
      got.push(e.data);
    }
    const ms = performance.now() - t0;

    expect(callCount, 'the request counter never left 1 - A1/A2 would be vacuous').toBe(3);
    expect(ms, 'the clock never left ~0 - the elapsed bound in A1/A2 would be vacuous').toBeGreaterThan(
      2_500,
    );
    expect(got.at(-1), 'the legitimate retry sequence did not complete').toEqual({ type: 'done' });
  });

  /**
   * A1 - the filed shape. The consumer throws on an application `error` event,
   * exactly as `commands/chat.ts:319`, `ui/chat/stream.ts` and
   * `lib/git-generate.ts` all do.
   */
  test('A1 a consumer that THROWS sends ONE request and is not held behind a retry loop', async () => {
    nextResp = [okResp([`data: {"type":"error","message":"quota exceeded"}\n\n`])];
    const { streamRequest } = await import('../src/lib/sse.js');
    const t0 = performance.now();
    let caught: unknown = null;
    try {
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' })) {
        if ((e.data as { type?: string }).type === 'error') throw new Error('consumer threw');
      }
    } catch (err) {
      caught = err;
    }
    const ms = performance.now() - t0;

    expect(caught, "the consumer's own error was swallowed").not.toBeNull();
    expect(
      callCount,
      'an application-level error was retried as if it were a dropped connection - this is the ' +
        'amplification half of : N-1 extra requests against a server that just refused one',
    ).toBe(1);
    expect(
      ms,
      "the consumer had already thrown, yet the generator's finally awaited a retry loop nobody " +
        'was consuming - this is the latency half of ',
    ).toBeLessThan(CANCELLED_MS);
  });

  /**
   * A2 - the shape a `return`-on-error would NOT have fixed, and the one that
   * proves this is about abandonment rather than about errors. No error event is
   * involved at all; the consumer simply stops reading.
   */
  test('A2 a consumer that BREAKS before done sends ONE request - no error event involved', async () => {
    nextResp = [
      okResp([`data: {"type":"text","content":"a"}\n\n`, `data: {"type":"text","content":"b"}\n\n`]),
    ];
    const { streamRequest } = await import('../src/lib/sse.js');
    const t0 = performance.now();
    const got: unknown[] = [];
    for await (const e of streamRequest('/api/chat/stream', { m: 'x' })) {
      got.push(e.data);
      break; // abandon
    }
    const ms = performance.now() - t0;

    expect(got, 'the consumer did not receive the event it broke on').toHaveLength(1);
    expect(callCount, 'breaking out of the loop still triggered the reconnect budget').toBe(1);
    expect(ms, 'breaking out of the loop still cost the full backoff').toBeLessThan(CANCELLED_MS);
  });

  /**
   * A3 - THE OTHER SIDE'S COST. Retry on a transport fault is a real feature
   * and a user on a flaky connection depends on it. A cancellation that also
   * killed this would be a regression wearing a fix's name.
   */
  test('A3 LEGITIMATE RETRY SURVIVES: a transport error still reconnects and completes', async () => {
    let n = 0;
    const undici = await import('undici');
    vi.mocked(undici.request).mockImplementation((async () => {
      n += 1;
      if (n === 1) throw new Error('ECONNRESET');
      return okResp([`data: {"type":"text","content":"ok"}\n\n`, `data: {"type":"done"}\n\n`]);
    }) as unknown as typeof undici.request);

    const { streamRequest } = await import('../src/lib/sse.js');
    const got: unknown[] = [];
    for await (const e of streamRequest('/api/chat/stream', { m: 'x' })) got.push(e.data);

    expect(n, 'the transport-error retry was removed - a flaky connection now fails outright').toBe(2);
    expect(got.at(-1), 'the reconnected stream did not complete').toEqual({ type: 'done' });
  });

  /**
   * A4 - the second legitimate case: a stream cut short by a proxy, with the
   * consumer still reading. It must still reconnect and deliver the remainder.
   */
  test('A4 LEGITIMATE RETRY SURVIVES: a truncated stream still reconnects and completes', async () => {
    nextResp = [
      okResp([`data: {"type":"text","content":"partial"}\n\n`]),
      okResp([`data: {"type":"text","content":"rest"}\n\n`, `data: {"type":"done"}\n\n`]),
    ];
    const { streamRequest } = await import('../src/lib/sse.js');
    const got: unknown[] = [];
    for await (const e of streamRequest('/api/chat/stream', { m: 'x' })) got.push(e.data);

    expect(callCount, 'the truncation retry was removed - silently truncated replies now stand').toBe(2);
    expect(got.map((d) => (d as { content?: string }).content).join('|')).toContain('partial');
    expect(got.at(-1), 'the reconnected stream did not complete').toEqual({ type: 'done' });
  });

  /**
   * A5 - THE BACKOFF ITSELF MUST BE ABORTABLE. Measured at HEAD: an abort
   * fired at 102 ms took effect at 1 004 ms, because `sleep()` was a bare
   * `setTimeout`. Ctrl+C during the third backoff step meant a 4 s dead wait.
   */
  test("A5 an abort during a backoff takes effect immediately, not when the timer expires", async () => {
    nextResp = [okResp([`data: {"type":"text","content":"partial"}\n\n`])]; // no done -> backoff
    const { streamRequest } = await import('../src/lib/sse.js');
    const controller = new AbortController();
    const t0 = performance.now();
    setTimeout(() => controller.abort(), 50);

    let caught: unknown = null;
    try {
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, {
        signal: controller.signal,
      })) {
        void e;
      }
    } catch (err) {
      caught = err;
    }
    const ms = performance.now() - t0;

    expect(caught, 'an aborted stream completed normally instead of reporting cancellation').not.toBeNull();
    expect(
      ms,
      'the abort was not observed until the backoff timer expired - sleep() is not abort-aware, so ' +
        'Ctrl+C during the third step still costs 4 s',
    ).toBeLessThan(CANCELLED_MS);
  });

  /**
   * A6 - THE LEG ONLY A PLANT CAN CATCH.
   *
   * Every arm above passes if the fix aborts the CALLER'S OWN controller instead
   * of an internal one linked to it: the request count is right, the elapsed
   * time is right, and A3/A4 pass because they pass no signal at all. But
   * `commands/agent.ts:709` creates ONE controller for SIGINT across a whole
   * run, and `ui/agent/AgentApp.tsx:529` holds one across turns - poisoning it
   * would make every subsequent stream abort instantly, from the first
   * abandonment onward. That is a regression wearing a fix's name, and this is
   * the only arm that sees it.
   */
  test('A6 THE PLANT LEG: cancellation must not poison a caller-owned signal reused for a later stream', async () => {
    const caller = new AbortController();

    // Turn 1 - the consumer abandons. This must cancel the stream's own work
    // WITHOUT aborting the controller the caller still owns.
    nextResp = [okResp([`data: {"type":"error","message":"nope"}\n\n`])];
    const { streamRequest } = await import('../src/lib/sse.js');
    try {
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, { signal: caller.signal })) {
        if ((e.data as { type?: string }).type === 'error') throw new Error('consumer threw');
      }
    } catch {
      /* expected */
    }

    expect(
      caller.signal.aborted,
      "the generator aborted the CALLER'S controller. Every later stream sharing it - the SIGINT " +
        'controller in commands/agent.ts, the per-run one in AgentApp - would abort instantly.',
    ).toBe(false);

    // Turn 2 - the SAME caller signal must still carry a normal stream.
    callCount = 0;
    nextResp = [okResp([`data: {"type":"text","content":"second"}\n\n`, `data: {"type":"done"}\n\n`])];
    const got: unknown[] = [];
    for await (const e of streamRequest('/api/chat/stream', { m: 'y' }, { signal: caller.signal })) {
      got.push(e.data);
    }

    expect(callCount, 'the second stream never issued a request - the shared signal was poisoned').toBe(1);
    expect(got.at(-1), 'the second stream on a reused caller signal did not complete').toEqual({
      type: 'done',
    });
  });

  /**
   * A8 - THE REAL `chat.ts` SHAPE: a caller signal IS threaded through.
   *
   * A1 and A2 pass no signal, so a half-fix that cancels only when the caller
   * supplied none - `signal: opts.signal ?? cancel.signal` - passes both of them
   * while leaving every production call site (all of which DO pass a signal)
   * exactly as broken as before. This arm is the one that sees that.
   */
  test('A8 the fix holds when the caller ALSO threads a live signal through', async () => {
    const caller = new AbortController(); // live, never aborted - exactly chat.ts
    nextResp = [okResp([`data: {"type":"error","message":"quota exceeded"}\n\n`])];
    const { streamRequest } = await import('../src/lib/sse.js');
    const t0 = performance.now();
    let caught: unknown = null;
    try {
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, {
        signal: caller.signal,
      })) {
        if ((e.data as { type?: string }).type === 'error') throw new Error('consumer threw');
      }
    } catch (err) {
      caught = err;
    }
    const ms = performance.now() - t0;

    expect(caught, "the consumer's own error was swallowed").not.toBeNull();
    expect(
      callCount,
      'cancellation did not happen when the caller supplied its own signal - which is every ' +
        'production call site, so the fix would be inert where it matters',
    ).toBe(1);
    expect(ms, 'the retry loop still ran to completion on the caller-signal path').toBeLessThan(
      CANCELLED_MS,
    );
  });

  /**
   * A7 - an ALREADY-aborted caller signal must still be refused up front. The
   * pre-existing contract (`sse.ts:135`) must survive the new plumbing.
   */
  test('A7 an already-aborted caller signal is still refused before any request', async () => {
    const caller = new AbortController();
    caller.abort();
    nextResp = [okResp([`data: {"type":"done"}\n\n`])];
    const { streamRequest } = await import('../src/lib/sse.js');
    const { isSpycoreCliError } = await import('../src/lib/errors.js');

    let caught: unknown = null;
    try {
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, { signal: caller.signal })) {
        void e;
      }
    } catch (err) {
      caught = err;
    }
    expect(isSpycoreCliError(caught), 'a pre-aborted signal no longer produces a cancellation error').toBe(
      true,
    );
    expect(callCount, 'a request was issued despite the signal already being aborted').toBe(0);
  });
});
