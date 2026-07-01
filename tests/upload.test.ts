import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
}

let responder:
  | ((url: string, init: { method: string; body?: unknown; headers?: Record<string, string> }) => MockResp)
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(
    async (
      url: string,
      init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) => {
      if (!responder) throw new Error('test forgot to set responder');
      // Drain the body so the form-data stream actually emits all events.
      // The CLI's progress callback fires on data events on the underlying
      // file read stream that form-data wraps. Pipe to a black-hole sink
      // so form-data flows through naturally — attaching a `data` listener
      // alone causes form-data to lock its multi-part state machine.
      const body = init.body as NodeJS.ReadableStream | undefined;
      if (body && typeof (body as { pipe?: unknown }).pipe === 'function') {
        const { Writable } = await import('node:stream');
        const sink = new Writable({
          write(_chunk, _enc, cb) {
            cb();
          },
        });
        await new Promise<void>((resolve, reject) => {
          sink.on('finish', resolve);
          sink.on('error', reject);
          (body as NodeJS.ReadableStream).pipe(sink);
        });
      }
      return responder(url, {
        method: init.method ?? 'GET',
        body: init.body,
        headers: init.headers,
      });
    },
  ),
}));

let workDir: string;

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  workDir = mkdtempSync(join(tmpdir(), 'spycli-upload-'));
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function jsonResp(status: number, body: unknown): MockResp {
  return {
    statusCode: status,
    headers: {},
    body: { json: async () => body },
  };
}

describe('uploadFile helper', () => {
  test('streams a file and reports progress to completion', async () => {
    const file = join(workDir, 'sample.txt');
    const payload = Buffer.from('hello upload world'.repeat(100));
    writeFileSync(file, payload);

    responder = (url, init) => {
      expect(init.method).toBe('POST');
      expect(url).toContain('/api/files/upload');
      return jsonResp(201, {
        success: true,
        data: {
          id: 'file_abc',
          url: 'https://r2.example.com/file_abc',
          size: payload.length,
          filename: 'sample.txt',
          mimeType: 'text/plain',
          expiresAt: null,
        },
      });
    };

    const { uploadFile } = await import('../src/lib/upload.js');
    let lastLoaded = 0;
    let lastTotal = 0;
    const result = await uploadFile({
      path: file,
      url: 'https://api.example.com/api/files/upload',
      onProgress: (loaded, total) => {
        lastLoaded = loaded;
        lastTotal = total;
      },
    });
    expect(result.id).toBe('file_abc');
    expect(result.size).toBe(payload.length);
    expect(lastLoaded).toBe(payload.length);
    expect(lastTotal).toBe(payload.length);
  });

  test('413 maps to a friendly upgrade hint', async () => {
    const file = join(workDir, 'big.txt');
    writeFileSync(file, Buffer.alloc(64));

    responder = () =>
      jsonResp(413, { success: false, error: 'File too large. Max 100MB' });

    const { uploadFile } = await import('../src/lib/upload.js');
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    let caught: unknown = null;
    try {
      await uploadFile({
        path: file,
        url: 'https://api.example.com/api/files/upload',
      });
    } catch (err) {
      caught = err;
    }
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toContain('100MB');
      expect(caught.hint).toContain('Upgrade');
    }
  });

  test('415 surfaces the server error message', async () => {
    const file = join(workDir, 'thing.bin');
    writeFileSync(file, Buffer.alloc(8));

    responder = () =>
      jsonResp(415, { success: false, error: 'File type not allowed' });

    const { uploadFile } = await import('../src/lib/upload.js');
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    let caught: unknown = null;
    try {
      await uploadFile({
        path: file,
        url: 'https://api.example.com/api/files/upload',
      });
    } catch (err) {
      caught = err;
    }
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toContain('not allowed');
    }
  });

  test('non-existent file is rejected before any network call', async () => {
    const { uploadFile } = await import('../src/lib/upload.js');
    let caught: unknown = null;
    try {
      await uploadFile({
        path: join(workDir, 'does-not-exist.txt'),
        url: 'https://api.example.com/api/files/upload',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
  });
});

describe('files upload command', () => {
  let stdoutChunks: string[];
  let stderrChunks: string[];
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
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
  });

  afterEach(() => {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  });

  async function runCli(argv: string[], parentArgs: string[] = []): Promise<void> {
    const { Command } = await import('commander');
    const { registerFilesCommand } = await import('../src/commands/files/index.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: parentArgs.includes('--json'), color: false });
    const program = new Command();
    program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
    registerFilesCommand(program);
    await program.parseAsync([
      'node',
      'spycore',
      ...parentArgs,
      'files',
      ...argv,
    ]);
  }

  test('Free plan rejects upload locally without hitting upload endpoint', async () => {
    const file = join(workDir, 'tiny.txt');
    writeFileSync(file, 'x');

    let uploadHit = false;
    responder = (url) => {
      if (url.includes('/api/user/me')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'u_1', plan: 'FREE' },
        });
      }
      if (url.includes('/api/files/upload')) {
        uploadHit = true;
        return jsonResp(201, { success: true, data: {} });
      }
      throw new Error(`unexpected ${url}`);
    };

    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    let caught: unknown = null;
    try {
      await runCli(['upload', file]);
    } catch (err) {
      caught = err;
    }
    expect(isSpycoreCliError(caught)).toBe(true);
    expect(uploadHit).toBe(false);
  });

  test('Pro plan accepts and emits JSON when --json is set', async () => {
    const file = join(workDir, 'note.md');
    writeFileSync(file, '# hello world');

    responder = (url) => {
      if (url.includes('/api/user/me')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'u_1', plan: 'PRO' },
        });
      }
      if (url.includes('/api/files/upload')) {
        return jsonResp(201, {
          success: true,
          data: {
            id: 'file_xyz',
            url: 'https://r2.example.com/file_xyz',
            size: 13,
            filename: 'note.md',
            mimeType: 'text/markdown',
            expiresAt: null,
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    };

    await runCli(['upload', file], ['--json']);
    const out = stdoutChunks.join('').trim();
    const parsed = JSON.parse(out);
    expect(parsed.id).toBe('file_xyz');
    expect(parsed.mime).toBe('text/markdown');
  });

  test('M1: an untrusted --api-url host receives NO Authorization header (token not exfiltrated)', async () => {
    const file = join(workDir, 'note.md');
    writeFileSync(file, '# hi');
    const authByUrl: Record<string, string | undefined> = {};
    responder = (url, init) => {
      authByUrl[url] = init.headers?.authorization;
      if (url.includes('/user/me')) {
        return jsonResp(200, { success: true, data: { id: 'u_1', plan: 'PRO' } });
      }
      if (url.includes('/files/upload')) {
        return jsonResp(201, {
          success: true,
          data: { id: 'f1', url: 'x', size: 4, filename: 'note.md', mimeType: 'text/markdown', expiresAt: null },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runCli(['upload', file], ['--api-url', 'https://evil.example.com']);
    // Every request to the attacker host — the plan probe AND the upload — must
    // be token-free. This is the CL6 gate that was missed on `files upload` (M1).
    const urls = Object.keys(authByUrl);
    expect(urls.some((u) => u.includes('/files/upload'))).toBe(true);
    for (const [url, auth] of Object.entries(authByUrl)) {
      expect(auth, url).toBeUndefined();
    }
  });

  test('M1: a trusted (default) host DOES receive the Authorization header', async () => {
    const file = join(workDir, 'note.md');
    writeFileSync(file, '# hi');
    let uploadAuth: string | undefined = 'unset';
    responder = (url, init) => {
      if (url.includes('/user/me')) {
        return jsonResp(200, { success: true, data: { id: 'u_1', plan: 'PRO' } });
      }
      if (url.includes('/files/upload')) {
        uploadAuth = init.headers?.authorization;
        return jsonResp(201, {
          success: true,
          data: { id: 'f1', url: 'x', size: 4, filename: 'note.md', mimeType: 'text/markdown', expiresAt: null },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runCli(['upload', file]); // default apiUrl = api.spycore.ai (trusted)
    expect(uploadAuth).toMatch(/^Bearer /);
  });
});
