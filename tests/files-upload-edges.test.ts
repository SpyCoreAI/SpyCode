import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
}

let responder: ((url: string, init: { method: string; body?: unknown }) => MockResp) | null = null;
let capturedBody = '';

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    const body = init.body as NodeJS.ReadableStream | undefined;
    if (body && typeof (body as { pipe?: unknown }).pipe === 'function') {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          cb();
        },
      });
      await new Promise<void>((resolve, reject) => {
        sink.on('finish', resolve);
        sink.on('error', reject);
        (body as NodeJS.ReadableStream).pipe(sink);
      });
      capturedBody = Buffer.concat(chunks).toString('latin1');
    }
    return responder(url, { method: init.method ?? 'GET', body: init.body });
  }),
}));

function jsonResp(statusCode: number, body: unknown): MockResp {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: { json: async () => body } };
}

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origStdoutTty = (process.stdout as { isTTY?: boolean }).isTTY;
const origStdin = process.stdin;

function stdout(): string {
  return stdoutChunks.join('');
}
function allOut(): string {
  return stdoutChunks.join('') + stderrChunks.join('');
}

async function runCli(argv: string[], parentArgs: string[] = []): Promise<unknown> {
  const { Command } = await import('commander');
  const { registerFilesCommand } = await import('../src/commands/files/index.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerFilesCommand(program);
  let caught: unknown = null;
  try {
    await program.parseAsync(['node', 'spycore', ...parentArgs, 'files', ...argv]);
  } catch (e) {
    caught = e;
  }
  return caught;
}

function okUploadResponder(plan: string, uploadData: Record<string, unknown>) {
  return (url: string) => {
    if (url.includes('/api/user/me')) return jsonResp(200, { success: true, data: { id: 'u_1', plan } });
    if (url.includes('/api/files/upload')) return jsonResp(201, { success: true, data: uploadData });
    throw new Error(`unexpected ${url}`);
  };
}

let workDir: string;

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  capturedBody = '';
  workDir = mkdtempSync(join(tmpdir(), 'spycli-upload-edge-'));
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
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  (process.stdout as { isTTY?: boolean }).isTTY = origStdoutTty;
  Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('files upload edges', () => {
  test('bufferStdinToTempFile sanitizes an all-separator name to upload', async () => {
    const fakeStdin = Readable.from(['hello']);
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const { bufferStdinToTempFile } = await import('../src/commands/files/upload.js');
    const tmpPath = await bufferStdinToTempFile('///');
    expect(tmpPath).toContain('-upload');
    expect(readFileSync(tmpPath, 'utf8')).toBe('hello');
    rmSync(tmpPath, { force: true });
  });

  test('stdin upload reads the piped content as the file', async () => {
    const fakeStdin = Readable.from([Buffer.from('piped-data')]);
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    responder = okUploadResponder('PRO', {
      id: 'f_1',
      url: 'https://x/f_1',
      size: 10,
      mime: 'text/plain',
      filename: 'stdin',
      expiresAt: '2030-01-02T00:00:00.000Z',
    });
    const caught = await runCli(['upload', '-']);
    expect(caught).toBeNull();
    expect(allOut()).toContain('Uploaded stdin');
    expect(allOut()).toContain('Auto-expires at 2030-01-02');
  });

  test('--name overrides the remote filename', async () => {
    const file = join(workDir, 'local.txt');
    writeFileSync(file, 'hello');
    responder = okUploadResponder('PRO', {
      id: 'f_1',
      url: 'https://x/f_1',
      size: 5,
      mime: 'text/plain',
      filename: 'custom.txt',
    });
    const caught = await runCli(['upload', file, '--name', 'custom.txt']);
    expect(caught).toBeNull();
    expect(allOut()).toContain('Uploaded custom.txt');
  });

  test('a missing file errors before any network use', async () => {
    let hits = 0;
    responder = () => {
      hits += 1;
      return jsonResp(200, { success: true, data: {} });
    };
    const caught = (await runCli(['upload', join(workDir, 'nope.txt')])) as Error;
    expect(caught?.message).toMatch(/File not found/);
    expect(hits).toBe(0);
  });

  test('a directory errors as not a regular file', async () => {
    const dir = join(workDir, 'dir');
    mkdirSync(dir);
    const caught = (await runCli(['upload', dir])) as Error;
    expect(caught?.message).toMatch(/Not a regular file/);
  });

  test('a failing plan probe degrades to no local limit check', async () => {
    const file = join(workDir, 'tiny.txt');
    writeFileSync(file, 'x');
    responder = (url: string) => {
      if (url.includes('/api/user/me')) return jsonResp(500, { success: false, error: 'boom' });
      if (url.includes('/api/files/upload'))
        return jsonResp(201, { success: true, data: { id: 'f_1', url: 'https://x/f_1', size: 1, mime: 'text/plain', filename: 'tiny.txt' } });
      throw new Error(`unexpected ${url}`);
    };
    const caught = await runCli(['upload', file]);
    expect(caught).toBeNull();
    expect(allOut()).toContain('Uploaded tiny.txt');
  });

  test('a file over the paid-plan cap is rejected locally', async () => {
    const file = join(workDir, 'big.bin');
    writeFileSync(file, Buffer.alloc(21 * 1024 * 1024, 0x61));
    responder = okUploadResponder('PRO', {});
    const caught = (await runCli(['upload', file])) as Error;
    expect(caught?.message).toMatch(/the upload limit is 20 MB per file/);
  });

  test('--mime overrides the detected type in the multipart body', async () => {
    const file = join(workDir, 'note.txt');
    writeFileSync(file, 'hello');
    responder = okUploadResponder('PRO', {
      id: 'f_1',
      url: 'https://x/f_1',
      size: 5,
      mime: 'application/x-custom',
      filename: 'note.txt',
    });
    const caught = await runCli(['upload', file, '--mime', 'application/x-custom']);
    expect(caught).toBeNull();
    expect(capturedBody).toContain('application/x-custom');
  });

  test('a TTY upload drives the spinner to success', async () => {
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    const file = join(workDir, 'big.txt');
    writeFileSync(file, Buffer.alloc(1024 * 1024, 0x61));
    responder = okUploadResponder('PRO', {
      id: 'f_1',
      url: 'https://x/f_1',
      size: 1024 * 1024,
      mime: 'text/plain',
      filename: 'big.txt',
    });
    const caught = await runCli(['upload', file]);
    expect(caught).toBeNull();
    expect(allOut()).toContain('Uploaded big.txt');
  });

  test('a TTY upload failure fails the spinner and rethrows', async () => {
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    const file = join(workDir, 'tiny.txt');
    writeFileSync(file, 'x');
    responder = (url: string) => {
      if (url.includes('/api/user/me')) return jsonResp(200, { success: true, data: { id: 'u_1', plan: 'PRO' } });
      if (url.includes('/api/files/upload')) return jsonResp(500, { success: false, error: 'server blew up' });
      throw new Error(`unexpected ${url}`);
    };
    const caught = (await runCli(['upload', file])) as Error;
    expect(caught).not.toBeNull();
    expect(caught.message).toMatch(/server blew up/);
  });
});
