/**
 * Phase 4b2 - handoff lifecycle hooks + --cmd-timeout.
 *
 * The agent loop and the hook loader are mocked so the test proves the
 * handoff command itself loads the hook session, fires session-start /
 * prompt-submit / session-end, and threads the configured run_command
 * timeout through - without running a real agent turn.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { RunAgentOptions } from '../src/lib/agent/loop.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  request: vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET', body: init.body });
  }),
}));

const runAgentMock = vi.hoisted(() =>
  vi.fn(async (_opts: RunAgentOptions) => ({
    turns: 1,
    toolCalls: 0,
    changedFiles: 0,
    cancelled: false,
    budgetStop: null,
    reachedMaxTurns: false,
  })),
);
const hookCalls = vi.hoisted(() => ({ load: 0, events: [] as string[], bridge: 0 }));

vi.mock('../src/lib/agent/loop.js', () => ({
  runAgent: runAgentMock,
  CONTINUE_HINT: 'CONTINUE',
  DEFAULT_MAX_TURNS: 25,
  MAX_TURNS_CAP: 200,
  MIN_TURNS: 1,
}));

vi.mock('../src/lib/hooks.js', () => ({
  loadHookSession: vi.fn(async () => {
    hookCalls.load += 1;
    return { notices: [] };
  }),
  fireHookEvent: vi.fn(async (_session: unknown, event: string) => {
    hookCalls.events.push(event);
    return { notices: [], blocked: false };
  }),
  createAgentHooksBridge: vi.fn(() => {
    hookCalls.bridge += 1;
    return { hasAny: false };
  }),
}));

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origCwd = process.cwd();
let workDir: string;

function jsonResp(status: number, body: unknown): MockResp {
  return {
    statusCode: status,
    headers: {},
    body: { json: async () => body },
  };
}

async function runHandoff(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerConversationsCommand } = await import(
    '../src/commands/conversations/index.js'
  );
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: false, color: false });
  const program = new Command();
  program.exitOverride();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerConversationsCommand(program);
  await program.parseAsync(['node', 'spycore', 'conversations', ...argv]);
}

beforeEach(async () => {
  freshConfigDir();
  responder = (url) => {
    if (url.includes('/conversations/cnv_1')) {
      return jsonResp(200, {
        success: true,
        data: {
          id: 'cnv_1',
          title: 'Web chat',
          model: 'hermes',
          messages: [
            { id: 'm1', role: 'user', content: 'hi', createdAt: new Date().toISOString() },
          ],
        },
      });
    }
    throw new Error(`unexpected ${url}`);
  };
  stdoutChunks = [];
  stderrChunks = [];
  workDir = mkdtempSync(join(tmpdir(), 'spycli-4b2-handoff-'));
  process.chdir(workDir);
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
  runAgentMock.mockClear();
  hookCalls.load = 0;
  hookCalls.events = [];
  hookCalls.bridge = 0;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.chdir(origCwd);
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('conversations handoff hooks and --cmd-timeout', () => {
  test('loads the hook session and fires session-start, prompt-submit, session-end', async () => {
    await runHandoff(['handoff', 'cnv_1']);
    expect(hookCalls.load).toBe(1);
    expect(hookCalls.events).toEqual(['session-start', 'prompt-submit', 'session-end']);
    expect(hookCalls.bridge).toBe(1);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    // First import of the conversations module graph exceeds the 10s default
    // on this VM (same as tests/fix-4b2.test.ts); the timeout covers import
    // cost, not the assertions.
  }, 60000);

  test('--cmd-timeout 5 threads 5000ms through to runAgent', async () => {
    await runHandoff(['handoff', 'cnv_1', '--cmd-timeout', '5']);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({ commandTimeoutMs: 5000 });
  });

  test('the default timeout is 120000ms when the flag is omitted', async () => {
    await runHandoff(['handoff', 'cnv_1']);
    expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({ commandTimeoutMs: 120000 });
  });

  test('--cmd-timeout abc errors before any agent work', async () => {
    await expect(runHandoff(['handoff', 'cnv_1', '--cmd-timeout', 'abc'])).rejects.toThrow(
      /Invalid --cmd-timeout/,
    );
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(hookCalls.load).toBe(0);
  });
});
