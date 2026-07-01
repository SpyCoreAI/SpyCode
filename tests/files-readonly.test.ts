import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: {
    json: () => Promise<unknown>;
    arrayBuffer?: () => Promise<ArrayBuffer>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
  };
}

let responder:
  | ((url: string, init: { method: string }) => MockResp)
  | null = null;

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

function stdout(): string {
  return stdoutChunks.join('');
}

async function runCli(argv: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerFilesCommand } = await import(
    '../src/commands/files/index.js'
  );
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

describe('files list', () => {
  test('renders a table of files', async () => {
    responder = (url) => {
      if (url.includes('/api/files?')) {
        return jsonResp(200, {
          success: true,
          data: {
            files: [
              {
                id: 'file_aaaa1111bbbb2222',
                filename: 'report.pdf',
                mimeType: 'application/pdf',
                size: 1_234_567,
                createdAt: new Date(Date.now() - 60_000).toISOString(),
              },
              {
                id: 'file_cccc3333dddd4444',
                filename: 'chart.png',
                mimeType: 'image/png',
                size: 42_000,
                createdAt: new Date(Date.now() - 5_000).toISOString(),
              },
            ],
            total: 2,
            page: 1,
            pageSize: 50,
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runCli(['list']);
    const out = stdout();
    expect(out).toContain('report.pdf');
    expect(out).toContain('chart.png');
    expect(out).toContain('PDF');
    expect(out).toContain('PNG');
    expect(out).toContain('1.2 MB');
  });

  test('--json mode emits raw payload', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          files: [
            {
              id: 'file_1',
              filename: 'a.md',
              mimeType: 'text/markdown',
              size: 100,
              createdAt: new Date().toISOString(),
            },
          ],
          total: 1,
          page: 1,
          pageSize: 50,
        },
      });
    await runCli(['list'], ['--json']);
    const out = stdout().trim();
    const parsed = JSON.parse(out);
    expect(parsed.files).toHaveLength(1);
    expect(parsed.files[0].id).toBe('file_1');
  });

  test('empty list prints a friendly placeholder', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: { files: [], total: 0, page: 1, pageSize: 50 },
      });
    await runCli(['list']);
    expect(stdout()).toContain('(no files yet)');
  });

  test('--page <n> sends page=<n> and footers when more pages remain', async () => {
    let observedUrl = '';
    responder = (url) => {
      observedUrl = url;
      return jsonResp(200, {
        success: true,
        data: {
          files: [
            {
              id: 'file_pg2',
              filename: 'on-page-2.pdf',
              mimeType: 'application/pdf',
              size: 2_048,
              createdAt: new Date().toISOString(),
            },
          ],
          total: 120,
          page: 2,
          pageSize: 50,
        },
      });
    };
    await runCli(['list', '--page', '2']);
    expect(observedUrl).toContain('page=2');
    expect(stdout()).toContain('(more available — use --page 3)');
  });
});

describe('files show', () => {
  test('prints metadata block', async () => {
    responder = (url) => {
      if (url.includes('/api/files/file_1')) {
        return jsonResp(200, {
          success: true,
          data: {
            id: 'file_1',
            filename: 'doc.md',
            mimeType: 'text/markdown',
            size: 512,
            createdAt: new Date().toISOString(),
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runCli(['show', 'file_1']);
    const out = stdout();
    expect(out).toContain('ID:');
    expect(out).toContain('file_1');
    expect(out).toContain('doc.md');
    expect(out).toContain('MD (text/markdown)');
  });

  test('404 surfaces a friendly hint', async () => {
    responder = () => jsonResp(404, { success: false, error: 'Not found' });
    let caught: unknown = null;
    try {
      await runCli(['show', 'file_missing']);
    } catch (err) {
      caught = err;
    }
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toContain('File not found');
    }
  });
});

describe('files download', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-download-'));
  });

  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('streams content to disk', async () => {
    const payload = Buffer.from('hello world');
    responder = (url, init) => {
      if (init.method === 'GET' && url.includes('/api/files/file_1')) {
        return jsonResp(200, {
          success: true,
          data: {
            id: 'file_1',
            filename: 'hello.txt',
            mimeType: 'text/plain',
            size: payload.length,
            url: 'https://r2.example.com/hello.txt?sig=abc',
            createdAt: new Date().toISOString(),
          },
        });
      }
      if (url.includes('r2.example.com')) {
        return streamResp(payload);
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = join(workDir, 'hello.txt');
    await runCli(['download', 'file_1', '--output', out, '--force']);
    const got = readFileSync(out);
    expect(got.equals(payload)).toBe(true);
  });

  test('refuses to overwrite without --force in non-TTY', async () => {
    responder = (url, init) => {
      if (init.method === 'GET' && url.includes('/api/files/file_1')) {
        return jsonResp(200, {
          success: true,
          data: {
            id: 'file_1',
            filename: 'hello.txt',
            mimeType: 'text/plain',
            size: 5,
            url: 'https://r2.example.com/hello.txt?sig=abc',
            createdAt: new Date().toISOString(),
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = join(workDir, 'hello.txt');
    writeFileSync(out, 'pre-existing');
    let caught: unknown = null;
    try {
      await runCli(['download', 'file_1', '--output', out]);
    } catch (err) {
      caught = err;
    }
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    expect(isSpycoreCliError(caught)).toBe(true);
    expect(readFileSync(out, 'utf8')).toBe('pre-existing');
  });
});

describe('files delete', () => {
  test('--yes deletes after fetching metadata', async () => {
    let deleted = false;
    responder = (url, init) => {
      if (init.method === 'GET' && url.includes('/api/files/file_1')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'file_1', filename: 'doc.md' },
        });
      }
      if (init.method === 'DELETE' && url.includes('/api/files/file_1')) {
        deleted = true;
        return jsonResp(200, { success: true });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await runCli(['delete', 'file_1', '--yes']);
    expect(deleted).toBe(true);
  });

  test('refuses without --yes in non-TTY', async () => {
    responder = (url, init) => {
      if (init.method === 'GET' && url.includes('/api/files/file_1')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'file_1', filename: 'doc.md' },
        });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    let caught: unknown = null;
    try {
      await runCli(['delete', 'file_1']);
    } catch (err) {
      caught = err;
    }
    expect(
      caught !== null || stderrChunks.join('').includes('Refusing'),
    ).toBe(true);
  });
});

describe('files lib helpers', () => {
  test('detectMime falls back to octet-stream for unknown', async () => {
    const { detectMime } = await import('../src/lib/files.js');
    expect(detectMime('thing.pdf')).toBe('application/pdf');
    expect(detectMime('weird.xyzz')).toBe('application/octet-stream');
  });

  test('formatFileSize is human readable', async () => {
    const { formatFileSize } = await import('../src/lib/files.js');
    expect(formatFileSize(0)).toBe('0 B');
    expect(formatFileSize(1023)).toBe('1023 B');
    expect(formatFileSize(1024)).toBe('1.0 KB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
  });

  test('isTextMime / isImageMime classify correctly', async () => {
    const { isTextMime, isImageMime } = await import('../src/lib/files.js');
    expect(isTextMime('text/plain')).toBe(true);
    expect(isTextMime('application/json')).toBe(true);
    expect(isTextMime('image/png')).toBe(false);
    expect(isImageMime('image/png')).toBe(true);
    expect(isImageMime('application/pdf')).toBe(false);
  });

  test('shortMimeLabel returns concise labels', async () => {
    const { shortMimeLabel } = await import('../src/lib/files.js');
    expect(shortMimeLabel('application/pdf')).toBe('PDF');
    expect(shortMimeLabel('image/png')).toBe('PNG');
    expect(shortMimeLabel('text/markdown')).toBe('MD');
  });
});
