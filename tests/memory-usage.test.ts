import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
}

let responder:
  | ((url: string, init: { method: string; body?: unknown }) => MockResp)
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(
    async (url: string, init: { method?: string; body?: unknown } = {}) => {
      if (!responder) throw new Error('test forgot to set responder');
      return responder(url, {
        method: init.method ?? 'GET',
        body: init.body,
      });
    },
  ),
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

function stdout(): string {
  return stdoutChunks.join('');
}

async function runMemory(argv: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerMemoryCommand } = await import(
    '../src/commands/memory/index.js'
  );
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerMemoryCommand(program);
  await program.parseAsync([
    'node',
    'spycore',
    ...parentArgs,
    'memory',
    ...argv,
  ]);
}

async function runUsage(argv: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerUsageCommand } = await import('../src/commands/usage.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerUsageCommand(program);
  await program.parseAsync(['node', 'spycore', ...parentArgs, 'usage', ...argv]);
}

describe('memory list', () => {
  test('renders a table from /api/memory', async () => {
    responder = (url) => {
      if (url.endsWith('/api/memory')) {
        return jsonResp(200, {
          success: true,
          data: {
            memories: [
              {
                id: 'mem_1',
                category: 'CONTEXT',
                content: 'I prefer concise answers.',
                createdAt: new Date().toISOString(),
              },
              {
                id: 'mem_2',
                category: 'PROFILE',
                content: 'I work as a backend engineer.',
                createdAt: new Date().toISOString(),
              },
            ],
            grouped: {},
            stats: {},
            settings: {},
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runMemory(['list']);
    const out = stdout();
    expect(out).toContain('mem_1');
    expect(out).toContain('CONTEXT');
    expect(out).toContain('I prefer concise answers');
    expect(out).toContain('PROFILE');
  });

  test('--category filters locally', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          memories: [
            { id: 'mem_a', category: 'CONTEXT', content: 'a', createdAt: new Date().toISOString() },
            { id: 'mem_b', category: 'PROFILE', content: 'b', createdAt: new Date().toISOString() },
          ],
        },
      });
    await runMemory(['list', '--category', 'profile']);
    const out = stdout();
    expect(out).toContain('mem_b');
    expect(out).not.toContain('mem_a');
  });

  test('empty list prints placeholder', async () => {
    responder = () => jsonResp(200, { success: true, data: { memories: [] } });
    await runMemory(['list']);
    expect(stdout()).toContain('(no memories yet)');
  });
});

describe('memory add', () => {
  test('POSTs to /api/memory with category + content', async () => {
    let captured: { method?: string; body?: unknown } | null = null;
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/api/memory')) {
        captured = init;
        return jsonResp(201, {
          success: true,
          data: {
            id: 'mem_new',
            category: 'PROFILE',
            content: 'I am a software engineer.',
            createdAt: new Date().toISOString(),
          },
        });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await runMemory(['add', 'I am a software engineer.', '--category', 'profile']);
    expect(captured).not.toBeNull();
    const body = JSON.parse(String((captured as { body?: unknown } | null)?.body ?? '{}'));
    expect(body.category).toBe('PROFILE');
    expect(body.content).toContain('software engineer');
    expect(stdout()).toContain('Added memory mem_new');
  });
});

describe('memory delete', () => {
  test('--yes deletes a single memory', async () => {
    let deleted = false;
    responder = (url, init) => {
      if (init.method === 'DELETE' && url.includes('/api/memory/mem_x')) {
        deleted = true;
        return jsonResp(200, { success: true });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await runMemory(['delete', 'mem_x', '--yes']);
    expect(deleted).toBe(true);
  });

  test('--all --yes deletes everything with confirm body', async () => {
    let captured: unknown = null;
    responder = (url, init) => {
      if (init.method === 'DELETE' && url.endsWith('/api/memory')) {
        captured = init.body;
        return jsonResp(200, { success: true, cleared: 7 });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await runMemory(['delete', '--all', '--yes']);
    const body = JSON.parse(String(captured ?? '{}'));
    expect(body.confirm).toBe('delete everything');
  });

  test('refuses --all without --yes in non-TTY', async () => {
    responder = () => jsonResp(200, { success: true });
    let caught: unknown = null;
    try {
      await runMemory(['delete', '--all']);
    } catch (err) {
      caught = err;
    }
    expect(caught !== null || stderrChunks.join('').length > 0).toBe(true);
  });
});

describe('usage command', () => {
  // Mirrors the REAL GET /api/usage shape (routes/user/index.ts +
  // getUsageSnapshot): plan + planDisplay, allModels/hephaestus bucket blocks,
  // weekly totals split, and the UPPERCASE per-model credit breakdown.
  const sample = {
    plan: 'PRO',
    planDisplay: 'Max 5×',
    resetsOn: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString(),
    allModels: {
      fiveHour: {
        used: 200,
        limit: 1000,
        resetAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      weekly: {
        used: 1500,
        limit: 5000,
        resetAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      },
    },
    hephaestus: {
      fiveHour: { used: 0, limit: 5, resetAt: null },
      weekly: { used: 3, limit: 50, resetAt: null },
    },
    perModel: {
      HERMES: { fiveHour: 100, weekly: 600 },
      MINOS: { fiveHour: 50, weekly: 200 },
      STYX: { fiveHour: 30, weekly: 400 },
      CHARON: { fiveHour: 20, weekly: 300 },
      HEPHAESTUS: { fiveHour: 0, weekly: 0 },
    },
    weekly: {
      totals: { messagesUsed: 142, messagesLimit: 5000, imagesUsed: 3, imagesLimit: 50 },
    },
  };

  test('full shape: plan display, bars, reset times, totals, image bucket, per-model table', async () => {
    responder = () => jsonResp(200, { success: true, data: sample });
    await runUsage([]);
    const out = stdout();
    expect(out).toContain('Plan: Max 5×  (PRO)'); // planDisplay preferred, raw enum rides along
    expect(out).toContain('5-hour window (all chat models)');
    expect(out).toContain('200 / 1000 (20%)');
    expect(out).toMatch(/resets in \d+m|resets in \d+h/); // 5h reset rendered
    expect(out).toContain('Weekly cap (all chat models)');
    expect(out).toContain('1500 / 5000 (30%)');
    expect(out).toContain('resets in 3d'); // weekly uses resetsOn (next Monday)
    expect(out).toContain('This week: messages 142/5000 · images 3/50');
    expect(out).toContain('Images (5-hour)');
    expect(out).toContain('Images (weekly)');
    expect(out).toContain('3 / 50');
    expect(out).toContain('Per-model usage (credits)');
    expect(out).toContain('█'); // bars rendered
  });

  test('per-model table uses SpyCore display names, never raw enum keys', async () => {
    responder = () => jsonResp(200, { success: true, data: sample });
    await runUsage([]);
    const out = stdout();
    for (const display of ['Hermes', 'Minos', 'Styx', 'Charon', 'Hephaestus']) {
      expect(out).toContain(display);
    }
    // Raw UPPERCASE keys must not leak into the table (PRO plan tail is fine).
    expect(out).not.toMatch(/^HERMES/m);
    expect(out).not.toMatch(/^HEPHAESTUS/m);
  });

  test('partial shape: missing fields are omitted without crashing', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          plan: 'STARTER',
          allModels: { fiveHour: { used: 3, limit: 855 } }, // no weekly, no resetAt
          // no planDisplay, no hephaestus, no perModel, no totals
        },
      });
    await runUsage([]);
    const out = stdout();
    expect(out).toContain('Plan: STARTER');
    expect(out).toContain('3 / 855');
    expect(out).not.toContain('Weekly cap');
    expect(out).not.toContain('Images');
    expect(out).not.toContain('Per-model');
    expect(out).not.toContain('resets'); // no resetAt → no reset tail
  });

  test('empty payload renders nothing but does not crash', async () => {
    responder = () => jsonResp(200, { success: true, data: {} });
    await runUsage([]);
    expect(stdout().trim()).toBe('');
  });

  test('--rolling skips the weekly bucket and the table', async () => {
    responder = () => jsonResp(200, { success: true, data: sample });
    await runUsage(['--rolling']);
    const out = stdout();
    expect(out).toContain('5-hour window');
    expect(out).not.toContain('Weekly cap');
    expect(out).not.toContain('Per-model');
  });

  test('--week skips the rolling window', async () => {
    responder = () => jsonResp(200, { success: true, data: sample });
    await runUsage(['--week']);
    const out = stdout();
    expect(out).toContain('Weekly cap (all chat models)');
    expect(out).not.toContain('5-hour window');
  });

  test('--json mode emits the raw payload untouched', async () => {
    responder = () => jsonResp(200, { success: true, data: sample });
    await runUsage([], ['--json']);
    const parsed = JSON.parse(stdout().trim());
    expect(parsed.plan).toBe('PRO');
    expect(parsed.planDisplay).toBe('Max 5×');
    expect(parsed.allModels.fiveHour.used).toBe(200);
    expect(parsed.perModel.HERMES.weekly).toBe(600); // passthrough keeps raw keys
  });

  test('401 → clean auth error with the login hint', async () => {
    responder = () => jsonResp(401, { success: false, error: 'Unauthorized' });
    await expect(runUsage([])).rejects.toMatchObject({
      message: expect.stringContaining('Authentication failed'),
      hint: expect.stringContaining('spycore login'),
    });
  });
});
