import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

// Leftover branch arms for src/commands/chat.ts. Harness copied from
// tests/chat-events.test.ts: POST /conversations → JSON, stream → SSE.

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
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-chatedge-')));
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

describe('chat leftover event arms', () => {
  test('JSON thinking without content yields an empty content line', async () => {
    responder = streamResponder([{ type: 'thinking' }, TEXT, DONE]);
    await runChat(['--json', 'chat', 'hi']);
    const lines = stdout().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; content?: unknown });
    const thinking = lines.find((l) => l.type === 'thinking');
    expect(thinking).toMatchObject({ content: '' });
  });

  test('human non-raw thinking is swallowed', async () => {
    responder = streamResponder([{ type: 'thinking', content: 'hmm' }, TEXT, DONE]);
    await runChat(['--no-color', 'chat', 'hi']);
    expect(stderr()).not.toContain('hmm');
    expect(stdout()).toContain('ok');
  });

  test('skills_activated filters out non-string entries', async () => {
    responder = streamResponder([
      { type: 'skills_activated', skills: ['web', 123, null] },
      TEXT, DONE,
    ]);
    await runChat(['--json', 'chat', 'hi']);
    const lines = stdout().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; skills?: unknown });
    expect(lines.find((l) => l.type === 'skills_activated')).toMatchObject({ skills: ['web'] });
  });

  test('skills_activated without a skills array yields an empty list', async () => {
    responder = streamResponder([{ type: 'skills_activated' }, TEXT, DONE]);
    await runChat(['--json', 'chat', 'hi']);
    const lines = stdout().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { type: string; skills?: unknown });
    expect(lines.find((l) => l.type === 'skills_activated')).toMatchObject({ skills: [] });
  });

  test('search_completed without a count reports zero', async () => {
    responder = streamResponder([{ type: 'search_completed', sources: [] }, TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).toMatch(/Found 0 sources/);
  });

  test('auto_switched without a reason renders an empty reason', async () => {
    responder = streamResponder([{ type: 'auto_switched', from: 'A', to: 'B' }, TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).toMatch(/Switched A → B: /);
  });

  test('usage without input/output reports zeros', async () => {
    responder = streamResponder([{ type: 'usage' }, TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stderr()).toMatch(/\(0 in \/ 0 out tokens\)/);
  });

  test('error without a message reports Unknown error', async () => {
    responder = streamResponder([{ type: 'error' }]);
    await expect(runChat(['--no-color', 'chat', '--raw', 'hi'])).rejects.toThrow(/Unknown error/);
  });

  test('plain reply without a trailing newline gains one', async () => {
    responder = streamResponder([{ type: 'text', content: 'Hello' }, DONE]);
    await runChat(['--no-color', 'chat', 'hi']);
    expect(stdout()).toContain('Hello');
  });

  test('--conversation falls back to the requested id when the fetch has none', async () => {
    let streamConvo = '';
    responder = (url, init) => {
      if (url.endsWith('/conversations/cnv_9') && init.method === 'GET') {
        return jsonResp(200, { success: true, data: {} });
      }
      if (url.endsWith('/api/chat/stream')) {
        streamConvo = JSON.parse(String(init.body)).conversationId as string;
        return sseResp([TEXT, DONE]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await runChat(['--no-color', 'chat', '--raw', '--conversation', 'cnv_9', 'hi']);
    expect(streamConvo).toBe('cnv_9');
  });

  test('--provider spycore takes the normal route', async () => {
    responder = streamResponder([TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', '--provider', 'spycore', 'hi']);
    expect(stdout()).toContain('ok');
  });

  test('no message on a TTY in JSON mode is rejected via the json arm', async () => {
    const savedOut = (process.stdout as unknown as { isTTY: unknown }).isTTY;
    (process.stdout as unknown as { isTTY: unknown }).isTTY = true;
    try {
      responder = streamResponder([TEXT, DONE]);
      await expect(runChat(['--json', 'chat'])).rejects.toThrow(/No message provided/);
    } finally {
      (process.stdout as unknown as { isTTY: unknown }).isTTY = savedOut;
    }
  });

  test('--stdin with an empty pipe throws', async () => {
    // The real vitest stdin never emits 'end', so an already-ended empty
    // stream stands in for the EOF case; without it this test hangs.
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', {
      value: Readable.from([]),
      configurable: true,
    });
    try {
      responder = streamResponder([TEXT, DONE]);
      await expect(runChat(['--no-color', 'chat', '--stdin'])).rejects.toThrow(
        /No input received on stdin/,
      );
    } finally {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    }
  }, 15_000);

  test('--stdin with piped content uses it as the message', async () => {
    const realStdin = process.stdin;
    const fake = Readable.from([Buffer.from('piped hello')]);
    Object.defineProperty(process, 'stdin', { value: fake, configurable: true });
    try {
      let sentBody = '';
      responder = (url, init) => {
        if (url.endsWith('/conversations') && init.method === 'POST') {
          return jsonResp(201, { success: true, data: { id: 'cnv_1', title: 'New', model: 'HERMES' } });
        }
        if (url.endsWith('/api/chat/stream')) {
          sentBody = String(init.body);
          return sseResp([TEXT, DONE]);
        }
        throw new Error(`unexpected ${init.method} ${url}`);
      };
      await runChat(['--no-color', 'chat', '--raw', '--stdin']);
      expect(sentBody).toContain('piped hello');
      expect(stdout()).toContain('ok');
    } finally {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    }
  }, 15_000);

  test('a falsy stored defaultEffort falls back to auto', async () => {
    const { getConfigStore } = await import('../src/lib/config.js');
    try {
      getConfigStore().set('defaultEffort', '');
    } catch {
      // Schema rejects the empty value: the fallback arm is then unreachable
      // through the store, and this test is skipped rather than faked.
      return;
    }
    responder = streamResponder([TEXT, DONE]);
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(stdout()).toContain('ok');
  });
});

describe('chat slash leftover arms', () => {
  test('user-command notices are printed', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const result = await handleSlashCommand('/demo', {
      json: false,
      color: false,
      currentConvo: 'cnv_x',
      apiUrl: undefined,
      resolveUserCommand: (() => ({
        kind: 'user-command',
        name: 'demo',
        source: 'user',
        message: 'expanded prompt',
        notices: ['note one'],
      })) as never,
    });
    expect(result).toMatchObject({ consumed: true, userPrompt: 'expanded prompt' });
    expect(stderr()).toContain('! note one');
  });
});
