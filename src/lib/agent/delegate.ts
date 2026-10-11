/**
 * Sub-agent orchestration (F1): the `delegate` tool.
 *
 * A run can hand a self-contained task to a sub-agent - a full nested
 * `runAgent` call - and receive the sub-agent's final answer as the tool
 * result. The tool itself is deliberately thin: it validates arguments and
 * enforces the depth gate, then hands off to `ctx.delegator`, which the loop
 * installs on every run's ToolContext. Everything provider-aware (model
 * defaulting/validation) and run-aware (budget sharing, event re-emission,
 * permission inheritance) lives in the loop's delegator implementation, so
 * this module never imports loop.ts - there is no import cycle.
 *
 * The three safety properties, and where each is enforced:
 *
 * 1. ROLES + DEPTH - `roleForDepth` marks every spawned run a `leaf`
 *    (H-10): leaf runs are withheld the `delegate` tool from their prompt
 *    catalogue / native declarations AND refused at dispatch, so a
 *    sub-agent can never spawn its own sub-agent - strictly tighter than
 *    the old depth gate. `MAX_DELEGATE_DEPTH` remains as defence in depth
 *    at dispatch: a run AT the max depth is refused even if the model
 *    guessed the tool name.
 * 2. BUDGET - the child shares the parent's `Budget` instance (see
 *    budget.ts: one budget spans a whole orchestrated run). The child's
 *    tokens/turns accumulate into the same counters, so the parent's caps
 *    stop the child exactly as they stop the parent. The delegator snapshots
 *    before/after so the result still reports the child's OWN spend.
 * 3. PERMISSIONS - the child inherits the parent's permission model wholesale:
 *    the same `requestApproval` gate, the same command rules, the same plan
 *    mode (a plan-phase run cannot smuggle writes past approval by
 *    delegating), the same web-tools switch. Approval prompts still pause for
 *    the user, one at a time, for the child's mutating calls too.
 */

import type { BudgetReason } from './budget.js';
import type { ToolResult } from './tools.js';
import { registerTool, type ToolDefinition } from './tool-core.js';

/** The tool's registry name. */
export const DELEGATE_TOOL_NAME = 'delegate';

/**
 * H-10 - delegation roles. The top-level run is the `orchestrator`; every
 * run spawned through `delegate` is a `leaf`. Leaf runs are withheld the
 * recursive/dangerous tools (`delegate` itself, durable-memory writes) -
 * strictly tighter than the MAX_DELEGATE_DEPTH gate, which remains as
 * defence in depth at dispatch.
 */
export type DelegateRole = 'orchestrator' | 'leaf';

/** The delegation role for a run at `depth` (0 = top-level). */
export function roleForDepth(depth: number): DelegateRole {
  return depth > 0 ? 'leaf' : 'orchestrator';
}

/**
 * Deepest run that may still delegate: 0 = the top-level run, 1 = its child,
 * 2 = the grandchild. A run AT this depth is refused at dispatch and never
 * offered the tool - the recursion bottom.
 */
export const MAX_DELEGATE_DEPTH = 2;

/** Default tool-calling turns for a child run when the caller omits maxTurns. */
export const DEFAULT_CHILD_MAX_TURNS = 10;

/**
 * Default model for a child run on the SpyCore provider. Hermes is the
 * cheapest SpyCore slug per output token (the dominant cost for an agentic
 * run), so delegation defaults to the economical choice; the caller can
 * always name a stronger model explicitly.
 */
export const DEFAULT_CHILD_MODEL = 'hermes';

/** SpyCore model slugs a child run may use (mirrors `AgentModelSlug`). */
export const VALID_CHILD_MODELS = ['charon', 'styx', 'hermes', 'minos'] as const;

/** Input to `Delegator.spawnChild` - what the `delegate` tool passes through. */
export interface DelegateChildInput {
  /** The sub-agent's assignment (already trimmed, non-empty). */
  task: string;
  /** Requested model slug, if the caller named one (validated by the delegator). */
  model?: string | undefined;
  /** Requested turn cap, defaulted by the tool when omitted. */
  maxTurns: number;
}

/** The outcome of one child run, as the tool reports it to the parent. */
export interface DelegateChildResult {
  /** False only when the child could not START (bad model, depth race) - `error` is then set. */
  ok: boolean;
  /** The child's final answer text (may be empty when it never finished). */
  finalText: string;
  turns: number;
  toolCalls: number;
  /** The child's OWN spend, measured as the shared-budget delta across the run. */
  tokensUsed: number;
  turnsUsed: number;
  /** Set when a shared-budget cap stopped the child (a controlled stop, not a failure). */
  budgetStop: BudgetReason | null;
  reachedMaxTurns: boolean;
  cancelled: boolean;
  /** Human phrase for `budgetStop`, e.g. "token budget reached (52,300 / 50,000)". */
  stopNote: string | null;
  /** Present only when `ok` is false. */
  error?: string | undefined;
}

/**
 * The loop's back-end for the `delegate` tool, installed on every run's
 * ToolContext. `depth` is the CURRENT run's depth; `spawnChild` runs the
 * nested agent at `depth + 1`.
 */
export interface Delegator {
  readonly depth: number;
  readonly maxDepth: number;
  spawnChild(input: DelegateChildInput): Promise<DelegateChildResult>;
}

/**
 * Framing prepended to every child run's task. A fresh conversation knows
 * nothing about the delegation, so the child is told explicitly: its final
 * answer goes back to the parent agent (not a human), clarifying questions
 * are impossible, and the answer must stand alone.
 */
export const CHILD_TASK_PREAMBLE = `You are a SUB-AGENT assisting another AI agent (your "parent"), not a human user directly. Your final answer is delivered verbatim to the parent as the result of its delegate tool call.

- Write your final answer as a concise, self-contained report: what you did, what you found, file paths and key facts. The parent cannot ask follow-up questions.
- Do NOT ask clarifying questions - there is no user to ask. Make reasonable assumptions and state them in your report.
- Use your tools to complete the task, then give your final answer as plain text (no tool block). That ends your run.

The parent's task for you:`;

// ── local arg accessors (dispatch already validated types against the schema,
// so these narrowing reads are safe - same contract as tools.ts's own) ──

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

/**
 * H-11 - the child's result is NEVER dropped. Validate an optional
 * `output_schema` (a JSON string like `{"type":"object","required":[...]}`)
 * against the child's final answer. A validation failure is reported as
 * `schema_valid: false` with the raw text preserved verbatim - not as an
 * error, and never as an empty result.
 */
export function validateChildOutputSchema(
  rawSchema: string,
  finalText: string,
): { valid: boolean; reason: string } {
  let schema: unknown;
  try {
    schema = JSON.parse(rawSchema);
  } catch {
    return { valid: false, reason: 'output_schema is not valid JSON' };
  }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return {
      valid: false,
      reason: 'output_schema must be a JSON object like {"type":"object","required":[...]}',
    };
  }
  // One layer of ```json fences is stripped - models fence JSON reflexively.
  let text = finalText.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { valid: false, reason: "the sub-agent's final answer is not valid JSON" };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { valid: false, reason: "the sub-agent's final answer is not a JSON object" };
  }
  const required = (schema as { required?: unknown }).required;
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((k) => typeof k !== 'string')) {
      return { valid: false, reason: 'output_schema "required" must be an array of strings' };
    }
    const missing = (required as string[]).filter(
      (k) => (parsed as Record<string, unknown>)[k] === undefined,
    );
    if (missing.length > 0) {
      return { valid: false, reason: `missing required key(s): ${missing.join(', ')}` };
    }
  }
  return { valid: true, reason: '' };
}

/** Compact token count (e.g. 1.2k, 50k) - mirrors budget.ts's compactTokens. */
function formatTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`;
  const s = (n / 1000).toFixed(1);
  return `${s.endsWith('.0') ? s.slice(0, -2) : s}k`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export const delegateTool: ToolDefinition = {
  name: DELEGATE_TOOL_NAME,
  description:
    'Spawn a sub-agent to complete a self-contained task, then receive its final result as text. ' +
    'The sub-agent runs the same tool set on the cheaper "hermes" model by default (override with `model`), ' +
    'for up to `maxTurns` tool-calling turns (default 10), and shares this run\'s token/time/turn budget - ' +
    'its spend counts against your caps. It inherits your permission model: plan mode, approval gates, and ' +
    'command rules apply to it exactly as they do to you. A sub-agent is a LEAF: it cannot spawn its own ' +
    'sub-agents and cannot write durable memory - it reports everything back to you. ' +
    'Put everything the sub-agent needs in `task` - it starts with no other ' +
    'context, and its final answer is returned verbatim as this call\'s result.',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The complete assignment for the sub-agent, phrased as a standalone task',
      },
      model: {
        type: 'string',
        description: 'SpyCore model slug for the sub-agent: charon, styx, hermes or minos. Defaults to hermes (cheapest)',
      },
      maxTurns: {
        type: 'integer',
        description: 'Max tool-calling turns for the sub-agent (default 10)',
      },
      output_schema: {
        type: 'string',
        description:
          'Optional JSON schema (as a string) for the sub-agent\'s final answer, e.g. {"type":"object","required":["summary"]}. ' +
          'The final answer must be a JSON object satisfying it. A validation failure NEVER drops the result: ' +
          'it is returned with schema_valid:false and the raw text preserved verbatim.',
      },
    },
    required: ['task'],
  },
  // Deliberately NOT mutating: the child inherits the parent's plan mode, so
  // a plan-phase run can delegate research sub-tasks but can never smuggle a
  // write past approval through delegation - the child's own dispatch blocks
  // mutating tools in plan mode. Approval gates still pause for the user on
  // the child's writes/commands in a normal run.
  async execute(args, ctx): Promise<ToolResult> {
    const task = optString(args, 'task')?.trim() ?? '';
    if (task.length === 0) {
      return {
        ok: false,
        summary: 'invalid task',
        content: 'Error: "task" must be a non-empty string describing the sub-agent\'s assignment.',
      };
    }
    const maxTurns = optInt(args, 'maxTurns') ?? DEFAULT_CHILD_MAX_TURNS;
    if (maxTurns < 1) {
      return {
        ok: false,
        summary: 'invalid maxTurns',
        content: 'Error: "maxTurns" must be a positive integer.',
      };
    }
    const delegator: Delegator | undefined = ctx.delegator;
    if (!delegator) {
      return {
        ok: false,
        summary: 'delegation unavailable',
        content: 'Error: sub-agent delegation is not available in this run.',
      };
    }
    // THE DEPTH GATE - the recursion bottom. A run at MAX_DELEGATE_DEPTH is
    // refused here even if the model guessed the tool name after it was
    // withheld from the prompt catalogue (defence in depth: the catalogue is
    // a hint, this is the enforcement).
    if (delegator.depth >= delegator.maxDepth) {
      return {
        ok: false,
        summary: 'delegation depth limit',
        content:
          `Error: delegation depth limit reached (max depth ${delegator.maxDepth}) - ` +
          'a sub-agent at this depth cannot spawn its own sub-agents. ' +
          'Complete the task yourself instead of delegating it further.',
      };
    }
    // The model arg is provider-aware (a SpyCore slug is meaningless to a
    // BYOK provider), so validation/defaulting lives in the delegator, not here.
    const child = await delegator.spawnChild({ task, model: optString(args, 'model'), maxTurns });
    if (!child.ok) {
      return {
        ok: false,
        summary: 'sub-agent failed to start',
        content: `Error: the sub-agent could not start: ${child.error ?? 'unknown error'}.`,
      };
    }
    const notes: string[] = [];
    if (child.cancelled) notes.push('The sub-agent was cancelled before it finished.');
    if (child.stopNote) {
      notes.push(`The sub-agent stopped early: ${child.stopNote}.`);
    } else if (child.reachedMaxTurns) {
      notes.push(`The sub-agent reached its turn limit (${maxTurns}) without giving a final answer.`);
    }
    const header =
      `Sub-agent finished in ${plural(child.turns, 'turn')} ` +
      `(${plural(child.toolCalls, 'tool call')}, ${formatTokens(child.tokensUsed)} tokens).`;
    // H-11: the child's result is never dropped. With `output_schema`, a
    // validation failure is reported as schema_valid:false with the raw text
    // preserved verbatim - the body below always carries the child's words.
    const schemaArg = optString(args, 'output_schema');
    let schemaBlock = '';
    if (schemaArg !== undefined) {
      const check = validateChildOutputSchema(schemaArg, child.finalText);
      schemaBlock = check.valid
        ? '\n\n[schema_valid: true]'
        : `\n\n[schema_valid: false - ${check.reason}; the raw result is preserved below]`;
    }
    const body = child.finalText.trim().length > 0 ? `\n\n${child.finalText}` : '';
    const tail = notes.length > 0 ? `\n\n${notes.join(' ')}` : '';
    return {
      ok: true,
      summary: `sub-agent: ${plural(child.turns, 'turn')}, ${formatTokens(child.tokensUsed)} tokens`,
      content: `${header}${schemaBlock}${body}${tail}`,
    };
  },
};

// H-6: the delegate tool self-registers on import, like the built-ins in
// builtin-tools.ts. tools.ts derives its registry from these calls - there is
// no manual list to drift.
registerTool(delegateTool);
