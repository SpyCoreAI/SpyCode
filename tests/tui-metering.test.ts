/**
 * Tests for session metering display (MAJOR #4): the compact token
 * formatter used by the status bar and the live activity readout.
 * Tokens only - no dollar cost, no context-% (that data does not exist).
 */
import { describe, expect, test } from 'vitest';
import { formatTokenCount } from '../src/ui/tui/statusbar.js';

describe('formatTokenCount', () => {
  test('small counts render plain', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });

  test('thousands compact to k, dropping trailing .0', () => {
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(1240)).toBe('1.2k');
    expect(formatTokenCount(12400)).toBe('12.4k');
    expect(formatTokenCount(50000)).toBe('50k');
  });

  test('rounds rather than truncates', () => {
    expect(formatTokenCount(1999)).toBe('2k');
  });

  test('non-finite and negative inputs are safe', () => {
    expect(formatTokenCount(NaN)).toBe('0');
    expect(formatTokenCount(Infinity)).toBe('0');
    expect(formatTokenCount(-5)).toBe('0');
  });
});
