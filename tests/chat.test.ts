import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

/**
 * The chat command sends a few HTTP requests:
 *   1. GET /api/auth/cli/whoami (via isAuthenticated check) — but isAuthenticated
 *      only checks token storage, no network. So we just set a stored token.
 *   2. GET /api/conversations/:id (when --conversation is passed)  → JSON
 *   3. POST /api/conversations (otherwise) → JSON
 *   4. POST /api/chat/stream → SSE
 *
 * We mock undici so the same responder serves all four. The responder
 * inspects the URL/method to pick the right shape.
 */

type MockBody = (AsyncIterable<Buffer> & { json?: () => Promise<unknown> })
  | { json: () => Promise<unknown> };

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: MockBody;
}

let responder:
  | ((url: string, init: { method: string; headers: Record<string, string>; body?: string | Buffer }) => MockResp)
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
    });
  }),
}));

// Spy on stdout / stderr so we can assert on what the command printed.
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  stdoutChunks = [];
  stderrChunks = [];
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  // Provide a fake stored token so isAuthenticated() returns true. The
  // file-backed storage path is sufficient — keytar is a soft dep we
  // don't need for tests.
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  vi.resetModules();
});

function jsonResp(status: number, body: unknown): MockResp {
  return {
    statusCode: status,
    headers: {},
    body: { json: async () => body },
  };
}

function sseResp(chunks: string[]): MockResp {
  const buffers = chunks.map((c) => Buffer.from(c, 'utf8'));
  return {
    statusCode: 200,
    headers: {},
    body: Readable.from(buffers) as unknown as MockBody,
  };
}

function stdout(): string {
  return stdoutChunks.join('');
}

function stderr(): string {
  return stderrChunks.join('');
}

async function runChat(argv: string[]): Promise<void> {
  // Build a Commander program identical to the production wiring but
  // without `process.exit` side effects. Re-import after vi.resetModules
  // so each test gets a fresh module graph (chalk in particular).
  const { Command } = await import('commander');
  const { registerChatCommand } = await import('../src/commands/chat.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: argv.includes('--json'), color: false });

  const program = new Command();
  program
    .name('spycore')
    .option('--api-url <url>')
    .option('--json')
    .option('--no-color');
  registerChatCommand(program);
  await program.parseAsync(['node', 'spycore', ...argv]);
}

describe('chat command', () => {
  test('one-shot mode renders streamed text from /api/chat/stream', async () => {
    responder = (url, init) => {
      if (url.endsWith('/conversations') && init.method === 'POST') {
        return jsonResp(201, {
          success: true,
          data: { id: 'cnv_1', title: 'New', model: 'HERMES' },
        });
      }
      if (url.endsWith('/api/chat/stream')) {
        return sseResp([
          `data: {"type":"text","content":"Hello "}\n\n`,
          `data: {"type":"text","content":"world"}\n\n`,
          `data: {"type":"done"}\n\n`,
        ]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };

    await runChat(['--no-color', 'chat', '--raw', 'Hi there']);
    expect(stdout()).toContain('Hello world');
  });

  test('--json mode emits one JSON event per line', async () => {
    responder = (url, init) => {
      if (url.endsWith('/conversations') && init.method === 'POST') {
        return jsonResp(201, {
          success: true,
          data: { id: 'cnv_1', title: 'New', model: 'HERMES' },
        });
      }
      if (url.endsWith('/api/chat/stream')) {
        return sseResp([
          `data: {"type":"text","content":"hi"}\n\n`,
          `data: {"type":"usage","input":1,"output":1}\n\n`,
          `data: {"type":"done"}\n\n`,
        ]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };

    await runChat(['--json', 'chat', 'hi']);
    const lines = stdout().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      // Every line must be parseable JSON.
      expect(() => JSON.parse(line)).not.toThrow();
    }
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain('chunk');
    expect(types).toContain('usage');
    expect(types).toContain('done');
  });

  /**
   * ⭐⭐ F-14 — THIS DEADLINE IS SIZED FROM THE PRODUCT'S OWN ARITHMETIC, NOT FROM LOAD.
   *
   * Measured across every `CLI Build` leg at four shas: 7 031 / 7 040 / 7 048 /
   * 7 060 / 7 093 / 7 114 / 7 139 ms — a same-leg swing of **1.01x** and a
   * cross-leg swing of 1.02x. A cost that does not move with hardware is a
   * TIMER, not work, so the 7.39x load factor measured elsewhere in this suite
   * does not apply here and a generous deadline would be unjustified.
   *
   * The 7 s was `streamWithRetry`'s backoff: an application-level `error` event
   * did not set `sawDone`, so the stream ending after it was read as a
   * mid-stream disconnect and retried — `1 000 + 2 000 + 4 000 = 7 000 ms`, and
   * 4 requests to `/api/chat/stream` for one error (measured, not inferred).
   * That was filed as a product defect; it was deliberately NOT pinned here,
   * because pinning a defect is how it becomes permanent.
   *
   * ⭐⭐ F-15 — THAT DEFECT IS NOW FIXED (`SPY-360`), AND THIS TEST COSTS ~30 ms.
   * `streamRequest` cancels its retry loop when the consumer abandons it, and
   * the backoff is abort-aware, so this arm now issues **1 request** and returns
   * immediately. F-14 predicted exactly this — "if it is ever repaired that test
   * drops to ~30 ms and the 20 s deadline becomes slack but harmless."
   *
   * ⭐ THE DEADLINE IS KEPT, DELIBERATELY. It is a pinned member of the measured
   * deadline class (`tests/test-deadline-class.test.ts` MEMBERS), and removing
   * it would be the same edit as never having added it. It is now slack rather
   * than load-bearing, and that is recorded here rather than left to look like
   * an oversight. The live control for the retry behaviour is
   * `tests/sse-cancel-on-abandon.test.ts`, which counts requests and elapsed
   * time directly instead of inferring them from a deadline.
   */
  test('error event surfaces as SpycoreCliError', { timeout: 20_000 }, async () => {
    responder = (url, init) => {
      if (url.endsWith('/conversations') && init.method === 'POST') {
        return jsonResp(201, {
          success: true,
          data: { id: 'cnv_1', title: 'New', model: 'HERMES' },
        });
      }
      if (url.endsWith('/api/chat/stream')) {
        return sseResp([
          `data: {"type":"error","message":"quota exceeded"}\n\n`,
        ]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };

    let caught: unknown = null;
    try {
      await runChat(['--no-color', 'chat', '--raw', 'hi']);
    } catch (err) {
      caught = err;
    }
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toContain('quota exceeded');
    }
  });

  test('rejects unknown model with helpful hint', async () => {
    let caught: unknown = null;
    try {
      await runChat(['chat', '--model', 'fakemodel', 'hi']);
    } catch (err) {
      caught = err;
    }
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toContain('Unknown model');
    }
  });

  test('hephaestus model returns deferred-feature error', async () => {
    let caught: unknown = null;
    try {
      await runChat(['chat', '--model', 'hephaestus', 'draw a cat']);
    } catch (err) {
      caught = err;
    }
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    expect(isSpycoreCliError(caught)).toBe(true);
  });

  test('skills_activated event is surfaced — human mode to stderr, JSON mode as a line', async () => {
    responder = (url, init) => {
      if (url.endsWith('/conversations') && init.method === 'POST') {
        return jsonResp(201, {
          success: true,
          data: { id: 'cnv_1', title: 'New', model: 'HERMES' },
        });
      }
      if (url.endsWith('/api/chat/stream')) {
        return sseResp([
          `data: {"type":"skills_activated","skills":["react-modern","typescript-strict"],"timestamp":1700000000,"cacheHit":false}\n\n`,
          `data: {"type":"text","content":"ok"}\n\n`,
          `data: {"type":"done"}\n\n`,
        ]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };

    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    const err = stderr();
    expect(err).toContain('Skills used:');
    expect(err).toContain('react-modern');
    expect(err).toContain('typescript-strict');
  });

  test('skills_activated event in --json mode emits a structured line', async () => {
    responder = (url, init) => {
      if (url.endsWith('/conversations') && init.method === 'POST') {
        return jsonResp(201, {
          success: true,
          data: { id: 'cnv_1', title: 'New', model: 'HERMES' },
        });
      }
      if (url.endsWith('/api/chat/stream')) {
        return sseResp([
          `data: {"type":"skills_activated","skills":["react-modern"],"timestamp":1700000000,"cacheHit":true}\n\n`,
          `data: {"type":"text","content":"ok"}\n\n`,
          `data: {"type":"done"}\n\n`,
        ]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };

    await runChat(['--json', 'chat', 'hi']);
    const lines = stdout().split('\n').filter(Boolean);
    const types = lines.map((l) => (JSON.parse(l) as { type: string }).type);
    expect(types).toContain('skills_activated');
    const activated = lines
      .map((l) => JSON.parse(l) as { type: string; skills?: unknown })
      .find((e) => e.type === 'skills_activated');
    expect(activated?.skills).toEqual(['react-modern']);
  });

  test('--no-stream renders the full response after streaming finishes', async () => {
    responder = (url, init) => {
      if (url.endsWith('/conversations') && init.method === 'POST') {
        return jsonResp(201, {
          success: true,
          data: { id: 'cnv_1', title: 'New', model: 'HERMES' },
        });
      }
      if (url.endsWith('/api/chat/stream')) {
        return sseResp([
          `data: {"type":"text","content":"# Heading\\n"}\n\n`,
          `data: {"type":"text","content":"body line\\n"}\n\n`,
          `data: {"type":"done"}\n\n`,
        ]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };

    await runChat(['--no-color', 'chat', '--no-stream', 'render']);
    expect(stdout()).toContain('Heading');
    expect(stdout()).toContain('body line');
  });

  test('not-logged-in path errors with the login hint', async () => {
    const { clearStoredTokenInFile } = await import('../src/lib/config.js');
    clearStoredTokenInFile();

    let caught: unknown = null;
    try {
      await runChat(['chat', 'hi']);
    } catch (err) {
      caught = err;
    }
    const { isSpycoreCliError, EXIT_AUTH_ERROR } = await import(
      '../src/lib/errors.js'
    );
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.code).toBe(EXIT_AUTH_ERROR);
    }
  });

});
