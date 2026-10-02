import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

/**
 * ⭐⭐ F-17 §F1–F4 — SPY-367: A TRANSPORT FAULT ARRIVING AFTER A TERMINAL EVENT IS
 * NOT A DROPPED CONNECTION — AND EVERY LEGITIMATE RETRY MUST SURVIVE THE FIX THAT
 * SAYS SO.
 *
 * `streamWithRetry` records two terminal states, `sawDone` and `sawTerminalError`,
 * and F-16 made the CLEAN-END path consult them. The `catch` path around the same
 * event loop consults NEITHER, contradicting the function's own documented
 * contract. Measured at HEAD `536a9394` against a mocked transport, in the
 * production call shape (`commands/image.ts` passes no signal and no
 * `maxRetries`), the blindness has THREE distinct symptoms:
 *
 *   fault after `done`,  budget available   2 requests   image + done delivered TWICE
 *   fault after `error`, budget available   2 requests   a paid generation AFTER a refusal
 *   fault after `done`,  budget exhausted   4 requests   `Stream interrupted` — THE PAID IMAGE IS DESTROYED
 *
 * ⭐⭐ THE THIRD IS THE ONE THAT MATTERS MOST AND IT NEEDS NO OVERRIDE TO REACH.
 * Three legitimate truncations exhaust the default budget of 3; the fourth attempt
 * delivers a real image and `done` and faults on the way out; `attempt >= maxRetries`
 * so the `catch` path throws instead of retrying, and a successfully delivered,
 * already-paid-for image is thrown away. `USER_GETS_IMAGE=false`.
 *
 * ⭐ THE RULE, AND WHY IT COSTS NO LEGITIMATE RETRY. A fault is retried IF AND ONLY
 * IF no terminal event has yet been delivered to the consumer on this stream. The
 * three real retry features — a connect-time fault, a mid-stream fault and a
 * truncation — all arrive with NO terminal event delivered, so the guard reads
 * false and the executed path is bit-for-bit the one that runs today. C4, C9 and
 * C10 are what keep that true.
 *
 * ⭐ The guard sits AFTER the abort check, so SPY-360's cancellation still outranks
 * it, and BEFORE the budget check, because a fix placed after the budget check
 * closes the retry symptom and leaves the image-destroying one open (that was
 * candidate C2, rejected by measurement — see audits/f17-plant-question.md).
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
/** Delivers `chunks` and THEN faults — a transport error at that exact point. */
function faultingResp(chunks: string[], err: Error): MockResp {
  async function* gen(): AsyncGenerator<Buffer> {
    for (const c of chunks) yield Buffer.from(c, 'utf8');
    throw err;
  }
  return { statusCode: 200, headers: {}, body: Readable.from(gen()) as unknown as MockBody };
}

const ERR = `data: {"type":"error","message":"quota exceeded"}\n\n`;
const IMG_A = `data: {"type":"image","urls":["https://cdn/AAA.png"],"revisedPrompt":"rp-A"}\n\n`;
const IMG_B = `data: {"type":"image","urls":["https://cdn/BBB.png"],"revisedPrompt":"rp-B"}\n\n`;
const DONE = `data: {"type":"done"}\n\n`;
const TXT = `data: {"type":"text","content":"a"}\n\n`;
const FAULT = (): Error => new Error('ECONNRESET after terminal');

/**
 * ⭐ The bound is 700 ms and the figure is DERIVED, not chosen: it must sit below
 * the SMALLEST backoff step (1 000 ms), because any re-wrap that still performs
 * one reconnect settles at ~1 000 ms and would pass a looser bound.
 */
const TERMINAL_MS = 700;
/** Retry arms cross up to three real backoff steps; the suite default is 5 s. */
const SLOW = 30_000;

/**
 * ⭐ The production call shape, byte-for-byte as `commands/image.ts` builds it: NO
 * `signal`, NO `maxRetries`, and a consumer that records `errorMessage` and keeps
 * iterating. It also mirrors the two post-loop decisions the user actually feels —
 * `errorMessage` is checked FIRST (`image.ts:284`, `:503`) and the file written is
 * `imageUrls[0]` (`:325`, `:542`) — so an arm can assert what the USER gets, not
 * only what the transport did.
 */
async function drivePoliteImageConsumer(
  o: { signal?: AbortSignal } = {},
): Promise<{
  imageUrls: string[];
  revisedPrompt: string;
  errorMessage: string | null;
  events: number;
  threw: string | null;
  userGetsImage: boolean;
  savedFile: string | undefined;
}> {
  const { streamRequest } = await import('../src/lib/sse.js');
  const imageUrls: string[] = [];
  let revisedPrompt = '';
  let errorMessage: string | null = null;
  let events = 0;
  let threw: string | null = null;
  try {
    for await (const event of streamRequest(
      '/api/chat/stream',
      { conversationId: 'c1', message: 'a cat', model: 'HEPHAESTUS' },
      { apiUrlOverride: undefined, ...(o.signal ? { signal: o.signal } : {}) },
    )) {
      events += 1;
      const data = event.data as (Record<string, unknown> & { type?: string }) | undefined;
      if (!data || typeof data !== 'object') continue;
      switch (data.type) {
        case 'image':
          imageUrls.push(...(Array.isArray(data.urls) ? (data.urls as string[]) : []));
          if (typeof data.revisedPrompt === 'string') revisedPrompt = data.revisedPrompt;
          break;
        case 'error':
          errorMessage = String(data.message ?? 'Image generation failed');
          break;
        case 'done':
        default:
          break;
      }
    }
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  return {
    imageUrls,
    revisedPrompt,
    errorMessage,
    events,
    threw,
    userGetsImage: !errorMessage && imageUrls.length > 0 && threw === null,
    savedFile: imageUrls[0],
  };
}

describe('§F1 SPY-367 — a fault after a terminal event is not a dropped connection', () => {
  /**
   * ⭐⭐ C0 THE INSTRUMENT FIRST. Every assertion below is a claim about a REQUEST
   * COUNT and an ELAPSED TIME. If the counter cannot reach a number other than 1,
   * or the clock a number other than ~0, the arms that assert 1 are green over an
   * instrument that can only report green. This forces both to the dirty side with
   * a purely LEGITIMATE retry sequence, so it depends on no defect and cannot rot
   * when one is fixed.
   */
  test(
    'C0 THE INSTRUMENT FIRST: the request counter and the clock can both report dirty',
    async () => {
      nextResp = [okResp([TXT]), okResp([TXT]), okResp([TXT, DONE])];
      const { streamRequest } = await import('../src/lib/sse.js');
      const t0 = performance.now();
      const got: unknown[] = [];
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, { maxRetries: 2 })) {
        got.push(e.data);
      }
      const ms = performance.now() - t0;

      expect(callCount, 'the request counter never left 1 — the arms below would be vacuous').toBe(3);
      expect(ms, 'the clock never left ~0 — the elapsed bounds below would be vacuous').toBeGreaterThan(
        2_500,
      );
      expect(got.at(-1), 'the legitimate retry sequence did not complete').toEqual({ type: 'done' });
    },
    SLOW,
  );

  /**
   * ⭐⭐ C1 — THE FILED SHAPE IN THE PRODUCTION CALL SHAPE. A stream delivers a real
   * image and `done`, then the connection faults on the way out. Measured at 2
   * requests before the fix, with the image and `done` delivered TWICE (events=4).
   */
  test(
    'C1 a fault arriving AFTER done sends ONE request and delivers the stream ONCE',
    async () => {
      nextResp = [faultingResp([IMG_A, DONE], FAULT()), okResp([IMG_B, DONE])];
      const t0 = performance.now();
      const r = await drivePoliteImageConsumer();
      const ms = performance.now() - t0;

      expect(
        callCount,
        'a completed stream was reconnected because the catch path never consults the terminal ' +
          'state. On this path every retry is a FRESH PAID IMAGE GENERATION',
      ).toBe(1);
      expect(
        r.events,
        'the image and done were delivered more than once — a duplicate reached the consumer',
      ).toBe(2);
      expect(r.imageUrls, 'a duplicate image URL was collected').toEqual(['https://cdn/AAA.png']);
      expect(r.threw, 'a completed stream must not surface an error').toBeNull();
      expect(ms, 'the reconnect backoff still ran after a completed stream').toBeLessThan(TERMINAL_MS);
    },
    SLOW,
  );

  /**
   * ⭐⭐ C2 — THE THIRD EXIT PATH. The fault arrives after an application `error`.
   * `sawDone` is FALSE here, so a fix written with `&&`, or one that consults only
   * `sawDone`, passes C1 and fails this. Before the fix: a second PAID generation
   * against a server that had just refused the request.
   */
  test(
    'C2 a fault arriving AFTER an application error is also terminal',
    async () => {
      nextResp = [faultingResp([ERR], FAULT()), okResp([IMG_B, DONE])];
      const r = await drivePoliteImageConsumer();

      expect(
        callCount,
        'a refused stream was reconnected: the terminal check reads only `done`, or joins the two ' +
          'flags with && instead of ||',
      ).toBe(1);
      expect(r.errorMessage, 'the error event was not delivered to the consumer').toBe('quota exceeded');
      expect(
        r.imageUrls,
        'a paid image was generated after a refusal — and then discarded, because errorMessage is ' +
          'checked first and never cleared',
      ).toHaveLength(0);
    },
    SLOW,
  );

  /**
   * ⭐⭐ C3 — WHAT THE USER ACTUALLY GETS WHEN THE TWO IMAGES DIFFER. Before the fix
   * the user paid twice, received image A, had image B silently discarded, and was
   * shown B's revised prompt alongside A's file — an incoherent result, not merely
   * a wasteful one. `count` is forced to 1 at `image.ts:414`, so a second URL is
   * unambiguously the duplicate.
   */
  test(
    'C3 the user is charged once and the saved file and its revised prompt agree',
    async () => {
      nextResp = [faultingResp([IMG_A, DONE], FAULT()), okResp([IMG_B, DONE])];
      const r = await drivePoliteImageConsumer();

      expect(callCount, 'the user was charged for a second image generation').toBe(1);
      expect(r.savedFile, 'the wrong image was written to disk').toBe('https://cdn/AAA.png');
      expect(
        r.revisedPrompt,
        'the revised prompt shown to the user describes the DISCARDED image, not the file they got ' +
          '— revisedPrompt is last-write-wins at image.ts:256 and :484',
      ).toBe('rp-A');
      expect(r.userGetsImage, 'the user did not receive their image').toBe(true);
    },
    SLOW,
  );

  /**
   * ⭐⭐ C4 — THE OTHER SIDE'S COST. A mid-stream transport fault with NO terminal
   * event delivered must still reconnect and complete. A fix that swallows any
   * fault once any event has arrived, or that SETS a terminal flag inside the catch
   * branch, kills this one.
   */
  test(
    'C4 LEGITIMATE RETRY SURVIVES: a mid-stream fault with no terminal event still reconnects',
    async () => {
      nextResp = [faultingResp([TXT], new Error('ECONNRESET mid')), okResp([TXT, DONE])];
      const { streamRequest } = await import('../src/lib/sse.js');
      const got: unknown[] = [];
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, {})) got.push(e.data);

      expect(
        callCount,
        'the mid-stream transport retry was removed — a fault after partial delivery now stands. A ' +
          'fix that treats "we already delivered something" as terminal lands here',
      ).toBe(2);
      expect(got.at(-1), 'the reconnected stream did not complete').toEqual({ type: 'done' });
    },
    SLOW,
  );

  /**
   * ⭐⭐ C5 — THE IMAGE-DESTROYING VARIANT, AND THE ARM THAT FORCES THE GUARD'S
   * PLACEMENT. Three legitimate truncations exhaust the DEFAULT budget; the fourth
   * attempt delivers a real image and `done` and then faults. Before the fix the
   * catch path took its throw branch and the paid image was destroyed
   * (`USER_GETS_IMAGE=false`). A guard placed AFTER the `attempt >= maxRetries`
   * check — candidate C2 in the plant table — still fails this arm.
   */
  test(
    'C5 a completed stream is not destroyed when the retry budget is already exhausted',
    async () => {
      nextResp = [
        okResp([TXT]),
        okResp([TXT]),
        okResp([TXT]),
        faultingResp([IMG_A, DONE], FAULT()),
      ];
      const r = await drivePoliteImageConsumer();

      expect(
        r.threw,
        'a stream that delivered the image AND done still raised `Stream interrupted`, because the ' +
          'budget check runs before any terminal check. The user paid for that image and lost it',
      ).toBeNull();
      expect(r.userGetsImage, 'the paid, delivered image was destroyed by a post-completion fault').toBe(
        true,
      );
      expect(r.savedFile, 'the delivered image did not survive').toBe('https://cdn/AAA.png');
      expect(callCount, 'the three legitimate truncation retries must still have happened').toBe(4);
    },
    SLOW,
  );

  /**
   * ⭐ C6 — THE LATER-ATTEMPT LEG. A fix that consults the terminal state only on
   * the FIRST attempt passes C1 and fails here: attempt 1 truncates legitimately,
   * attempt 2 completes and then faults.
   */
  test(
    'C6 the terminal state is honoured when it was reached on a LATER attempt',
    async () => {
      nextResp = [okResp([TXT]), faultingResp([IMG_A, DONE], FAULT()), okResp([IMG_B, DONE])];
      const r = await drivePoliteImageConsumer();

      expect(
        callCount,
        'the terminal state was only consulted on the first attempt, so a legitimate retry that ' +
          'then completes and faults still burns another paid request',
      ).toBe(2);
      expect(r.imageUrls, 'a duplicate image was collected on the later attempt').toEqual([
        'https://cdn/AAA.png',
      ]);
    },
    SLOW,
  );

  /**
   * ⭐⭐ C7 — THE LEG A HALF-FIX SURVIVES. C1 passes no signal, so a fix written as
   * "terminate only when the caller supplied no signal of its own" would pass it
   * while leaving every site that DOES thread a signal exactly as before. This is
   * the hole F-15 found in its own corpus.
   */
  test(
    'C7 the fix holds when the caller ALSO threads a live signal through',
    async () => {
      const caller = new AbortController(); // live, never aborted — exactly chat.ts
      nextResp = [faultingResp([IMG_A, DONE], FAULT()), okResp([IMG_B, DONE])];
      const r = await drivePoliteImageConsumer({ signal: caller.signal });

      expect(
        callCount,
        'termination did not happen when the caller supplied its own signal — which is five of the ' +
          'seven production call sites, so the fix would be inert where it matters most',
      ).toBe(1);
      expect(caller.signal.aborted, "the fix aborted the CALLER'S own controller").toBe(false);
      expect(r.threw, 'a completed stream surfaced an error on the caller-signal path').toBeNull();
    },
    SLOW,
  );

  /**
   * ⭐⭐ C8 — THE STREAM IS NOT CUT SHORT. A fix that `return`s the moment it SEES a
   * terminal event stops delivering everything after it. Here an `error` is followed
   * by a real image and `done`, and then the connection faults: one request, and all
   * three events must still have reached the consumer.
   */
  test(
    'C8 events after a terminal event are still delivered, and the fault after them is ignored',
    async () => {
      nextResp = [faultingResp([ERR, IMG_A, DONE], FAULT()), okResp([IMG_B, DONE])];
      const r = await drivePoliteImageConsumer();

      expect(callCount, 'a stream that reached done was retried after its trailing fault').toBe(1);
      expect(
        r.events,
        'the fix returned as soon as it saw the terminal event and cut the stream short — events ' +
          'after one must still reach the consumer',
      ).toBe(3);
      expect(r.errorMessage, 'the error event was dropped').toBe('quota exceeded');
      expect(r.imageUrls, 'the image delivered after the error was dropped').toEqual([
        'https://cdn/AAA.png',
      ]);
    },
    SLOW,
  );

  /**
   * ⭐ C9 — A RAW FRAME IS NOT A TERMINAL EVENT. The payload of a malformed frame is
   * a STRING. A fix that treats "some data arrived" as terminal, or that reads
   * `.type` without the `typeof data === 'object' && data !== null` guard, stops
   * this legitimate retry.
   */
  test(
    'C9 LEGITIMATE RETRY SURVIVES: a raw frame then a fault still reconnects',
    async () => {
      nextResp = [faultingResp([`data: not-json\n\n`], new Error('ECONNRESET raw')), okResp([TXT, DONE])];
      const { streamRequest } = await import('../src/lib/sse.js');
      const got: unknown[] = [];
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, {})) got.push(e.data);

      expect(
        callCount,
        'a raw frame was mistaken for a terminal event, so a genuinely interrupted stream no longer ' +
          'reconnects',
      ).toBe(2);
      expect(got[0], 'the raw payload should surface as a string, unchanged').toBe('not-json');
      expect(got.at(-1), 'the reconnected stream did not complete').toEqual({ type: 'done' });
    },
    SLOW,
  );

  /**
   * ⭐⭐ C11 — CANCELLATION STILL OUTRANKS THE TERMINAL STATE, AND THIS ARM EXISTS
   * BECAUSE A PLANT PROVED IT HAD TO. Mutation M6 moves the new guard ABOVE the
   * abort check. It was proved applied and reddened NOTHING — not this corpus,
   * and not the full 1 772-test tree. A purpose-built discriminator then showed
   * it is not inert at all: with the caller's signal aborted after a terminal
   * event and the body then faulting, `Cancelled` becomes a silent clean end.
   *
   * So the ordering IS load-bearing and was, until this arm, entirely unpinned.
   * A user who hits Ctrl+C on a stream that has already delivered `done` must
   * still be told it was cancelled — that is SPY-360's contract, and RULE 11
   * requires it kept.
   */
  test(
    'C11 an abort still wins over the terminal state on the catch path',
    async () => {
      const caller = new AbortController();
      async function* gen(): AsyncGenerator<Buffer> {
        yield Buffer.from(IMG_A, 'utf8');
        yield Buffer.from(DONE, 'utf8');
        caller.abort(); // the user hits Ctrl+C after the stream completed
        throw new Error('ECONNRESET after done, post-abort');
      }
      nextResp = [
        { statusCode: 200, headers: {}, body: Readable.from(gen()) as unknown as MockBody },
        okResp([IMG_B, DONE]),
      ];

      const { streamRequest } = await import('../src/lib/sse.js');
      let threw: string | null = null;
      try {
        for await (const _e of streamRequest('/api/chat/stream', { m: 'x' }, { signal: caller.signal })) {
          /* keep iterating */
        }
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
      }

      expect(
        threw,
        'the terminal-state guard was placed ABOVE the abort check, so a cancelled run now ends ' +
          'silently instead of reporting `Cancelled` — SPY-360 s contract, unpinned until F-17',
      ).toBe('Cancelled');
      expect(callCount, 'a cancelled stream was reconnected').toBe(1);
    },
    SLOW,
  );

  /**
   * ⭐ C10 — the connect-time fault, which never reaches the event loop at all and
   * therefore never reaches the changed branch. Present so the claim "the other two
   * retry features are untouched" is measured rather than asserted.
   */
  test(
    'C10 LEGITIMATE RETRY SURVIVES: a connect-time transport error still reconnects',
    async () => {
      let n = 0;
      const undici = await import('undici');
      vi.mocked(undici.request).mockImplementation((async () => {
        n += 1;
        if (n === 1) throw new Error('ECONNRESET connect');
        return okResp([TXT, DONE]);
      }) as unknown as typeof undici.request);

      const { streamRequest } = await import('../src/lib/sse.js');
      const got: unknown[] = [];
      for await (const e of streamRequest('/api/chat/stream', { m: 'x' }, {})) got.push(e.data);

      expect(n, 'the transport-error retry was removed — a flaky connection now fails outright').toBe(2);
      expect(got.at(-1), 'the reconnected stream did not complete').toEqual({ type: 'done' });
    },
    SLOW,
  );
});
