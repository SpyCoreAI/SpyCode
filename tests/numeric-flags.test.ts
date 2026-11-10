import { describe, expect, test } from 'vitest';
import { parseIntFlag } from '../src/lib/numeric-flags.js';
import { isSpycoreCliError } from '../src/lib/errors.js';

describe('parseIntFlag', () => {
  test('returns the default when the flag is absent', () => {
    expect(parseIntFlag(undefined, 'limit', { min: 1, max: 100, defaultValue: 20 })).toBe(20);
  });

  test('parses a valid integer', () => {
    expect(parseIntFlag('7', 'limit', { min: 1, max: 100, defaultValue: 20 })).toBe(7);
  });

  test('a numeric value outside the range clamps (as before)', () => {
    expect(parseIntFlag('500', 'limit', { min: 1, max: 100, defaultValue: 20 })).toBe(100);
    expect(parseIntFlag('0', 'limit', { min: 1, max: 100, defaultValue: 20 })).toBe(1);
  });

  test('non-numeric input errors instead of producing NaN results', () => {
    for (const bad of ['abc', '1.5', '-3', '', '  ', '10x', '0x10']) {
      let caught: unknown = null;
      try {
        parseIntFlag(bad, 'limit', { min: 1, max: 100, defaultValue: 20 });
      } catch (err) {
        caught = err;
      }
      expect(isSpycoreCliError(caught), `--limit ${JSON.stringify(bad)}`).toBe(true);
      if (isSpycoreCliError(caught)) {
        expect(caught.message).toMatch(/Invalid --limit/);
      }
    }
  });

  test('a page without a max clamps only at the bottom', () => {
    expect(parseIntFlag('99999', 'page', { min: 1, defaultValue: 1 })).toBe(99999);
    expect(parseIntFlag('0', 'page', { min: 1, defaultValue: 1 })).toBe(1);
  });
});
