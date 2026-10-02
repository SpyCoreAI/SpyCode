import { describe, expect, test } from 'vitest';
import {
  CONTEXT_REARM_PCT,
  CONTEXT_WARN_PCT,
  CONTEXT_WINDOW_TOKENS,
  contextPercent,
  contextWarnText,
  estimateTokensFromChars,
  formatContextSegment,
  nextContextWarnState,
} from '../src/lib/context-meter.js';

/**
 * PHASE-1 1.8 — the TUI context meter.
 *
 * Pinned here:
 *  - the APPROXIMATE window map mirrors the figures the public model pages
 *    state (nothing invented; styx_max carries the Styx family figure);
 *  - meter math + `context ~N%` labeling (always tilde-marked — the window
 *    map is approximate by design);
 *  - HIDDEN-WHEN-UNKNOWN: no reading (or no published window) → the segment
 *    is undefined, so the default StatusBar renders byte-identically (the
 *    1.7 `mode` prop precedent — an unset optional segment adds nothing);
 *  - the 80% warn-once threshold with <70% re-arm hysteresis.
 */

describe('window map — public figures only', () => {
  test('every chat model carries the marketing-page figure', () => {
    expect(CONTEXT_WINDOW_TOKENS).toEqual({
      hermes: 262_000,
      minos: 1_000_000,
      styx: 256_000,
      styx_max: 256_000, // the Styx family figure — no separate window is published
      charon: 1_000_000,
    });
  });

  test('the image model has NO window entry (meter never applies to it)', () => {
    expect(CONTEXT_WINDOW_TOKENS.hephaestus).toBeUndefined();
  });
});

describe('meter math + labeling', () => {
  test('chars/4 heuristic rounds up and floors negatives at zero', () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(1)).toBe(1);
    expect(estimateTokensFromChars(4)).toBe(1);
    expect(estimateTokensFromChars(5)).toBe(2);
    expect(estimateTokensFromChars(32_000)).toBe(8_000);
    expect(estimateTokensFromChars(-10)).toBe(0);
  });

  test('percent is computed against the model window and rounded', () => {
    expect(contextPercent(131_000, 'styx')).toBe(51); // 131000/256000
    expect(contextPercent(262_000, 'hermes')).toBe(100);
    expect(contextPercent(500_000, 'charon')).toBe(50);
    expect(contextPercent(0, 'minos')).toBe(0);
  });

  test('segment text is tilde-labeled — approximate by design', () => {
    expect(formatContextSegment(128_000, 'styx')).toBe('context ~50%');
    expect(formatContextSegment(0, 'charon')).toBe('context ~0%');
  });

  test('hidden when unknown: null tokens or an unmapped model → undefined', () => {
    // undefined → ChatApp passes nothing → StatusBar's optional segment is
    // absent and the default bar renders byte-identically (1.7 precedent).
    expect(formatContextSegment(null, 'styx')).toBeUndefined();
    expect(formatContextSegment(1_000, 'hephaestus')).toBeUndefined();
    expect(contextPercent(1_000, 'hephaestus')).toBeNull();
  });
});

describe('80% warn-once with <70% re-arm hysteresis', () => {
  test('thresholds are pinned at 80 / 70', () => {
    expect(CONTEXT_WARN_PCT).toBe(80);
    expect(CONTEXT_REARM_PCT).toBe(70);
  });

  test('armed meter below the threshold never warns', () => {
    expect(nextContextWarnState(true, 0)).toEqual({ armed: true, warn: false });
    expect(nextContextWarnState(true, 79)).toEqual({ armed: true, warn: false });
  });

  test('crossing 80% warns exactly once, then disarms', () => {
    const first = nextContextWarnState(true, 80);
    expect(first).toEqual({ armed: false, warn: true });
    // Staying high — or climbing higher — must NOT warn again.
    expect(nextContextWarnState(first.armed, 85)).toEqual({ armed: false, warn: false });
    expect(nextContextWarnState(first.armed, 99)).toEqual({ armed: false, warn: false });
  });

  test('hysteresis: 70–79 stays disarmed; below 70 re-arms; 80 warns again', () => {
    // Dropping into the dead band (70 ≤ pct < 80) must not re-arm — that is
    // the whole point of the hysteresis: no warn ping-pong around 80%.
    expect(nextContextWarnState(false, 75)).toEqual({ armed: false, warn: false });
    expect(nextContextWarnState(false, 70)).toEqual({ armed: false, warn: false });
    // Below 70 the warning re-arms…
    const rearmed = nextContextWarnState(false, 69);
    expect(rearmed).toEqual({ armed: true, warn: false });
    // …so the NEXT 80% crossing warns again.
    expect(nextContextWarnState(rearmed.armed, 81)).toEqual({ armed: false, warn: true });
  });

  test('the notice names /compact and the archived-recoverable invariant', () => {
    const text = contextWarnText(82);
    expect(text).toContain('~82%');
    expect(text).toContain('/compact');
    expect(text).toContain('archived');
    expect(text).toContain('recoverable');
  });
});
