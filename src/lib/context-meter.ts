/**
 * Context meter — PHASE-1 1.8. Pure helpers behind the TUI status-bar
 * `context ~N%` segment and its 80% warning.
 *
 * Measurement source, in order of preference:
 *   1. the server's last-turn `usage` SSE event (`input` ≈ the full assembled
 *      context the model just read) — exact, and already consumed by ChatApp;
 *   2. before the first reply of a conversation, a calibrated chars/4
 *      heuristic over the characters sent so far.
 * Both render as `~N%` against the APPROXIMATE window map below, so the
 * segment is always labeled as an estimate. No reading → the segment is
 * omitted entirely and the status bar renders byte-identically (the 1.7
 * `mode` segment precedent).
 *
 * The window map is client-side and approximate BY DESIGN: every figure
 * mirrors what the public SpyCore model pages already state (Hermes 262K,
 * Minos 1M, Styx 256K, Charon 1M); Styx Max carries the Styx family figure —
 * no separate window is published for it. SpyCore model names only.
 */
import type { ModelSlug } from './models.js';

/** Approximate context windows (tokens) per SpyCore chat model. */
export const CONTEXT_WINDOW_TOKENS: Partial<Record<ModelSlug, number>> = {
  hermes: 262_000,
  minos: 1_000_000,
  styx: 256_000,
  styx_max: 256_000,
  charon: 1_000_000,
};

/** Warn once when the meter crosses this percentage… */
export const CONTEXT_WARN_PCT = 80;
/** …and re-arm the warning only after it drops back below this one. */
export const CONTEXT_REARM_PCT = 70;

/** Calibrated chars→tokens heuristic (~4 chars/token); clearly approximate. */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

/**
 * Percentage of the model's approximate window a token count fills. Null when
 * the model has no published window (the segment then stays hidden).
 */
export function contextPercent(tokens: number, model: ModelSlug): number | null {
  const window = CONTEXT_WINDOW_TOKENS[model];
  if (!window || tokens < 0) return null;
  return Math.round((tokens / window) * 100);
}

/**
 * The status-bar segment text — `context ~42%` — or undefined when there is
 * no reading (undefined keeps the default StatusBar byte-identical).
 */
export function formatContextSegment(
  tokens: number | null,
  model: ModelSlug,
): string | undefined {
  if (tokens === null) return undefined;
  const pct = contextPercent(tokens, model);
  if (pct === null) return undefined;
  return `context ~${pct}%`;
}

/**
 * One-shot threshold with hysteresis: warn when an ARMED meter reaches
 * CONTEXT_WARN_PCT; disarm after warning; re-arm only when the reading falls
 * below CONTEXT_REARM_PCT (or the conversation changes — the caller resets).
 */
export function nextContextWarnState(
  armed: boolean,
  pct: number,
): { armed: boolean; warn: boolean } {
  if (armed && pct >= CONTEXT_WARN_PCT) return { armed: false, warn: true };
  if (!armed && pct < CONTEXT_REARM_PCT) return { armed: true, warn: false };
  return { armed, warn: false };
}

/** The one-line 80% notice — names /compact, SpyCore wording only. */
export function contextWarnText(pct: number): string {
  return `Context is ~${pct}% full — /compact rolls older messages into a summary (originals are archived and recoverable).`;
}
