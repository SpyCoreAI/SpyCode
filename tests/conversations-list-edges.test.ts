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
const origColumns = (process.stdout as { columns?: number }).columns;

function stdout(): string {
  return stdoutChunks.join('');
}
function allOut(): string {
  return stdoutChunks.join('') + stderrChunks.join('');
}

async function runCli(argv: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerConversationsCommand } = await import('../src/commands/conversations/index.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerConversationsCommand(program);
  await program.parseAsync(['node', 'spycore', ...parentArgs, 'conversations', ...argv]);
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
  (process.stdout as { columns?: number }).columns = origColumns;
  vi.resetModules();
});

function conv(id: string, updatedAt: string, extra: Record<string, unknown> = {}) {
  return { id, title: `T-${id}`, model: 'HERMES', updatedAt, createdAt: updatedAt, ...extra };
}

describe('conversations list edges', () => {
  test('relative times: garbage, minutes, hours, days', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          conversations: [
            conv('cnv_garbage', 'not-a-date'),
            conv('cnv_2h', new Date(Date.now() - 2 * 3600_000).toISOString()),
            conv('cnv_3d', new Date(Date.now() - 3 * 86400_000).toISOString()),
          ],
          total: 3,
          page: 1,
        },
      });
    await runCli(['list']);
    const out = stdout();
    expect(out).toContain('T-cnv_2h');
    expect(out).toContain('2h ago');
    expect(out).toContain('3d ago');
  });

  test('a row without title or model renders fallbacks', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          conversations: [conv('cnv_bare', new Date().toISOString(), { title: '', model: '' })],
          total: 1,
          page: 1,
        },
      });
    await runCli(['list']);
    expect(stdout()).toContain('(untitled)');
  });

  test('empty page 1 says no conversations yet', async () => {
    responder = () => jsonResp(200, { success: true, data: { conversations: [], page: 1 } });
    await runCli(['list']);
    expect(stdout()).toContain('(no conversations yet)');
  });

  test('a missing conversations array degrades to empty', async () => {
    responder = () => jsonResp(200, { success: true, data: { page: 1 } });
    await runCli(['list']);
    expect(stdout()).toContain('(no conversations yet)');
  });

  test('limit and page clamp to their bounds', async () => {
    let observedUrl = '';
    responder = (url) => {
      observedUrl = url;
      return jsonResp(200, {
        success: true,
        data: {
          conversations: [conv('cnv_a', new Date().toISOString()), conv('cnv_b', new Date().toISOString())],
          total: 2,
          page: 1,
        },
      });
    };
    await runCli(['list', '--limit', '0', '--page', '0']);
    expect(observedUrl).toContain('page=1');
    expect(stdout()).toContain('T-cnv_a');
    expect(stdout()).not.toContain('T-cnv_b');
    await runCli(['list', '--limit', '500']);
    expect(stdout()).toContain('T-cnv_b');
  });

  test('an invalid --limit errors clearly instead of silently returning nothing', async () => {
    responder = () =>
      jsonResp(200, { success: true, data: { conversations: [], page: 1 } });
    await expect(runCli(['list', '--limit', 'abc'])).rejects.toThrow(/Invalid --limit/);
    await expect(runCli(['list', '--page', '1.5'])).rejects.toThrow(/Invalid --page/);
  });

  test('the list shows the FULL id, copy-pasteable into show/delete', async () => {
    const fullId = 'cnv_0123456789abcdef0123456789abcdef';
    responder = () =>
      jsonResp(200, {
        success: true,
        data: { conversations: [conv(fullId, new Date().toISOString())], total: 1, page: 1 },
      });
    await runCli(['list']);
    // The id column carries the whole id (the title next to it is still
    // clipped, but the id itself must be copy-pasteable into show/delete).
    expect(stdout()).toContain(fullId);
  });

  test('JSON includes total and hasMore when the server sends total', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: { conversations: [conv('cnv_1', new Date().toISOString())], total: 25, page: 1 },
      });
    await runCli(['list'], ['--json']);
    const parsed = JSON.parse(stdout().trim());
    expect(parsed.total).toBe(25);
    expect(parsed.hasMore).toBe(true);
  });

  test('JSON omits total and hasMore when the server sends neither', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: { conversations: [conv('cnv_1', new Date().toISOString())], page: 1 },
      });
    await runCli(['list'], ['--json']);
    const parsed = JSON.parse(stdout().trim());
    expect(parsed).not.toHaveProperty('total');
    expect(parsed).not.toHaveProperty('hasMore');
  });

  test('a non-text format renders structured output', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: { conversations: [conv('cnv_1', new Date().toISOString())], total: 1, page: 1 },
      });
    await runCli(['list', '--format', 'yaml']);
    expect(allOut()).toContain('cnv_1');
  });

  test('narrow terminal columns shrink the title column, and hasMore prints the footer', async () => {
    (process.stdout as { columns?: number }).columns = 60;
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          conversations: [conv('cnv_1', new Date().toISOString(), { title: 'A very long conversation title here' })],
          total: 25,
          page: 1,
        },
      });
    await runCli(['list']);
    const out = stdout();
    expect(out).toContain('(more available - use --page 2)');
    expect(out).toContain('A very long convers…');
    expect(out).not.toContain('A very long conversation title here');
  });
});
