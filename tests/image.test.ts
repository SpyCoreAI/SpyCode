import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
  | ((url: string, init: { method: string; body?: unknown; headers?: Record<string, string> }) => MockResp)
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(
    async (
      url: string,
      init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) => {
      if (!responder) throw new Error('test forgot to set responder');
      return responder(url, {
        method: init.method ?? 'GET',
        body: init.body,
        headers: init.headers,
      });
    },
  ),
}));

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

let workDir: string;

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  stdoutChunks = [];
  stderrChunks = [];
  workDir = mkdtempSync(join(tmpdir(), 'spycli-image-'));
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

function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const lines: string[] = [];
  for (const e of events) lines.push(`data: ${JSON.stringify(e)}\n\n`);
  const buf = Buffer.from(lines.join(''));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: {
      json: async () => ({}),
      [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator](),
    },
  };
}

function binaryResp(buf: Buffer, contentType = 'image/png'): MockResp {
  return {
    statusCode: 200,
    headers: { 'content-type': contentType },
    body: {
      json: async () => ({}),
      [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator](),
    },
  };
}

async function runCli(argv: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerImageCommand } = await import('../src/commands/image.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerImageCommand(program);
  await program.parseAsync(['node', 'spycore', ...parentArgs, 'image', ...argv]);
}

describe('spycore image', () => {
  test('streams image event then downloads', async () => {
    const png = Buffer.from('PNGDATA'.repeat(50));
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'cnv_img', title: 'New', model: 'HEPHAESTUS' },
        });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          {
            type: 'image',
            urls: ['https://r2.example.com/img.png?sig=abc'],
            revisedPrompt: 'a sunset over mountains',
            cost: 0.04,
          },
          { type: 'done' },
        ]);
      }
      if (url.includes('r2.example.com')) {
        return binaryResp(png);
      }
      throw new Error(`unexpected ${url}`);
    };

    const out = join(workDir, 'pic.png');
    await runCli(['a sunset', '--output', out]);
    const got = readFileSync(out);
    expect(got.equals(png)).toBe(true);
  });

  test('moderation rejection produces a sanitised message', async () => {
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'cnv_img', title: 'New', model: 'HEPHAESTUS' },
        });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          { type: 'error', message: 'Blocked by moderation policy' },
          { type: 'done' },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    };
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    let caught: unknown = null;
    try {
      await runCli(['something']);
    } catch (err) {
      caught = err;
    }
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toContain('moderation');
    }
  });

  test('quota error gets the usage hint', async () => {
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'cnv_img', title: 'New', model: 'HEPHAESTUS' },
        });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          { type: 'error', message: 'Image quota exhausted for this period.' },
          { type: 'done' },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    };
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    let caught: unknown = null;
    try {
      await runCli(['painting']);
    } catch (err) {
      caught = err;
    }
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.hint).toContain('spycore usage');
    }
  });

  test('--count > 1 clamps to one image, warns once, and succeeds', async () => {
    const png = Buffer.from('PNGDATA'.repeat(20));
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'cnv_img', title: 'New', model: 'HEPHAESTUS' },
        });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          { type: 'image', urls: ['https://r2.example.com/x.png'] },
          { type: 'done' },
        ]);
      }
      if (url.includes('r2.example.com')) {
        return binaryResp(png);
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = join(workDir, 'multi.png');
    // Must NOT throw (exit 0) and the single image must be saved.
    await runCli(['hello', '--count', '3', '--output', out]);
    expect(readFileSync(out).equals(png)).toBe(true);
    // Exactly one human notice, on stderr.
    const stderr = stderrChunks.join('');
    expect(stderr.split("isn't supported yet").length - 1).toBe(1);
  });

  test('--count > 1 emits no notice under --json (output stays valid)', async () => {
    const png = Buffer.from('PNG');
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'cnv_img', title: 'New', model: 'HEPHAESTUS' },
        });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          { type: 'image', urls: ['https://r2.example.com/x.png'] },
          { type: 'done' },
        ]);
      }
      if (url.includes('r2.example.com')) {
        return binaryResp(png);
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = join(workDir, 'multi-json.png');
    await runCli(['hello', '--count', '4', '--output', out], ['--json']);
    expect(stderrChunks.join('')).not.toContain('supported yet');
    const parsed = JSON.parse(stdoutChunks.join('').trim());
    expect(parsed.count).toBe(1);
    expect(parsed.localPath).toBe(out);
  });

  test('--style threads styleVariance onto the conversation settings', async () => {
    const png = Buffer.from('PNGDATA');
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    responder = (url, init) => {
      calls.push({
        method: init.method,
        url,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
      });
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'cnv_img', title: 'New', model: 'HEPHAESTUS' },
        });
      }
      if (init.method === 'PATCH' && url.includes('/conversations/cnv_img/settings')) {
        return jsonResp(200, {
          success: true,
          data: { imageParams: { styleVariance: 'high' } },
        });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          { type: 'image', urls: ['https://r2.example.com/x.png'] },
          { type: 'done' },
        ]);
      }
      if (url.includes('r2.example.com')) {
        return binaryResp(png);
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = join(workDir, 'styled.png');
    await runCli(['a fox', '--style', 'high', '--output', out]);
    const patch = calls.find(
      (c) => c.method === 'PATCH' && c.url.includes('/conversations/cnv_img/settings'),
    );
    expect(patch).toBeDefined();
    expect(patch!.body).toEqual({ imageParams: { styleVariance: 'high' } });
  });

  test('omitting --style sends no settings patch (payload unchanged)', async () => {
    const png = Buffer.from('PNGDATA');
    const calls: Array<{ method: string; url: string }> = [];
    responder = (url, init) => {
      calls.push({ method: init.method, url });
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'cnv_img', title: 'New', model: 'HEPHAESTUS' },
        });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          { type: 'image', urls: ['https://r2.example.com/x.png'] },
          { type: 'done' },
        ]);
      }
      if (url.includes('r2.example.com')) {
        return binaryResp(png);
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = join(workDir, 'plain.png');
    await runCli(['a fox', '--output', out]);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('auto-named file uses the extension that matches the bytes (jpeg)', async () => {
    // Bytes are JPEG (FF D8 FF) and the response advertises image/jpeg, yet the
    // historical default name was always *.png — assert it is now *.jpg.
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'cnv_img', title: 'New', model: 'HEPHAESTUS' },
        });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          { type: 'image', urls: ['https://r2.example.com/generated'] },
          { type: 'done' },
        ]);
      }
      if (url.includes('r2.example.com')) {
        return binaryResp(jpeg, 'image/jpeg');
      }
      throw new Error(`unexpected ${url}`);
    };
    // No --output: the default name is resolved against cwd, so run inside the
    // temp dir to keep the repo clean.
    const prevCwd = process.cwd();
    process.chdir(workDir);
    try {
      await runCli(['a fox at dusk']);
    } finally {
      process.chdir(prevCwd);
    }
    const created = readdirSync(workDir).filter((f) => f.startsWith('image_'));
    expect(created).toHaveLength(1);
    expect(created[0]!.endsWith('.jpg')).toBe(true);
    expect(readFileSync(join(workDir, created[0]!)).equals(jpeg)).toBe(true);
  });

  test('--json mode emits structured output', async () => {
    const png = Buffer.from('PNG');
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'cnv_img', title: 'New', model: 'HEPHAESTUS' },
        });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          { type: 'image', urls: ['https://r2.example.com/x.png'], revisedPrompt: 'rp', cost: 0 },
          { type: 'done' },
        ]);
      }
      if (url.includes('r2.example.com')) {
        return binaryResp(png);
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = join(workDir, 'json.png');
    await runCli(['cat picture', '--output', out], ['--json']);
    const text = stdoutChunks.join('').trim();
    const parsed = JSON.parse(text);
    expect(parsed.localPath).toBe(out);
    expect(parsed.url).toBe('https://r2.example.com/x.png');
    expect(parsed.size).toBe(png.length);
  });
});
