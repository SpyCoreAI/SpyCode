/**
 * Cost / runaway guardrails for the agent. Optional caps -
 * tokens, wall-clock seconds, and model round-trips (turns) - that stop a run
 * GRACEFULLY at a turn boundary before it overspends. We never compute a dollar
 * cost: budgets are expressed only in tokens / time / turns.
 *
 * One Budget is shared across an entire orchestrated run (plan phase, execute
 * phase, and every verify fix attempt) so the caps cover the whole thing - not
 * each phase in isolation. The clock is injectable so tests are deterministic.
 */

import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';

export type BudgetReason = 'tokens' | 'time' | 'turns';

export interface BudgetCaps {
  /** Total input+output tokens across all turns. */
  maxTokens?: number | undefined;
  /** Wall-clock budget for the whole run, in milliseconds. */
  maxTimeMs?: number | undefined;
  /** Whole-run cap on model round-trips (set only when --max-turns is explicit). */
  maxTurns?: number | undefined;
}

export interface BudgetSnapshot {
  tokensUsed: number;
  turnsUsed: number;
  elapsedMs: number;
}

export interface Budget {
  /** Whether any cap is configured (controls whether the UI shows the bar). */
  readonly hasCaps: boolean;
  readonly caps: BudgetCaps;
  /** Record one turn's token usage. */
  addTokens(input: number, output: number): void;
  /** Record a completed model round-trip. */
  addTurn(): void;
  /** The first cap currently exceeded, or null. */
  check(): BudgetReason | null;
  snapshot(): BudgetSnapshot;
}

const isPos = (n: number | undefined): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Normalize raw flag inputs into caps. `undefined` means "flag not passed"
 * and stays uncapped. Any PROVIDED value that is non-positive or non-finite
 * is invalid input and throws a user error naming the flag - the old code
 * silently dropped it to uncapped, so `--max-tokens abc` ran with NO token
 * cap at all. (The same holds for `--max-turns`: it reaches here pre-clamped
 * by resolveMaxTurns, but a direct caller passing 0/NaN gets the same error
 * instead of a silent uncapped run.)
 *
 * Fractional values are floored, then validated: a value in (0, 1) passes
 * the positivity check but floors to 0, and a 0 cap reads as "uncapped"
 * everywhere downstream (`isPos(0)` is false) - so `--max-tokens 0.5` used
 * to run with NO token cap. Anything flooring below 1 throws like 0 does.
 */
export function toBudgetCaps(input: {
  maxTokens?: number | undefined;
  maxTimeMs?: number | undefined;
  maxTurns?: number | undefined;
}): BudgetCaps {
  const caps: BudgetCaps = {};
  if (input.maxTokens !== undefined) {
    if (!isPos(input.maxTokens)) {
      throw new SpycoreCliError(
        `--max-tokens must be a positive number (got ${String(input.maxTokens)})`,
        EXIT_USER_ERROR,
        'Omit the flag for no token cap.',
      );
    }
    caps.maxTokens = Math.floor(input.maxTokens);
    if (caps.maxTokens < 1) {
      throw new SpycoreCliError(
        `--max-tokens must be at least 1 (got ${String(input.maxTokens)})`,
        EXIT_USER_ERROR,
        'Omit the flag for no token cap.',
      );
    }
  }
  if (input.maxTimeMs !== undefined) {
    if (!isPos(input.maxTimeMs)) {
      throw new SpycoreCliError(
        `--max-time must be a positive number of seconds (got ${String(input.maxTimeMs / 1000)})`,
        EXIT_USER_ERROR,
        'Omit the flag for no time cap.',
      );
    }
    caps.maxTimeMs = Math.floor(input.maxTimeMs);
    if (caps.maxTimeMs < 1) {
      throw new SpycoreCliError(
        `--max-time must be at least 1ms (got ${String(input.maxTimeMs / 1000)}s)`,
        EXIT_USER_ERROR,
        'Omit the flag for no time cap.',
      );
    }
  }
  if (input.maxTurns !== undefined) {
    if (!isPos(input.maxTurns)) {
      throw new SpycoreCliError(
        `--max-turns must be a positive number (got ${String(input.maxTurns)})`,
        EXIT_USER_ERROR,
        'Omit the flag for the default turn limit.',
      );
    }
    caps.maxTurns = Math.floor(input.maxTurns);
    if (caps.maxTurns < 1) {
      throw new SpycoreCliError(
        `--max-turns must be at least 1 (got ${String(input.maxTurns)})`,
        EXIT_USER_ERROR,
        'Omit the flag for the default turn limit.',
      );
    }
  }
  return caps;
}

/**
 * `initial` (resume support) pre-loads consumption carried over from an
 * interrupted run - tokens/turns/elapsed accumulate CUMULATIVELY on top of it,
 * so a resumed run can never reset its spend allowance.
 */
export function createBudget(caps: BudgetCaps, now: () => number = Date.now, initial?: BudgetSnapshot): Budget {
  const carried = (n: number | undefined): number =>
    typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
  const startMs = now() - carried(initial?.elapsedMs);
  let tokensUsed = carried(initial?.tokensUsed);
  let turnsUsed = carried(initial?.turnsUsed);
  const hasCaps = isPos(caps.maxTokens) || isPos(caps.maxTimeMs) || isPos(caps.maxTurns);
  return {
    hasCaps,
    caps,
    addTokens(input, output) {
      const i = Number.isFinite(input) ? Math.max(0, input) : 0;
      const o = Number.isFinite(output) ? Math.max(0, output) : 0;
      tokensUsed += i + o;
    },
    addTurn() {
      turnsUsed += 1;
    },
    check() {
      if (isPos(caps.maxTokens) && tokensUsed >= caps.maxTokens) return 'tokens';
      if (isPos(caps.maxTimeMs) && now() - startMs >= caps.maxTimeMs) return 'time';
      if (isPos(caps.maxTurns) && turnsUsed >= caps.maxTurns) return 'turns';
      return null;
    },
    snapshot() {
      return { tokensUsed, turnsUsed, elapsedMs: now() - startMs };
    },
  };
}

/** Manual thousands grouping - locale-independent, so output is deterministic. */
function group(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Compact token count (e.g. 12.4k, 50k) - trailing ".0" is dropped. */
function compactTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  const s = (n / 1000).toFixed(1);
  return `${s.endsWith('.0') ? s.slice(0, -2) : s}k`;
}

/**
 * The compact running indicator, e.g. "tokens 12.4k/50k · 38s/60s" - only the
 * dimensions that actually have caps are shown. Returns '' when none are set.
 */
export function formatBudgetBar(snap: BudgetSnapshot, caps: BudgetCaps): string {
  const parts: string[] = [];
  if (isPos(caps.maxTokens)) {
    parts.push(`tokens ${compactTokens(snap.tokensUsed)}/${compactTokens(caps.maxTokens)}`);
  }
  if (isPos(caps.maxTimeMs)) {
    parts.push(`${Math.round(snap.elapsedMs / 1000)}s/${Math.round(caps.maxTimeMs / 1000)}s`);
  }
  if (isPos(caps.maxTurns)) {
    parts.push(`turns ${snap.turnsUsed}/${caps.maxTurns}`);
  }
  return parts.join(' · ');
}

/** The stop phrase, e.g. "token budget reached (52,300 / 50,000)". */
export function describeBudgetStop(reason: BudgetReason, snap: BudgetSnapshot, caps: BudgetCaps): string {
  if (reason === 'tokens') {
    return `token budget reached (${group(snap.tokensUsed)} / ${group(caps.maxTokens ?? 0)})`;
  }
  if (reason === 'time') {
    return `time budget reached (${Math.round(snap.elapsedMs / 1000)}s / ${Math.round((caps.maxTimeMs ?? 0) / 1000)}s)`;
  }
  return `turn limit reached (${snap.turnsUsed} / ${caps.maxTurns ?? 0})`;
}
