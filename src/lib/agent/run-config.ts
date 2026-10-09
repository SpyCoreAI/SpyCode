/**
 * Shared agent-run configuration - the knobs both front-ends resolve.
 *
 * `spycore agent` (src/commands/agent.ts) and the chat TUI's plan/agent modes
 * (src/lib/chat-agent-run.ts) used to resolve the same knobs with separate
 * inline expressions: `getConfigStore().get('agentWebTools') !== false` here,
 * `resolveWebToolsEnabled(undefined, …)` there, a clamped max-turns in one
 * and the raw default in the other. Same semantics, two spellings - the shape
 * that lets one path's default drift without the other noticing.
 *
 * Every knob below has ONE resolver. Both front-ends call it; neither
 * re-spells it.
 */
import { getConfigStore } from '../config.js';
import { DEFAULT_MAX_TURNS, MAX_TURNS_CAP, MIN_TURNS } from './loop.js';
import { createBudget, toBudgetCaps, type Budget, type BudgetCaps, type BudgetSnapshot } from './budget.js';

/**
 * Resolve whether the agent's web tools (web_search / fetch_url) are offered:
 * the `--no-web` flag wins; otherwise the `agentWebTools` config key (default
 * true).
 */
export function resolveWebToolsEnabled(
  webFlag: boolean | undefined,
  configValue: unknown,
): boolean {
  if (webFlag === false) return false;
  return configValue !== false;
}

/**
 * Resolve whether the workspace observer runs: an explicit flag wins in EITHER
 * direction; otherwise the `agentObserveWorkspace` config key.
 *
 * R-CLI-1 - THE DEFAULT IS THE PRODUCT DECISION, AND IT IS
 * **OFF**. It is expressed as `=== true` rather than as a truthiness test: an
 * absent flag, an absent key, and a key holding anything other than the
 * literal `true` all leave the observer OFF, so nothing is read and nothing is
 * written.
 *
 * The reason is not that observation is unsafe - it is that it reads the
 * FULL PLAINTEXT of every file the ignore rules do not hide and stores it in an
 * on-disk journal, and the published `0.6.0` writes nothing of the kind. A user
 * who merely UPDATES must not silently acquire a new on-disk archive of their
 * project. NO CAPABILITY IS REMOVED: `--observe` turns it on for one run and
 * `spycore config set agentObserveWorkspace true` turns it on for good.
 */
export function resolveObserveWorkspaceEnabled(
  observeFlag: boolean | undefined,
  configValue: unknown,
): boolean {
  if (observeFlag === false) return false;
  if (observeFlag === true) return true;
  return configValue === true;
}

/**
 * Resolve the turn cap: the raw `--max-turns` value (or the default when
 * absent/unparseable), clamped to [MIN_TURNS, MAX_TURNS_CAP]. Both front-ends
 * go through this so a default change can never escape the clamp on one path.
 */
export function resolveMaxTurns(raw: unknown): number {
  return Math.max(
    MIN_TURNS,
    Math.min(MAX_TURNS_CAP, Number(raw ?? DEFAULT_MAX_TURNS) || DEFAULT_MAX_TURNS),
  );
}

/** Web-tools resolution straight from the config store (no per-run flag). */
export function readAgentWebTools(): boolean {
  return resolveWebToolsEnabled(undefined, getConfigStore().get('agentWebTools'));
}

/** Observer resolution straight from the config store (no per-run flag). */
export function readAgentObserveWorkspace(): boolean {
  return resolveObserveWorkspaceEnabled(undefined, getConfigStore().get('agentObserveWorkspace'));
}

/**
 * Budget caps from the run's flags. A turn cap only becomes a whole-run
 * budget when the user EXPLICITLY passes --max-turns (not the default), so
 * the built-in per-call iteration guard is unchanged without it. Both the
 * fresh-run and resume paths in `spycore agent` share this - it was two
 * identical inline expressions.
 */
export function resolveBudgetCaps(flags: {
  maxTokens?: string | undefined;
  maxTime?: string | undefined;
  /** True when --max-turns came from the CLI (not the default). */
  maxTurnsExplicit: boolean;
  maxTurns: number;
}): BudgetCaps {
  return toBudgetCaps({
    maxTokens: flags.maxTokens !== undefined ? Number(flags.maxTokens) : undefined,
    maxTimeMs: flags.maxTime !== undefined ? Number(flags.maxTime) * 1000 : undefined,
    maxTurns: flags.maxTurnsExplicit ? flags.maxTurns : undefined,
  });
}

/** A fresh run budget on the shared clock; `initial` pre-loads a resumed run's spend. */
export function createRunBudget(caps: BudgetCaps = {}, initial?: BudgetSnapshot): Budget {
  return createBudget(caps, Date.now, initial);
}
