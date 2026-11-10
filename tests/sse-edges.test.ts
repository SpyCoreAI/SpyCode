import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

type MockBody = AsyncIterable<Buffer> & { json?: () => Promise<unknown> };
type MockResp = {
  statusCode: number;
  body: MockBody;
  headers: Record<string, string | string[]>;
};

let nextResp: MockResp | MockResp[] | Error | (() => MockResp | Error) | null = null;
let callCount = 0;
let seenRequests: Array<{ url: string; headers: Record<string, string> }> = [];

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, opts: { headers?: Record<string, string> }) => {
    callCount += 1;
    seenRequests.push({ url, headers: opts.headers ?? {} });
    if (typeof nextResp === 'function') {
      const r = nextResp();
      if (r instanceof Error) throw r;
      return r;
    }
    if (nextResp instanceof Error) throw nextResp;
    if (Array.isArray(nextResp)) {
      const idx = Math.min(callCount - 1, nextResp.length - 1);
      const r = nextResp[idx];
      if (!r) throw new Error('test exhausted nextResp array');
      return r;
    }
    if (!nextResp) throw new Error('test forgot to set nextResp');
    return nextResp;
  }),
}));

beforeEach(() => {
  freshConfigDir();
  nextResp = null;
  callCount = 0;
  seenRequests = [];
});

function sseBody(chunks: string[]): MockBody {
  return Readable.from(chunks.map((c) => Buffer.from(c, 'utf8'))) as unknown as MockBody;
}

function okResp(chunks: string[]): MockResp {
  return { statusCode: 200, headers: {}, body: sseBody(chunks) };
}

describe('parseSSEStream edges', () => {
  test('Uint8Array chunks are converted, and a split multi-byte tail is flushed', async () => {
    const { parseSSEStream } = await import('../src/lib/sse.js');
    const bytes = Uint8Array.from(Buffer.from('data: {"type":"text","content":"hi"}\n\n', 'utf8'));
    const events: unknown[] = [];
    for await (const e of parseSSEStream(Readable.from([bytes]) as never)) events.push(e);
    expect(events).toHaveLength(1);

    // Stream ends mid-UTF-8-sequence: the final decode flushes U+FFFD.
    const partial = Buffer.concat([
      Buffer.from('data: {"type":"text","content":"x', 'utf8'),
      Buffer.from([0xc3]),
    ]);
    const tailEvents: unknown[] = [];
    for await (const e of parseSSEStream(Readable.from([partial]) as never)) tailEvents.push(e);
    expect(tailEvents).toHaveLength(0);
  });

  test('a throwing destroy is swallowed', async () => {
    const { parseSSEStream } = await import('../src/lib/sse.js');
    const body = {
      async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
        yield Buffer.from('data: {"type":"text","content":"hi"}\n\n', 'utf8');
      },
      destroy(): void {
        throw new Error('destroy boom');
      },
    };
    const events: unknown[] = [];
    for await (const e of parseSSEStream(body as never)) events.push(e);
    expect(events).toHaveLength(1);
  });
});

describe('streamWithRetry edges', () => {
  test('a pre-aborted signal throws Cancelled before any request', async () => {
    const { streamWithRetry } = await import('../src/lib/sse.js');
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      streamWithRetry({ url: 'http://test.invalid/api/x', headers: {}, signal: ctl.signal, onEvent: () => {} }),
    ).rejects.toThrow('Cancelled');
    expect(callCount).toBe(0);
  });

  test('a connect fault with no retries left throws Cannot reach API', async () => {
    const { streamWithRetry } = await import('../src/lib/sse.js');
    nextResp = new Error('boom');
    await expect(
      streamWithRetry({ url: 'http://test.invalid/api/x', headers: {}, maxRetries: 0, onEvent: () => {} }),
    ).rejects.toThrow('Cannot reach API: boom');
  });

  test('an event id is sent back as last-event-id on retry', async () => {
    const { streamWithRetry } = await import('../src/lib/sse.js');
    nextResp = [
      okResp(['id: 42\ndata: {"type":"text","content":"hi"}\n\n']),
      okResp(['data: {"type":"done"}\n\n']),
    ];
    const seen: unknown[] = [];
    await streamWithRetry({
      url: 'http://test.invalid/api/x',
      headers: {},
      maxRetries: 3,
      onEvent: (e) => {
        seen.push(e);
      },
    });
    expect(seen).toHaveLength(2);
    expect(seenRequests).toHaveLength(2);
    expect(seenRequests[1]!.headers['last-event-id']).toBe('42');
  });

  test('a clean end without a terminal event and no budget returns', async () => {
    const { streamWithRetry } = await import('../src/lib/sse.js');
    nextResp = okResp(['data: {"type":"text","content":"hi"}\n\n']);
    const seen: unknown[] = [];
    await streamWithRetry({
      url: 'http://test.invalid/api/x',
      headers: {},
      maxRetries: 0,
      onEvent: (e) => {
        seen.push(e);
      },
    });
    expect(seen).toHaveLength(1);
  });

  test('a mid-stream fault with no budget left throws Stream interrupted', async () => {
    const { streamWithRetry } = await import('../src/lib/sse.js');
    const body = {
      async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
        yield Buffer.from('data: {"type":"text","content":"hi"}\n\n', 'utf8');
        throw new Error('mid');
      },
    };
    nextResp = { statusCode: 200, headers: {}, body: body as unknown as MockBody };
    await expect(
      streamWithRetry({ url: 'http://test.invalid/api/x', headers: {}, maxRetries: 0, onEvent: () => {} }),
    ).rejects.toThrow('Stream interrupted');
  });

  test('an abort that lands during a connect fault throws Cancelled', async () => {
    const { streamWithRetry } = await import('../src/lib/sse.js');
    const ctl = new AbortController();
    nextResp = () => {
      ctl.abort();
      return new Error('boom');
    };
    await expect(
      streamWithRetry({ url: 'http://test.invalid/api/x', headers: {}, signal: ctl.signal, onEvent: () => {} }),
    ).rejects.toThrow('Cancelled');
  });

  test('a non-Error connect fault stringifies, and a message-only 400 body maps', async () => {
    const { streamWithRetry } = await import('../src/lib/sse.js');
    nextResp = (() => {
      throw 'plain failure';
    }) as unknown as () => MockResp;
    await expect(
      streamWithRetry({ url: 'http://test.invalid/api/x', headers: {}, maxRetries: 0, onEvent: () => {} }),
    ).rejects.toThrow('Cannot reach API: plain failure');

    nextResp = {
      statusCode: 400,
      headers: {},
      body: {
        ...sseBody([]),
        json: async () => ({ message: 'bad input' }),
      },
    };
    await expect(
      streamWithRetry({ url: 'http://test.invalid/api/x', headers: {}, onEvent: () => {} }),
    ).rejects.toThrow('bad input');
  });

  test('an idle-timeout SpycoreCliError is rethrown, a string fault is wrapped', async () => {
    const { streamWithRetry } = await import('../src/lib/sse.js');
    const stalled = {
      async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
        await new Promise(() => {});
        yield Buffer.from('', 'utf8');
      },
    };
    nextResp = { statusCode: 200, headers: {}, body: stalled as unknown as MockBody };
    await expect(
      streamWithRetry({
        url: 'http://test.invalid/api/x',
        headers: {},
        maxRetries: 0,
        idleTimeoutMs: 50,
        onEvent: () => {},
      }),
    ).rejects.toThrow(/stalled/);

    const stringFault = {
      async *[Symbol.asyncIterator](): AsyncIterator<Buffer> {
        yield Buffer.from('data: {"type":"text","content":"hi"}\n\n', 'utf8');
        throw 'oops-string' as never;
      },
    };
    nextResp = { statusCode: 200, headers: {}, body: stringFault as unknown as MockBody };
    await expect(
      streamWithRetry({ url: 'http://test.invalid/api/x', headers: {}, maxRetries: 0, onEvent: () => {} }),
    ).rejects.toThrow('Stream interrupted: oops-string');
  });

  test('a 429 with retry-after carries the retry hint', async () => {
    const { streamWithRetry } = await import('../src/lib/sse.js');
    nextResp = {
      statusCode: 429,
      headers: { 'retry-after': '30' },
      body: {
        ...sseBody([]),
        json: async () => ({ error: 'slow down' }),
      },
    };
    let caught: unknown;
    try {
      await streamWithRetry({ url: 'http://test.invalid/api/x', headers: {}, onEvent: () => {} });
    } catch (err) {
      caught = err;
    }
    expect((caught as { hint?: string }).hint).toBe('Retry after 30s.');
  });

  test('a 429 without retry-after falls back to the generic hint', async () => {
    const { streamWithRetry } = await import('../src/lib/sse.js');
    nextResp = {
      statusCode: 429,
      headers: {},
      body: {
        ...sseBody([]),
        json: async () => ({ error: 'slow down' }),
      },
    };
    let caught: unknown;
    try {
      await streamWithRetry({ url: 'http://test.invalid/api/x', headers: {}, onEvent: () => {} });
    } catch (err) {
      caught = err;
    }
    expect((caught as { hint?: string }).hint).toBe('Wait a moment and try again.');
  });

  test('a non-JSON 400 body maps to HTTP 400, and 429 maps to rate limit', async () => {
    const { streamWithRetry } = await import('../src/lib/sse.js');
    nextResp = {
      statusCode: 400,
      headers: {},
      body: {
        ...sseBody([]),
        json: async () => {
          throw new Error('not json');
        },
      },
    };
    await expect(
      streamWithRetry({ url: 'http://test.invalid/api/x', headers: {}, onEvent: () => {} }),
    ).rejects.toThrow('HTTP 400');

    nextResp = {
      statusCode: 429,
      headers: { 'retry-after': '30' },
      body: {
        ...sseBody([]),
        json: async () => ({ error: 'slow down' }),
      },
    };
    await expect(
      streamWithRetry({ url: 'http://test.invalid/api/x', headers: {}, onEvent: () => {} }),
    ).rejects.toThrow('Rate limit exceeded: slow down');
  });
});

describe('streamRequest edges', () => {
  test('a path without a leading slash is prefixed', async () => {
    const { streamRequest } = await import('../src/lib/sse.js');
    nextResp = okResp(['data: {"type":"done"}\n\n']);
    const events: unknown[] = [];
    for await (const e of streamRequest('chat/stream', {}, { apiUrlOverride: 'http://test.invalid' })) {
      events.push(e);
    }
    expect(events).toHaveLength(1);
    expect(seenRequests[0]!.url).toBe('http://test.invalid/api/chat/stream');
  });

  test('events queued while the consumer is slow drain through the done break', async () => {
    const { streamRequest } = await import('../src/lib/sse.js');
    nextResp = okResp([
      'data: {"type":"text","content":"one"}\n\ndata: {"type":"text","content":"two"}\n\ndata: {"type":"done"}\n\n',
    ]);
    const gen = streamRequest('chat/stream', {}, { apiUrlOverride: 'http://test.invalid' });
    const first = await gen.next();
    expect(first.done).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    const rest: unknown[] = [];
    for await (const e of gen) rest.push(e);
    expect(rest.length).toBeGreaterThanOrEqual(2);
  });
});

describe('readCappedJson', () => {
  test('parses a small streamed body', async () => {
    const { readCappedJson } = await import('../src/lib/sse.js');
    async function* gen(): AsyncGenerator<Buffer> {
      yield Buffer.from('{"error":', 'utf8');
      yield Buffer.from('"boom"}', 'utf8');
    }
    await expect(readCappedJson(gen())).resolves.toEqual({ error: 'boom' });
  });

  test('returns null past the 1 MiB cap', async () => {
    const { readCappedJson } = await import('../src/lib/sse.js');
    async function* gen(): AsyncGenerator<Buffer> {
      yield Buffer.alloc(600_000, 0x61);
      yield Buffer.alloc(600_000, 0x61);
    }
    await expect(readCappedJson(gen())).resolves.toBeNull();
  });

  test('falls back to .json() for non-streaming bodies', async () => {
    const { readCappedJson } = await import('../src/lib/sse.js');
    await expect(readCappedJson({ json: async () => ({ ok: true }) })).resolves.toEqual({
      ok: true,
    });
    await expect(readCappedJson({ json: async () => { throw new Error('bad'); } })).resolves.toBeNull();
  });
});

describe('parseSSEStream drains many events in order', () => {
  test('500 events in one chunk all arrive, in order', async () => {
    const { parseSSEStream } = await import('../src/lib/sse.js');
    const chunk = Array.from({ length: 500 }, (_, i) => `data: {"n":${i}}\n\n`).join('');
    const events: unknown[] = [];
    for await (const e of parseSSEStream(Readable.from([Buffer.from(chunk, 'utf8')]) as never)) {
      events.push(e);
    }
    expect(events).toHaveLength(500);
    expect((events[499] as { data: { n: number } }).data.n).toBe(499);
  });
});
