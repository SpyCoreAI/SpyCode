import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

// BYOK chat (items 17-19): the --provider path bypasses the SpyCore login
// gate, wires --new on the SpyCore path, and honors --attach/--no-stream
// instead of silently dropping them. Harness copied from tests/chat.test.ts.
type MockBody = (AsyncIterable<Buffer> & { json?: () => Promise<unknown> })
  | { json: () => Promise<unknown> };
interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: MockBody;
}
type Responder = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string | Buffer },
) => MockResp;
let responder: Responder | null = null;
let requests: Array<{ url: string; method: string; body?: string | Buffer }> = [];

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}) => {
    requests.push({ url, method: init.method ?? 'GET', body: init.body });
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
    });
  }),
}));

let workDir: string;
let origCwd: string;
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  requests = [];
  origCwd = process.cwd();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-chatbyok-')));
  stdoutChunks = [];
  stderrChunks = [];
  process.stdout.write = ((c: unknown) => {
    stdoutChunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    stderrChunks.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  process.chdir(workDir);
  // A saved BYOK provider; NO stored SpyCore token (logged out).
  const { setStoredProviders } = await import('../src/lib/config.js');
  setStoredProviders([
    { name: 'local', type: 'openai', baseURL: 'http://127.0.0.1:11434/v1', model: 'm', apiKey: 'sk-test' },
  ]);
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.chdir(origCwd);
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  vi.resetModules();
});

function stdout(): string {
  return stdoutChunks.join('');
}

function stderr(): string {
  return stderrChunks.join('');
}

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

function openaiSse(deltas: string[]): MockResp {
  const lines = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`);
  lines.push('data: [DONE]\n\n');
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Readable.from([Buffer.from(lines.join(''), 'utf8')]) as unknown as MockBody,
  };
}

/** A reply cut off by max_tokens, with usage totals on the final chunk. */
function openaiSseTruncated(): MockResp {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'cut ' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Readable.from([Buffer.from(lines.join(''), 'utf8')]) as unknown as MockBody,
  };
}

function spycoreSse(text: string): MockResp {
  return {
    statusCode: 200,
    headers: {},
    body: Readable.from([
      Buffer.from(`data: {"type":"text","content":${JSON.stringify(text)}}\n\ndata: {"type":"done"}\n\n`, 'utf8'),
    ]) as unknown as MockBody,
  };
}

async function runChat(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerChatCommand } = await import('../src/commands/chat.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: argv.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  program.exitOverride();
  registerChatCommand(program);
  await program.parseAsync(['node', 'spycore', ...argv]);
}

/** BYOK provider answers; any SpyCore URL is a failure (logged-out path must not touch it). */
function byokResponder(): Responder {
  return (url) => {
    if (url.includes('127.0.0.1:11434')) return openaiSse(['hello']);
    throw new Error(`unexpected ${url} - BYOK chat must not touch SpyCore`);
  };
}

describe('BYOK chat (logged out)', () => {
  test('works without a SpyCore login', async () => {
    responder = byokResponder();
    await runChat(['chat', '--provider', 'local', 'hi']);
    expect(stdout()).toContain('hello');
    expect(requests.some((r) => r.url.includes('/api/chat/stream'))).toBe(false);
    expect(requests.some((r) => r.url.includes('/conversations'))).toBe(false);
  });

  test('--effort is rejected, not silently ignored', async () => {
    responder = byokResponder();
    await expect(runChat(['chat', '--provider', 'local', '--effort', 'high', 'hi'])).rejects.toThrow(
      /--effort is not supported with BYOK/,
    );
    expect(requests).toHaveLength(0);
  });

  test('--attach inlines a text file into the provider message', async () => {
    writeFileSync(join(workDir, 'note.txt'), 'remember the falcon');
    responder = byokResponder();
    await runChat(['chat', '--provider', 'local', '--attach', 'note.txt', 'hi']);
    expect(stdout()).toContain('hello');
    const body = JSON.parse(String(requests[requests.length - 1]?.body ?? '{}')) as {
      messages: Array<{ content: string }>;
    };
    const sent = body.messages.map((m) => m.content).join('\n');
    expect(sent).toContain('[Attached files]');
    expect(sent).toContain('remember the falcon');
  });

  test('--attach of an image is rejected, not silently dropped', async () => {
    writeFileSync(join(workDir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    responder = byokResponder();
    await expect(
      runChat(['chat', '--provider', 'local', '--attach', 'pic.png', 'hi']),
    ).rejects.toThrow(/Image attachments are not supported with BYOK/);
    expect(requests).toHaveLength(0);
  });

  test('--no-stream buffers the reply and prints it once at the end', async () => {
    responder = byokResponder();
    await runChat(['chat', '--provider', 'local', '--no-stream', 'hi']);
    expect(stdout()).toContain('hello');
  });

  test('a truncated BYOK reply warns, and usage tokens print (R2 L7)', async () => {
    responder = (url) => {
      if (url.includes('127.0.0.1:11434')) return openaiSseTruncated();
      throw new Error(`unexpected ${url} - BYOK chat must not touch SpyCore`);
    };
    await runChat(['chat', '--provider', 'local', 'hi']);
    expect(stdout()).toContain('cut ');
    // Previously the cut-off text printed with no hint it was incomplete.
    expect(stderr()).toMatch(/Response truncated/);
    expect(stderr()).toContain('(10 in / 5 out tokens)');
  });

  test('a truncated BYOK reply carries usage + warnings in --json (R2 L7)', async () => {
    responder = (url) => {
      if (url.includes('127.0.0.1:11434')) return openaiSseTruncated();
      throw new Error(`unexpected ${url} - BYOK chat must not touch SpyCore`);
    };
    await runChat(['--json', 'chat', '--provider', 'local', 'hi']);
    const payload = JSON.parse(stdout()) as {
      message: string;
      usage?: { input: number; output: number };
      warnings?: string[];
    };
    expect(payload.message).toContain('cut ');
    expect(payload.usage).toEqual({ input: 10, output: 5 });
    expect(payload.warnings?.join(' ')).toMatch(/Response truncated/);
  });
});

describe('chat --new on the SpyCore path', () => {
  beforeEach(async () => {
    // Logged in, with a remembered conversation. The last-conversation id
    // lives in the raw config store (key not in the typed schema).
    const { setStoredTokenInFile, getConfigStore } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    (getConfigStore() as unknown as { set(k: string, v: string): void }).set('lastConversationId', 'cnv_old');
  });

  function spycoreResponder(newId: string): Responder {
    return (url, init) => {
      if (url.endsWith('/conversations') && init.method === 'POST') {
        return jsonResp(201, { success: true, data: { id: newId, title: 'New', model: 'HERMES' } });
      }
      if (url.endsWith('/api/chat/stream')) return spycoreSse('hi there');
      throw new Error(`unexpected ${init.method} ${url}`);
    };
  }

  test('--new forces a fresh conversation even when one is remembered', async () => {
    responder = spycoreResponder('cnv_new');
    await runChat(['chat', '--new', '--raw', 'Hi']);
    expect(stdout()).toContain('hi there');
    expect(requests.some((r) => r.url.endsWith('/conversations') && r.method === 'POST')).toBe(true);
    const stream = requests.find((r) => r.url.endsWith('/api/chat/stream'));
    expect(JSON.parse(String(stream?.body ?? '{}')).conversationId).toBe('cnv_new');
  });

  test('--resume reuses the remembered conversation without creating one', async () => {
    responder = spycoreResponder('cnv_new');
    await runChat(['chat', '--resume', '--raw', 'Hi']);
    expect(stdout()).toContain('hi there');
    expect(requests.some((r) => r.url.endsWith('/conversations') && r.method === 'POST')).toBe(false);
    const stream = requests.find((r) => r.url.endsWith('/api/chat/stream'));
    expect(JSON.parse(String(stream?.body ?? '{}')).conversationId).toBe('cnv_old');
  });

  test('a conversation created without an id fails loudly instead of propagating undefined (R2 L10)', async () => {
    responder = (url, init) => {
      if (url.endsWith('/conversations') && init.method === 'POST') {
        // Malformed server response: success envelope, no id.
        return jsonResp(201, { success: true, data: { title: 'New', model: 'HERMES' } });
      }
      if (url.endsWith('/api/chat/stream')) return spycoreSse('hi there');
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await expect(runChat(['chat', '--new', '--raw', 'Hi'])).rejects.toThrow(
      /created a conversation without an id/,
    );
    // Nothing was stored or streamed with an undefined id.
    expect(requests.some((r) => r.url.endsWith('/api/chat/stream'))).toBe(false);
  });
});
