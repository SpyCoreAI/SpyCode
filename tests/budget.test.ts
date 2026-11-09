import { describe, expect, test } from 'vitest';
import {
  createBudget,
  toBudgetCaps,
  formatBudgetBar,
  describeBudgetStop,
} from '../src/lib/agent/budget.js';
import { SpycoreCliError } from '../src/lib/errors.js';

describe('toBudgetCaps', () => {
  test('keeps positive finite caps; undefined means no cap', () => {
    expect(toBudgetCaps({ maxTokens: 5000, maxTimeMs: 60000, maxTurns: 8 })).toEqual({
      maxTokens: 5000,
      maxTimeMs: 60000,
      maxTurns: 8,
    });
    expect(toBudgetCaps({})).toEqual({});
    expect(toBudgetCaps({ maxTokens: undefined, maxTimeMs: undefined, maxTurns: undefined })).toEqual({});
  });

  test('floors fractional caps', () => {
    expect(toBudgetCaps({ maxTokens: 1000.9 })).toEqual({ maxTokens: 1000 });
  });

  test('non-positive / non-finite caps throw instead of silently uncapping', () => {
    // --max-tokens abc / 0 used to run with NO token cap at all.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => toBudgetCaps({ maxTokens: bad })).toThrow('--max-tokens must be a positive number');
      expect(() => toBudgetCaps({ maxTimeMs: bad })).toThrow('--max-time must be a positive number');
      expect(() => toBudgetCaps({ maxTurns: bad })).toThrow('--max-turns must be a positive number');
    }
    expect(() => toBudgetCaps({ maxTokens: 0 })).toThrow(SpycoreCliError);
    expect(() => toBudgetCaps({ maxTokens: 0 })).toThrow('--max-tokens must be a positive number (got 0)');
    expect(() => toBudgetCaps({ maxTimeMs: Number.NaN })).toThrow(
      '--max-time must be a positive number of seconds (got NaN)',
    );
  });
});

describe('createBudget', () => {
  test('hasCaps reflects whether any cap is set', () => {
    expect(createBudget({}).hasCaps).toBe(false);
    expect(createBudget({ maxTokens: 100 }).hasCaps).toBe(true);
  });

  test('token cap trips once usage reaches it', () => {
    const b = createBudget({ maxTokens: 1500 });
    expect(b.check()).toBeNull();
    b.addTokens(600, 400); // 1000
    expect(b.check()).toBeNull();
    b.addTokens(300, 300); // 1600 >= 1500
    expect(b.check()).toBe('tokens');
    expect(b.snapshot().tokensUsed).toBe(1600);
  });

  test('turn cap trips once round-trips reach it', () => {
    const b = createBudget({ maxTurns: 2 });
    b.addTurn();
    expect(b.check()).toBeNull();
    b.addTurn();
    expect(b.check()).toBe('turns');
  });

  test('time cap uses the injected clock', () => {
    let clock = 1000;
    const b = createBudget({ maxTimeMs: 5000 }, () => clock);
    expect(b.check()).toBeNull();
    clock = 5500; // 4500ms elapsed
    expect(b.check()).toBeNull();
    clock = 6200; // 5200ms elapsed >= 5000
    expect(b.check()).toBe('time');
    expect(b.snapshot().elapsedMs).toBe(5200);
  });

  test('check() priority is tokens, then time, then turns', () => {
    let clock = 0;
    const b = createBudget({ maxTokens: 10, maxTimeMs: 10, maxTurns: 1 }, () => clock);
    b.addTokens(50, 0);
    b.addTurn();
    clock = 100;
    expect(b.check()).toBe('tokens'); // all three exceeded → tokens wins
  });
});

describe('formatBudgetBar', () => {
  test('shows only the dimensions that have caps, compactly', () => {
    expect(
      formatBudgetBar({ tokensUsed: 12400, turnsUsed: 3, elapsedMs: 38000 }, { maxTokens: 50000, maxTimeMs: 60000 }),
    ).toBe('tokens 12.4k/50k · 38s/60s');
    expect(formatBudgetBar({ tokensUsed: 0, turnsUsed: 4, elapsedMs: 0 }, { maxTurns: 8 })).toBe('turns 4/8');
    expect(formatBudgetBar({ tokensUsed: 0, turnsUsed: 0, elapsedMs: 0 }, {})).toBe('');
  });
});

describe('describeBudgetStop', () => {
  test('formats each reason with grouped numbers', () => {
    expect(
      describeBudgetStop('tokens', { tokensUsed: 52300, turnsUsed: 0, elapsedMs: 0 }, { maxTokens: 50000 }),
    ).toBe('token budget reached (52,300 / 50,000)');
    expect(
      describeBudgetStop('time', { tokensUsed: 0, turnsUsed: 0, elapsedMs: 62000 }, { maxTimeMs: 60000 }),
    ).toBe('time budget reached (62s / 60s)');
    expect(
      describeBudgetStop('turns', { tokensUsed: 0, turnsUsed: 8, elapsedMs: 0 }, { maxTurns: 8 }),
    ).toBe('turn limit reached (8 / 8)');
  });
});
