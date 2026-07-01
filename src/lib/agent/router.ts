/**
 * Smart model routing for the agent.
 *
 * Most agent tasks are standard coding work that STYX (the coding model)
 * handles well and cheaply; only genuinely complex tasks need CHARON's deeper
 * reasoning. A one-time, cheap HERMES classification picks the tier. An
 * explicit `--model` always wins (no triage). The router's pick is clamped to
 * the models the user's plan allows. HERMES cannot drive the prompt-loop, so it
 * is never auto-routed to (only used for the classification, and only reachable
 * for runs via `--model` or a free-plan clamp).
 *
 * Identity-safe: only SpyCore model names ever appear — never an upstream
 * provider.
 */
import { api, streamRequest, type StreamEvent } from '../api.js';
import { MODEL_DISPLAY } from '../models.js';
import type { AgentModelSlug } from './loop.js';

export type ComplexityTier = 'standard' | 'complex';

export interface RouteDecision {
  model: AgentModelSlug;
  /** Short, identity-safe reason for the routing line. */
  reason: string;
  /** True when the user passed --model (triage + clamp skipped). */
  viaOverride: boolean;
  /** The classified tier (null for an override or a failed triage). Drives auto plan mode. */
  tier: ComplexityTier | null;
}

/** Capability order (cheapest → most capable) used for plan clamping. */
const CAPABILITY_ORDER: readonly AgentModelSlug[] = ['hermes', 'minos', 'styx', 'charon'];

const CLASSIFY_TIMEOUT_MS = 6_000;

const CLASSIFY_PROMPT = (task: string): string =>
  `You are a task-complexity classifier for a coding agent. Classify the task below as EXACTLY one word — STANDARD or COMPLEX.
STANDARD: typical edits, single-file changes, writing a script, running build/test/lint/git commands, or a straightforward feature.
COMPLEX: multi-file refactors, architecture or design work, deep or cross-cutting debugging, or a vague/underspecified task that needs significant reasoning.
Reply with ONLY the single word STANDARD or COMPLEX — no explanation.

TASK: ${task}`;

/** Parse a tier from classifier output; null when neither word is present. */
export function parseTier(text: string): ComplexityTier | null {
  const m = /\b(COMPLEX|STANDARD)\b/i.exec(text);
  if (!m) return null;
  return m[1]!.toUpperCase() === 'COMPLEX' ? 'complex' : 'standard';
}

/** Map a plan slug to the allowed agent models (null = unknown → no clamp). */
export function resolveAllowedModels(plan: string | undefined): Set<AgentModelSlug> | null {
  if (!plan) return null;
  const p = plan.toLowerCase();
  if (p === 'free' || p.includes('free')) return new Set<AgentModelSlug>(['hermes']);
  return new Set<AgentModelSlug>(['hermes', 'minos', 'styx', 'charon']);
}

/** Clamp `pick` to `allowed`: the most capable allowed model not exceeding it. */
export function clampModel(pick: AgentModelSlug, allowed: Set<AgentModelSlug> | null): AgentModelSlug {
  if (!allowed || allowed.has(pick)) return pick;
  const idx = CAPABILITY_ORDER.indexOf(pick);
  for (let i = idx; i >= 0; i -= 1) {
    const m = CAPABILITY_ORDER[i]!;
    if (allowed.has(m)) return m;
  }
  for (const m of CAPABILITY_ORDER) if (allowed.has(m)) return m;
  return pick; // allowed empty — leave as-is
}

/**
 * Decide whether to run in plan mode: --plan forces on, --no-plan forces off,
 * otherwise auto-on for tasks the triage classified COMPLEX.
 */
export function resolvePlanMode(planFlag: boolean | undefined, tier: ComplexityTier | null): boolean {
  if (planFlag === true) return true;
  if (planFlag === false) return false;
  return tier === 'complex';
}

/** The identity-safe one-line routing summary for the UI. */
export function routingLine(d: RouteDecision): string {
  const display = MODEL_DISPLAY[d.model];
  return d.viaOverride ? `Model: ${display} (--model)` : `Routing → ${display} (${d.reason})`;
}

interface ConversationCreateResp {
  id: string;
}

/**
 * Cheap one-shot HERMES classification of task complexity. Short timeout,
 * early-exits as soon as a tier word appears. Returns null on
 * timeout/failure/garbage so the caller can default to the STYX workhorse.
 */
export async function classifyComplexity(
  task: string,
  apiUrlOverride: string | undefined,
): Promise<ComplexityTier | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
  try {
    const convo = await api.post<ConversationCreateResp>('/conversations', {
      apiUrlOverride,
      body: { model: 'HERMES' },
    });
    let text = '';
    for await (const event of streamRequest(
      '/api/chat/stream',
      { conversationId: convo.id, message: CLASSIFY_PROMPT(task), model: 'HERMES' },
      { apiUrlOverride, signal: controller.signal, maxRetries: 0 },
    )) {
      const data = (event as StreamEvent).data as
        | (Record<string, unknown> & { type?: string })
        | undefined;
      if (!data || typeof data !== 'object') continue;
      if (data.type === 'text' && typeof data.content === 'string') {
        text += data.content;
        const tier = parseTier(text);
        if (tier) {
          controller.abort(); // got the answer — stop streaming early
          return tier;
        }
      } else if (data.type === 'done' || data.type === 'error') {
        break;
      }
    }
    return parseTier(text);
  } catch {
    return null; // timeout / network / abort → caller defaults to STYX
  } finally {
    clearTimeout(timer);
  }
}

interface WhoamiPlanResp {
  plan?: string;
}

/** Best-effort plan slug from whoami; undefined when it can't be determined. */
export async function fetchPlan(apiUrlOverride: string | undefined): Promise<string | undefined> {
  try {
    const me = await api.get<WhoamiPlanResp>('/auth/cli/whoami', { apiUrlOverride });
    return typeof me.plan === 'string' ? me.plan : undefined;
  } catch {
    return undefined;
  }
}

export interface RouteOptions {
  /** Explicit --model (already validated); when set, triage + clamp are skipped. */
  explicitModel?: AgentModelSlug | undefined;
  task: string;
  /** Plan slug; when omitted the router fetches it (in parallel with triage). */
  plan?: string | undefined;
  apiUrlOverride?: string | undefined;
}

/** Decide which model the agent should run on. Never throws. */
export async function routeAgentModel(opts: RouteOptions): Promise<RouteDecision> {
  if (opts.explicitModel) {
    return { model: opts.explicitModel, reason: '--model', viaOverride: true, tier: null };
  }
  // Triage + plan lookup run concurrently to hide latency.
  const [tier, plan] = await Promise.all([
    classifyComplexity(opts.task, opts.apiUrlOverride),
    opts.plan !== undefined ? Promise.resolve(opts.plan) : fetchPlan(opts.apiUrlOverride),
  ]);
  const pick: AgentModelSlug = tier === 'complex' ? 'charon' : 'styx';
  const baseReason = tier === 'complex' ? 'complex task' : tier === 'standard' ? 'coding task' : 'default';
  const allowed = resolveAllowedModels(plan);
  const clamped = clampModel(pick, allowed);
  const reason = clamped === pick ? baseReason : `${baseReason}, limited by plan`;
  return { model: clamped, reason, viaOverride: false, tier };
}
