/**
 * Bounds for the BYOK adapters' client-side history. The endpoints are
 * stateless, so each adapter accumulates the conversation locally and
 * replays the FULL array on every turn - unbounded, a long agent run
 * grows quadratically in cost and eventually outgrows the model's
 * context window with no compaction and no graceful error. The sessions
 * map itself was never pruned either, so idle sessions accumulated for
 * the process lifetime.
 *
 * - History is trimmed to MAX_BYOK_HISTORY_MESSAGES per session, oldest
 *   user/assistant PAIR first, so the role alternation Anthropic/Google
 *   require survives the trim. The system prompt is not stored in the
 *   message array (Anthropic/Google keep it top-level; OpenAI folds it
 *   into each turn's user message), so trimming never drops it.
 * - Sessions idle longer than BYOK_SESSION_IDLE_MS are dropped, and the
 *   map is capped at MAX_BYOK_SESSIONS (oldest first).
 */
import type { ProviderMessage } from './types.js';

/** Most messages kept per BYOK session (50 turns of user + assistant). */
export const MAX_BYOK_HISTORY_MESSAGES = 100;
/** Most live sessions kept per provider instance. */
export const MAX_BYOK_SESSIONS = 32;
/** Idle sessions older than this are pruned on the next conversation. */
export const BYOK_SESSION_IDLE_MS = 60 * 60 * 1000;

/**
 * Trim `messages` in place to at most `max` entries, dropping the oldest
 * user/assistant pair at a time. Never drops the last message (the turn
 * in flight). No-op when already within the cap.
 */
export function trimHistoryMessages(
  messages: ProviderMessage[],
  max: number = MAX_BYOK_HISTORY_MESSAGES,
): void {
  while (messages.length > max && messages.length > 1) {
    messages.splice(0, 2);
  }
}

/**
 * Drop idle sessions from `sessions` (and their `lastUsed` entries), then
 * drop the oldest until at most MAX_BYOK_SESSIONS remain. Pure map
 * surgery - the caller owns both maps and calls this from
 * `createConversation`, so a fresh conversation is what pays for the
 * prune, never a turn in flight.
 */
export function pruneByokSessions<T>(
  sessions: Map<string, T>,
  lastUsed: Map<string, number>,
): void {
  const now = Date.now();
  for (const [id, at] of [...lastUsed]) {
    if (now - at > BYOK_SESSION_IDLE_MS) {
      sessions.delete(id);
      lastUsed.delete(id);
    }
  }
  if (sessions.size <= MAX_BYOK_SESSIONS) return;
  const byAge = [...lastUsed.entries()].sort((a, b) => a[1] - b[1]);
  for (const [id] of byAge) {
    if (sessions.size <= MAX_BYOK_SESSIONS) break;
    sessions.delete(id);
    lastUsed.delete(id);
  }
}
