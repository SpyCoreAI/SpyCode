import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

// Same wire shape as tests/chat.test.ts: POST /conversations → JSON,
// POST /api/chat/stream → SSE, GET /conversations/:id → JSON.

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

let workDir: string;
let origCwd: string;
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  origCwd = process.cwd();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-chatev-')));
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
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
  process.chdir(workDir);
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  try {
    process.chdir(origCwd);
  } catch {
    /* ignore */
  }
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
function sseResp(events: Array<Record<string, unknown> | null | string>): MockResp {
  const lines = events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`);
  return {
    statusCode: 200,
    headers: {},
    body: Readable.from(lines.map((l) => Buffer.from(l, 'utf8'))) as unknown as MockBody,
  };
}
const stdout = (): string => stdoutChunks.join('');
const stderr = (): string => stderrChunks.join('');

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

/** Standard responder: creates cnv_1, then streams the given events. */
function streamResponder(events: Array<Record<string, unknown> | null | string>): Responder {
  return (url, init) => {
    if (url.endsWith('/conversations') && init.method === 'POST') {
      return jsonResp(201, { success: true, data: { id: 'cnv_1', title: 'New', model: 'HERMES' } });
    }
    if (url.endsWith('/api/chat/stream')) return sseResp(events);
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

const TEXT = { type: 'text', content: 'ok' };
const DONE = { type: 'done' };

// ───────────────────── human-mode event rendering (--raw) ─────────────────────

describe('chat human-mode stream events', () => {
  test('thinking is swallowed in human mode', async () => {
    responder = streamResponder([{ type: 'thinking', content: 'hmm' }, TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stdout()).toContain('ok');
    expect(stderr()).not.toContain('hmm');
  });

  test('search lifecycle lines render, singular and plural', async () => {
    responder = streamResponder([
      { type: 'search_started', query: 'cats' },
      { type: 'search_completed', count: 1, sources: ['a'] },
      TEXT, DONE,
    ]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).toMatch(/Searching the web/);
    expect(stderr()).toMatch(/Found 1 source[^s]/);
    stderrChunks = [];
    responder = streamResponder([
      { type: 'search_completed', count: 3, sources: ['a', 'b', 'c'] },
      TEXT, DONE,
    ]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).toMatch(/Found 3 sources/);
  });

  test('a failed search warns', async () => {
    responder = streamResponder([{ type: 'search_failed' }, TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).toMatch(/Search returned no results/);
  });

  test('routing and auto-switch lines render, empty routing stays silent', async () => {
    responder = streamResponder([
      { type: 'auto_routed', resolvedModel: 'hermes' },
      { type: 'auto_switched', from: 'HERMES', to: 'MINOS', reason: 'vision' },
      TEXT, DONE,
    ]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).toMatch(/Routed to HERMES/);
    expect(stderr()).toMatch(/Switched HERMES → MINOS/);
    stderrChunks = [];
    responder = streamResponder([{ type: 'auto_routed' }, TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).not.toMatch(/Routed to/);
  });

  test('memory and usage lines render', async () => {
    responder = streamResponder([
      { type: 'memory_created' },
      { type: 'usage', input: 5, output: 7 },
      TEXT, DONE,
    ]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).toMatch(/Memory saved/);
    expect(stderr()).toMatch(/\(5 in \/ 7 out tokens\)/);
  });

  test('title is skipped in human mode; finish_reason length warns, stop stays silent', async () => {
    responder = streamResponder([{ type: 'title', content: 'T' }, TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).not.toContain('T\n');
    stderrChunks = [];
    responder = streamResponder([{ type: 'finish_reason', reason: 'length' }, TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).toMatch(/truncated \(max tokens hit\)/);
    stderrChunks = [];
    responder = streamResponder([{ type: 'finish_reason', reason: 'stop' }, TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).not.toMatch(/truncated/);
  });

  test('error mapping: plan hint, plain error, unknown type silence', async () => {
    responder = streamResponder([{ type: 'error', message: 'upgrade your plan' }]);
    await expect(runChat(['--no-color', 'chat', '--raw', 'hi'])).rejects.toThrow(/Stream error: upgrade your plan/);
    responder = streamResponder([{ type: 'error', message: 'boom' }]);
    await expect(runChat(['--no-color', 'chat', '--raw', 'hi'])).rejects.toThrow(/^Stream error: boom$/);
    responder = streamResponder([{ type: 'something_new', x: 1 }, TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stdout()).toContain('ok');
  });

  test('a null data line and a content-less text event are tolerated', async () => {
    responder = streamResponder([null, { type: 'text' }, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stdout()).not.toContain('undefined');
  });

  test('plain human mode renders through the markdown renderer', async () => {
    responder = streamResponder([{ type: 'text', content: '# Title\n' }, { type: 'text', content: 'body\n' }, DONE]);
    await runChat(['--no-color', 'chat', 'hi']);
    expect(stdout()).toContain('Title');
    expect(stdout()).toContain('body');
  });

  test('a stream error in human mode flushes the renderer before throwing', async () => {
    responder = streamResponder([
      { type: 'text', content: 'partial ' },
      { type: 'error', message: 'boom' },
    ]);
    await expect(runChat(['--no-color', 'chat', 'hi'])).rejects.toThrow(/Stream error: boom/);
    expect(stdout()).toContain('partial');
  });
});

// ───────────────────── JSON-mode event lines ─────────────────────

describe('chat JSON-mode stream events', () => {
  test('every event kind emits a JSON line', async () => {
    responder = streamResponder([
      { type: 'thinking', content: 'hmm' },
      { type: 'search_started', query: 'q' },
      { type: 'search_completed', count: 2, sources: ['a'] },
      { type: 'search_failed' },
      { type: 'auto_routed', resolvedModel: 'minos' },
      { type: 'auto_switched', from: 'A', to: 'B', reason: 'r' },
      { type: 'memory_created' },
      { type: 'title', content: 'T' },
      { type: 'finish_reason', reason: 'stop' },
      { type: 'something_new', x: 1 },
      TEXT, DONE,
    ]);
    await runChat(['--json', 'chat', 'hi']);
    const types = stdout().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { type: string }).type);
    for (const t of ['thinking', 'search_started', 'search_completed', 'search_failed', 'routed', 'auto_switched', 'memory_created', 'title', 'finish_reason', 'something_new', 'chunk', 'done']) {
      expect(types).toContain(t);
    }
  });

  test('a JSON error line is written before the throw', async () => {
    responder = streamResponder([{ type: 'error', message: 'upgrade your plan' }]);
    await expect(runChat(['--json', 'chat', 'hi'])).rejects.toThrow(/Stream error: upgrade your plan/);
    const lines = stdout().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string });
    expect(lines.map((l) => l.type)).toContain('error');
  });
});

// ───────────────────── conversation resolution ─────────────────────

describe('chat conversation resolution', () => {
  test('--conversation fetches and reuses the id', async () => {
    let streamConvo = '';
    responder = (url, init) => {
      if (url.endsWith('/conversations/cnv_9') && init.method === 'GET') {
        return jsonResp(200, { success: true, data: { id: 'cnv_9' } });
      }
      if (url.endsWith('/api/chat/stream')) {
        streamConvo = JSON.parse(String(init.body)).conversationId as string;
        return sseResp([TEXT, DONE]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await runChat(['--no-color', 'chat', '--raw', '--conversation', 'cnv_9', 'hi']);
    expect(streamConvo).toBe('cnv_9');
    expect(stdout()).toContain('ok');
  });

  test('--conversation with a missing id reports not-found', async () => {
    responder = (url, init) => {
      if (url.includes('/conversations/cnv_nope') && init.method === 'GET') {
        return jsonResp(404, { success: false, error: 'not found' });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await expect(
      runChat(['--no-color', 'chat', '--raw', '--conversation', 'cnv_nope', 'hi']),
    ).rejects.toThrow(/Conversation not found: cnv_nope/);
  });

  test('--conversation with a server error rethrows it', async () => {
    responder = (url, init) => {
      if (url.includes('/conversations/cnv_x') && init.method === 'GET') {
        return jsonResp(500, { success: false, error: 'kaput' });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await expect(
      runChat(['--no-color', 'chat', '--raw', '--conversation', 'cnv_x', 'hi']),
    ).rejects.toThrow(/Server error/);
  });

  test('--resume with no previous conversation is rejected', async () => {
    await expect(runChat(['--no-color', 'chat', '--raw', '--resume', 'hi'])).rejects.toThrow(
      /No previous conversation to resume/,
    );
  });

  test('--resume reuses the last conversation without creating one', async () => {
    let creates = 0;
    let streamConvo = '';
    responder = (url, init) => {
      if (url.endsWith('/conversations') && init.method === 'POST') {
        creates += 1;
        return jsonResp(201, { success: true, data: { id: 'cnv_1', title: 'New', model: 'HERMES' } });
      }
      if (url.endsWith('/api/chat/stream')) {
        streamConvo = JSON.parse(String(init.body)).conversationId as string;
        return sseResp([TEXT, DONE]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await runChat(['--no-color', 'chat', '--raw', 'first']);
    expect(creates).toBe(1);
    await runChat(['--no-color', 'chat', '--raw', '--resume', 'second']);
    expect(creates).toBe(1);
    expect(streamConvo).toBe('cnv_1');
  });

  test('no message on a non-TTY is rejected', async () => {
    // Conversation resolution runs before the interactive guard.
    responder = streamResponder([TEXT, DONE]);
    await expect(runChat(['--no-color', 'chat'])).rejects.toThrow(/No message provided/);
  });

  test('an effort the model cannot do is clamped with a notice', async () => {
    responder = streamResponder([TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', '--model', 'hermes', '--effort', 'high', 'hi']);
    expect(stderr()).toMatch(/Effort 'high' isn't supported by Hermes; using 'auto'/);
  });

  test('an unknown effort is rejected', async () => {
    await expect(runChat(['--no-color', 'chat', '--raw', '--effort', 'bogus', 'hi'])).rejects.toThrow(
      /Unknown effort: bogus/,
    );
  });

  test('an image attachment on a non-vision model is rejected before any network call', async () => {
    writeFileSync(join(workDir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(
      runChat(['--no-color', 'chat', '--raw', '--model', 'styx', '--attach', 'pic.png', 'hi']),
    ).rejects.toThrow(/vision/i);
  });

  test('a text attachment is inlined and echoed as a chip', async () => {
    writeFileSync(join(workDir, 'note.txt'), 'hello attach\n');
    let streamBody = '';
    responder = (url, init) => {
      if (url.endsWith('/conversations') && init.method === 'POST') {
        return jsonResp(201, { success: true, data: { id: 'cnv_1', title: 'New', model: 'HERMES' } });
      }
      if (url.endsWith('/api/chat/stream')) {
        streamBody = String(init.body);
        return sseResp([TEXT, DONE]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await runChat(['--no-color', 'chat', '--raw', '--attach', 'note.txt', 'hi']);
    expect(stderr()).toMatch(/\+ attached/);
    expect(streamBody).toContain('hello attach');
  });

  test('an oversized wire message is clamped with an explicit warning', async () => {
    responder = streamResponder([TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'x'.repeat(40_000)]);
    expect(stderr()).toMatch(/message limit/);
  });

  test('a blocking prompt-submit hook rejects with its reason, or bare', async () => {
    responder = streamResponder([TEXT, DONE]);
    const { getConfigPath } = await import('../src/lib/config.js');
    const { dirname } = await import('node:path');
    // A script file, not `echo … >&2; exit 2`: `;` is not a command
    // separator under cmd.exe, so `exit 2` never ran and the chat resolved.
    const script = join(dirname(getConfigPath()), 'block-hook.mjs');
    writeFileSync(script, `process.stderr.write('nope-reason\\n');\nprocess.exit(2);\n`);
    writeFileSync(
      join(dirname(getConfigPath()), 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'prompt-submit', command: `"${process.execPath}" "${script}"` }] }),
    );
    await expect(runChat(['--no-color', 'chat', '--raw', 'hi'])).rejects.toThrow(
      /Prompt blocked by a user hook: nope-reason/,
    );
    writeFileSync(
      join(dirname(getConfigPath()), 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'prompt-submit', command: 'exit 2' }] }),
    );
    // An empty stderr still yields the '(no reason given)' placeholder,
    // so the blocked message always carries a reason.
    await expect(runChat(['--no-color', 'chat', '--raw', 'hi'])).rejects.toThrow(
      /Prompt blocked by a user hook: \(no reason given\)/,
    );
  });

  test('a TTY-shaped run defines the hook approval callback without invoking it', async () => {
    const savedIn = (process.stdin as unknown as { isTTY: unknown }).isTTY;
    const savedOut = (process.stdout as unknown as { isTTY: unknown }).isTTY;
    (process.stdin as unknown as { isTTY: unknown }).isTTY = true;
    (process.stdout as unknown as { isTTY: unknown }).isTTY = true;
    try {
      responder = streamResponder([TEXT, DONE]);
      await runChat(['--no-color', 'chat', '--raw', 'hi']);
      expect(stdout()).toContain('ok');
    } finally {
      (process.stdin as unknown as { isTTY: unknown }).isTTY = savedIn;
      (process.stdout as unknown as { isTTY: unknown }).isTTY = savedOut;
    }
  });
});
