/**
 * PLAN / ASK / AGENT modes for the chat TUI - PHASE-1 1.7.
 *
 * This is the render-agnostic CORE for the chat session's plan/agent modes
 * (the registry / commit-flow philosophy): the Ink session supplies IO; all
 * execution goes through the EXISTING runAgent path - no parallel execution
 * path exists in this module or anywhere else.
 *
 * STRUCTURAL per-mode tool policy (RULE 9):
 * - ASK is not an agent mode at all: this module type- AND runtime-rejects
 * it. Ask-mode messages ride the plain chat contract, which has NO tool
 * registry - zero write/exec capability exists there.
 * - PLAN runs `runAgent({planMode: true})`: the read-only registry subset
 * is composed AT LOOP START (read-only prompt catalogue, read-only
 * native declarations, NO MCP bridge spawned) and the dispatch guard
 * hard-errors any guessed mutating call before it can execute.
 * - AGENT runs the full existing loop with the NORMAL approval model via
 * the tested createApprovalController. Nothing here can approve:
 * approving a plan only unlocks the execute phase, whose every write /
 * command still prompts individually (autoApproveAll starts false and
 * only the user's own accept_all answer ever sets it).
 *
 * Hooks fire identically in every mode: prompt-submit at the top of this
 * core (a block means the run never starts), pre/post-tool via the SAME
 * createAgentHooksBridge → dispatchWithHooks wrapper the agent command uses.
 *
 * Checkpoints/budgets/resume: a hosted run records through the SAME
 * RunRecorder rules as `spycore agent` (plan phases persist nothing; an
 * interrupted execute run is resumable with `spycore agent --resume`).
 */
import {
  createRunBudget,
  readAgentObserveWorkspace,
  readAgentWebTools,
  resolveMaxTurns,
} from './agent/run-config.js';
import { createRunRecorder } from './agent/checkpoint.js';
import {
  DEFAULT_MAX_TURNS,
  runAgent,
  type AgentEvent,
} from './agent/loop.js';
import {
  createApprovalController,
  type ApprovalDecision,
  type ApprovalRequest,
} from './agent/approval.js';
import type { EffectiveCommandRules } from './agent/command-rules.js';
import { currentGitHead, makeRunStateHook } from './agent/resume.js';
import {
  createAgentHooksBridge,
  fireHookEvent,
  type HookSession,
} from './hooks.js';
import type { ModelSlug } from './models.js';
import { agentModelFor } from './chat-mode.js';
import { composeReviseFeedback, runPlanEditSession } from './plan-edit.js';

export interface ChatAgentIo {
  notify(kind: 'info' | 'success' | 'warning' | 'error', text: string): void;
  /** Render one loop event (tool calls/results, narration, final, notices). */
  renderEvent(event: AgentEvent): void;
  /** Show the produced plan (already display-sanitized by the surface). */
  presentPlan(plan: string): void;
  /** One-line answer (plan decision). */
  ask(question: string): Promise<string>;
  /** Free-text answer (plan revision feedback). */
  readText(question: string): Promise<string>;
  /** The NORMAL per-action approval prompt - mode switching never bypasses it. */
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
}

export interface ChatAgentRunOpts {
  cwd: string;
  /** The user's prompt, treated as the agent TASK. */
  task: string;
  /** ONLY plan | agent - ask never reaches an agent loop (runtime-enforced). */
  mode: 'plan' | 'agent';
  /** The chat session's active model (clamped to the agent set). */
  model: ModelSlug;
  apiUrlOverride?: string | undefined;
  /** The session's lifecycle hooks - fire identically in every mode. */
  hooks?: HookSession | undefined;
  /** PHASE-1 1.10: command allow/deny rules (loaded + trust/approval-gated by
   * the session surface). Absent ⇒ rule-free approval behavior. */
  commandRules?: EffectiveCommandRules | undefined;
  /** Project context block (the session already computes it). */
  projectContext?: string | undefined;
  /** Model-call provider override (tests). Default = the SpyCore backend. */
  provider?: import('./providers/types.js').Provider | undefined;
  signal?: AbortSignal | undefined;
  io: ChatAgentIo;
}

export interface ChatAgentRunResult {
  completed: boolean;
  finalText?: string;
}

/**
 * Run one plan- or agent-mode turn inside the chat session, entirely through
 * the existing runAgent machinery. NEVER throws (the Ink session must
 * survive); failures land as io.notify('error', …).
 */
export async function runChatAgentTurn(opts: ChatAgentRunOpts): Promise<ChatAgentRunResult> {
  const { io, cwd } = opts;
  if ((opts.mode as string) === 'ask') {
    // Structural pin: ask NEVER hosts an agent loop - the plain chat
    // contract (no tool registry) is the only ask-mode path.
    io.notify('error', 'Ask mode has no agent run - send the message normally.');
    return { completed: false };
  }

  // ── prompt-submit hook: identical semantics to every other surface. ──
  if (opts.hooks) {
    try {
      const gate = await fireHookEvent(opts.hooks, 'prompt-submit', { prompt: opts.task });
      for (const n of gate.notices) io.notify('warning', n);
      if (gate.blocked) return { completed: false };
    } catch {
      /* hooks never break the session */
    }
  }

  const { model, clamped } = agentModelFor(opts.model);
  if (clamped) {
    io.notify('warning', `The session model isn't available for agent runs - using ${model} for this run.`);
  }
  const planMode = opts.mode === 'plan';
  // Shared run-config resolvers - the same knobs `spycore agent` resolves,
  // so the two front-ends cannot diverge silently.
  const webTools = readAgentWebTools();
  // No per-run flag on the chat-driven agent either; the key is the control.
  // - OPT-IN. Only the literal `true` enables the observer, so an
  // absent key leaves it off exactly as a fresh install has it.
  const observeWorkspace = readAgentObserveWorkspace();
  const maxTurns = resolveMaxTurns(DEFAULT_MAX_TURNS);

  // Normal approval model, reused verbatim: autoApproveAll starts FALSE and
  // only the user's own accept_all answer flips it. Plan approval never
  // touches this controller.
  const ctrl = createApprovalController();
  const requestApproval: typeof ctrl.request = async (req) => {
    // The loop dispatches sequentially, so a pending slot after request()
    // is THIS request. After the user's own accept_all, request() resolves
    // immediately (nothing pending) and no prompt is shown.
    const pendingAnswer = ctrl.request(req);
    if (ctrl.hasPending()) {
      try {
        ctrl.resolvePending(await io.requestApproval(req));
      } catch {
        ctrl.reject('rejected by user');
      }
    }
    return pendingAnswer;
  };

  const hooksBridge = opts.hooks ? createAgentHooksBridge(opts.hooks) : null;
  const budget = createRunBudget();
  const loadedSkills = new Set<string>();

  // Same recorder rules as `spycore agent` (1.4): created up front; plan
  // phases persist nothing (no onRunState); execute journals step boundaries.
  const recorder = createRunRecorder({
    cwd,
    task: opts.task,
    initial: {
      providerKind: 'spycore',
      model,
      planMode,
      maxTurns,
      budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} },
      gitHead: currentGitHead(cwd),
    },
  });

  const runPhase = (extra: {
    planMode?: boolean;
    approvedPlan?: string;
    planEdited?: boolean;
    planFeedback?: string;
  }) =>
    runAgent({
      task: opts.task,
      model,
      maxTurns,
      apiUrlOverride: opts.apiUrlOverride,
      signal: opts.signal,
      cwd,
      requestApproval,
      // 1.10: rules ride the same runAgent path - deny fires before the
      // approval prompt; allow auto-approves only tokenizer-eligible commands.
      commandRules: opts.commandRules,
      recordChange: (c) => recorder.recordChange(c),
      // F-2c-48 · C-UX45: one journal commit per observation window, not per record.
      recordChanges: (cs) => recorder.recordChanges(cs),
      budget,
      loadedSkills,
      webTools,
      observeWorkspace,
      projectContext: opts.projectContext,
      provider: opts.provider,
      onEvent: (e) => io.renderEvent(e),
      ...(hooksBridge?.hasAny ? { hooks: hooksBridge } : {}),
      ...(extra.planMode
        ? {}
        : { onRunState: makeRunStateHook({ recorder, budget, cwd, loadedSkills }) }),
      ...extra,
    });

  try {
    let plan: string | undefined;
    let planEdited = false;
    if (planMode) {
      let planRes = await runPhase({ planMode: true });
      // Empty-plan guard - the same single retry the agent command uses.
      if (!planRes.cancelled && planRes.finalText.trim().length === 0) {
        io.notify('warning', 'Empty plan returned - retrying once…');
        planRes = await runPhase({
          planMode: true,
          planFeedback:
            'Your previous reply was EMPTY. Output the one-line summary and the NUMBERED plan now, exactly as instructed.',
        });
      }
      if (planRes.cancelled) {
        io.notify('warning', 'Interrupted.');
        recorder.abandon();
        return { completed: false };
      }
      plan = planRes.finalText;

      // ── plan decision loop: approve / edit / revise / cancel. Approval
      // starts execution through the SAME runAgent path; it pre-approves
      // NOTHING - the per-action approval controller above still prompts for
      // every write and command, EDITED OR NOT (the 1.11 invariant: no code
      // path from plan content to approval state exists).
      // `lastGenerated` tracks the model's latest plan so an EDITED approval
      // can be marked (M4) and an edited [r]evise carries the edited plan.
      let lastGenerated = plan;
      for (;;) {
        io.presentPlan(plan);
        const answer = (
          await io.ask('[a]pprove & execute / [e]dit / [r]evise (give feedback) / [c]ancel: ')
        )
          .trim()
          .toLowerCase();
        if (answer === 'a' || answer === 'approve' || answer === 'y' || answer === 'yes') {
          break;
        }
        if (answer === 'e' || answer === 'edit') {
          // 1.11: the shared edit session transforms only this local string;
          // discard inside the session restores the pre-edit plan and returns
          // here (NOT run-cancel). The edited plan re-renders at the loop head.
          const res = await runPlanEditSession(plan, {
            present: (t) => io.notify('info', t),
            ask: (q) => io.ask(q),
            readText: (q) => io.readText(q),
            notify: (k, t) => io.notify(k, t),
          });
          plan = res.plan;
          continue;
        }
        if (answer === 'r' || answer === 'revise') {
          const feedback = (await io.readText('Feedback for the revised plan:')).trim();
          // Unedited → the feedback verbatim (byte-identical to 1.7); edited →
          // the EDITED plan is the current plan and rides the regeneration.
          const composed = composeReviseFeedback(plan, lastGenerated, feedback);
          const revised = await runPhase({
            planMode: true,
            ...(composed ? { planFeedback: composed } : {}),
          });
          if (revised.cancelled) {
            io.notify('warning', 'Interrupted.');
            recorder.abandon();
            return { completed: false };
          }
          if (revised.finalText.trim().length > 0) {
            plan = revised.finalText;
            lastGenerated = plan;
          }
          continue;
        }
        // cancel (or anything unrecognized after a re-ask would loop - treat
        // c/n/q as cancel, everything else re-asks via the loop head).
        if (answer === 'c' || answer === 'cancel' || answer === 'n' || answer === 'no' || answer === 'q') {
          io.notify('warning', 'Plan discarded - nothing executed.');
          recorder.abandon();
          return { completed: false };
        }
      }
      planEdited = plan !== lastGenerated;
      // M5: the recorder stores the (possibly edited) plan VERBATIM - the M4
      // marker is injection-time wording in the loop, never stored plan text.
      recorder.update({ approvedPlan: plan });
    }

    const result = await runPhase({
      ...(plan ? { approvedPlan: plan, ...(planEdited ? { planEdited: true } : {}) } : {}),
    });
    const stoppedShort =
      result.cancelled || result.budgetStop !== null || result.reachedMaxTurns;
    recorder.finalize(stoppedShort ? 'interrupted' : 'completed');
    if (result.cancelled) {
      io.notify('warning', 'Interrupted.');
      return { completed: false };
    }
    if (recorder.changeCount() > 0) {
      io.notify(
        'info',
        // Scope named for the same reason as AgentApp's sibling line: the count
        // is of journaled files, and the journal is bounded by the workspace.
        `${recorder.changeCount()} file${recorder.changeCount() === 1 ? '' : 's'} changed in this workspace - undo with \`spycore rewind\`.`,
      );
    }
    return { completed: true, finalText: result.finalText };
  } catch (err) {
    recorder.abandon();
    io.notify('error', err instanceof Error ? err.message : String(err));
    return { completed: false };
  }
}
