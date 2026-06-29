import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
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

function stderr(): string {
  return stderrChunks.join('');
}

describe('handleSlashCommand', () => {
  test('/help prints command reference to stderr', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/help', {
      json: false,
      color: false,
      currentConvo: 'cnv_x',
      apiUrl: undefined,
    });
    expect(r.consumed).toBe(true);
    expect(stderr()).toContain('/model');
    expect(stderr()).toContain('/save');
    expect(stderr()).toContain('/exit');
  });

  test('/model rejects unknown models without changing state', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/model fakemodel', {
      json: false,
      color: false,
      currentConvo: 'cnv_x',
      apiUrl: undefined,
    });
    expect(r.consumed).toBe(true);
    expect(r.newModel).toBeUndefined();
    expect(stderr()).toContain('Unknown model');
  });

  test('/model sets a valid model', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/model styx', {
      json: false,
      color: false,
      currentConvo: 'cnv_x',
      apiUrl: undefined,
    });
    expect(r.consumed).toBe(true);
    expect(r.newModel).toBe('styx');
  });

  test('/new requests a fresh conversation', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/new', {
      json: false,
      color: false,
      currentConvo: 'cnv_x',
      apiUrl: undefined,
    });
    expect(r.newConvo).toBe(true);
  });

  test('/exit signals end of session', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/exit', {
      json: false,
      color: false,
      currentConvo: 'cnv_x',
      apiUrl: undefined,
    });
    expect(r.exit).toBe(true);
  });

  test('unknown slash command keeps loop running and surfaces a hint', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/wat', {
      json: false,
      color: false,
      currentConvo: 'cnv_x',
      apiUrl: undefined,
    });
    expect(r.consumed).toBe(true);
    expect(r.exit).toBeUndefined();
    expect(stderr()).toContain('Unknown command');
  });

  test('/save writes a markdown export of the current conversation', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'spycli-slash-'));
    try {
      responder = (url) => {
        if (url.includes('/conversations/cnv_x')) {
          return jsonResp(200, {
            success: true,
            data: {
              id: 'cnv_x',
              title: 'Demo',
              model: 'HERMES',
              messages: [
                { role: 'user', content: 'hi', createdAt: new Date().toISOString() },
                {
                  role: 'assistant',
                  model: 'HERMES',
                  content: 'hello',
                  createdAt: new Date().toISOString(),
                },
              ],
            },
          });
        }
        throw new Error(`unexpected ${url}`);
      };

      const { handleSlashCommand } = await import('../src/commands/chat.js');
      const file = join(workDir, 'out.md');
      const r = await handleSlashCommand(`/save ${file}`, {
        json: false,
        color: false,
        currentConvo: 'cnv_x',
        apiUrl: undefined,
      });
      expect(r.consumed).toBe(true);
      const md = readFileSync(file, 'utf8');
      expect(md).toContain('# Demo');
      expect(md).toContain('## You');
      expect(md).toContain('## HERMES');
      expect(md).toContain('hi');
      expect(md).toContain('hello');
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe('conversationToMarkdown', () => {
  test('escapes-free output retains content order and headings', async () => {
    const { conversationToMarkdown } = await import('../src/commands/chat.js');
    const md = conversationToMarkdown({
      id: 'cnv_a',
      title: 'Test',
      model: 'HERMES',
      messages: [
        { role: 'user', content: 'one', createdAt: new Date().toISOString() },
        {
          role: 'assistant',
          model: 'MINOS',
          content: 'two',
          createdAt: new Date().toISOString(),
        },
      ],
    });
    expect(md).toContain('# Test');
    expect(md).toMatch(/## You[\s\S]+one[\s\S]+## MINOS[\s\S]+two/);
  });
});
