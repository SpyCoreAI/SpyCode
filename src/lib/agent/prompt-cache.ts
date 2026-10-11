/**
 * A-6 + H-1 - the cache-sacred invariant.
 *
 * The system prompt is BYTE-STABLE for the whole conversation: the tool
 * catalogue, the rules and the identity block never change mid-run, so the
 * provider's KV-cache prefix stays warm and every step after the first is
 * cheaper. Anything that must be injected mid-conversation rides the
 * MESSAGE / tool-result path (the loop's `pending` continuation), never the
 * system prompt - that is the one architectural rule this module guards.
 *
 * The guard is deliberately boring: commit the turn-1 hash, verify any later
 * system send against it. A violation is an internal error (it means a code
 * path rebuilt the system prompt), not something the model ever sees.
 */
import { createHash } from 'node:crypto';

/** SHA-256 of the exact system-prompt bytes the provider received. */
export function hashPrompt(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface PromptCacheGuard {
  /** Record the turn-1 system prompt (fresh conversation). */
  commit(system: string): void;
  /**
   * Assert a later system send is byte-identical to the committed one.
   * Throws when a code path rebuilt the system prompt mid-conversation.
   * A first call with no commit behaves as a commit (continued
   * conversations never re-send the system prompt - the server holds it).
   */
  verify(system: string): void;
  /** The committed hash, or null before the first commit/verify. */
  readonly hash: string | null;
}

export function createPromptCacheGuard(): PromptCacheGuard {
  let committed: string | null = null;
  return {
    commit(system: string): void {
      committed = hashPrompt(system);
    },
    verify(system: string): void {
      if (committed === null) {
        committed = hashPrompt(system);
        return;
      }
      if (hashPrompt(system) !== committed) {
        throw new Error(
          'prompt-cache invariant violated: the system prompt changed mid-conversation - ' +
            'mid-conversation injections must ride the message/tool-result path, never the system prompt',
        );
      }
    },
    get hash(): string | null {
      return committed;
    },
  };
}
