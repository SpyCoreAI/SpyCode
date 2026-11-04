/**
 * The `delegate` tool's back-end for `runAgent`: the clamped delegation depth
 * of a run, and the Delegator that spawns a child run.
 *
 * `runAgent` is injected by the caller rather than imported, so this module
 * adds no runtime import cycle; imports from loop.ts are type-only. The
 * Delegator is created once per `runAgent` call and reads the run's tool
 * context live (`ctx.recordChange` at call time, never a copy).
 */
import type { AgentEvent, AgentResult, RunAgentOptions } from './loop.js';
import type { Provider } from '../providers/types.js';
import type { ToolContext } from './tools.js';
import {
  CHILD_TASK_PREAMBLE,
  DEFAULT_CHILD_MAX_TURNS,
  DEFAULT_CHILD_MODEL,
  MAX_DELEGATE_DEPTH,
  VALID_CHILD_MODELS,
  type DelegateChildInput,
  type DelegateChildResult,
  type Delegator,
} from './delegate.js';
import { describeBudgetStop } from './budget.js';

/** The run's delegation depth: `delegateDepth` as given, clamped to a non-negative integer. */
export function resolveDelegateDepth(raw: number | undefined): number {
  // m4: clamp - a negative/NaN delegateDepth from a direct library caller
  // would defeat the depth gate (unbounded recursion). External callers
  // leave it unset (0); the model cannot set it.
  const rawDepth = raw ?? 0;
  const delegateDepth =
    typeof rawDepth === 'number' && Number.isFinite(rawDepth) ? Math.max(0, Math.floor(rawDepth)) : 0;
  return delegateDepth;
}

/** The `delegate` tool's back-end for one run; `runAgent` is the injected recursion. */
export function createDelegator({
  opts,
  ctx,
  emit,
  provider,
  model,
  apiUrlOverride,
  budget,
  delegateDepth,
  runAgent,
}: {
  opts: RunAgentOptions;
  ctx: ToolContext;
  emit: (e: AgentEvent) => void;
  provider: Provider;
  model: string;
  apiUrlOverride: RunAgentOptions['apiUrlOverride'];
  budget: RunAgentOptions['budget'];
  delegateDepth: number;
  runAgent: (opts: RunAgentOptions) => Promise<AgentResult>;
}): Delegator {
  // F1 sub-agent orchestration: the `delegate` tool's back-end. Installed on
  // every run's ToolContext (depth 0 at the top); each child gets depth+1.
  //
  // PERMISSION INHERITANCE (the safety case): the child is the same agent with
  // the same rules - the parent's requestApproval gate, command rules, plan
  // mode, web-tools switch, hooks and tool limits are all threaded through
  // unchanged. A plan-phase run cannot smuggle writes past approval by
  // delegating: the child's own dispatch blocks mutating tools in plan mode.
  // What is deliberately NOT shared: loadedSkills (a FRESH set - the child's
  // conversation never saw the parent's injections, so "already loaded" would
  // lie), the conversation/session (fresh), attachments and plan-phase state
  // (parent-specific), and onRunState (the child's conversation id must never
  // masquerade as the parent's in resume bookkeeping).
  //
  // BUDGET: the SAME Budget instance is shared, so the child's tokens/turns/
  // time accumulate into the parent's counters and the parent's caps stop the
  // child exactly as they stop the parent. The before/after snapshots measure
  // the child's OWN spend for the result report.
  //
  // JOURNAL CONTINUITY: the child's file changes belong to the same session
  // the user will rewind, so they flow into the parent's recordChange sink.
  // The sink is read LIVE off ctx (not captured) so the observation window's
  // self-journaled exclusion still applies while a parent window is open
  // around this delegate call - otherwise the window's coarse diff would
  // journal the child's files a second time. recordChanges is WIRED (the
  // mechanical observer-window pin requires it) but deliberately routes
  // per-record through the same live sink: the parent's batch sink would
  // bypass the window's exclusion and double-journal whenever
  // hooks+delegation+child-opaque-calls coincide, and a double record makes
  // `rewind` restore an intermediate state rather than the prior one. The
  // price is the per-record journal cost returning for huge child deltas
  // under --observe - correctness outranks batching across the delegation
  // boundary.
  //
  // RENDERING: the child's whole event stream is re-emitted into the parent's
  // with the child's depth, so a front-end renders nested runs indented
  // (MessageView's `depth` prop) from this stream alone. Depth is set once, by
  // the direct parent's wrapper, and never overwritten further up - so a
  // grandchild's depth-2 tag survives the trip through the child's stream.
  /** The DelegateChildResult shape for a child that never started. */
  const childNotStarted = (error: string): DelegateChildResult => ({
    ok: false,
    finalText: '',
    turns: 0,
    toolCalls: 0,
    tokensUsed: 0,
    turnsUsed: 0,
    budgetStop: null,
    reachedMaxTurns: false,
    cancelled: false,
    stopNote: null,
    error,
  });
  const delegator: Delegator = {
    depth: delegateDepth,
    maxDepth: MAX_DELEGATE_DEPTH,
    spawnChild: async (input: DelegateChildInput) => {
      const childDepth = delegateDepth + 1;
      if (childDepth > MAX_DELEGATE_DEPTH) {
        // Defensive: the tool refuses at the gate before calling; this keeps
        // a mis-wired caller from recursing past the cap.
        return childNotStarted(`delegation depth limit reached (max depth ${MAX_DELEGATE_DEPTH})`);
      }
      // Model selection is provider-aware: a SpyCore slug is meaningless to a
      // BYOK provider, which instead inherits the parent's model id. An
      // explicit slug on the SpyCore provider must be a known one.
      let childModel: string;
      if (provider.id === 'spycore') {
        childModel = input.model ?? DEFAULT_CHILD_MODEL;
        if (!(VALID_CHILD_MODELS as readonly string[]).includes(childModel)) {
          return childNotStarted(
            `unknown model "${childModel}" - use one of: ${VALID_CHILD_MODELS.join(', ')}`,
          );
        }
      } else {
        childModel = input.model && input.model.length > 0 ? input.model : model;
      }
      const before = budget?.snapshot();
      const child = await runAgent({
        task: `${CHILD_TASK_PREAMBLE}\n\n${input.task}`,
        model: childModel,
        provider,
        maxTurns: input.maxTurns ?? DEFAULT_CHILD_MAX_TURNS,
        apiUrlOverride,
        signal: opts.signal,
        cwd: opts.cwd,
        limits: opts.limits,
        requestApproval: opts.requestApproval,
        commandRules: opts.commandRules,
        commandTimeoutMs: opts.commandTimeoutMs,
        planMode: opts.planMode,
        webTools: opts.webTools,
        observeWorkspace: opts.observeWorkspace,
        toolProtocol: opts.toolProtocol,
        projectContext: opts.projectContext,
        budget,
        hooks: opts.hooks,
        // m2: inherit the MCP trust resolver - otherwise the child silently
        // loses project-scoped MCP tools the parent had (fail-closed skips
        // them when the resolver is absent).
        ...(opts.confirmProjectMcpTrust
          ? { confirmProjectMcpTrust: opts.confirmProjectMcpTrust }
          : {}),
        recordChange: (c) => ctx.recordChange?.(c),
        // See JOURNAL CONTINUITY above: wired per-record through the live
        // sink, never the parent's batch sink (which would bypass the
        // observation window's self-journaled exclusion).
        recordChanges: (delta) => {
          const sink = ctx.recordChange;
          if (sink) for (const c of delta) sink(c);
        },
        delegateDepth: childDepth,
        // Tag the child's events with its depth - but only when unset. A
        // grandchild's events already carry the grandchild's depth (set by the
        // child's own wrapper below us); overwriting here would collapse the
        // nesting and every nested run would render at depth 1.
        // F1/F4: swallow the child's `context_full` - it is unactionable here.
        // The parent UI cannot compact a child's context (the compact flow
        // rewrites the main conversation); the child is bounded by the shared
        // budget and its own maxTurns instead.
        onEvent: (e) => {
          if (e.type === 'context_full') return;
          emit(e.depth === undefined ? { ...e, depth: childDepth } : e);
        },
      });
      const after = budget?.snapshot();
      return {
        ok: true,
        finalText: child.finalText,
        turns: child.turns,
        toolCalls: child.toolCalls,
        tokensUsed: (after?.tokensUsed ?? 0) - (before?.tokensUsed ?? 0),
        turnsUsed: (after?.turnsUsed ?? 0) - (before?.turnsUsed ?? 0),
        budgetStop: child.budgetStop,
        reachedMaxTurns: child.reachedMaxTurns,
        cancelled: child.cancelled,
        stopNote:
          child.budgetStop && budget
            ? describeBudgetStop(child.budgetStop, budget.snapshot(), budget.caps)
            : null,
      };
    },
  };
  return delegator;
}
