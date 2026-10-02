import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

/**
 * PHASE-1 1.2 — multimodal --attach (chat + agent) and the TUI /attach.
 *
 * Coverage:
 *   1. parsing/inspection — repeatable flag, mixed kinds, missing file,
 *      unsupported binary, over-limit image count, size caps
 *   2. image path (undici mocked) — upload called with the web's multipart
 *      shape, stream body carries file IDs in `attachments`, oversized /
 *      wrong-type rejected BEFORE any upload
 *   3. text path — delimiter + relative-path header + per-file cap + wire cap
 *   4. vision gate — non-vision model → actionable error naming SpyCore
 *      vision models only; agent routing constrained when images present
 *   5. /attach — registered in SLASH_HELP, feeds exactly the next message
 *      (consume-once queue), chip text sanitized
 *   6. 403 waitlisted / plan-gate errors surfaced clean
 */

type MockBody = (AsyncIterable<Buffer> & { json?: () => Promise<unknown> })
  | { json: () => Promise<unknown> };

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: MockBody;
}

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let responder:
  | ((url: string, init: { method: string; headers: Record<string, string>; body?: unknown }) => MockResp)
  | null = null;
let calls: CapturedCall[] = [];

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    const captured = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
    };
    calls.push(captured);
    return responder(url, captured);
  }),
}));

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

let workDir: string;

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  calls = [];
  stdoutChunks = [];
  stderrChunks = [];
  workDir = mkdtempSync(join(tmpdir(), 'spycli-attach-'));
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
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buffers = events.map((e) => Buffer.from(`data: ${JSON.stringify(e)}\n\n`, 'utf8'));
  const body = Readable.from(buffers) as unknown as MockBody;
  (body as { json?: () => Promise<unknown> }).json = async () => ({});
  return { statusCode: 200, headers: {}, body };
}

function stderr(): string {
  return stderrChunks.join('');
}

/** Drain a form-data (or any old-style readable) body into a string. */
function drainBody(body: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = body as NodeJS.ReadableStream & { resume?: () => void };
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer | string) =>
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
    );
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
    // form-data's CombinedStream is an old-style stream: it only starts
    // flowing on an explicit resume().
    stream.resume?.();
  });
}

/** A tiny valid-enough PNG payload (magic bytes + padding). */
function writePng(name: string, extraBytes = 64): string {
  const path = join(workDir, name);
  const magic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(path, Buffer.concat([magic, Buffer.alloc(extraBytes, 1)]));
  return path;
}

function writeText(name: string, content: string): string {
  const path = join(workDir, name);
  writeFileSync(path, content, 'utf8');
  return path;
}

async function runChat(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerChatCommand } = await import('../src/commands/chat.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: argv.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerChatCommand(program);
  await program.parseAsync(['node', 'spycore', ...argv]);
}

async function runAgentCmd(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerAgentCommand } = await import('../src/commands/agent.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: argv.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerAgentCommand(program);
  await program.parseAsync(['node', 'spycore', ...argv]);
}

/** Standard chat responder: conversation create + upload + stream. */
function chatResponder(opts?: { uploadStatus?: number; uploadBody?: unknown; streamResp?: MockResp }) {
  let uploadSeq = 0;
  return (url: string, init: { method: string }): MockResp => {
    if (url.endsWith('/conversations') && init.method === 'POST') {
      return jsonResp(201, { success: true, data: { id: 'cnv_1', title: 'New', model: 'HERMES' } });
    }
    if (url.endsWith('/files/upload') && init.method === 'POST') {
      if (opts?.uploadStatus && opts.uploadStatus >= 400) {
        return jsonResp(opts.uploadStatus, opts.uploadBody ?? { success: false, error: 'Upload rejected' });
      }
      uploadSeq += 1;
      return jsonResp(201, {
        success: true,
        data: {
          id: `file_${uploadSeq}`,
          url: 'https://storage.example/file',
          size: 72,
          filename: `img${uploadSeq}.png`,
          mimeType: 'image/png',
          expiresAt: null,
        },
      });
    }
    if (url.endsWith('/api/chat/stream')) {
      return (
        opts?.streamResp ?? sseResp([{ type: 'text', content: 'I see it.' }, { type: 'done' }])
      );
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

// ───────────────────────── 1. parsing / inspection ─────────────────────────

describe('attachment inspection', () => {
  test('collectAttachOption accumulates repeated --attach values', async () => {
    const { collectAttachOption } = await import('../src/lib/attachments.js');
    const acc = collectAttachOption('b.md', collectAttachOption('a.png', undefined as unknown as string[]));
    expect(acc).toEqual(['a.png', 'b.md']);
  });

  test('mixed image + text batch inspects with kinds and sizes', async () => {
    const { inspectAttachments } = await import('../src/lib/attachments.js');
    const png = writePng('shot.png');
    const md = writeText('notes.md', '# hello\nworld\n');
    const atts = inspectAttachments([png, md], workDir);
    expect(atts).toHaveLength(2);
    expect(atts[0]).toMatchObject({ kind: 'image', displayPath: 'shot.png' });
    expect(atts[1]).toMatchObject({ kind: 'text', displayPath: 'notes.md' });
    expect(atts[1]!.text).toContain('# hello');
  });

  test('missing file → clean error', async () => {
    const { inspectAttachment } = await import('../src/lib/attachments.js');
    expect(() => inspectAttachment(join(workDir, 'nope.png'), workDir)).toThrow(/not found/i);
  });

  test('binary non-image → clean rejection naming the supported kinds', async () => {
    const { inspectAttachment } = await import('../src/lib/attachments.js');
    const bin = join(workDir, 'blob.bin');
    writeFileSync(bin, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0x10]));
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    let caught: unknown;
    try {
      inspectAttachment(bin, workDir);
    } catch (err) {
      caught = err;
    }
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toMatch(/unsupported binary/i);
      expect(caught.hint).toMatch(/\.png, \.jpg, \.jpeg, \.webp, \.gif/);
      expect(caught.hint).toMatch(/text files/i);
    }
  });

  test('empty file → clean error', async () => {
    const { inspectAttachment } = await import('../src/lib/attachments.js');
    const empty = join(workDir, 'empty.md');
    writeFileSync(empty, '');
    expect(() => inspectAttachment(empty, workDir)).toThrow(/empty/i);
  });

  test('over-limit image count (11 > 10) → clear error', async () => {
    const { inspectAttachments, MAX_IMAGES_PER_MESSAGE } = await import('../src/lib/attachments.js');
    expect(MAX_IMAGES_PER_MESSAGE).toBe(10);
    const paths = Array.from({ length: 11 }, (_, i) => writePng(`img${i}.png`));
    expect(() => inspectAttachments(paths, workDir)).toThrow(/too many images/i);
  });

  test('oversized image (>20 MB) rejected locally', async () => {
    const { inspectAttachment, IMAGE_ATTACH_MAX_BYTES } = await import('../src/lib/attachments.js');
    // A third hand-typed copy of the number — weak-pin form (c): it goes stale
    // in lockstep with the constant it "checks", which is exactly how the 10 MB
    // survived web's move to 20 MB. Kept because it pins the LOCAL rejection
    // behaviour, but the number itself is bound to the server in
    // tests/limits-contract.test.ts, which is what can actually catch drift.
    expect(IMAGE_ATTACH_MAX_BYTES).toBe(20 * 1024 * 1024);
    const big = join(workDir, 'big.png');
    writeFileSync(big, Buffer.alloc(IMAGE_ATTACH_MAX_BYTES + 1, 1));
    expect(() => inspectAttachment(big, workDir)).toThrow(/image limit/i);
  });

  test('text file over the per-file cap is truncated with an explicit marker', async () => {
    const { inspectAttachment, TEXT_ATTACH_MAX_CHARS } = await import('../src/lib/attachments.js');
    expect(TEXT_ATTACH_MAX_CHARS).toBe(24_000);
    const big = writeText('big.md', 'x'.repeat(TEXT_ATTACH_MAX_CHARS + 500));
    const att = inspectAttachment(big, workDir);
    expect(att.truncated).toBe(true);
    expect(att.text).toContain(`[attachment truncated at ${TEXT_ATTACH_MAX_CHARS} characters]`);
    expect(att.text!.length).toBeLessThan(TEXT_ATTACH_MAX_CHARS + 100);
  });

  test('text file far beyond the read guard is rejected before reading', async () => {
    const { inspectAttachment, TEXT_ATTACH_MAX_CHARS } = await import('../src/lib/attachments.js');
    const huge = join(workDir, 'huge.log');
    writeFileSync(huge, Buffer.alloc(TEXT_ATTACH_MAX_CHARS * 4 + 1, 0x61)); // 'a' × >96K
    expect(() => inspectAttachment(huge, workDir)).toThrow(/capped at 24000 characters/i);
  });

  test('path outside cwd falls back to the basename as display path', async () => {
    const { inspectAttachment } = await import('../src/lib/attachments.js');
    const otherDir = mkdtempSync(join(tmpdir(), 'spycli-attach-out-'));
    try {
      const p = join(otherDir, 'far.md');
      writeFileSync(p, 'far away');
      const att = inspectAttachment(p, workDir);
      expect(att.displayPath).toBe('far.md');
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────── 3. text path (blocks + caps) ─────────────────────────

describe('text inlining', () => {
  test('blocks carry the delimiter + relative-path header', async () => {
    const { inspectAttachment, buildTextAttachmentBlocks } = await import('../src/lib/attachments.js');
    const md = writeText('docs/api.md'.replace('/', '_'), 'The API docs.');
    const att = inspectAttachment(md, workDir);
    const blocks = buildTextAttachmentBlocks([att]);
    expect(blocks).toContain(`---- attached file: ${att.displayPath} ----`);
    expect(blocks).toContain('The API docs.');
    expect(blocks).toContain(`---- end attached file: ${att.displayPath} ----`);
  });

  test('composeMessageWithAttachments appends blocks after the user text', async () => {
    const { inspectAttachment, composeMessageWithAttachments } = await import('../src/lib/attachments.js');
    const md = writeText('a.md', 'alpha');
    const att = inspectAttachment(md, workDir);
    const wire = composeMessageWithAttachments('summarize this', [att]);
    expect(wire.startsWith('summarize this')).toBe(true);
    expect(wire).toContain('[Attached files]');
    expect(wire.indexOf('alpha')).toBeGreaterThan(wire.indexOf('summarize this'));
  });

  test('wire cap: assembled message over 32,000 chars → actionable error', async () => {
    const { assertWireMessageFits, WIRE_MESSAGE_MAX_CHARS } = await import('../src/lib/attachments.js');
    expect(WIRE_MESSAGE_MAX_CHARS).toBe(32_000);
    expect(() => assertWireMessageFits('x'.repeat(32_001), 1)).toThrow(/limit is 32000/);
    // No attachments → the guard stays out of the way (pre-existing paths unchanged).
    expect(() => assertWireMessageFits('x'.repeat(50_000), 0)).not.toThrow();
    expect(() => assertWireMessageFits('x'.repeat(31_999), 2)).not.toThrow();
  });

  test('agent budget: task + blocks over 24,000 chars → actionable error', async () => {
    const { assertAgentTaskFits, AGENT_TASK_ATTACH_MAX_CHARS } = await import('../src/lib/attachments.js');
    expect(AGENT_TASK_ATTACH_MAX_CHARS).toBe(24_000);
    expect(() => assertAgentTaskFits('t'.repeat(1000), 'b'.repeat(23_001))).toThrow(/agent limit/i);
    expect(() => assertAgentTaskFits('t'.repeat(1000), 'b'.repeat(22_000))).not.toThrow();
    expect(() => assertAgentTaskFits('t'.repeat(100_000), '')).not.toThrow(); // no attachments → no gate
  });

  test('chat one-shot inlines the block into the stream message (no attachments field)', async () => {
    responder = chatResponder();
    const md = writeText('ctx.md', 'IMPORTANT CONTEXT LINE');
    await runChat(['--no-color', 'chat', '--raw', '--attach', md, 'use the file']);
    const streamCall = calls.find((c) => c.url.endsWith('/api/chat/stream'));
    expect(streamCall).toBeDefined();
    const body = JSON.parse(String(streamCall!.body)) as { message: string; attachments?: string[] };
    expect(body.message).toContain('use the file');
    expect(body.message).toContain('---- attached file: ');
    expect(body.message).toContain('IMPORTANT CONTEXT LINE');
    expect(body.message).toContain('---- end attached file: ');
    expect(body.attachments).toBeUndefined();
    // Echo chip on stderr, kind + size included.
    expect(stderr()).toMatch(/\+ attached .*ctx\.md \(text, /);
  });
});

// ───────────────────────── 2. image path (client mocked) ─────────────────────────

describe('image attachments over the web contract', () => {
  test('uploads multipart to /api/files/upload and sends file IDs in `attachments`', async () => {
    responder = chatResponder();
    const png = writePng('shot.png');
    await runChat(['--no-color', 'chat', '--raw', '--attach', png, 'what is in this image?']);

    const uploadCall = calls.find((c) => c.url.endsWith('/files/upload'));
    expect(uploadCall).toBeDefined();
    expect(uploadCall!.method).toBe('POST');
    expect(String(uploadCall!.headers['content-type'])).toMatch(/^multipart\/form-data/);
    const multipart = await drainBody(uploadCall!.body);
    expect(multipart).toContain('name="file"');
    expect(multipart).toContain('filename="shot.png"');
    expect(multipart).toContain('CHAT_IMAGE');

    const streamCall = calls.find((c) => c.url.endsWith('/api/chat/stream'));
    expect(streamCall).toBeDefined();
    const body = JSON.parse(String(streamCall!.body)) as {
      message: string;
      attachments?: string[];
      model: string;
    };
    expect(body.attachments).toEqual(['file_1']);
    expect(body.message).toContain('what is in this image?');
    expect(stderr()).toMatch(/\+ attached .*shot\.png \(image, /);
  });

  test('two images upload in order and both IDs ride the stream body', async () => {
    responder = chatResponder();
    const a = writePng('a.png');
    const b = writePng('b.png');
    await runChat(['--no-color', 'chat', '--raw', '-m', 'minos', '--attach', a, '--attach', b, 'compare']);
    const uploads = calls.filter((c) => c.url.endsWith('/files/upload'));
    expect(uploads).toHaveLength(2);
    const streamCall = calls.find((c) => c.url.endsWith('/api/chat/stream'));
    const body = JSON.parse(String(streamCall!.body)) as { attachments?: string[] };
    expect(body.attachments).toEqual(['file_1', 'file_2']);
  });

  test('oversized image is rejected BEFORE any network call', async () => {
    responder = chatResponder();
    const { IMAGE_ATTACH_MAX_BYTES } = await import('../src/lib/attachments.js');
    const big = join(workDir, 'big.png');
    writeFileSync(big, Buffer.alloc(IMAGE_ATTACH_MAX_BYTES + 1, 1));
    await expect(
      runChat(['--no-color', 'chat', '--raw', '--attach', big, 'hi']),
    ).rejects.toThrow(/image limit/i);
    expect(calls).toHaveLength(0); // no conversation create, no upload
  });

  test('unsupported binary is rejected BEFORE any network call', async () => {
    responder = chatResponder();
    const bin = join(workDir, 'blob.dat');
    writeFileSync(bin, Buffer.from([0x00, 0xde, 0xad, 0xbe, 0xef]));
    await expect(
      runChat(['--no-color', 'chat', '--raw', '--attach', bin, 'hi']),
    ).rejects.toThrow(/unsupported binary/i);
    expect(calls).toHaveLength(0);
  });

  test('upload plan-gate 403 surfaces the scrubbed server message + upgrade hint', async () => {
    responder = chatResponder({
      uploadStatus: 403,
      uploadBody: {
        success: false,
        error: 'File uploads are available on Pro plans and above. Upgrade at https://spycore.ai/pricing',
      },
    });
    const png = writePng('shot.png');
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    let caught: unknown;
    try {
      await runChat(['--no-color', 'chat', '--raw', '--attach', png, 'hi']);
    } catch (err) {
      caught = err;
    }
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toContain('Pro plans and above');
    }
  });
});

// ───────────────────────── 4. vision gate ─────────────────────────

describe('vision gating', () => {
  test('chat: image + non-vision model → actionable error naming Hermes and Minos', async () => {
    responder = chatResponder();
    const png = writePng('shot.png');
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    let caught: unknown;
    try {
      await runChat(['--no-color', 'chat', '--raw', '-m', 'styx', '--attach', png, 'look']);
    } catch (err) {
      caught = err;
    }
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toContain("Styx can't view images");
      expect(caught.message).toContain('Hermes, Minos');
      expect(caught.hint).toContain('--model hermes');
    }
    expect(calls).toHaveLength(0); // gated before conversation create + upload
  });

  test('chat: styx_max is gated too', async () => {
    responder = chatResponder();
    const png = writePng('shot.png');
    await expect(
      runChat(['--no-color', 'chat', '--raw', '-m', 'styx_max', '--attach', png, 'look']),
    ).rejects.toThrow(/Styx Max can't view images/);
  });

  test('chat: minos + image passes the gate', async () => {
    responder = chatResponder();
    const png = writePng('shot.png');
    await runChat(['--no-color', 'chat', '--raw', '-m', 'minos', '--attach', png, 'look']);
    const streamCall = calls.find((c) => c.url.endsWith('/api/chat/stream'));
    const body = JSON.parse(String(streamCall!.body)) as { model: string; attachments?: string[] };
    expect(body.model).toBe('MINOS');
    expect(body.attachments).toEqual(['file_1']);
  });

  test('agent routing: requireVision pins the pick to Minos (no triage)', async () => {
    const { routeAgentModel } = await import('../src/lib/agent/router.js');
    const d = await routeAgentModel({ task: 'describe the mock', plan: 'PRO', requireVision: true });
    expect(d.model).toBe('minos');
    expect(d.reason).toBe('image attachments');
    expect(d.viaOverride).toBe(false);
    expect(calls).toHaveLength(0); // no classify stream, no plan fetch
  });

  test('agent routing: requireVision + free plan clamps to Hermes (also vision)', async () => {
    const { routeAgentModel } = await import('../src/lib/agent/router.js');
    const d = await routeAgentModel({ task: 'describe', plan: 'FREE', requireVision: true });
    expect(d.model).toBe('hermes');
    expect(d.reason).toBe('image attachments, limited by plan');
  });

  test('agent command: explicit --model styx + image → actionable vision error', async () => {
    responder = () => {
      throw new Error('no network expected');
    };
    const png = writePng('shot.png');
    await expect(
      runAgentCmd(['agent', 'describe the screenshot', '--model', 'styx', '--attach', png]),
    ).rejects.toThrow(/Styx can't view images.*Hermes, Minos/);
    expect(calls).toHaveLength(0);
  });

  test('agent command: BYOK provider + image attachment → clean rejection', async () => {
    responder = () => {
      throw new Error('no network expected');
    };
    const png = writePng('shot.png');
    await expect(
      runAgentCmd([
        'agent', 'describe', '--provider', 'openai', '--model', 'some-model', '--attach', png,
      ]),
    ).rejects.toThrow(/Image attachments require the SpyCore provider/);
    expect(calls).toHaveLength(0);
  });
});

// ─────────────── agent loop: attachments on turn 1 of a fresh conversation only ───────────────

describe('agent loop attachment threading', () => {
  test('first turn carries attachments + inlined blocks; fenced follow-up turns do not', async () => {
    const streamBodies: Array<Record<string, unknown>> = [];
    let turn = 0;
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'cnv_agent' } });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        streamBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        turn += 1;
        if (turn === 1) {
          // One fenced tool call so the loop sends a SECOND turn.
          return sseResp([
            {
              type: 'text',
              content: '```spycore:tool\n{"tool":"list_dir","args":{"path":"."}}\n```',
            },
            { type: 'done' },
          ]);
        }
        return sseResp([{ type: 'text', content: 'All done.' }, { type: 'done' }]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };

    const { runAgent } = await import('../src/lib/agent/loop.js');
    const blocks = '---- attached file: notes.md ----\nHello notes\n---- end attached file: notes.md ----';
    const result = await runAgent({
      task: 'describe the attachment',
      model: 'minos',
      cwd: workDir,
      attachments: ['file_img_1'],
      attachedContext: blocks,
      onEvent: () => {},
    });
    expect(result.finalText).toContain('All done.');
    expect(streamBodies.length).toBeGreaterThanOrEqual(2);
    // Turn 1: attachments + the inlined blocks right after the TASK line.
    expect(streamBodies[0]!.attachments).toEqual(['file_img_1']);
    expect(String(streamBodies[0]!.message)).toContain('TASK: describe the attachment');
    expect(String(streamBodies[0]!.message)).toContain('Hello notes');
    // Turn 2 (tool-result feedback): no attachments re-sent.
    expect(streamBodies[1]!.attachments).toBeUndefined();
  });

  test('continuation runs (conversationId set) never re-send attachments', async () => {
    const streamBodies: Array<Record<string, unknown>> = [];
    responder = (url, init) => {
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        streamBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return sseResp([{ type: 'text', content: 'Continued.' }, { type: 'done' }]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({
      task: 'original task',
      model: 'minos',
      cwd: workDir,
      conversationId: 'cnv_agent',
      continueMessage: 'fix the failing check',
      attachments: ['file_img_1'],
      attachedContext: 'ignored on continuation',
      onEvent: () => {},
    });
    expect(streamBodies[0]!.attachments).toBeUndefined();
    expect(streamBodies[0]!.message).toBe('fix the failing check');
  });
});

// ───────────────────────── 5. /attach ─────────────────────────

describe('/attach slash command', () => {
  test('registered in SLASH_HELP', async () => {
    const { SLASH_HELP } = await import('../src/lib/slash/registry.js');
    expect(SLASH_HELP.some((e) => e.command === '/attach <path>')).toBe(true);
  });

  test('runSlashCommand attach → validated attachment outcome', async () => {
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const md = writeText('note.md', 'note body');
    const outcome = await runSlashCommand('attach', [md], {
      cwd: workDir,
      model: 'hermes',
      effort: 'auto',
      conversationId: 'cnv_1',
      apiUrl: undefined,
      injectGuide: true,
      injectChangelog: true,
    });
    expect(outcome.kind).toBe('attach');
    if (outcome.kind === 'attach') {
      expect(outcome.attachment.kind).toBe('text');
      expect(outcome.attachment.displayPath).toBe('note.md');
    }
  });

  test('missing argument → attach-usage; bad path → attach-error', async () => {
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const ctx = {
      cwd: workDir,
      model: 'hermes' as const,
      effort: 'auto' as const,
      conversationId: 'cnv_1',
      apiUrl: undefined,
      injectGuide: true,
      injectChangelog: true,
    };
    expect((await runSlashCommand('attach', [], ctx)).kind).toBe('attach-usage');
    const bad = await runSlashCommand('attach', ['missing.png'], ctx);
    expect(bad.kind).toBe('attach-error');
    if (bad.kind === 'attach-error') expect(bad.message).toMatch(/not found/i);
  });

  test('one-shot renderer surfaces the attachment for the NEXT message + prints a chip', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const md = writeText('note.md', 'note body');
    const res = await handleSlashCommand(`/attach ${md}`, {
      json: false,
      color: false,
      currentConvo: 'cnv_1',
      apiUrl: undefined,
    });
    expect(res.consumed).toBe(true);
    expect(res.attachment?.displayPath).toBe('note.md');
    expect(stderr()).toContain('Attached');
    expect(stderr()).toContain('note.md (text,');
    expect(stderr()).toContain('applies to your next message');
  });

  test('pending queue feeds exactly the next message (consume-once)', async () => {
    const { PendingAttachments, inspectAttachment } = await import('../src/lib/attachments.js');
    const md = writeText('note.md', 'hello');
    const att = inspectAttachment(md, workDir);
    const q = new PendingAttachments();
    q.add(att);
    expect(q.hasImages()).toBe(false);
    // A failed send snapshots but does NOT consume — still queued.
    expect(q.snapshot()).toHaveLength(1);
    expect(q.size).toBe(1);
    // The successful send consumes; the message after it carries nothing.
    q.consume();
    expect(q.snapshot()).toHaveLength(0);
    // --attach seeds arrive via the constructor.
    const seeded = new PendingAttachments([att, { ...att, kind: 'image' }]);
    expect(seeded.size).toBe(2);
    expect(seeded.hasImages()).toBe(true);
  });

  test('echo chip is ANSI-sanitized', async () => {
    const { attachmentChip } = await import('../src/lib/attachments.js');
    const { sanitizeForDisplay } = await import('../src/lib/sanitize-display.js');
    const chip = attachmentChip({
      absPath: '/tmp/x',
      displayPath: 'evil\u001b[2J\u001b]0;pwn\u0007name.md',
      kind: 'text',
      sizeBytes: 42,
      mime: 'text/markdown',
    });
    const rendered = sanitizeForDisplay(chip);
    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\u0007');
    expect(rendered).toContain('name.md');
    expect(rendered).toContain('(text, 42 B)');
  });
});

// ───────────────────────── 6. 403 waitlisted ─────────────────────────

describe('waitlist gate surfacing', () => {
  test('stream 403 waitlisted → clean actionable error with the server message', async () => {
    responder = (url, init) => {
      if (url.endsWith('/conversations') && init.method === 'POST') {
        return jsonResp(201, { success: true, data: { id: 'cnv_1', title: 'New', model: 'HERMES' } });
      }
      if (url.endsWith('/files/upload') && init.method === 'POST') {
        return jsonResp(201, {
          success: true,
          data: { id: 'file_1', url: 'u', size: 72, filename: 'shot.png', mimeType: 'image/png' },
        });
      }
      if (url.endsWith('/api/chat/stream')) {
        return jsonResp(403, {
          success: false,
          error: "You're on the SpyCore waitlist — chat opens when your early access begins.",
          code: 'waitlisted',
        });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    const png = writePng('shot.png');
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    let caught: unknown;
    try {
      await runChat(['--no-color', 'chat', '--raw', '--attach', png, 'hi']);
    } catch (err) {
      caught = err;
    }
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toContain('SpyCore waitlist');
      expect(caught.message).toContain('early access');
    }
  });
});

// ───────────────── identity: the vision-gate names SpyCore models only ─────────────────
// (The negative vendor-name gate for this surface lives in the source-tree-only
// identity-denylist.test.ts, next to the other deny probes.)

describe('identity — attachment surface', () => {
  test('vision-gate error names the SpyCore vision models', async () => {
    const { visionGateError, VISION_MODEL_SLUGS } = await import('../src/lib/attachments.js');
    expect(VISION_MODEL_SLUGS).toEqual(['hermes', 'minos']);
    const err = visionGateError('charon');
    expect(err.message).toContain("Charon can't view images");
    expect(err.message).toContain('Hermes, Minos');
  });
});
