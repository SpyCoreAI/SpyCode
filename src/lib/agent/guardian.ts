/**
 * H-3 - the denial circuit breaker (the guardian-LLM's enforcement half).
 *
 * After N CONSECUTIVE approval rejections (default 3), the run appends a
 * hard-stop note to the tool-result text the model sees - "stop insisting,
 * report back to the user" - instead of letting the model badger the user
 * with endless variants. Any approval resets the count.
 *
 * The note rides in the rejection's `reason`, which the gated tools already
 * render into the tool-result CONTENT. That is the whole point: the note is
 * appended to the tool-result text ONLY - the system prompt is never
 * touched, so the provider's KV-cache prefix (A-6/H-1) stays warm. There is
 * no guardian LLM call here; the judgement ("the user has said no N times")
 * needs no inference, just a counter.
 */

import type { ApprovalOutcome, RequestApproval } from './approval.js';

/**
 * Consecutive rejections before the hard-stop note engages. 0 disables the
 * breaker (plain pass-through). Overridable per run; the CLI default comes
 * from config (`guardianThreshold`) with env override
 * `SPYCODE_GUARDIAN_THRESHOLD`.
 */
export const DEFAULT_GUARDIAN_THRESHOLD = 3;

/**
 * The hard-stop note. Appended to the rejection reason, so it lands in the
 * tool-result text the model reads - nowhere else.
 */
export function guardianHardStopText(rejections: number): string {
  return (
    `Hard stop: this action has been rejected ${rejections} time${rejections === 1 ? '' : 's'} in a row. ` +
    'Do NOT try again, rephrase, or emit a variant - the user has decided. ' +
    'Summarize what you attempted and hand the decision back to the user instead.'
  );
}

/** Live state of one run's breaker (exposed for tests and the UI). */
export interface GuardianBreaker {
  /** The wrapped resolver - drop-in for `ctx.requestApproval`. */
  request: RequestApproval;
  /** Consecutive rejections so far (resets on any approval). */
  consecutiveRejections(): number;
  /** True once the breaker has tripped (stays true until an approval resets it). */
  tripped(): boolean;
}

/**
 * Wrap an approval resolver with the denial circuit breaker. The wrapper is
 * transparent until the threshold is reached: approvals pass through
 * untouched and reset the counter; rejections increment it, and from the
 * threshold on the hard-stop note is appended to the rejection reason.
 */
export function createGuardianBreaker(
  resolve: RequestApproval | undefined,
  threshold: number = DEFAULT_GUARDIAN_THRESHOLD,
): GuardianBreaker {
  let rejections = 0;
  let tripped = false;
  const request: RequestApproval = async (req) => {
    if (!resolve || !(threshold > 0)) {
      // Disabled (or no resolver to wrap): pass through unchanged.
      return resolve ? resolve(req) : { approved: false, reason: 'approval is unavailable in this context' };
    }
    const outcome: ApprovalOutcome = await resolve(req);
    if (outcome.approved) {
      rejections = 0;
      tripped = false;
      return outcome;
    }
    rejections += 1;
    if (rejections >= threshold) {
      tripped = true;
      const note = guardianHardStopText(rejections);
      return {
        approved: false,
        reason: outcome.reason ? `${outcome.reason}\n\n${note}` : note,
      };
    }
    return outcome;
  };
  return {
    request,
    consecutiveRejections: () => rejections,
    tripped: () => tripped,
  };
}

/** Resolve the effective threshold: run opt > env > config default. */
export function resolveGuardianThreshold(opts: {
  opt?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  configured?: number | undefined;
}): number {
  if (opts.opt !== undefined) return Math.max(0, Math.floor(opts.opt));
  const envRaw = opts.env?.SPYCODE_GUARDIAN_THRESHOLD;
  if (envRaw !== undefined && envRaw.trim().length > 0) {
    const n = Number(envRaw);
    if (Number.isFinite(n)) return Math.max(0, Math.floor(n));
  }
  if (opts.configured !== undefined && Number.isFinite(opts.configured)) {
    return Math.max(0, Math.floor(opts.configured));
  }
  return DEFAULT_GUARDIAN_THRESHOLD;
}
