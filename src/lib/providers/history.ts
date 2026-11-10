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
import type { ProviderMessage, ProviderToolCall } from './types.js';

/** Most messages kept per BYOK session (50 turns of user + assistant). */
export const MAX_BYOK_HISTORY_MESSAGES = 100;
/** Most live sessions kept per provider instance. */
export const MAX_BYOK_SESSIONS = 32;
/** Idle sessions older than this are pruned on the next conversation. */
export const BYOK_SESSION_IDLE_MS = 60 * 60 * 1000;

/**
 * Render native tool calls as the fenced `spycore:tool` blocks the agent
 * loop parses (see protocol.ts) - one block per call, in order. The replayed
 * assistant message then reads exactly like a fenced turn's own output, so
 * the next turn can see what the model called. Unparseable arguments (a
 * stream cut short mid-fragment) fall back to an empty object rather than
 * breaking the render - the call name itself is the part that must survive.
 */
export function formatToolCallsForHistory(calls: ProviderToolCall[]): string {
  return calls
    .map((c) => {
      let args: unknown = {};
      try {
        args = JSON.parse(c.arguments && c.arguments.length > 0 ? c.arguments : '{}');
      } catch {
        args = {};
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
      return '```spycore:tool\n' + JSON.stringify({ tool: c.name, args }) + '\n```';
    })
    .join('\n');
}

/**
 * Record a finished assistant turn in a BYOK session history (R2-10).
 * The Anthropic/Google wires reject an assistant message with empty content
 * when a user message follows it, so a no-text turn must NEVER be recorded
 * as `{content: ''}`: a tool-call-only turn is recorded as its calls
 * (fenced, via formatToolCallsForHistory), and a turn with neither text nor
 * calls as an explicit `(empty reply)` marker - both keep the history
 * alternating and non-empty, so the next turn's request stays valid and
 * the model can see what (if anything) it did. A turn WITH text is
 * recorded exactly as before.
 */
export function recordAssistantMessage(
  messages: ProviderMessage[],
  text: string,
  toolCalls: ProviderToolCall[],
): void {
  if (text.length > 0) {
    messages.push({ role: 'assistant', content: text });
    return;
  }
  if (toolCalls.length > 0) {
    messages.push({ role: 'assistant', content: formatToolCallsForHistory(toolCalls) });
    return;
  }
  messages.push({ role: 'assistant', content: '(empty reply)' });
}

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
