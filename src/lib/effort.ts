/**
 * Graduated chat "effort" — the CLI's own copy of the SpyCore effort
 * definition. Self-contained on purpose (it depends on nothing outside this
 * package); keep its levels and behavior aligned with the SpyCore backend.
 * Keyed by the CLI's own model slugs (lowercase, underscore — e.g. "styx_max")
 * so the map lines up with ModelSlug from ./models.ts exactly.
 *
 * Effort controls how deeply a model "thinks". Billing is currently
 * effort-neutral on the backend (the same credit cost for every level), so the
 * CLI must NEVER print a per-level credit figure — only a short qualitative
 * descriptor. If effort billing turns on later, nothing here changes.
 */
import type { ModelSlug } from './models.js';

export type EffortLevel = 'auto' | 'low' | 'medium' | 'high' | 'max';

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'auto',
  'low',
  'medium',
  'high',
  'max',
];

export const DEFAULT_EFFORT: EffortLevel = 'auto';

/**
 * Short qualitative descriptor per level — no vendor terms, no numbers. Kept
 * verbatim in sync with the SpyCore product's effort descriptors so the wording
 * a user sees stays consistent everywhere. Intentionally carries NO cost figure:
 * live billing is effort-neutral, so a per-level credits number would be meaningless.
 */
export const EFFORT_DESCRIPTION: Record<EffortLevel, string> = {
  auto: 'balanced — adapts to the task',
  low: 'fastest, lightest reasoning',
  medium: 'moderate reasoning',
  high: 'deeper reasoning, a bit slower',
  max: 'deepest reasoning, slowest',
};

/**
 * Per-model SUPPORTED effort levels — kept in lockstep with the SpyCore
 * backend's supported-effort matrix, keyed by the CLI slug:
 *   · hermes / styx / styx_max — single fixed mode → 'auto' only.
 *   · minos    — boolean reasoning toggle → 'auto','low','high'.
 *   · charon   — full ladder → 'auto','low','medium','high','max'.
 *   · hephaestus — image generation (effort irrelevant) → 'auto' only.
 */
export const SUPPORTED_EFFORT_BY_MODEL: Record<ModelSlug, readonly EffortLevel[]> = {
  hermes: ['auto'],
  minos: ['auto', 'low', 'high'],
  styx: ['auto'],
  styx_max: ['auto'],
  charon: ['auto', 'low', 'medium', 'high', 'max'],
  hephaestus: ['auto'],
};

/** The levels the given model exposes (defaults to ['auto'] for an unknown slug). */
export function supportedEffortFor(model: ModelSlug): readonly EffortLevel[] {
  return SUPPORTED_EFFORT_BY_MODEL[model] ?? ['auto'];
}

/** True when the model exposes more than just 'auto' (so a real choice exists). */
export function modelSupportsGraduatedEffort(model: ModelSlug): boolean {
  return supportedEffortFor(model).length > 1;
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === 'string' &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

/** Ordinal rank for the graduated tiers (auto is supported by every model and
 *  handled separately). The clamp uses this to step DOWN to the nearest
 *  supported tier — never rounding up past what the caller asked for. */
const RANK: Record<EffortLevel, number> = {
  auto: 0,
  low: 1,
  medium: 2,
  high: 3,
  max: 4,
};

export interface ClampedEffort {
  /** The level we will actually send to the backend. */
  level: EffortLevel;
  /** True when the requested level was unsupported and had to be clamped. */
  clamped: boolean;
  /** The level the caller asked for (echoed for the "clamped" notice). */
  requested: EffortLevel;
}

/**
 * Clamp a requested level to the model's nearest SUPPORTED level. Mirrors the
 * server + web clamp: when the exact level isn't supported we step DOWN to the
 * closest supported graduated tier ≤ the request (never round up — never a
 * higher tier than asked), falling back to 'auto'. 'auto' is supported by every
 * model, so an auto request never clamps.
 */
export function clampEffortForModel(
  model: ModelSlug,
  requested: EffortLevel,
): ClampedEffort {
  const supported = supportedEffortFor(model);
  if (supported.includes(requested)) {
    return { level: requested, clamped: false, requested };
  }
  const wantRank = RANK[requested];
  let best: EffortLevel = 'auto';
  let bestRank = -1;
  for (const level of supported) {
    if (level === 'auto') continue;
    const rank = RANK[level];
    if (rank <= wantRank && rank > bestRank) {
      best = level;
      bestRank = rank;
    }
  }
  return { level: best, clamped: true, requested };
}
