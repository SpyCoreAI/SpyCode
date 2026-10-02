/**
 * Self-verify: after the agent reports the task complete, run a user-specified
 * verification command (e.g. "npm test"). On failure, inject the failure back
 * into the SAME conversation so the agent fixes it, then re-verify — bounded by
 * --verify-attempts. Turns "I think I'm done" into "the check actually passes".
 *
 * The verify command runs via the shared executor (sandbox cwd, the same
 * timeout / process-group kill / output cap as run_command), through the
 * catastrophic screen, the configured command rules, and the SAME approval
 * gate every other execution path uses.
 *
 * ⭐ WHY THE GATE EXISTS, stated precisely because the obvious reason is wrong.
 * `verifyCommand` is NOT model-generated: it is the string the user typed after
 * `--verify`, fixed for the whole loop. What changes between attempts is not
 * the command but the WORKSPACE — this loop's entire purpose is to let the
 * agent rewrite the project and then re-run the check. So `npm test` on attempt
 * 3 executes whatever `package.json`, the test runner config and the test files
 * say AFTER the agent has edited them, which is not what the user authorised
 * when they typed it. Until this gate existed, that re-execution was the only
 * path in the package with no approval control in ANY mode — not merely under
 * `--yes`.
 *
 * ⭐ NO NEW APPROVAL MODE. The order and the semantics are `run_command`'s,
 * unchanged: catastrophic screen → deny rule → allow rule → `requestApproval`,
 * failing CLOSED when no resolver is wired. Headless without `--yes` therefore
 * auto-rejects, and under `--yes` this behaves exactly as `run_command` does.
 * A user who does not want the prompt has the mechanism that already exists —
 * an allow rule for their verify command — rather than a bespoke exemption.
 */
import { runShellCommand, tailLines, matchesCatastrophic, DEFAULT_COMMAND_TIMEOUT_MS } from './tools.js';
import { evaluateCommandRules, type EffectiveCommandRules } from './command-rules.js';
import type { ApprovalRequest, CommandPreApproval, RequestApproval } from './approval.js';
import { resolveApproval } from './approval.js';
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
  /** False when the command never ran — blocked by the screen, a deny rule, or a refused approval. */
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
  /**
   * The approval resolver, identical to the one `run_command` is given.
   * OPTIONAL in the type and FAIL-CLOSED at the call: an omitted resolver
   * refuses, exactly as `tools.ts` does, so a caller that forgets to wire it
   * cannot silently restore the ungated behaviour this replaced.
   */
  requestApproval?: RequestApproval | undefined;
  /** Configured allow/deny rules — the same table `run_command` consults. */
  commandRules?: EffectiveCommandRules | undefined;
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

    // The approval control, in `run_command`'s exact order and semantics.
    // A deny rule returns before the resolver is consulted, so neither --yes
    // nor a session accept_all can override it; an allow rule auto-approves.
    let preApproved: CommandPreApproval | undefined;
    if (opts.commandRules) {
      const decision = evaluateCommandRules(opts.verifyCommand, opts.commandRules);
      if (decision.action === 'deny') {
        lastTail = `blocked: the verification command is denied by the ${decision.rule.scope} rule "${decision.rule.entry}"`;
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
      if (decision.action === 'allow') {
        preApproved = { scope: decision.rule.scope, entry: decision.rule.entry };
      }
    }

    {
      const request: ApprovalRequest = { kind: 'command', command: opts.verifyCommand };
      // ⭐⭐ F-2c-45 (`C-PR34`, the sibling site) — this block used to sit
      // inside `if (!autoApproved)`, a byte-for-byte clone of `run_command`'s
      // skip. The clone was never filed; it was found by deriving the class
      // from the source rather than reading the one report. The channel is now
      // unconditional and the rule supplies the decision inside it.
      //
      // Fail closed — the absent-resolver arm REFUSES. This is the line that
      // makes the gate real: were it to default to approval, every caller that
      // forgot to wire a resolver would be back to the ungated path.
      //
      // ⭐ RULING 2 — the auto-reject stays, but it must be LOUD. A silent
      // refusal is worse than the interaction it replaces: the run that hits
      // this arm is headless without `--yes`, where nobody is at the keyboard
      // to infer what happened. So the reason names the exact two routes that
      // pre-approve it, rather than describing the internal state that produced
      // the refusal.
      const outcome = await resolveApproval(
        opts.requestApproval,
        request,
        preApproved,
        'no approval prompt is available here (non-interactive run without --yes). ' +
          'Pre-approve it with --yes, or add an `allow` command rule for this ' +
          'command (`spycore command-rules`)',
      );
      if (!outcome.approved) {
        lastTail = `blocked: verification was not approved — ${outcome.reason ?? 'rejected by user'}`;
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
