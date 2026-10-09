/**
 * The run event plumbing for `runAgent`: the retained event log with its
 * live `onEvent` forwarding, and the `budget` / `budget_stop` reporting
 * built on top of it.
 *
 * loop.ts re-exports `MAX_RETAINED_EVENTS`, so its public surface is
 * unchanged. Both factories are called once per `runAgent` call; nothing
 * run-scoped lives at module scope.
 *
 * Imports from loop.ts are type-only, so this module adds no runtime import
 * cycle.
 */
import type { Budget, BudgetReason } from './budget.js';
import type { AgentEvent, RunAgentOptions } from './loop.js';

/**
 * Bound on the per-run retained event log (AgentResult.events). Oldest
 * events are dropped past this size; the live onEvent stream still sees
 * everything.
 */
export const MAX_RETAINED_EVENTS = 10_000;

/** The per-run event log and the `emit` every other run helper reports through. */
export function createEventSink(opts: Pick<RunAgentOptions, 'onEvent'>): {
  events: AgentEvent[];
  emit: (e: AgentEvent) => void;
} {
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent): void => {
    events.push(e);
    // Bound the retained event log: a runaway run emitting an event per
    // token would otherwise grow this array without limit. Oldest dropped;
    // the live onEvent stream is unaffected.
    if (events.length > MAX_RETAINED_EVENTS) {
      events.splice(0, events.length - MAX_RETAINED_EVENTS);
    }
    opts.onEvent?.(e);
  };
  return { events, emit };
}

/** Budget reporting for one run: `budget` events per turn and the `budget_stop` event. */
export function createBudgetReporter(
  budget: Budget | undefined,
  emit: (e: AgentEvent) => void,
): {
  hasTurnBudget: boolean;
  emitBudget: () => void;
  emitBudgetStop: (reason: BudgetReason) => void;
} {
  const hasTurnBudget = !!budget && budget.caps.maxTurns !== undefined;
  const emitBudget = (): void => {
    if (!budget?.hasCaps) return;
    const s = budget.snapshot();
    emit({ type: 'budget', tokensUsed: s.tokensUsed, turnsUsed: s.turnsUsed, elapsedMs: s.elapsedMs });
  };
  const emitBudgetStop = (reason: BudgetReason): void => {
    if (!budget) return;
    const s = budget.snapshot();
    const cap =
      reason === 'tokens'
        ? budget.caps.maxTokens ?? 0
        : reason === 'time'
          ? budget.caps.maxTimeMs ?? 0
          : budget.caps.maxTurns ?? 0;
    emit({ type: 'budget_stop', reason, cap, tokensUsed: s.tokensUsed, turnsUsed: s.turnsUsed, elapsedMs: s.elapsedMs });
  };
  return { hasTurnBudget, emitBudget, emitBudgetStop };
}
