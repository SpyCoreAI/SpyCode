/**
 * A-7 - reserved final step: instead of a hard cut at the turn cap, the
 * model gets one last summary-only turn (tool calls there are never
 * dispatched).
 *
 * A-9 - evidence check at close: a final answer claiming "tests passed"
 * with no matching successful tool call emits an `evidence_warn` - warn
 * only, the answer is unchanged.
 */
import { writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { runAgent, type AgentEvent } from '../src/lib/agent/loop.js';
import {
  ACCEPT,
  block,
  byTurn,
  say,
  ScriptProvider,
  tempDir,
} from './loop-pin-harness.js';

function eventsOf() {
  const events: AgentEvent[] = [];
  return { events, onEvent: (e: AgentEvent) => events.push(e) };
}

describe('A-7 reserved final step', () => {
  test('the cap grants one summary-only turn instead of a hard cut', async () => {
    const cwd = tempDir('spycode-loop-');
    writeFileSync(`${cwd}/a.txt`, 'hello\n');
    const provider = new ScriptProvider({
      script: byTurn([
        [{ type: 'text', text: block('read_file', { path: 'a.txt' }) }, { type: 'usage', input: 1, output: 1 }, { type: 'done' }],
        [{ type: 'text', text: block('read_file', { path: 'a.txt' }) }, { type: 'usage', input: 1, output: 1 }, { type: 'done' }],
        say('Summary: I read a.txt twice; nothing left to do.'),
      ]),
    });
    const { events, onEvent } = eventsOf();
    const res = await runAgent({ task: 'read the file', cwd, provider, maxTurns: 2, onEvent });

    // Two tool turns + the reserved summary turn.
    expect(res.turns).toBe(3);
    expect(res.toolCalls).toBe(2);
    expect(res.reachedMaxTurns).toBe(true);
    expect(res.finalText).toBe('Summary: I read a.txt twice; nothing left to do.');
    // The summary turn's message carries the summary-only instruction...
    expect(provider.turns[2]!.message).toContain('FINAL step');
    expect(provider.turns[2]!.message).toContain('do NOT call any tool');
    // ...and the system prompt is NOT re-sent (cache-sacred invariant, A-6/H-1).
    expect(provider.turns[0]!.system).toContain('You are SpyCode');
    expect(provider.turns[2]!.system).toBeUndefined();
    // The cap event still fires exactly once.
    expect(events.filter((e) => e.type === 'max_turns')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1);
  });

  test('a tool call emitted on the summary turn is never dispatched', async () => {
    const cwd = tempDir('spycode-loop-');
    writeFileSync(`${cwd}/a.txt`, 'hello\n');
    const provider = new ScriptProvider({
      script: byTurn([
        [{ type: 'text', text: block('read_file', { path: 'a.txt' }) }, { type: 'usage', input: 1, output: 1 }, { type: 'done' }],
        [
          { type: 'text', text: `One more thing.\n${block('write_file', { path: 'evil.txt', content: 'x' })}` },
          { type: 'usage', input: 1, output: 1 },
          { type: 'done' },
        ],
      ]),
    });
    const res = await runAgent({
      task: 'read the file',
      cwd,
      provider,
      maxTurns: 1,
      requestApproval: ACCEPT,
      onEvent: () => {},
    });
    expect(res.turns).toBe(2);
    expect(res.toolCalls).toBe(1);
    expect(res.finalText).toBe('One more thing.');
    expect(res.changedFiles).toBe(0);
  });

  test('an explicit --max-turns budget still grants the summary turn, then reports the budget stop', async () => {
    const cwd = tempDir('spycode-loop-');
    writeFileSync(`${cwd}/a.txt`, 'hello\n');
    const provider = new ScriptProvider({
      script: byTurn([
        [{ type: 'text', text: block('read_file', { path: 'a.txt' }) }, { type: 'usage', input: 1, output: 1 }, { type: 'done' }],
        say('Summary: done.'),
      ]),
    });
    const { events, onEvent } = eventsOf();
    // maxTurns: 1 as an explicit budget -> the budget reporter is engaged.
    const { createBudget } = await import('../src/lib/agent/budget.js');
    const budget = createBudget({ maxTurns: 1 });
    const res = await runAgent({ task: 't', cwd, provider, maxTurns: 1, budget, onEvent });
    // The tool turn ran, the reserved summary turn still ran, and the result
    // reports the budget stop - the old hard-cut contract is preserved.
    expect(res.turns).toBe(2);
    expect(res.finalText).toBe('Summary: done.');
    expect(res.budgetStop).toBe('turns');
    expect(res.reachedMaxTurns).toBe(false);
    expect(events.filter((e) => e.type === 'budget_stop')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'max_turns')).toHaveLength(0);
  });
});

describe('A-2 loop breaker (integration)', () => {
  test('identical tool calls escalate to a graceful breaker that ends the run', async () => {
    const cwd = tempDir('spycode-loop-');
    writeFileSync(`${cwd}/a.txt`, 'same content\n');
    const readBlock = { type: 'text', text: block('read_file', { path: 'a.txt' }) } as const;
    const usage = { type: 'usage', input: 1, output: 1 } as const;
    const done = { type: 'done' } as const;
    const provider = new ScriptProvider({
      script: ({ turn }) =>
        turn <= 6 ? [readBlock, usage, done] : say('I will never get here.'),
    });
    const { events, onEvent } = eventsOf();
    const res = await runAgent({ task: 'read the file', cwd, provider, maxTurns: 10, onEvent });

    const notices = events.filter((e) => e.type === 'loop_notice');
    expect(notices.map((e) => (e.type === 'loop_notice' ? e.level : ''))).toEqual(['warn', 'veto', 'breaker']);
    // The breaker ended the run on turn 5 - the session stayed healthy.
    expect(res.turns).toBe(5);
    expect(res.finalText).toContain('Stopped');
    expect(res.reachedMaxTurns).toBe(false);
    expect(provider.turns).toHaveLength(5);
  });
});

describe('A-9 evidence check at close', () => {
  test('an unbacked "tests passed" claim warns but does not block', async () => {
    const cwd = tempDir('spycode-loop-');
    const provider = new ScriptProvider({ script: byTurn([say('All tests passed.')]) });
    const { events, onEvent } = eventsOf();
    const res = await runAgent({ task: 't', cwd, provider, onEvent });
    expect(res.finalText).toBe('All tests passed.');
    const warns = events.filter((e) => e.type === 'evidence_warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.type === 'evidence_warn' && warns[0]!.text).toContain('tests passed');
  });

  test('a real successful test command backs the claim - no warning', async () => {
    const cwd = tempDir('spycode-loop-');
    writeFileSync(
      `${cwd}/package.json`,
      JSON.stringify({ name: 't', scripts: { test: 'node -e "process.exit(0)"' } }),
    );
    const provider = new ScriptProvider({
      script: byTurn([
        [{ type: 'text', text: block('run_command', { command: 'npm test' }) }, { type: 'usage', input: 1, output: 1 }, { type: 'done' }],
        say('All tests passed.'),
      ]),
    });
    const { events, onEvent } = eventsOf();
    const res = await runAgent({ task: 't', cwd, provider, requestApproval: ACCEPT, onEvent });
    expect(res.finalText).toBe('All tests passed.');
    expect(events.filter((e) => e.type === 'evidence_warn')).toHaveLength(0);
  });

  test('a failed test command does not back the claim', async () => {
    const cwd = tempDir('spycode-loop-');
    const provider = new ScriptProvider({
      script: byTurn([
        [{ type: 'text', text: block('run_command', { command: 'npm test && exit 1' }) }, { type: 'usage', input: 1, output: 1 }, { type: 'done' }],
        say('All tests passed.'),
      ]),
    });
    const { events, onEvent } = eventsOf();
    await runAgent({ task: 't', cwd, provider, requestApproval: ACCEPT, onEvent });
    expect(events.filter((e) => e.type === 'evidence_warn')).toHaveLength(1);
  });

  test('no claim, no warning', async () => {
    const cwd = tempDir('spycode-loop-');
    const provider = new ScriptProvider({ script: byTurn([say('Done, here is the summary.')]) });
    const { events, onEvent } = eventsOf();
    await runAgent({ task: 't', cwd, provider, onEvent });
    expect(events.filter((e) => e.type === 'evidence_warn')).toHaveLength(0);
  });
});
