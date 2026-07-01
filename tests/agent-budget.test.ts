import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';
import { headlessApproval } from '../src/lib/agent/approval.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown>; [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> };
}

let responder: ((url: string, init: { method: string }) => MockResp) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET' });
  }),
}));

let workDir: string;

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  workDir = mkdtempSync(join(tmpdir(), 'spycli-budget-'));
  writeFileSync(join(workDir, 'x.txt'), 'hello');
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: { json: async () => ({}), [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator]() },
  };
}

const block = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

/** Responder whose every chat turn emits a tool call (so the loop keeps going) + usage. */
function neverEndingResponder(input: number, output: number, beforeTurn?: () => void) {
  return (url: string, init: { method: string }): MockResp => {
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return { statusCode: 200, headers: {}, body: { json: async () => ({ success: true, data: { id: 'cnv_b' } }) } };
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      beforeTurn?.();
      return sseResp([
        { type: 'text', content: block('read_file', { path: 'x.txt' }) },
        { type: 'usage', input, output },
        { type: 'done' },
      ]);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

/** Responder whose turn is a final answer (no tool block) + usage. */
function finishingResponder(text: string, input: number, output: number) {
  return (url: string, init: { method: string }): MockResp => {
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return { statusCode: 200, headers: {}, body: { json: async () => ({ success: true, data: { id: 'cnv_b' } }) } };
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      return sseResp([{ type: 'text', content: text }, { type: 'usage', input, output }, { type: 'done' }]);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

describe('runAgent — cost/runaway budgets', () => {
  test('token cap stops the run gracefully (exit reason: tokens)', async () => {
    responder = neverEndingResponder(600, 400); // 1000 tokens/turn
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const { createBudget } = await import('../src/lib/agent/budget.js');
    const budget = createBudget({ maxTokens: 1500 });
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 't',
      cwd: workDir,
      budget,
      requestApproval: headlessApproval(true),
      onEvent: (e) => events.push(e),
    });
    expect(result.budgetStop).toBe('tokens');
    expect(result.turns).toBe(2); // 1000 + 1000 = 2000 ≥ 1500 → stops at the next boundary
    expect(result.reachedMaxTurns).toBe(false);
    expect(events.find((e) => e.type === 'budget_stop')).toMatchObject({ reason: 'tokens', cap: 1500 });
  });

  test('explicit turn cap stops after N round-trips (and replaces max_turns)', async () => {
    responder = neverEndingResponder(10, 10);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const { createBudget } = await import('../src/lib/agent/budget.js');
    const budget = createBudget({ maxTurns: 2 });
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 't', cwd: workDir, maxTurns: 2, budget, onEvent: (e) => events.push(e) });
    expect(result.budgetStop).toBe('turns');
    expect(result.turns).toBe(2);
    expect(events.find((e) => e.type === 'budget_stop')).toMatchObject({ reason: 'turns', cap: 2 });
    expect(events.some((e) => e.type === 'max_turns')).toBe(false);
  });

  test('time cap stops the run, using the injected clock', async () => {
    let clock = 0;
    responder = neverEndingResponder(10, 10, () => {
      clock += 3000; // each model round-trip "takes" 3s
    });
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const { createBudget } = await import('../src/lib/agent/budget.js');
    const budget = createBudget({ maxTimeMs: 5000 }, () => clock); // startMs = 0
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 't', cwd: workDir, budget, onEvent: (e) => events.push(e) });
    expect(result.budgetStop).toBe('time');
    expect(events.find((e) => e.type === 'budget_stop')).toMatchObject({ reason: 'time', cap: 5000 });
  });

  test('no budget configured → behaves exactly as before (no budget events)', async () => {
    responder = finishingResponder('All done.', 10, 10);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 't', cwd: workDir, onEvent: (e) => events.push(e) });
    expect(result.budgetStop).toBeNull();
    expect(result.finalText).toContain('All done');
    expect(events.some((e) => e.type === 'budget' || e.type === 'budget_stop')).toBe(false);
  });

  test('a run that finishes within budget emits a running indicator but no stop', async () => {
    responder = finishingResponder('Done early.', 100, 50);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const { createBudget } = await import('../src/lib/agent/budget.js');
    const budget = createBudget({ maxTokens: 100000 });
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 't', cwd: workDir, budget, onEvent: (e) => events.push(e) });
    expect(result.budgetStop).toBeNull();
    expect(events.find((e) => e.type === 'budget')).toMatchObject({ tokensUsed: 150 });
  });
});
