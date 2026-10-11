import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

/**
 * `spycore image edit <file> -p "<instruction>"` - PHASE-1 1.3.
 *
 * The edit surface must mirror the web contract EXACTLY (upload via the 1.2
 * plumbing, then `/api/chat/stream` with `editSourceImageUrl`), validate the
 * input locally with the 1.2 limits, save results exactly like generation,
 * and keep every error clean + actionable. The generation grammar is
 * untouched: only a literal first token `edit` dispatches to the edit flow.
 */

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
let srcPath: string;

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  stdoutChunks = [];
  stderrChunks = [];
  workDir = mkdtempSync(join(tmpdir(), 'spycli-image-edit-'));
  srcPath = join(workDir, 'src.png');
  writeFileSync(srcPath, Buffer.from('PNGSOURCE'.repeat(20)));
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

const UPLOADED_URL =
  'https://r2.example.com/spycore-test/uploads/u1/chat_image/abc-src.webp';

/** Happy-path responder: upload → conversation → SSE edit → R2 download. */
function happyResponder(
  png: Buffer,
  calls?: Array<{ method: string; url: string; body?: unknown }>,
) {
  return (url: string, init: { method: string; body?: unknown }): MockResp => {
    calls?.push({ method: init.method, url, body: init.body });
    if (init.method === 'POST' && url.includes('/files/upload')) {
      return jsonResp(200, {
        success: true,
        data: {
          id: 'file_1',
          url: UPLOADED_URL,
          size: 180,
          filename: 'src.webp',
          mimeType: 'image/webp',
          expiresAt: null,
        },
      });
    }
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return jsonResp(200, {
        success: true,
        data: { id: 'cnv_edit', title: 'New', model: 'HEPHAESTUS' },
      });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      return sseResp([
        {
          type: 'image',
          urls: ['https://r2.example.com/edited.png?sig=abc'],
          revisedPrompt: 'a purple sky over mountains',
          cost: 0.03,
        },
        { type: 'done' },
      ]);
    }
    if (url.includes('r2.example.com')) {
      return binaryResp(png);
    }
    throw new Error(`unexpected ${url}`);
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

async function expectCliError(argv: string[]): Promise<{ message: string; hint?: string }> {
  const { isSpycoreCliError } = await import('../src/lib/errors.js');
  let caught: unknown = null;
  try {
    await runCli(argv);
  } catch (err) {
    caught = err;
  }
  expect(isSpycoreCliError(caught)).toBe(true);
  const e = caught as { message: string; hint?: string };
  return { message: e.message, hint: e.hint };
}

describe('spycore image edit - parsing', () => {
  test('missing --prompt fails with usage', async () => {
    const err = await expectCliError(['edit', srcPath]);
    expect(err.message).toContain('Missing --prompt');
    expect(err.hint).toContain('spycore image edit');
  });

  test('missing input file fails with usage', async () => {
    const err = await expectCliError(['edit', '--prompt', 'make it purple']);
    expect(err.message).toContain('Missing input image');
    expect(err.hint).toContain('spycore image edit');
  });

  test('more than one input is rejected', async () => {
    const err = await expectCliError(['edit', srcPath, 'other.png', '-p', 'make it purple']);
    expect(err.message).toContain('exactly one input file');
  });

  test('https URLs are rejected with the local-file guidance', async () => {
    const err = await expectCliError([
      'edit',
      'https://example.com/pic.png',
      '-p',
      'make it purple',
    ]);
    expect(err.message).toContain('URLs are not supported');
    expect(err.hint).toContain('.png');
  });

  test('non-image extension is rejected with the named types', async () => {
    const txt = join(workDir, 'notes.txt');
    writeFileSync(txt, 'hello');
    const err = await expectCliError(['edit', txt, '-p', 'make it purple']);
    expect(err.message).toContain('Unsupported input type');
    expect(err.message).toContain('.txt');
    expect(err.hint).toContain('.webp');
  });

  test('missing file is a clean not-found error', async () => {
    const err = await expectCliError(['edit', join(workDir, 'nope.png'), '-p', 'make it purple']);
    expect(err.message).toContain('Input image not found');
  });

  test('oversized image is rejected with the named limit before any upload', async () => {
    // DERIVED, not re-typed. This was `10 * 1024 * 1024 + 1` - a FOURTH
    // hand-typed copy of the image cap, and it silently stopped testing
    // oversize the moment the real cap moved to 20 MB: 10 MB + 1 byte is now a
    // perfectly acceptable image, so the case sailed past the check and died at
    // the network instead. A fixture that spells out the limit it is probing
    // stops probing it as soon as the limit changes.
    const { IMAGE_ATTACH_MAX_BYTES } = await import('../src/lib/attachments.js');
    const big = join(workDir, 'big.png');
    writeFileSync(big, Buffer.alloc(IMAGE_ATTACH_MAX_BYTES + 1));
    const err = await expectCliError(['edit', big, '-p', 'make it purple']);
    expect(err.message).toContain('limit');
    // responder is null - reaching the network would have thrown
    // 'test forgot to set responder' instead of the clean size error.
  });

  test('--style and --count are generation-only', async () => {
    const styleErr = await expectCliError(['edit', srcPath, '-p', 'make it purple', '--style', 'high']);
    expect(styleErr.message).toContain('--style is not supported for image edits');
    const countErr = await expectCliError(['edit', srcPath, '-p', 'make it purple', '--count', '2']);
    expect(countErr.message).toContain('--count is not supported for image edits');
  });

  test('short prompts are rejected like generation', async () => {
    const err = await expectCliError(['edit', srcPath, '-p', 'ab']);
    expect(err.message).toContain('at least 3 characters');
  });
});

describe('spycore image edit - happy path', () => {
  test('uploads via 1.2 plumbing then sends the exact web edit contract and saves the result', async () => {
    const png = Buffer.from('EDITEDPNG'.repeat(40));
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    responder = happyResponder(png, calls);

    const out = join(workDir, 'edited.png');
    await runCli(['edit', srcPath, '-p', 'make the sky purple', '--output', out]);

    // Result saved to disk exactly like generation.
    expect(readFileSync(out).equals(png)).toBe(true);

    // Upload → conversation → stream, in that order.
    const postOrder = calls
      .filter((c) => c.method === 'POST')
      .map((c) =>
        c.url.includes('/files/upload')
          ? 'upload'
          : c.url.endsWith('/conversations')
            ? 'conversation'
            : c.url.includes('/api/chat/stream')
              ? 'stream'
              : 'other',
      );
    expect(postOrder).toEqual(['upload', 'conversation', 'stream']);

    // The stream body is the EXACT web edit contract - nothing more.
    const stream = calls.find((c) => c.url.includes('/api/chat/stream'))!;
    expect(JSON.parse(String(stream.body))).toEqual({
      conversationId: 'cnv_edit',
      message: 'make the sky purple',
      model: 'HEPHAESTUS',
      editSourceImageUrl: UPLOADED_URL,
    });
  });

  test('--json mode emits structured edit output', async () => {
    const png = Buffer.from('EDITED');
    responder = happyResponder(png);
    const out = join(workDir, 'edited-json.png');
    await runCli(['edit', srcPath, '-p', 'make the sky purple', '--output', out], ['--json']);
    const parsed = JSON.parse(stdoutChunks.join('').trim());
    expect(parsed.mode).toBe('edit');
    expect(parsed.localPath).toBe(out);
    expect(parsed.url).toBe('https://r2.example.com/edited.png?sig=abc');
    expect(parsed.sourceFileId).toBe('file_1');
    expect(parsed.size).toBe(png.length);
    expect(parsed.revisedPrompt).toBe('a purple sky over mountains');
  });
});

describe('spycore image edit - gated errors', () => {
  test('Free-plan upload rejection surfaces the actionable upgrade message', async () => {
    responder = (url, init) => {
      if (init.method === 'POST' && url.includes('/files/upload')) {
        return jsonResp(403, {
          success: false,
          error:
            'File uploads are available on Pro plans and above. Upgrade at https://spycore.ai/pricing',
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const err = await expectCliError(['edit', srcPath, '-p', 'make it purple']);
    expect(err.message).toContain('Pro plans and above');
    expect(err.hint).toContain('pricing');
  });

  test('Free-plan stream 403 (plan_required) becomes the actionable edit upgrade message', async () => {
    responder = (url, init) => {
      if (init.method === 'POST' && url.includes('/files/upload')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'file_1', url: UPLOADED_URL, size: 1, filename: 'src.webp', mimeType: 'image/webp' },
        });
      }
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'cnv_edit', title: 'New', model: 'HEPHAESTUS' } });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return jsonResp(403, { success: false, error: 'plan_required' });
      }
      throw new Error(`unexpected ${url}`);
    };
    const err = await expectCliError(['edit', srcPath, '-p', 'make it purple']);
    expect(err.message).toBe('Image editing requires a Pro plan or higher.');
    expect(err.hint).toContain('pricing');
  });

  test('WAITLISTED stream 403 surfaces the clean waitlist message', async () => {
    responder = (url, init) => {
      if (init.method === 'POST' && url.includes('/files/upload')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'file_1', url: UPLOADED_URL, size: 1, filename: 'src.webp', mimeType: 'image/webp' },
        });
      }
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'cnv_edit', title: 'New', model: 'HEPHAESTUS' } });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return jsonResp(403, {
          success: false,
          error: "You're on the SpyCore waitlist - chat opens when your early access begins.",
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const err = await expectCliError(['edit', srcPath, '-p', 'make it purple']);
    expect(err.message).toContain('waitlist');
    expect(err.message).not.toMatch(/plan_required/);
  });

  test('provider failure collapses to the generic edit error', async () => {
    responder = (url, init) => {
      if (init.method === 'POST' && url.includes('/files/upload')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'file_1', url: UPLOADED_URL, size: 1, filename: 'src.webp', mimeType: 'image/webp' },
        });
      }
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'cnv_edit', title: 'New', model: 'HEPHAESTUS' } });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          { type: 'error', message: 'Image generation failed. Please try again.' },
          { type: 'done' },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    };
    const err = await expectCliError(['edit', srcPath, '-p', 'make it purple']);
    expect(err.message).toBe('Image edit failed - try rephrasing the prompt.');
  });

  test('moderation rejection produces the sanitised moderation message', async () => {
    responder = (url, init) => {
      if (init.method === 'POST' && url.includes('/files/upload')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'file_1', url: UPLOADED_URL, size: 1, filename: 'src.webp', mimeType: 'image/webp' },
        });
      }
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'cnv_edit', title: 'New', model: 'HEPHAESTUS' } });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          { type: 'error', message: 'Blocked by moderation policy' },
          { type: 'done' },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    };
    const err = await expectCliError(['edit', srcPath, '-p', 'make it purple']);
    expect(err.message).toContain('moderation');
  });

  test('insufficient credits (quota) surfaces the server message with the usage hint', async () => {
    responder = (url, init) => {
      if (init.method === 'POST' && url.includes('/files/upload')) {
        return jsonResp(200, {
          success: true,
          data: { id: 'file_1', url: UPLOADED_URL, size: 1, filename: 'src.webp', mimeType: 'image/webp' },
        });
      }
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'cnv_edit', title: 'New', model: 'HEPHAESTUS' } });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([
          { type: 'error', message: 'Image quota exhausted for this period.' },
          { type: 'done' },
        ]);
      }
      throw new Error(`unexpected ${url}`);
    };
    const err = await expectCliError(['edit', srcPath, '-p', 'make it purple']);
    expect(err.hint).toContain('spycore usage');
  });
});

describe('spycore image - generation grammar untouched', () => {
  test('a quoted prompt starting with "edit" still generates (single token ≠ edit)', async () => {
    const png = Buffer.from('GENPNG');
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    responder = (url, init) => {
      calls.push({ method: init.method, url, body: init.body });
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'cnv_img', title: 'New', model: 'HEPHAESTUS' } });
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
    const out = join(workDir, 'gen.png');
    await runCli(['edit this photo style', '--output', out]);
    expect(readFileSync(out).equals(png)).toBe(true);
    // No upload happened, and the stream body is a plain generation.
    expect(calls.some((c) => c.url.includes('/files/upload'))).toBe(false);
    const stream = calls.find((c) => c.url.includes('/api/chat/stream'))!;
    const body = JSON.parse(String(stream.body)) as Record<string, unknown>;
    expect(body.message).toBe('edit this photo style');
    expect(body).not.toHaveProperty('editSourceImageUrl');
  });

  test('--prompt on a generation is rejected with the edit usage', async () => {
    const err = await expectCliError(['a nice sunset', '-p', 'whoops']);
    expect(err.message).toContain('--prompt is only used with `spycore image edit`');
  });
});
