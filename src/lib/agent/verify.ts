/**
 * Self-verify: after the agent reports the task complete, run a user-specified
 * verification command (e.g. "npm test"). On failure, inject the failure back
 * into the SAME conversation so the agent fixes it, then re-verify — bounded by
 * --verify-attempts. Turns "I think I'm done" into "the check actually passes".
 *
 * The verify command runs via the shared executor (sandbox cwd, the same
 * timeout / process-group kill / output cap as run_command) WITHOUT an approval
 * prompt — the user pre-authorized it by passing --verify — but still through
 * the catastrophic denylist as a safety net.
 */
import { runShellCommand, tailLines, matchesCatastrophic, DEFAULT_COMMAND_TIMEOUT_MS } from './tools.js';
import type { AgentResult } from './loop.js';
import type { Budget } from './budget.js';

export type VerifyEvent =
  | { type: 'verify_start'; command: string; attempt: number; attempts: number }
  | {
      type: 'verify_result';
      command: string;
      attempt: number;
      attempts: number;
      passed: boolean;
      blocked: boolean;
      exitCode: number | null;
      timedOut: boolean;
      outputTail: string;
    };

export interface VerifyOutcome {
  /** False only when the command was blocked by the denylist (never ran). */
  ran: boolean;
  passed: boolean;
  /** How many verify runs were performed. */
  attempts: number;
  cancelled: boolean;
  lastTail: string;
  /** Set when a cost/runaway budget cut the verify loop short. */
  stoppedByBudget?: boolean;
}

export interface VerifyLoopOptions {
  verifyCommand: string;
  /** Clamped 1–10. */
  attempts: number;
  cwd: string;
  commandTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Re-enter the agent on the same conversation with the failure feedback. */
  continueRun: (conversationId: string, message: string) => Promise<AgentResult>;
  /** Shared cost/runaway budget — a hit cap stops the whole verify loop. */
  budget?: Pick<Budget, 'check'> | undefined;
  onEvent?: (event: VerifyEvent) => void;
}

export function clampVerifyAttempts(n: number | undefined): number {
  const v = Number.isFinite(n) ? Number(n) : 3;
  return Math.max(1, Math.min(10, Math.floor(v) || 3));
}

function feedback(command: string, exitCode: number | null, timedOut: boolean, tail: string): string {
  const status = timedOut ? 'timed out' : `exited with code ${exitCode}`;
  return `Your verification command \`${command}\` failed (${status}):

${tail.length > 0 ? tail : '(no output)'}

Fix the underlying cause and complete the task. When you are confident it is fixed, stop with a final answer.`;
}

/**
 * Run the verify→fix→re-verify loop. Returns once the command passes, the
 * attempt budget is exhausted, the run is cancelled, or the command is blocked.
 */
export async function runVerifyLoop(
  initialConversationId: string,
  opts: VerifyLoopOptions,
): Promise<VerifyOutcome> {
  const attempts = clampVerifyAttempts(opts.attempts);
  const timeoutMs = opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  let conversationId = initialConversationId;
  let lastTail = '';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (opts.signal?.aborted) {
      return { ran: true, passed: false, attempts: attempt - 1, cancelled: true, lastTail };
    }
    // A cost/runaway cap hit (e.g. during the prior fix) stops everything.
    if (opts.budget?.check()) {
      return { ran: true, passed: false, attempts: attempt - 1, cancelled: false, lastTail, stoppedByBudget: true };
    }
    opts.onEvent?.({ type: 'verify_start', command: opts.verifyCommand, attempt, attempts });

    // Safety net: never run an obviously catastrophic verify command.
    const danger = matchesCatastrophic(opts.verifyCommand);
    if (danger) {
      lastTail = `blocked: refusing to run a catastrophic verification command (${danger})`;
      opts.onEvent?.({
        type: 'verify_result',
        command: opts.verifyCommand,
        attempt,
        attempts,
        passed: false,
        blocked: true,
        exitCode: null,
        timedOut: false,
        outputTail: lastTail,
      });
      return { ran: false, passed: false, attempts: attempt, cancelled: false, lastTail };
    }

    const run = await runShellCommand(opts.verifyCommand, opts.cwd, timeoutMs, opts.signal);
    const passed = !run.timedOut && run.exitCode === 0;
    lastTail = tailLines(run.combined, 40);
    opts.onEvent?.({
      type: 'verify_result',
      command: opts.verifyCommand,
      attempt,
      attempts,
      passed,
      blocked: false,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      outputTail: lastTail,
    });

    if (passed) return { ran: true, passed: true, attempts: attempt, cancelled: false, lastTail };
    if (attempt === attempts) return { ran: true, passed: false, attempts, cancelled: false, lastTail };
    if (opts.signal?.aborted) {
      return { ran: true, passed: false, attempts: attempt, cancelled: true, lastTail };
    }

    // Inject the failure as a new turn and let the agent fix it.
    const fixRes = await opts.continueRun(conversationId, feedback(opts.verifyCommand, run.exitCode, run.timedOut, lastTail));
    conversationId = fixRes.conversationId;
    if (fixRes.cancelled) {
      return { ran: true, passed: false, attempts: attempt, cancelled: true, lastTail };
    }
    // The fix exhausted the shared budget — stop instead of re-verifying.
    if (fixRes.budgetStop) {
      return { ran: true, passed: false, attempts: attempt, cancelled: false, lastTail, stoppedByBudget: true };
    }
  }
  return { ran: true, passed: false, attempts, cancelled: false, lastTail };
}
