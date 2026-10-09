/**
 * F4 - auto-compact at the context ceiling.
 *
 * When the context meter reaches AUTO_COMPACT_PCT the agent loop raises a
 * `context_full` event so the front-end can warn the user and run the
 * existing compact flow (summarize, then continue with the summary).
 * Manual `/compact` behavior is untouched - this module only decides WHEN
 * the automatic signal fires.
 *
 * Two hard properties:
 *  - one-shot with hysteresis: the signal fires once per approach and
 *    re-arms only after the reading drops below AUTO_COMPACT_REARM_PCT,
 *    so a reading hovering at 95-96% cannot spam the front-end;
 *  - never during an approval gate: `check` takes the loop's current
 *    approval-in-flight state and refuses to fire while a gate is open.
 *    The trigger stays armed in that case, so the signal is deferred to
 *    the next turn rather than lost.
 */

import { contextPercent } from '../context-meter.js';
import type { ModelSlug } from '../models.js';

/** Fire the auto-compact signal when the meter reaches this percentage. */
export const AUTO_COMPACT_PCT = 95;
/** Re-arm the one-shot only after the reading drops back below this one. */
export const AUTO_COMPACT_REARM_PCT = 80;

export interface AutoCompactTrigger {
  /**
   * Feed one post-turn reading. Returns true exactly when the loop should
   * raise the auto-compact signal: the trigger is armed, `pct` is at or
   * above the threshold, and no approval gate is open. A true return
   * disarms the trigger until it re-arms below the re-arm line.
   *
   * `pct` is null when the model has no published context window (e.g. a
   * BYOK id) - a null reading never fires and never changes the state.
   */
  check(pct: number | null, approvalPending: boolean): boolean;
  /** True once fired and not yet re-armed. */
  readonly fired: boolean;
}

export function createAutoCompactTrigger(): AutoCompactTrigger {
  let armed = true;
  return {
    check(pct: number | null, approvalPending: boolean): boolean {
      if (pct === null) return false;
      if (armed && pct >= AUTO_COMPACT_PCT) {
        // An open approval gate defers the signal - the trigger stays armed
        // and the next turn's reading retries. Compacting under a pending
        // prompt would rewrite the transcript the user is deciding on.
        if (approvalPending) return false;
        armed = false;
        return true;
      }
      if (!armed && pct < AUTO_COMPACT_REARM_PCT) armed = true;
      return false;
    },
    get fired(): boolean {
      return !armed;
    },
  };
}

/**
 * Percentage of the model's approximate window the last turn's `usage`
 * `input` fills. Null for models with no published window - the loop then
 * never fires the auto-compact signal.
 */
export function autoCompactPct(inputTokens: number, model: string): number | null {
  return contextPercent(inputTokens, model as ModelSlug);
}

/**
 * The visible pre-compact notice copy - a warning, not a blocking prompt.
 * The front-end pushes this (e.g. as a `warning` notice) when handling the
 * `context_full` event, right before running the compact flow.
 */
export function autoCompactWarnText(pct: number): string {
  return (
    `Context is ~${pct}% full - auto-compacting now: older messages roll into ` +
    'a summary (originals are archived and recoverable).'
  );
}
