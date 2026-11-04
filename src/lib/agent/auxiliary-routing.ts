/**
 * H-17 - auxiliary routing: every auxiliary LLM job (anything that is not
 * the main agent loop) gets its own pinned provider/model.
 *
 * The pattern started with the session title (pinned to the smallest/fastest
 * model); this table generalizes it so cheap side jobs never burn the main
 * loop's model and each job's cost stays predictable. On a BYOK provider the
 * pin is meaningless (a SpyCore slug is not a valid model id there), so the
 * caller's model is kept.
 *
 * To add a job: add a row to AUXILIARY_ROUTES and route its call site
 * through `resolveAuxiliaryModel`.
 */

/** The auxiliary LLM jobs with a pinned model. */
export type AuxiliaryJob = 'session-title' | 'skill-generation' | 'compaction-summary';

interface AuxiliaryRoute {
  /** The SpyCore model slug this job is pinned to. */
  spycoreModel: string;
  /** Why this job gets this model. */
  why: string;
}

export const AUXILIARY_ROUTES: Record<AuxiliaryJob, AuxiliaryRoute> = {
  // One cheap call per session: the smallest/fastest model is enough.
  'session-title': {
    spycoreModel: 'minos',
    why: 'a single short title - the smallest/fastest model is enough',
  },
  // A writing task (a SKILL.md body) off the main loop: the economical
  // default, still far cheaper than the main agent model.
  'skill-generation': {
    spycoreModel: 'hermes',
    why: 'a writing task that benefits from a stronger model, still off the main loop',
  },
  // H-9: stage 2 of two-stage compaction - summarizing a pruned transcript
  // is a compression job, not reasoning; the smallest/fastest model is enough.
  'compaction-summary': {
    spycoreModel: 'minos',
    why: 'transcript summarization after deterministic pruning - cheap compression, not reasoning',
  },
};

/**
 * Resolve the model for an auxiliary job. On the SpyCore provider the job's
 * pinned slug wins; otherwise (BYOK) the caller's model is kept.
 */
export function resolveAuxiliaryModel(
  job: AuxiliaryJob,
  providerId: string,
  fallbackModel: string,
): string {
  if (providerId === 'spycore') return AUXILIARY_ROUTES[job].spycoreModel;
  return fallbackModel;
}
