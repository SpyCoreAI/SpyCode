/**
 * Chat-session modes (PHASE-1 1.7) - the pure, dependency-light helpers.
 *
 * Kept separate from the run core (chat-agent-run.ts) so the slash registry
 * can validate /mode without dragging the agent stack into the one-shot
 * import graph. Type-only imports below add no runtime edges.
 */
import type { AgentModelSlug } from './agent/loop.js';
import type { ModelSlug } from './models.js';

/** ask = plain conversation (no tool registry exists at all on that path);
 *  plan = read-only exploration that produces a plan; agent = the full loop. */
export type ChatMode = 'ask' | 'plan' | 'agent';
export const CHAT_MODES: readonly ChatMode[] = ['ask', 'plan', 'agent'];
export const DEFAULT_CHAT_MODE: ChatMode = 'ask';

export function isChatMode(v: string): v is ChatMode {
  return (CHAT_MODES as readonly string[]).includes(v);
}

/** Shift+Tab cycle order: ask → plan → agent → ask. */
export function nextChatMode(mode: ChatMode): ChatMode {
  const idx = CHAT_MODES.indexOf(mode);
  return CHAT_MODES[(idx + 1) % CHAT_MODES.length] as ChatMode;
}

/**
 * Mid-run switch policy: REJECTED while a run/flow is active (never queued).
 * Both /mode and the keybinding consult this ONE helper. An in-flight run's
 * registry could not mutate anyway - composition happens once from runAgent
 * opts at start - but the switch is refused outright for clarity.
 *
 * 1.8: /compact reuses the SAME gate (an in-place summarize must never race a
 * streaming turn); the `action` label defaults to the 1.7 wording so every
 * existing caller's message stays byte-identical.
 */
export function modeSwitchBlockedReason(
  runActive: boolean,
  action = 'mode switching',
): string | null {
  return runActive
    ? `A run is in progress - ${action} is disabled until it finishes.`
    : null;
}

/**
 * Map the chat session's model onto the agent loop's supported set. The chat
 * surface can sit on styx_max (not an agent slug) - clamp to styx with a
 * notice; hephaestus cannot occur in chat.
 */
export function agentModelFor(model: ModelSlug): { model: AgentModelSlug; clamped: boolean } {
  if (model === 'charon' || model === 'styx' || model === 'hermes' || model === 'minos') {
    return { model, clamped: false };
  }
  return { model: 'styx', clamped: true };
}
