import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import {
  AUTO_COMPACT_PCT,
  AUTO_COMPACT_REARM_PCT,
  autoCompactPct,
  autoCompactWarnText,
  createAutoCompactTrigger,
} from '../src/lib/agent/auto-compact.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';

/**
 * F4 - auto-compact at the context ceiling (95%).
 *
 * Pinned here:
 *  - the 95% threshold is a constant (AUTO_COMPACT_PCT);
 *  - the trigger is one-shot with hysteresis: fires at/above 95, never
 *    below; re-arms only below the 80 re-arm line;
 *  - the trigger NEVER fires while an approval gate is open - it stays
 *    armed and defers the signal instead of dropping it;
 *  - a null reading (model with no published window, e.g. BYOK) never
 *    fires and never changes the trigger state;
 *  - the loop raises `context_full` with the turn, pct and input tokens
 *    when the previous turn's usage crosses the threshold.
 */

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: {
    json: () => Promise<unknown>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
  };
}

let responder:
  | ((url: string, init: { method: string; body?: unknown; headers?: Record<string, string> }) => MockResp)
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(
    async (
      url: string,
      init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) => {
      if (!responder) throw new Error('test forgot to set responder');
      return responder(url, { method: init.method ?? 'GET', body: init.body, headers: init.headers });
    },
  ),
}));

let workDir: string;

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  workDir = mkdtempSync(join(tmpdir(), 'spycli-autocompact-'));
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

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: {
      json: async () => ({}),
      [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator](),
    },
  };
}

/** One scripted turn: optional tool block, a usage event, then done. */
function turn(opts: { text?: string; tool?: { tool: string; args: unknown }; input: number }) {
  const events: Array<Record<string, unknown>> = [];
  const text = opts.tool
    ? `Calling tool.\n\`\`\`spycore:tool\n${JSON.stringify({ tool: opts.tool.tool, args: opts.tool.args })}\n\`\`\``
    : (opts.text ?? 'Done.');
  events.push({ type: 'text', content: text });
  events.push({ type: 'usage', input: opts.input, output: 50 });
  events.push({ type: 'done' });
  return sseResp(events);
}

function makeResponder(turns: MockResp[]) {
  let i = 0;
  return (url: string, init: { method: string }) => {
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return jsonResp(200, { success: true, data: { id: 'cnv_autocompact' } });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      return turns[Math.min(i++, turns.length - 1)]!;
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

describe('auto-compact trigger (unit)', () => {
  test('the threshold is a constant 95', () => {
    expect(AUTO_COMPACT_PCT).toBe(95);
    expect(AUTO_COMPACT_REARM_PCT).toBe(80);
  });

  test('fires at exactly 95, not at 94', () => {
    const t = createAutoCompactTrigger();
    expect(t.check(94, false)).toBe(false);
    expect(t.fired).toBe(false);
    expect(t.check(95, false)).toBe(true);
    expect(t.fired).toBe(true);
  });

  test('one-shot: no second fire while the reading stays high', () => {
    const t = createAutoCompactTrigger();
    expect(t.check(96, false)).toBe(true);
    expect(t.check(96, false)).toBe(false);
    expect(t.check(99, false)).toBe(false);
  });

  test('re-arms only below the re-arm line, then fires again', () => {
    const t = createAutoCompactTrigger();
    expect(t.check(97, false)).toBe(true);
    expect(t.check(80, false)).toBe(false); // at the line: still disarmed
    expect(t.fired).toBe(true);
    expect(t.check(79, false)).toBe(false); // re-arms here, no fire
    expect(t.fired).toBe(false);
    expect(t.check(95, false)).toBe(true);
  });

  test('an open approval gate defers the signal without losing it', () => {
    const t = createAutoCompactTrigger();
    expect(t.check(97, true)).toBe(false);
    expect(t.fired).toBe(false); // still armed
    expect(t.check(97, false)).toBe(true); // deferred signal fires on the next reading
  });

  test('approval pending below threshold changes nothing', () => {
    const t = createAutoCompactTrigger();
    expect(t.check(50, true)).toBe(false);
    expect(t.fired).toBe(false);
    expect(t.check(95, false)).toBe(true);
  });

  test('a null reading never fires and never changes state', () => {
    const t = createAutoCompactTrigger();
    expect(t.check(null, false)).toBe(false);
    expect(t.fired).toBe(false);
    expect(t.check(95, false)).toBe(true);
    expect(t.check(null, false)).toBe(false);
    expect(t.fired).toBe(true);
  });

  test('autoCompactPct maps tokens against the model window', () => {
    expect(autoCompactPct(950_000, 'charon')).toBe(95);
    expect(autoCompactPct(262_000, 'hermes')).toBe(100);
    expect(autoCompactPct(1_000_000, 'gpt-4o')).toBe(null); // BYOK: no published window
    expect(autoCompactPct(0, 'charon')).toBe(0);
  });

  test('the pre-compact notice names the pct and the archive invariant', () => {
    const text = autoCompactWarnText(96);
    expect(text).toContain('~96%');
    expect(text).toContain('auto-compact');
    expect(text).toContain('archived');
  });
});

describe('runAgent auto-compact (loop integration)', () => {
  test('emits context_full before the next turn when usage crosses 95%', async () => {
    writeFileSync(join(workDir, 'data.txt'), 'hello agent');
    // charon window is 1M: 960_000 input tokens = 96%.
    responder = makeResponder([
      turn({ tool: { tool: 'read_file', args: { path: 'data.txt' } }, input: 960_000 }),
      turn({ text: 'The file says hello.', input: 965_000 }),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'read data.txt',
      model: 'charon',
      cwd: workDir,
      onEvent: (e) => events.push(e),
    });
    expect(result.finalText).toContain('hello');
    const full = events.filter((e) => e.type === 'context_full');
    expect(full).toHaveLength(1);
    expect(full[0]).toMatchObject({ type: 'context_full', turn: 2, pct: 96, inputTokens: 960_000 });
  });

  test('no context_full when the meter stays below 95%', async () => {
    writeFileSync(join(workDir, 'data.txt'), 'hello agent');
    responder = makeResponder([
      turn({ tool: { tool: 'read_file', args: { path: 'data.txt' } }, input: 500_000 }),
      turn({ text: 'The file says hello.', input: 505_000 }),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({
      task: 'read data.txt',
      model: 'charon',
      cwd: workDir,
      onEvent: (e) => events.push(e),
    });
    expect(events.some((e) => e.type === 'context_full')).toBe(false);
  });

  test('no context_full for a model with no published window (BYOK)', async () => {
    writeFileSync(join(workDir, 'data.txt'), 'hello agent');
    responder = makeResponder([
      turn({ tool: { tool: 'read_file', args: { path: 'data.txt' } }, input: 9_000_000 }),
      turn({ text: 'The file says hello.', input: 9_100_000 }),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({
      task: 'read data.txt',
      model: 'gpt-4o', // unknown window -> contextPercent returns null -> no signal
      cwd: workDir,
      onEvent: (e) => events.push(e),
    });
    expect(events.some((e) => e.type === 'context_full')).toBe(false);
  });

  test('one-shot across turns: a single context_full even when every turn is at 96%', async () => {
    writeFileSync(join(workDir, 'data.txt'), 'hello agent');
    responder = makeResponder([
      turn({ tool: { tool: 'read_file', args: { path: 'data.txt' } }, input: 960_000 }),
      turn({ tool: { tool: 'read_file', args: { path: 'data.txt' } }, input: 961_000 }),
      turn({ text: 'The file says hello.', input: 962_000 }),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({
      task: 'read data.txt',
      model: 'charon',
      cwd: workDir,
      onEvent: (e) => events.push(e),
    });
    expect(events.filter((e) => e.type === 'context_full')).toHaveLength(1);
  });
});
