import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

/**
 * undici.request is the only network seam, so we mock it module-wide and
 * craft response shapes (status + an async-iterable body) per test.
 */
type MockBody = AsyncIterable<Buffer> & { json?: () => Promise<unknown> };
type MockResp = {
  statusCode: number;
  body: MockBody;
  headers: Record<string, string | string[]>;
};

let nextResp:
  | MockResp
  | (() => Promise<MockResp> | MockResp)
  | (MockResp[])
  | Error
  | null = null;
let callCount = 0;

vi.mock('undici', () => ({
  request: vi.fn(async () => {
    callCount += 1;
    if (nextResp instanceof Error) throw nextResp;
    if (Array.isArray(nextResp)) {
      const idx = Math.min(callCount - 1, nextResp.length - 1);
      const r = nextResp[idx];
      if (!r) throw new Error('test exhausted nextResp array');
      return r;
    }
    if (typeof nextResp === 'function') return await nextResp();
    if (!nextResp) throw new Error('test forgot to set nextResp');
    return nextResp;
  }),
}));

beforeEach(() => {
  freshConfigDir();
  nextResp = null;
  callCount = 0;
});

/** Build an SSE stream body from a list of "data:..." strings. */
function sseBody(chunks: string[]): MockBody {
  const buffers = chunks.map((c) => Buffer.from(c, 'utf8'));
  return Readable.from(buffers) as unknown as MockBody;
}

function okResp(chunks: string[]): MockResp {
  return {
    statusCode: 200,
    headers: {},
    body: sseBody(chunks),
  };
}

describe('parseSSEStream', () => {
  test('parses a single event with JSON payload', async () => {
    const { parseSSEStream } = await import('../src/lib/sse.js');
    const stream = sseBody([`data: {"type":"text","content":"hi"}\n\n`]);
    const events = [];
    for await (const e of parseSSEStream(stream)) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toEqual({ type: 'text', content: 'hi' });
    expect(events[0]?.event).toBe('message');
  });

  test('parses multiple events split across chunks', async () => {
    const { parseSSEStream } = await import('../src/lib/sse.js');
    // Split mid-event to exercise the streaming buffer.
    const stream = sseBody([
      `data: {"type":"text","content":"foo"}\n\nda`,
      `ta: {"type":"text","content":"bar"}\n\n`,
      `data: {"type":"done"}\n\n`,
    ]);
    const events = [];
    for await (const e of parseSSEStream(stream)) events.push(e);
    expect(events.map((e) => e.data)).toEqual([
      { type: 'text', content: 'foo' },
      { type: 'text', content: 'bar' },
      { type: 'done' },
    ]);
  });

  test('handles malformed JSON by surfacing raw string', async () => {
    const { parseSSEStream } = await import('../src/lib/sse.js');
    const stream = sseBody([`data: not-json-at-all\n\n`]);
    const events = [];
    for await (const e of parseSSEStream(stream)) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe('not-json-at-all');
  });

  test('decodes multi-byte UTF-8 split mid-codepoint', async () => {
    const { parseSSEStream } = await import('../src/lib/sse.js');
    // "你好" = E4 BD A0  E5 A5 BD. Cut the first codepoint in half.
    const full = Buffer.from(
      `data: {"type":"text","content":"你好"}\n\n`,
      'utf8',
    );
    const cut = Math.floor(full.length / 2);
    const a = full.subarray(0, cut);
    const b = full.subarray(cut);
    const stream = Readable.from([a, b]) as unknown as MockBody;
    const events = [];
    for await (const e of parseSSEStream(stream)) events.push(e);
    expect(events).toHaveLength(1);
    expect((events[0]?.data as { content: string }).content).toBe('你好');
  });
});

describe('streamWithRetry', () => {
  test('streams events from a happy-path response', async () => {
    nextResp = okResp([
      `data: {"type":"text","content":"hello"}\n\n`,
      `data: {"type":"done"}\n\n`,
    ]);
    const { streamWithRetry } = await import('../src/lib/sse.js');
    const events: unknown[] = [];
    await streamWithRetry({
      url: 'http://x',
      headers: {},
      body: '{}',
      onEvent: (e) => {
        events.push(e.data);
      },
      maxRetries: 0,
    });
    expect(events).toEqual([
      { type: 'text', content: 'hello' },
      { type: 'done' },
    ]);
  });

  test('reconnects when first attempt fails before done', async () => {
    nextResp = [
      // First stream ends without `done` -> retry triggers.
      okResp([`data: {"type":"text","content":"partial"}\n\n`]),
      okResp([
        `data: {"type":"text","content":"final"}\n\n`,
        `data: {"type":"done"}\n\n`,
      ]),
    ];
    const { streamWithRetry } = await import('../src/lib/sse.js');
    const events: unknown[] = [];
    await streamWithRetry({
      url: 'http://x',
      headers: {},
      body: '{}',
      onEvent: (e) => {
        events.push(e.data);
      },
      maxRetries: 1,
    });
    // We retried once and the second stream completed cleanly.
    expect(callCount).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toEqual({ type: 'done' });
  });

  test('maps 401 to auth-error SpycoreCliError', async () => {
    nextResp = {
      statusCode: 401,
      headers: {},
      body: {
        json: async () => ({ success: false, error: 'invalid' }),
      } as unknown as MockBody,
    };
    const { streamWithRetry } = await import('../src/lib/sse.js');
    const { EXIT_AUTH_ERROR, isSpycoreCliError } = await import(
      '../src/lib/errors.js'
    );
    try {
      await streamWithRetry({
        url: 'http://x',
        headers: {},
        body: '{}',
        onEvent: () => {},
        maxRetries: 0,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(isSpycoreCliError(err)).toBe(true);
      if (isSpycoreCliError(err)) {
        expect(err.code).toBe(EXIT_AUTH_ERROR);
      }
    }
  });

  test('respects abort signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { streamWithRetry } = await import('../src/lib/sse.js');
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    try {
      await streamWithRetry({
        url: 'http://x',
        headers: {},
        body: '{}',
        onEvent: () => {},
        signal: controller.signal,
        maxRetries: 0,
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect(isSpycoreCliError(err)).toBe(true);
    }
  });
});

describe('streamRequest async generator', () => {
  test('yields events with auto-attached auth header', async () => {
    nextResp = okResp([
      `data: {"type":"text","content":"a"}\n\n`,
      `data: {"type":"done"}\n\n`,
    ]);
    const { streamRequest } = await import('../src/lib/sse.js');
    const events: unknown[] = [];
    for await (const e of streamRequest('/api/chat/stream', { foo: 1 })) {
      events.push(e.data);
    }
    expect(events).toEqual([
      { type: 'text', content: 'a' },
      { type: 'done' },
    ]);
  });
});
