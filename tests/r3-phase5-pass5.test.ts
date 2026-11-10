/**
 * R3-18 / R3-19 / R3-20 / R3-21 (phase 5, pass 5): REAL tests, mocked
 * transport only (undici `request`, like tests/api.test.ts and
 * tests/files-readonly.test.ts). No live server; the live built-CLI
 * probes for the same cases are in the fix log.
 *
 * R3-18: a `{success:true, data:null}` envelope used to sail through
 * apiRequest and crash each caller with a raw TypeError. The central fix
 * throws `unexpectedServerResponse` in apiRequest instead.
 * R3-19: `usage` crashed on a non-string server `plan`
 * (`data.plan.toLowerCase()` unguarded).
 * R3-20: `capVersion` in update-banner.ts sliced a surrogate pair on a
 * poisoned registry version.
 * R3-21: `files download` skipped size verification on a non-numeric
 * server `size`, saving a truncated delivery as complete.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir, isR2Url } from './helpers.js';
import { EXIT_SERVER_ERROR, isSpycoreCliError } from '../src/lib/errors.js';
import { runCompactFlow, type CompactFlowIo } from '../src/lib/slash/compact-flow.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: {
    json: () => Promise<unknown>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
  };
}

let responder: ((url: string, init: { method: string }) => MockResp) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET' });
  }),
}));

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
let workDir = '';

function stdout(): string {
  return stdoutChunks.join('');
}
function stderr(): string {
  return stderrChunks.join('');
}

function jsonResp(status: number, body: unknown): MockResp {
  return {
    statusCode: status,
    headers: {},
    body: { json: async () => body },
  };
}

function streamResp(buf: Buffer): MockResp {
  return {
    statusCode: 200,
    headers: {},
    body: {
      json: async () => ({}),
      arrayBuffer: async () =>
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
      [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator](),
    },
  };
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return true;
      const next = s.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function runFilesCli(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerFilesCommand } = await import('../src/commands/files/index.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: false, color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerFilesCommand(program);
  await program.parseAsync(['node', 'spycore', 'files', ...argv]);
}

async function runUsageCli(argv: string[] = ['usage']): Promise<void> {
  const { Command } = await import('commander');
  const { registerUsageCommand } = await import('../src/commands/usage.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: false, color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerUsageCommand(program);
  await program.parseAsync(['node', 'spycore', ...argv]);
}

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  stdoutChunks = [];
  stderrChunks = [];
  workDir = mkdtempSync(join(tmpdir(), 'r3-p5-'));
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  vi.resetModules();
  rmSync(workDir, { recursive: true, force: true });
});

// ═══ R3-18: null success envelope ═══
describe('R3-18 null success envelope', () => {
  test('api.get with data:null fails cleanly instead of returning null', async () => {
    responder = () => jsonResp(200, { success: true, data: null });
    const { api } = await import('../src/lib/api.js');
    let caught: unknown = null;
    try {
      await api.get('/api/files', { anonymous: true });
    } catch (err) {
      caught = err;
    }
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.code).toBe(EXIT_SERVER_ERROR);
      expect(caught.message).toMatch(/Unexpected server response/);
    }
  });

  test('api.get with data absent fails cleanly too', async () => {
    responder = () => jsonResp(200, { success: true });
    const { api } = await import('../src/lib/api.js');
    await expect(api.get('/api/files', { anonymous: true })).rejects.toThrow(
      /Unexpected server response/,
    );
  });

  test('api.get with a valid envelope still resolves (control)', async () => {
    responder = () => jsonResp(200, { success: true, data: { files: [] } });
    const { api } = await import('../src/lib/api.js');
    await expect(api.get('/api/files', { anonymous: true })).resolves.toEqual({ files: [] });
  });

  test('fire-and-forget calls may opt out: DELETE with no data resolves', async () => {
    responder = () => jsonResp(200, { success: true });
    const { api } = await import('../src/lib/api.js');
    await expect(
      api.delete('/api/files/f1', { anonymous: true, allowEmptyData: true }),
    ).resolves.toBeUndefined();
  });

  test('DELETE with data:null and no opt-out still fails cleanly', async () => {
    responder = () => jsonResp(200, { success: true, data: null });
    const { api } = await import('../src/lib/api.js');
    await expect(api.delete('/api/files/f1', { anonymous: true })).rejects.toThrow(
      /Unexpected server response/,
    );
  });

  test('/compact never throws on a null summarize envelope (its own contract)', async () => {
    responder = (url) => {
      if (url.includes('/summarize')) return jsonResp(200, { success: true, data: null });
      throw new Error(`unexpected ${url}`);
    };
    const notices: [string, string][] = [];
    const ioObj: CompactFlowIo = {
      notify: (kind, text) => {
        notices.push([kind, text]);
      },
      ask: async () => 'y',
    };
    const out = await runCompactFlow({ conversationId: 'c1', io: ioObj });
    expect(out).toEqual({ compacted: false });
    const err = notices.find(([k]) => k === 'error');
    expect(err).toBeDefined();
    expect(err![1]).toMatch(/Unexpected server response/);
  });
});

// ═══ R3-19: usage with a non-string server plan ═══
describe('R3-19 usage with a non-string plan', () => {
  test('plan:42 with a string planDisplay renders instead of crashing', async () => {
    responder = (url) => {
      if (url.includes('/api/usage')) {
        return jsonResp(200, { success: true, data: { plan: 42, planDisplay: 'Pro' } });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runUsageCli(['usage']);
    expect(stdout()).toContain('Plan: Pro');
  });

  test('a non-string planDisplay renders instead of crashing', async () => {
    responder = (url) => {
      if (url.includes('/api/usage')) {
        return jsonResp(200, { success: true, data: { plan: 'PRO', planDisplay: 42 } });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runUsageCli(['usage']);
    expect(stdout()).toContain('Plan:');
  });

  test('differing string plan/planDisplay still shows the raw plan tail (control)', async () => {
    responder = (url) => {
      if (url.includes('/api/usage')) {
        return jsonResp(200, { success: true, data: { plan: 'STARTER', planDisplay: 'Pro' } });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runUsageCli(['usage']);
    expect(stdout()).toContain('Plan: Pro  (STARTER)');
  });
});

// ═══ R3-20: capVersion splits a surrogate pair ═══
describe('R3-20 update banner capVersion', () => {
  async function renderBanner(current: string, latest: string): Promise<string> {
    const ttyBefore = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const ciBefore = process.env.CI;
    const noUpdBefore = process.env.SPYCORE_NO_UPDATE_CHECK;
    delete process.env.CI;
    delete process.env.SPYCORE_NO_UPDATE_CHECK;
    stderrChunks = [];
    try {
      const { __setPendingForTests, flushUpdateBanner } = await import(
        '../src/lib/update-banner.js'
      );
      __setPendingForTests({ current, latest });
      flushUpdateBanner();
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: ttyBefore, configurable: true });
      if (ciBefore !== undefined) process.env.CI = ciBefore;
      if (noUpdBefore !== undefined) process.env.SPYCORE_NO_UPDATE_CHECK = noUpdBefore;
    }
    return stderr();
  }

  test('a poisoned version with an astral char at the cut renders no lone surrogate', async () => {
    const poisoned = 'x'.repeat(14) + '😀' + 'y'.repeat(10);
    const err = await renderBanner('1.0.0', poisoned);
    expect(hasLoneSurrogate(err)).toBe(false);
    expect(err).toContain('x'.repeat(14));
  });

  test('plain ASCII versions still render whole (control)', async () => {
    const err = await renderBanner('0.9.9', '0.9.10');
    expect(hasLoneSurrogate(err)).toBe(false);
    expect(err).toContain('0.9.9');
    expect(err).toContain('0.9.10');
  });
});

// ═══ R3-21: files download size verification ═══
describe('R3-21 files download size verification', () => {
  function downloadResponder(size: unknown, body: Buffer) {
    return (url: string, init: { method: string }) => {
      if (init.method === 'GET' && url.includes('/api/files/f1')) {
        return jsonResp(200, {
          success: true,
          data: {
            id: 'f1',
            filename: 'dl-size.bin',
            mimeType: 'text/plain',
            size,
            url: 'https://r2.example.com/dl-size.bin?sig=abc',
            createdAt: new Date().toISOString(),
          },
        });
      }
      if (isR2Url(url)) return streamResp(body);
      throw new Error(`unexpected ${init.method} ${url}`);
    };
  }

  test("size:'abc' + truncated body is refused and no file is saved", async () => {
    responder = downloadResponder('abc', Buffer.from('he'));
    const out = join(workDir, 'dl-size.bin');
    await expect(
      runFilesCli(['download', 'f1', '--output', out, '--force']),
    ).rejects.toThrow(/Unexpected server response.*non-numeric size/);
    expect(existsSync(out)).toBe(false);
  });

  test("size:'5' (numeric string) is refused up front, not coerced", async () => {
    responder = downloadResponder('5', Buffer.from('he'));
    const out = join(workDir, 'dl-size.bin');
    await expect(
      runFilesCli(['download', 'f1', '--output', out, '--force']),
    ).rejects.toThrow(/Unexpected server response.*non-numeric size/);
    expect(existsSync(out)).toBe(false);
  });

  test('size:0 + a non-empty body is refused (declared empty, delivered bytes)', async () => {
    responder = downloadResponder(0, Buffer.from('hello'));
    const out = join(workDir, 'dl-size.bin');
    await expect(
      runFilesCli(['download', 'f1', '--output', out, '--force']),
    ).rejects.toThrow(/Download incomplete: received 5 B of 0 B/);
    expect(existsSync(out)).toBe(false);
  });

  test('size:5 + full 5-byte body still saves (control)', async () => {
    responder = downloadResponder(5, Buffer.from('hello'));
    const out = join(workDir, 'dl-size.bin');
    await runFilesCli(['download', 'f1', '--output', out, '--force']);
    expect(existsSync(out)).toBe(true);
  });
});
