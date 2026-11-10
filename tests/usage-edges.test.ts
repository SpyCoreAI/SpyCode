import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
}

let responder: ((url: string, init: { method: string }) => MockResp) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET' });
  }),
}));

function jsonResp(statusCode: number, body: unknown): MockResp {
  return { statusCode, headers: { 'content-type': 'application/json' }, body: { json: async () => body } };
}

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

function stdout(): string {
  return stdoutChunks.join('');
}
function allOut(): string {
  return stdoutChunks.join('') + stderrChunks.join('');
}

async function runCli(argv: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerUsageCommand } = await import('../src/commands/usage.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerUsageCommand(program);
  await program.parseAsync(['node', 'spycore', ...parentArgs, ...argv]);
}

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

function usageData(data: Record<string, unknown>) {
  responder = (url) => {
    if (url.includes('/api/usage')) return jsonResp(200, { success: true, data });
    throw new Error(`unexpected ${url}`);
  };
}

describe('usage edges', () => {
  test('a zero limit renders a full bar and an infinite percent', async () => {
    usageData({ plan: 'PRO', allModels: { fiveHour: { used: 5, limit: 0 } } });
    await runCli(['usage']);
    const out = stdout();
    expect(out).toContain('─'.repeat(24));
    expect(out).toContain('5 / 0 (∞)');
  });

  test('a bucket without used or limit renders 0 / 0', async () => {
    usageData({ plan: 'PRO', allModels: { fiveHour: { used: 3 } } });
    await runCli(['usage']);
    expect(stdout()).toContain('3 / 0 (∞)');
  });

  test('reset timestamps: garbage is silent, past is now, seconds, hours', async () => {
    usageData({
      plan: 'PRO',
      allModels: {
        fiveHour: { used: 1, limit: 10, resetAt: 'garbage' },
        weekly: { used: 2, limit: 100, resetAt: new Date(Date.now() - 1000).toISOString() },
      },
      hephaestus: {
        fiveHour: { used: 0, limit: 10, resetAt: new Date(Date.now() + 30_000).toISOString() },
        weekly: { used: 0, limit: 10, resetAt: new Date(Date.now() + 2 * 3600_000 + 5.5 * 60_000).toISOString() },
      },
    });
    await runCli(['usage']);
    const out = stdout();
    expect(out).toContain('resets now');
    expect(out).toMatch(/in \d+s/);
    expect(out).toContain('in 2h 5m');
    expect(out).not.toContain('garbage');
  });

  test('weekly totals render messages and images with infinite fallbacks', async () => {
    usageData({
      plan: 'PRO',
      allModels: { weekly: { used: 2, limit: 100 } },
      weekly: { totals: { messagesUsed: 42, imagesUsed: 7 } },
    });
    await runCli(['usage']);
    expect(stdout()).toContain('This week: messages 42/∞ · images 7/∞');
  });

  test('an exact-hour reset renders without minutes', async () => {
    usageData({
      plan: 'PRO',
      allModels: { weekly: { used: 2, limit: 100, resetAt: new Date(Date.now() + 2 * 3600_000 + 30_000).toISOString() } },
    });
    await runCli(['usage']);
    expect(stdout()).toContain('in 2h');
    expect(stdout()).not.toContain('in 2h 0m');
  });

  test('weekly totals with only images render the images part alone', async () => {
    usageData({
      plan: 'PRO',
      allModels: { weekly: { used: 2, limit: 100 } },
      weekly: { totals: { imagesUsed: 7 } },
    });
    await runCli(['usage']);
    expect(stdout()).toContain('This week: images 7/∞');
    expect(stdout()).not.toContain('messages');
  });

  test('weekly totals with limits render the limits', async () => {
    usageData({
      plan: 'PRO',
      allModels: { weekly: { used: 2, limit: 100 } },
      weekly: { totals: { messagesUsed: 42, messagesLimit: 500, imagesUsed: 7, imagesLimit: 50 } },
    });
    await runCli(['usage']);
    expect(stdout()).toContain('messages 42/500 · images 7/50');
  });

  test('weekly resetAt falls back to the bucket resetAt when resetsOn is absent', async () => {
    usageData({
      plan: 'PRO',
      allModels: { weekly: { used: 2, limit: 100, resetAt: new Date(Date.now() + 3.5 * 86400_000).toISOString() } },
    });
    await runCli(['usage']);
    expect(stdout()).toContain('in 3d');
  });

  test('per-model rows render zero for missing windows', async () => {
    usageData({ plan: 'PRO', perModel: { HERMES: {} } });
    await runCli(['usage']);
    const out = stdout();
    expect(out).toContain('Per-model usage');
    expect(out).toContain('Hermes');
    expect(out).toMatch(/Hermes\s+0\s+0/);
  });

  test('JSON format passes the payload through', async () => {
    usageData({ plan: 'PRO', allModels: { weekly: { used: 2, limit: 100 } } });
    await runCli(['usage'], ['--json']);
    const parsed = JSON.parse(stdout().trim());
    expect(parsed.plan).toBe('PRO');
  });

  test('a non-text format renders structured output', async () => {
    usageData({ plan: 'PRO', allModels: { weekly: { used: 2, limit: 100 } } });
    await runCli(['usage', '--format', 'yaml']);
    expect(allOut()).toContain('PRO');
  });

  // R3-13: a success envelope with null `data` used to crash on
  // `data.planDisplay` with a raw TypeError.
  test('a null usage body fails cleanly instead of crashing', async () => {
    responder = (url) => {
      if (url.includes('/api/usage')) return jsonResp(200, { success: true, data: null });
      throw new Error(`unexpected ${url}`);
    };
    await expect(runCli(['usage'])).rejects.toThrow(/Unexpected server response/);
  });
});
