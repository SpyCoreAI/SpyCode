/**
 * Regression tests for the fix round: the BLOCKER (#1) submit-routing
 * matrix. A `!` shell submitted while a run is in flight must NEVER execute
 * inline - it queues exactly like a task, so two run loops can never
 * interleave and corrupt session state.
 */
import { describe, expect, test } from 'vitest';
import { isRefusedWhileRunning, parseTuiInput, routeSubmit, shiftRunnable } from '../src/ui/tui/commands.js';

const MAXQ = 5;

describe('routeSubmit - the BLOCKER #1 regression matrix', () => {
  test('shell submitted while running queues (never runs inline)', () => {
    const parsed = parseTuiInput('!ls -la');
    expect(parsed.kind).toBe('shell');
    expect(routeSubmit(parsed, 'running', 0, MAXQ)).toEqual({ action: 'queue' });
  });

  test('task submitted while running queues', () => {
    const parsed = parseTuiInput('do the thing');
    expect(routeSubmit(parsed, 'running', 2, MAXQ)).toEqual({ action: 'queue' });
  });

  test('shell submitted while idle runs immediately', () => {
    expect(routeSubmit(parseTuiInput('!ls'), 'idle', 0, MAXQ)).toEqual({ action: 'run' });
  });

  test('task submitted while idle runs immediately', () => {
    expect(routeSubmit(parseTuiInput('do the thing'), 'idle', 0, MAXQ)).toEqual({ action: 'run' });
  });

  test('full queue refuses both shell and task with queue-full', () => {
    expect(routeSubmit(parseTuiInput('!ls'), 'running', MAXQ, MAXQ)).toEqual({ action: 'queue-full' });
    expect(routeSubmit(parseTuiInput('do the thing'), 'running', MAXQ, MAXQ)).toEqual({
      action: 'queue-full',
    });
  });

  test('queue-full at MAXQ-1 still queues (boundary)', () => {
    expect(routeSubmit(parseTuiInput('!ls'), 'running', MAXQ - 1, MAXQ)).toEqual({ action: 'queue' });
  });

  test('slash commands never queue - they run inline even while busy', () => {
    expect(routeSubmit(parseTuiInput('/help'), 'running', 0, MAXQ)).toEqual({ action: 'tui-command' });
    expect(routeSubmit(parseTuiInput('/compact'), 'running', 0, MAXQ)).toEqual({ action: 'tui-command' });
  });

  test('empty input is a no-op in both phases', () => {
    expect(routeSubmit(parseTuiInput('   '), 'running', 0, MAXQ)).toEqual({ action: 'empty' });
    expect(routeSubmit(parseTuiInput('   '), 'idle', 0, MAXQ)).toEqual({ action: 'empty' });
  });

  test('queue length does not matter while idle', () => {
    expect(routeSubmit(parseTuiInput('!ls'), 'idle', MAXQ, MAXQ)).toEqual({ action: 'run' });
  });
});

describe('shiftRunnable - N3: empty `!` submits never stall the drain', () => {
  test('skips leading empty shell submits and returns the next runnable item', () => {
    const queue = [
      { kind: 'shell' as const, text: '' },
      { kind: 'shell' as const, text: '' },
      { kind: 'task' as const, text: 'do the thing' },
    ];
    const next = shiftRunnable(queue);
    expect(next).toEqual({ kind: 'task', text: 'do the thing' });
    expect(queue).toHaveLength(0);
  });

  test('empty shell between tasks is skipped, order preserved', () => {
    const queue = [
      { kind: 'task' as const, text: 'first' },
      { kind: 'shell' as const, text: '' },
      { kind: 'shell' as const, text: 'ls' },
    ];
    expect(shiftRunnable(queue)).toEqual({ kind: 'task', text: 'first' });
    expect(shiftRunnable(queue)).toEqual({ kind: 'shell', text: 'ls' });
    expect(shiftRunnable(queue)).toBeUndefined();
  });

  test('all-empty queue drains to undefined (no stall, no item)', () => {
    const queue = [
      { kind: 'shell' as const, text: '' },
      { kind: 'shell' as const, text: '   '.trim() },
    ];
    expect(shiftRunnable(queue)).toBeUndefined();
    expect(queue).toHaveLength(0);
  });

  test('non-empty shell passes through untouched', () => {
    const queue = [{ kind: 'shell' as const, text: 'git status' }];
    expect(shiftRunnable(queue)).toEqual({ kind: 'shell', text: 'git status' });
  });

  test('empty queue returns undefined', () => {
    expect(shiftRunnable([])).toBeUndefined();
  });
});

describe('isRefusedWhileRunning - N4: /undo joins /compact and /resume', () => {
  test('undo/compact/resume/clear/exit refused while running, allowed when idle', () => {
    for (const name of ['undo', 'compact', 'resume', 'clear', 'exit']) {
      expect(isRefusedWhileRunning(name, 'running')).toBe(true);
      expect(isRefusedWhileRunning(name, 'idle')).toBe(false);
    }
  });

  test('other commands are never refused by this guard', () => {
    for (const name of ['help', 'model', 'diff', 'usage', 'theme']) {
      expect(isRefusedWhileRunning(name, 'running')).toBe(false);
      expect(isRefusedWhileRunning(name, 'idle')).toBe(false);
    }
  });

  test('unknown command names are never refused', () => {
    expect(isRefusedWhileRunning('nope', 'running')).toBe(false);
  });
});
