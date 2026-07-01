/**
 * Cost / runaway guardrails for the agent. Optional, IDENTITY-SAFE caps —
 * tokens, wall-clock seconds, and model round-trips (turns) — that stop a run
 * GRACEFULLY at a turn boundary before it overspends. We never compute a dollar
 * cost: provider pricing is not ours to expose, so budgets are expressed only
 * in tokens / time / turns.
 *
 * One Budget is shared across an entire orchestrated run (plan phase, execute
 * phase, and every verify fix attempt) so the caps cover the whole thing — not
 * each phase in isolation. The clock is injectable so tests are deterministic.
 */

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

/** Normalize raw flag inputs into caps; silently drops non-positive / non-finite values. */
export function toBudgetCaps(input: {
  maxTokens?: number | undefined;
  maxTimeMs?: number | undefined;
  maxTurns?: number | undefined;
}): BudgetCaps {
  const caps: BudgetCaps = {};
  if (isPos(input.maxTokens)) caps.maxTokens = Math.floor(input.maxTokens);
  if (isPos(input.maxTimeMs)) caps.maxTimeMs = Math.floor(input.maxTimeMs);
  if (isPos(input.maxTurns)) caps.maxTurns = Math.floor(input.maxTurns);
  return caps;
}

export function createBudget(caps: BudgetCaps, now: () => number = Date.now): Budget {
  const startMs = now();
  let tokensUsed = 0;
  let turnsUsed = 0;
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

/** Manual thousands grouping — locale-independent, so output is deterministic. */
function group(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Compact token count (e.g. 12.4k, 50k) — trailing ".0" is dropped. */
function compactTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  const s = (n / 1000).toFixed(1);
  return `${s.endsWith('.0') ? s.slice(0, -2) : s}k`;
}

/**
 * The compact running indicator, e.g. "tokens 12.4k/50k · 38s/60s" — only the
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
