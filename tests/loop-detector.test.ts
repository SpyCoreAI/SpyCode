/**
 * A-2 - tiered loop detector: repetition and wandering with a three-step
 * response (warn -> guide veto -> soft breaker). Terminal verbs (a final
 * answer, i.e. a turn with no tool calls) are never gated.
 */
import { describe, expect, test } from 'vitest';
import {
  createLoopDetector,
  LOOP_BREAKER_REPEATS,
  LOOP_VETO_REPEATS,
  LOOP_WANDER_VETO_TURNS,
  LOOP_WANDER_WARN_TURNS,
  LOOP_WARN_REPEATS,
  type LoopCallTrace,
  type TurnTrace,
} from '../src/lib/agent/loop-detector.js';

const read = (path: string, content: string, ok = true): LoopCallTrace => ({
  tool: 'read_file',
  argsKey: JSON.stringify({ path }),
  ok,
  content,
  mutating: false,
});
const write = (path: string, ok = true): LoopCallTrace => ({
  tool: 'write_file',
  argsKey: JSON.stringify({ path, content: 'x' }),
  ok,
  content: 'written',
  mutating: true,
});
const cmd = (command: string, ok = true): LoopCallTrace => ({
  tool: 'run_command',
  argsKey: JSON.stringify({ command }),
  ok,
  content: 'output',
  mutating: true,
});

const turn = (n: number, calls: LoopCallTrace[]): TurnTrace => ({ turn: n, calls });

function run(traces: TurnTrace[]) {
  const d = createLoopDetector();
  return traces.map((t) => d.observeTurn(t));
}

describe('A-2 loop detector', () => {
  test('a final-answer turn (no calls) is never gated', () => {
    const d = createLoopDetector();
    expect(d.observeTurn(turn(1, [])).level).toBe('none');
  });

  test('byte-identical repetition escalates warn -> veto -> breaker', () => {
    const traces = Array.from({ length: LOOP_BREAKER_REPEATS + 1 }, (_, i) =>
      turn(i + 1, [read('a.txt', `content-${i}`)]),
    );
    const verdicts = run(traces);
    // Same signature every turn; content differs each time so only the
    // signature streak counts. Streak N fires after N+1 identical turns.
    expect(verdicts[0]!.level).toBe('none');
    expect(verdicts[1]!.level).toBe('none');
    expect(verdicts[LOOP_WARN_REPEATS]!.level).toBe('warn');
    expect(verdicts[LOOP_VETO_REPEATS]!.level).toBe('veto');
    expect(verdicts[LOOP_BREAKER_REPEATS]!.level).toBe('breaker');
  });

  test('the veto tells the model what to do instead of repeating', () => {
    const traces = Array.from({ length: LOOP_VETO_REPEATS + 1 }, (_, i) => turn(i + 1, [read('a.txt', `c${i}`)]));
    const verdicts = run(traces);
    const veto = verdicts[verdicts.length - 1]!;
    expect(veto.level).toBe('veto');
    expect(veto.notice).toContain('Do NOT issue the same call again');
    expect(veto.notice).toContain('final answer');
  });

  test('a model that ignores the veto trips the breaker on the next repeat', () => {
    const traces = Array.from({ length: LOOP_VETO_REPEATS + 2 }, (_, i) => turn(i + 1, [read('a.txt', `c${i}`)]));
    const verdicts = run(traces);
    expect(verdicts[LOOP_VETO_REPEATS]!.level).toBe('veto');
    const breaker = verdicts[LOOP_VETO_REPEATS + 1]!;
    expect(breaker.level).toBe('breaker');
    expect(breaker.notice).toContain('Stopped');
  });

  test('a changing signature resets the streak', () => {
    const verdicts = run([
      turn(1, [read('a.txt', 'c1')]),
      turn(2, [read('a.txt', 'c2')]),
      turn(3, [read('b.txt', 'c3')]),
      turn(4, [read('a.txt', 'c4')]),
    ]);
    expect(verdicts.map((v) => v.level)).toEqual(['none', 'none', 'none', 'none']);
  });

  test('re-reading an unchanged file counts as repetition', () => {
    const verdicts = run([
      turn(1, [read('a.txt', 'same')]),
      turn(2, [read('a.txt', 'same')]),
      turn(3, [read('a.txt', 'same')]),
      turn(4, [read('a.txt', 'same')]),
    ]);
    // Content is identical, so no "new information" resets anything; the
    // re-read streak alone escalates.
    expect(verdicts[2]!.level).toBe('warn');
    expect(verdicts[3]!.level).toBe('veto');
  });

  test('a mutation between reads breaks the re-read streak', () => {
    const verdicts = run([
      turn(1, [read('a.txt', 'same')]),
      turn(2, [write('a.txt')]),
      turn(3, [read('a.txt', 'same')]),
    ]);
    expect(verdicts.map((v) => v.level)).toEqual(['none', 'none', 'none']);
  });

  test('wandering: many turns with no progress escalate warn -> veto', () => {
    // Distinct failing calls: no repetition, no mutation, no new information.
    const traces = Array.from({ length: LOOP_WANDER_VETO_TURNS }, (_, i) =>
      turn(i + 1, [{ ...read(`f${i}.txt`, 'err'), ok: false, content: `error ${i}` }]),
    );
    const verdicts = run(traces);
    expect(verdicts[LOOP_WANDER_WARN_TURNS - 1]!.level).toBe('warn');
    expect(verdicts[LOOP_WANDER_WARN_TURNS - 1]!.reason).toBe('wandering_warn');
    expect(verdicts[LOOP_WANDER_VETO_TURNS - 1]!.level).toBe('veto');
    expect(verdicts[LOOP_WANDER_VETO_TURNS - 1]!.reason).toBe('wandering_veto');
    // Fires once per escalation, not every turn after.
    expect(verdicts[LOOP_WANDER_WARN_TURNS]!.level).toBe('none');
  });

  test('progress (a successful mutation) resets the wandering clock', () => {
    const traces = Array.from({ length: LOOP_WANDER_WARN_TURNS - 1 }, (_, i) =>
      turn(i + 1, [{ ...read(`f${i}.txt`, 'err'), ok: false, content: `error ${i}` }]),
    );
    traces.push(turn(LOOP_WANDER_WARN_TURNS, [write('out.txt')]));
    traces.push(
      ...Array.from({ length: 3 }, (_, i) =>
        turn(LOOP_WANDER_WARN_TURNS + 1 + i, [
          { ...read(`g${i}.txt`, 'err'), ok: false, content: `error x${i}` },
        ]),
      ),
    );
    const verdicts = run(traces);
    expect(verdicts.every((v) => v.level === 'none')).toBe(true);
  });

  test('a failing repeat still counts - errors are repetition too', () => {
    const failing = (c: string): LoopCallTrace => ({ ...cmd(c, false), content: 'same error' });
    const verdicts = run([
      turn(1, [failing('oops')]),
      turn(2, [failing('oops')]),
      turn(3, [failing('oops')]),
      turn(4, [failing('oops')]),
    ]);
    expect(verdicts[2]!.level).toBe('warn');
    expect(verdicts[3]!.level).toBe('veto');
  });
});
