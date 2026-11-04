/**
 * run-config: the shared agent-run knobs. These truth tables pin the semantics
 * both front-ends (`spycore agent` and the chat TUI's plan/agent modes) share -
 * a default change here moves both paths together, never one silently.
 */
import { describe, expect, test } from 'vitest';
import {
  resolveBudgetCaps,
  resolveMaxTurns,
  resolveObserveWorkspaceEnabled,
  resolveWebToolsEnabled,
} from '../src/lib/agent/run-config.js';
import { DEFAULT_MAX_TURNS, MAX_TURNS_CAP, MIN_TURNS } from '../src/lib/agent/loop.js';

describe('resolveWebToolsEnabled', () => {
  test('the --no-web flag wins in either config state', () => {
    expect(resolveWebToolsEnabled(false, true)).toBe(false);
    expect(resolveWebToolsEnabled(false, false)).toBe(false);
    expect(resolveWebToolsEnabled(false, undefined)).toBe(false);
  });
  test('otherwise the config key decides, defaulting to on', () => {
    expect(resolveWebToolsEnabled(undefined, undefined)).toBe(true);
    expect(resolveWebToolsEnabled(undefined, true)).toBe(true);
    expect(resolveWebToolsEnabled(undefined, false)).toBe(false);
    // Only the literal false disables - anything else stays on.
    expect(resolveWebToolsEnabled(undefined, 0)).toBe(true);
    expect(resolveWebToolsEnabled(undefined, '')).toBe(true);
  });
});

describe('resolveObserveWorkspaceEnabled', () => {
  test('an explicit flag wins in either direction', () => {
    expect(resolveObserveWorkspaceEnabled(true, false)).toBe(true);
    expect(resolveObserveWorkspaceEnabled(false, true)).toBe(false);
  });
  test('otherwise the config key decides with a strict === true (default OFF)', () => {
    expect(resolveObserveWorkspaceEnabled(undefined, undefined)).toBe(false);
    expect(resolveObserveWorkspaceEnabled(undefined, false)).toBe(false);
    expect(resolveObserveWorkspaceEnabled(undefined, true)).toBe(true);
    // Truthy-but-not-true stays OFF - the R-CLI-1 product decision.
    expect(resolveObserveWorkspaceEnabled(undefined, 1)).toBe(false);
    expect(resolveObserveWorkspaceEnabled(undefined, 'true')).toBe(false);
  });
});

describe('resolveMaxTurns', () => {
  test('absent or unparseable falls back to the default', () => {
    expect(resolveMaxTurns(undefined)).toBe(DEFAULT_MAX_TURNS);
    expect(resolveMaxTurns('abc')).toBe(DEFAULT_MAX_TURNS);
  });
  test('clamps to [MIN_TURNS, MAX_TURNS_CAP]', () => {
    // 0 is falsy and falls back to the default (same as the original inline
    // expression); negatives clamp up, huge values clamp down.
    expect(resolveMaxTurns(0)).toBe(DEFAULT_MAX_TURNS);
    expect(resolveMaxTurns(-5)).toBe(MIN_TURNS);
    expect(resolveMaxTurns(99999)).toBe(MAX_TURNS_CAP);
    expect(resolveMaxTurns(10)).toBe(10);
    expect(resolveMaxTurns('50')).toBe(50);
  });
});

describe('resolveBudgetCaps', () => {
  test('parses flag strings; a turn cap needs the explicit flag', () => {
    expect(
      resolveBudgetCaps({ maxTokens: '1000', maxTime: '60', maxTurnsExplicit: false, maxTurns: 25 }),
    ).toEqual({ maxTokens: 1000, maxTimeMs: 60000 });
    expect(
      resolveBudgetCaps({ maxTokens: undefined, maxTime: undefined, maxTurnsExplicit: true, maxTurns: 10 }),
    ).toEqual({ maxTurns: 10 });
  });
  test('non-positive values are dropped', () => {
    expect(
      resolveBudgetCaps({ maxTokens: '0', maxTime: '-5', maxTurnsExplicit: true, maxTurns: 0 }),
    ).toEqual({});
  });
});
