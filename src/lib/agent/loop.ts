/**
 * Client-side agent prompt-loop.
 *
 * The CLI streams text from /api/chat/stream; the model emits tool calls as
 * `spycore:tool` fenced blocks (see protocol.ts). Each turn we stream the
 * reply, parse complete tool blocks once the turn finishes, execute them via
 * the read-only tool registry, then feed the results back as the next message
 * - looping until the model answers with no tool block (final answer) or we
 * hit the turn cap.
 *
 * The loop emits a structured `AgentEvent` stream so any front-end (the Ink
 * UI, a plain-text renderer, or `--json`) can present progress identically.
 */
import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';
import { WIRE_MESSAGE_MAX_CHARS, clampToWireMax } from '../wire-limits.js';
import { SpyCoreProvider } from '../providers/spycore.js';
import type { Provider, ToolDecl, ToolResultDecl } from '../providers/types.js';
import { parseTurn } from './protocol.js';
import type { ResolvedMcpServer } from './mcp-config.js';
import { REGISTRY, type ToolLimits, type ToolResult } from './tools.js';
import { createLoopDetector, type LoopCallTrace } from './loop-detector.js';
import { checkEvidenceClaims, type EvidenceCall } from './evidence-check.js';
import type { ToolResultKind, RequestApproval } from './approval.js';
import {
  autoCompactPct,
  createAutoCompactTrigger,
} from './auto-compact.js';
import type { EffectiveCommandRules } from './command-rules.js';
// F1 sub-agent orchestration: the `delegate` tool's constants. The Delegator
// interface is implemented in run-delegate.ts. delegate.ts imports only types
// back, so no runtime cycle.
import {
  MAX_DELEGATE_DEPTH,
  roleForDepth,
} from './delegate.js';
import type { RecordedChange } from './checkpoint.js';
import type { Budget, BudgetReason } from './budget.js';
import { createBudgetReporter, createEventSink } from './run-events.js';
import { createRunJournal, createToolContext, loadRunSkills, trackApprovalInFlight } from './run-context.js';
import { createDelegator, resolveDelegateDepth } from './run-delegate.js';
import { createRunDispatcher, type TurnCounters } from './run-dispatch.js';
import { openRunSession } from './run-session.js';
import { assembleFirstTurn } from './run-prompt.js';
import { createPromptCacheGuard } from './prompt-cache.js';
import {
  loadDurableMemorySnapshot,
  renderDurableMemoryBlock,
} from './durable-memory.js';

export const MIN_TURNS = 1;
export const MAX_TURNS_CAP = 200;
export const DEFAULT_MAX_TURNS = 25;
/**
 * Default cap on tool calls dispatched within a single turn. A runaway model
 * issuing thousands of dispatches in one turn is cut off per turn: the
 * turn's remaining calls are skipped with an in-band notice and the turn
 * completes on the results so far. Configurable per run via
 * RunAgentOptions.maxToolCallsPerTurn (CLI: --max-tool-calls-per-turn).
 */
export const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 50;
export const MAX_TOOL_CALLS_PER_TURN_CAP = 1000;
// The retained-event bound lives with the event sink in run-events.ts.
export { MAX_RETAINED_EVENTS } from './run-events.js';

export type AgentModelSlug = 'charon' | 'styx' | 'hermes' | 'minos';

/**
 * The default model-call provider: SpyCore's backend (server-side skills /
 * memory / search / quota). Stateless on the client, so a
 * shared singleton is fine; callers may pass their own provider (e.g. a BYOK
 * OpenAI-compatible one) via `RunAgentOptions.provider`.
 */
const DEFAULT_PROVIDER: Provider = new SpyCoreProvider();

/** Progress events emitted by the loop, in order.
 *
 * F1 `depth`: every variant carries the delegation depth of the run that
 * emitted it - 0 for the top-level run (left unset there), 1 for a direct
 * sub-agent, 2 for its child. The loop re-emits a child's whole event stream
 * into the parent's with the child's depth, so a front-end can render nested
 * runs indented (MessageView's `depth` prop) from this stream alone.
 */
export type AgentEvent =
  | { type: 'assistant_token'; turn: number; chunk: string; depth?: number }
  | { type: 'narration'; turn: number; text: string; depth?: number }
  | {
      type: 'tool_call';
      turn: number;
      index: number;
      tool: string;
      arg: string;
      args: Record<string, unknown>;
      depth?: number;
    }
  | {
      type: 'tool_result';
      turn: number;
      index: number;
      tool: string;
      ok: boolean;
      summary: string;
      /** Present for mutating tools / run_command so the UI picks the glyph. */
      kind?: ToolResultKind | undefined;
      added?: number | undefined;
      removed?: number | undefined;
      isNew?: boolean | undefined;
      /** run_command: the command + a capped output tail for the scrollback. */
      command?: string | undefined;
      outputTail?: string | undefined;
      depth?: number;
    }
  | { type: 'parse_error'; turn: number; message: string; depth?: number }
  /** NATIVE tool-use: the model named a tool mid-stream - an early "⚙ <tool> …" hint. */
  | { type: 'tool_call_started'; turn: number; index: number; name: string; depth?: number }
  /** Server-side skills the SpyCore backend activated this turn (informational; spycore provider only). */
  | { type: 'skills'; turn: number; skills: string[]; depth?: number }
  /** A connected MCP server (dim, informational): startup warning or a ready summary. */
  | { type: 'mcp_notice'; level: 'warn' | 'info'; text: string; depth?: number }
  /** Project skills withheld by the workspace trust gate (warn, names the remedy). */
  | { type: 'skill_notice'; level: 'warn' | 'info'; text: string; depth?: number }
  /** PHASE-1 1.6: a lifecycle-hook diagnostic (block reasons, warns, timeouts). */
  | { type: 'hook_notice'; level: 'warn' | 'info'; text: string; depth?: number }
  /** PHASE-1 1.10: a command-rule decision - an allowlist auto-approval
   * (info, naming the matched rule; never silent) or a deny (warn). */
  | { type: 'rule_notice'; level: 'warn' | 'info'; text: string; depth?: number }
  /** PHASE-1 1.8: the first-turn assembly was clamped to the wire message cap
   * (explicit in-band markers were left at each cut - nothing silent). */
  | { type: 'context_clamped'; text: string; depth?: number }
  | { type: 'final'; text: string; depth?: number }
  | { type: 'max_turns'; turns: number; depth?: number }
  /** Running budget after a turn - only emitted when a cap is configured. */
  | { type: 'budget'; tokensUsed: number; turnsUsed: number; elapsedMs: number; depth?: number }
  /** F4: the context meter reached the auto-compact threshold. The loop
   * fires this once per approach (re-armed below the re-arm line) and never
   * while an approval gate is open. The front-end must warn the user and
   * run the existing compact flow (summarize, continue with the summary) -
   * and re-check its own approval state before compacting, since the loop's
   * in-flight check only covers the tool channel. */
  | { type: 'context_full'; turn: number; pct: number; inputTokens: number; depth?: number }
  /** A cap was hit: the run stops gracefully (a controlled stop, not an error). */
  | {
      type: 'budget_stop';
      reason: BudgetReason;
      cap: number;
      tokensUsed: number;
      turnsUsed: number;
      elapsedMs: number;
      depth?: number;
    }
  /** Per-turn tool-call cap hit: the turn's remaining calls were skipped and
   * the turn completed on the results so far (in-band notice to the model). */
  | { type: 'tool_call_cap'; turn: number; cap: number; skipped: number; depth?: number }
  /** A-2: the tiered loop detector fired. `warn`/`veto` are in-band guidance
   * for the model (also prepended to the next turn's message); `breaker`
   * ended the run gracefully - the session stays healthy. */
  | { type: 'loop_notice'; level: 'warn' | 'veto' | 'breaker'; text: string; turn: number; depth?: number }
  /** A-9: the final answer claimed something ("tests passed") no successful
   * tool call backs. Warn only - the answer is emitted unchanged. */
  | { type: 'evidence_warn'; text: string; turn: number; depth?: number };

export interface RunAgentOptions {
  task: string;
  /**
   * Wire model id handed to the active provider: a SpyCore slug ('charon') for
   * the default provider, or a raw BYOK model id ('gpt-4o') for a non-spycore
   * one. The command layer validates SpyCore slugs before this point.
   */
  model?: string;
  /** Model-call provider. Defaults to the SpyCore backend when omitted. */
  provider?: Provider | undefined;
  maxTurns?: number;
  /**
   * Max tool calls dispatched in a single turn (default
   * DEFAULT_MAX_TOOL_CALLS_PER_TURN). When the model issues more calls than
   * this in one turn, the rest are skipped with an in-band notice and the
   * turn completes on the results so far - one bad turn can never hang the
   * run in dispatch.
   */
  maxToolCallsPerTurn?: number;
  apiUrlOverride?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Absolute sandbox root for filesystem tools. */
  cwd: string;
  /** Override the default tool limits (tests use this). */
  limits?: ToolLimits;
  /** Pause-for-approval hook for the mutating tools + run_command. */
  requestApproval?: RequestApproval | undefined;
  /**
   * PHASE-1 1.10: resolved command allow/deny rules for run_command (loaded
   * by the command layer - global user scope plus trust+approval-gated
   * project scope). Omitted ⇒ run_command approval behavior is byte-identical
   * to a rule-free build. Precedence inside the tool: immutable built-in
   * catastrophic guard > deny > allow > ask; deny fires before the approval
   * prompt, so --yes / accept_all cannot override it.
   */
  commandRules?: EffectiveCommandRules | undefined;
  /** Timeout (ms) for run_command (defaults to 120s). */
  commandTimeoutMs?: number | undefined;
  /** Plan mode: block mutating tools; the final answer is a plan to approve. */
  planMode?: boolean | undefined;
  /**
   * Web tools (web_search / fetch_url). Default ON. `false` (from `--no-web`
   * or `agentWebTools=false`) removes them from the prompt catalogue, the
   * native declarations, AND dispatch - the model never sees them.
   */
  webTools?: boolean | undefined;
  /**
   * Observe the workspace around each OPAQUE tool call (`run_command`, MCP
   * tools, tool hooks) so their changes reach the journal.  Default OFF -
   * only `true` (from `--observe` or `agentObserveWorkspace=true`) takes the
   * before/after snapshot at all. See .
   *
   * OFF IS NOT "NO JOURNAL". `write_file` and `edit_file` report their own
   * changes and keep doing so; what is lost is exactly the opaque set. The run
   * says so ONCE, the first time an opaque call runs unobserved - a silently
   * weaker rewind is the hazard this option would otherwise create.
   */
  observeWorkspace?: boolean | undefined;
  /**
   * Tool-call wire protocol: 'auto' (default) uses NATIVE function-calling when
   * the SpyCore server advertises it (capabilities.nativeTools) and falls back
   * to FENCED otherwise; 'fenced' forces the text protocol; 'native' requires
   * native support and errors if the server/provider doesn't offer it.
   */
  toolProtocol?: 'auto' | 'native' | 'fenced' | undefined;
  /** Execute phase: the approved plan, injected into the task context. */
  approvedPlan?: string | undefined;
  /**
   * Execute phase (1.11): the user EDITED the plan before approving. Adds ONE
   * marker phrase to the plan-injection header AT INJECTION TIME - the marker
   * is never part of the stored (user-editable) plan text, and an unedited
   * approval stays byte-identical. It informs the model only; it changes
   * NOTHING about approvals, command rules, or hooks.
   */
  planEdited?: boolean | undefined;
  /** Plan phase: user feedback on a previous plan, used to revise it. */
  planFeedback?: string | undefined;
  /**
   * Read-at-start project context: the `<spycode-context>` block from
   * memory.ts `buildContextInjection` (SPYCODE.md + CODEBASE_GUIDE.md + the
   * latest CODEBASE_CHANGELOG.md). The orchestrator computes it ONCE per task
   * (one disk read, honouring injectGuide/injectChangelog) and threads the SAME
   * string into every phase. It is APPENDED to the core system prompt - after
   * the agent's identity/safety/tool protocol, supplementing but NEVER
   * overriding them - on the first turn of a fresh conversation. Continuations
   * (verify fix-ups carry `conversationId`) inherit it from history, so it is
   * never re-read or re-injected per phase/turn. Empty/undefined → no-op,
   * leaving the system prompt byte-identical to a memory-free build.
   */
  projectContext?: string | undefined;
  /**
   * Image attachments: uploaded SpyCore FILE IDs, sent through the stream
   * request's existing `attachments` field on the FIRST turn of a fresh
   * conversation (the server resolves them to imageUrls for vision models -
   * exactly the web chat contract). Continuations never re-send them; their
   * takeaways live in the conversation history.
   */
  attachments?: string[] | undefined;
  /**
   * Inlined text attachments: pre-built, delimited per-file blocks appended
   * to the `TASK: …` first message. User-owned content - no untrusted-content
   * wrapper. Computed once by the command layer and identical across the
   * plan + execute phases.
   */
  attachedContext?: string | undefined;
  /** Continue this existing conversation instead of opening a new one (verify fix-up). */
  conversationId?: string | undefined;
  /** First message when continuing - e.g. the verify-failure feedback. */
  continueMessage?: string | undefined;
  /** External change recorder; when set, the caller owns checkpoint persistence. */
  recordChange?: ((change: RecordedChange) => void) | undefined;
  /**
   * F-2c-48 · `C-UX45` - the BATCH sink for the observation window's delta.
   *
   * One opaque call can change hundreds of files, and the window discovers them
   * all at one instant. Handing them over one at a time makes the recorder rewrite
   * the whole journal once per record - O(N²), unbounded in N, and the observer is
   * what makes N large. This sink receives the whole delta so the journal is
   * committed once.
   *
   * Optional, and the fallback is the per-record path, so a caller that omits it
   * still journals exactly the same records - it just pays the quadratic again.
   * That silence is why `observer-window.test.ts` asserts mechanically that every
   * call site wiring `recordChange` also wires this: a new site added later is
   * otherwise a cost regression nothing reddens.
   */
  recordChanges?: ((changes: readonly RecordedChange[]) => void) | undefined;
  /**
   * H-5: toolsets disabled for this run (the per-surface gate, e.g. from
   * `toolsetsDisabled.<surface>`). Withheld from the prompt catalogue and
   * the native declarations; dispatch refuses them as unknown tools.
   */
  disabledToolsets?: string[] | undefined;
  /**
   * H-3: the denial circuit breaker's threshold for this run (consecutive
   * approval rejections before the hard-stop note engages). Unset ⇒ the
   * default (3); 0 disables. Resolved by the command layer from config+env.
   */
  guardianThreshold?: number | undefined;
  /**
   * A-8: receives the run's live handle once the run is set up. `steer`
   * folds a user message into the run at the next step boundary instead of
   * queueing a separate task after the run - the TUI uses this for mid-run
   * input. Isolated: a throw inside the callback never breaks the run.
   */
  onHandle?: ((handle: AgentRunHandle) => void) | undefined;
  /**
   * Session-wide set of skill names already loaded via load_skill. Pass ONE
   * set across plan/execute/verify phases so a repeat load returns a short
   * notice instead of re-injecting the full body. Defaults to per-call.
   */
  loadedSkills?: Set<string> | undefined;
  /** Shared cost/runaway budget (tokens/time/turns) spanning the whole run. */
  budget?: Budget | undefined;
  /**
   * F1: delegation depth of THIS run (0 = the top-level run). The loop sets it
   * on every child it spawns through the `delegate` tool; external callers
   * leave it unset. At MAX_DELEGATE_DEPTH (see delegate.ts) the `delegate`
   * tool is withheld from the prompt catalogue / native declarations AND
   * refused at dispatch - the recursion bottom.
   */
  delegateDepth?: number | undefined;
  /**
   * Interactive trust resolver for PROJECT-scoped MCP servers in an untrusted
   * workspace (see SetupMcpOptions.confirmProjectMcpTrust). Supplied only by an
   * interactive caller (TTY, not --yes/--json); omitted callers fail closed and
   * skip a cloned repo's project MCP servers.
   */
  confirmProjectMcpTrust?:
    | ((req: { cwd: string; servers: ResolvedMcpServer[] }) => Promise<boolean>)
    | undefined;
  /**
   * PHASE-1 1.6: lifecycle-hook bridge (pre-tool / post-tool). BLOCKING-ONLY
   * influence: a pre-tool block substitutes an error result BEFORE dispatch;
   * post-tool feedback is appended AFTER. The bridge has no access to
   * requestApproval - nothing a hook returns can approve or auto-confirm
   * anything; a hook exit 0 still goes through the normal approval flow
   * inside dispatchTool. Omitted → dispatch is byte-identical to pre-hooks.
   */
  hooks?:
    | {
        hasAny: boolean;
        preTool(
          name: string,
          args: Record<string, unknown>,
        ): Promise<{ blocked: boolean; reason: string | null; notices: string[] }>;
        postTool(
          name: string,
          ok: boolean,
          summary: string,
        ): Promise<{ feedback: string | null; notices: string[] }>;
      }
    | undefined;
  onEvent?: (event: AgentEvent) => void;
  /**
   * Resume/progress hook (additive): called once when the conversation id and
   * tool protocol are known (turnsCompleted 0) and again at the start of each
   * subsequent turn with the count of COMPLETED turns. Separate from the event
   * stream on purpose - `--json` output stays byte-identical when unused. The
   * hook is isolated: a throw inside it never breaks the run.
   */
  onRunState?: ((state: AgentRunState) => void) | undefined;
}

/** Snapshot handed to `onRunState` at each completed step boundary. */
export interface AgentRunState {
  conversationId: string;
  /** Whether this conversation speaks the NATIVE tool protocol. */
  nativeTools: boolean;
  /** Completed loop turns so far in THIS runAgent call. */
  turnsCompleted: number;
}

/**
 * A-8 - the live handle for a running agent. Handed out once via
 * `RunAgentOptions.onHandle`, before the first turn streams.
 */
export interface AgentRunHandle {
  /**
   * Fold a user message into the run at the next step boundary: the text
   * becomes a user-steer section of the next turn's message instead of
   * being lost (or queued as a separate task after the run). Returns false
   * when the text was empty or the run had already settled.
   */
  steer(text: string): boolean;
}

export interface AgentResult {
  finalText: string;
  turns: number;
  toolCalls: number;
  reachedMaxTurns: boolean;
  cancelled: boolean;
  events: AgentEvent[];
  /** Number of files the run created/modified (journaled for `spycore rewind`). */
  changedFiles: number;
  /** The conversation this run used - pass back as `conversationId` to continue it. */
  conversationId: string;
  /** Set when a cost/runaway cap stopped the run (a controlled stop, not failure). */
  budgetStop: BudgetReason | null;
}

function clampTurns(n: number | undefined): number {
  const v = Number.isFinite(n) ? Number(n) : DEFAULT_MAX_TURNS;
  return Math.max(MIN_TURNS, Math.min(MAX_TURNS_CAP, Math.floor(v)));
}

/** Clamp the per-turn tool-call cap the same way clampTurns clamps turns. */
function clampToolCallsPerTurn(n: number | undefined): number {
  const v = Number.isFinite(n) ? Number(n) : DEFAULT_MAX_TOOL_CALLS_PER_TURN;
  return Math.max(1, Math.min(MAX_TOOL_CALLS_PER_TURN_CAP, Math.floor(v)));
}

interface TurnResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** NATIVE mode: the fully-assembled tool calls the model emitted this turn. */
  toolCalls: ProviderToolCallLite[];
}

/** Local mirror of the provider's tool-call shape (id + name + JSON args text). */
interface ProviderToolCallLite {
  id: string;
  name: string;
  arguments: string;
}

interface StreamTurnInput {
  provider: Provider;
  conversationId: string;
  model: string;
  message: string;
  system: string | undefined;
  apiUrlOverride: string | undefined;
  signal: AbortSignal | undefined;
  /** NATIVE mode: tools to declare this turn (re-sent every turn). */
  tools: ToolDecl[] | undefined;
  /** NATIVE mode: results answering the prior turn's tool_calls (continuation). */
  toolResults: ToolResultDecl[] | undefined;
  /** Image attachments (FILE IDs) - first turn of a fresh conversation only. */
  attachments: string[] | undefined;
  onToken: (chunk: string) => void;
  onSkills: (skills: string[]) => void;
  onToolStarted: ((index: number, name: string) => void) | undefined;
  shouldStop: (() => boolean) | undefined;
}

/**
 * Stream one assistant turn through the active provider, forwarding text chunks
 * to `onToken`, and return the full accumulated text plus the turn's token usage
 * (from the provider's `usage` event). Provider-agnostic: the SpyCore backend
 * and a BYOK OpenAI-compatible endpoint both surface the same `ProviderEvent`s.
 *
 * `shouldStop` is handed to the provider and polled as text streams in; when it
 * returns true (the time budget elapsed mid-turn) the provider stops consuming
 * and ends the turn, so we return the partial text - the caller then stops the
 * run at the turn boundary. We never act on a partial reply, so no mutation can
 * be left half-applied.
 */
async function streamTurn(input: StreamTurnInput): Promise<TurnResult> {
  let text = '';
  let inputTokens = 0;
  let outputTokens = 0;
  const toolCalls: ProviderToolCallLite[] = [];
  for await (const event of input.provider.streamChat({
    conversationId: input.conversationId,
    message: input.message,
    system: input.system,
    model: input.model,
    apiUrlOverride: input.apiUrlOverride,
    signal: input.signal,
    shouldStop: input.shouldStop,
    tools: input.tools,
    toolResults: input.toolResults,
    attachments: input.attachments,
  })) {
    if (event.type === 'text') {
      text += event.text;
      input.onToken(event.text);
    } else if (event.type === 'tool_call_started') {
      // Early UI affordance: the model named a tool before the turn finished.
      input.onToolStarted?.(event.index, event.name);
    } else if (event.type === 'tool_calls') {
      for (const c of event.calls) toolCalls.push({ id: c.id, name: c.name, arguments: c.arguments });
    } else if (event.type === 'usage') {
      inputTokens = event.input;
      outputTokens = event.output;
    } else if (event.type === 'skills') {
      // Informational (spycore provider only): server-side skills activated.
      input.onSkills(event.skills);
    } else if (event.type === 'error') {
      throw new SpycoreCliError(event.message, EXIT_USER_ERROR);
    } else if (event.type === 'done') {
      break;
    }
  }
  return { text, inputTokens, outputTokens, toolCalls };
}

/** Format one executed call's result for the message fed back to the model. */
/**
 * Cap on the echoed call arguments in a fenced result header. Unbounded before
 * (FIX BATCH 2 / B2): a `write_file` with a 40 KB `content` arg put 40 KB of
 * JSON in the header alone, blowing the wire cap and - once the assembler
 * clamps - crowding the actual tool RESULT out of the turn. The model already
 * knows what it called; it does not need its own payload read back verbatim.
 */
const CALL_ARGS_MAX_CHARS = 2_000;

function formatResultForModel(
  index: number,
  total: number,
  tool: string,
  args: Record<string, unknown>,
  ok: boolean,
  summary: string,
  content: string,
): string {
  const argsJson = JSON.stringify(args);
  const shownArgs =
    argsJson.length > CALL_ARGS_MAX_CHARS
      ? `${argsJson.slice(0, CALL_ARGS_MAX_CHARS)}… [arguments truncated]`
      : argsJson;
  const header = `Tool ${index + 1}/${total}: ${tool}(${shownArgs}) → ${ok ? 'OK' : 'ERROR'} (${summary})`;
  return `${header}\n${content}`;
}

export const CONTINUE_HINT =
  'Continue: call more tools with spycore:tool blocks, or give your final answer as plain text (no fenced block).';

/**
 * A-7 - the reserved final step. When the turn cap is hit the run does not
 * cut mid-thought: the model gets exactly one more turn, and on that turn it
 * may not call tools - it summarizes. Tool calls emitted on the summary turn
 * are never dispatched.
 */
export const SUMMARY_ONLY_MESSAGE =
  'You have reached the turn limit. This is your FINAL step: do NOT call any tool. ' +
  'Reply with a concise summary of what you did, what you found, and what remains unfinished - as plain text.';

function blockTruncMarker(k: number): string {
  return `\n[tool result ${k} truncated to fit the message limit]`;
}
function blockOmitMarker(k: number): string {
  return `[tool result ${k} omitted to fit the message limit]`;
}

/** Fit one formatted result block into `budget` chars, marker included. */
function fitResultBlock(block: string, budget: number, k: number): string {
  if (block.length <= budget) return block;
  const marker = blockTruncMarker(k);
  const keep = budget - marker.length;
  if (keep > 0) return `${block.slice(0, keep)}${marker}`;
  const omit = blockOmitMarker(k);
  return omit.length <= budget ? omit : '';
}

/**
 * Assemble the FENCED continuation turn - N formatted tool results joined into
 * ONE `message` field, which the server caps at 32,000 chars. Turn 1 has gone
 * through `clampWireAssembly` since 1.8; continuation turns went out RAW, so a
 * single oversized result 400'd the whole run (FIX BATCH 2 / B2).
 *
 * Under budget the output is BYTE-IDENTICAL to the unclamped string, so a
 * normal run's wire (and its `--json` transcript) does not move at all. Over
 * budget, results share the remaining space by water-filling: small results
 * survive whole, and only the oversized ones are cut - each with an explicit
 * in-band marker, never silently.
 */
export function assembleFencedContinuation(
  turn: number,
  blocks: string[],
  maxChars: number = WIRE_MESSAGE_MAX_CHARS,
): { message: string; clamped: boolean } {
  const head = `TOOL RESULTS (turn ${turn}):\n\n`;
  const tail = `\n\n${CONTINUE_HINT}`;
  const naive = `${head}${blocks.join('\n\n')}${tail}`;
  if (naive.length <= maxChars) return { message: naive, clamped: false };

  const n = blocks.length;
  const joins = n > 1 ? (n - 1) * 2 : 0;
  let pool = maxChars - head.length - tail.length - joins;
  // Water-fill: hand every block an equal share of what is left, but a block
  // shorter than its share only takes what it needs and returns the rest to
  // the pool for the bigger ones. Ascending order makes that a single pass.
  const shares = new Array<number>(n).fill(0);
  const ascending = blocks.map((_, i) => i).sort((a, b) => blocks[a]!.length - blocks[b]!.length);
  let slots = n;
  for (const i of ascending) {
    const equal = Math.max(0, Math.floor(pool / slots));
    const take = Math.min(blocks[i]!.length, equal);
    shares[i] = take;
    pool -= take;
    slots -= 1;
  }

  const fitted = blocks.map((b, i) => fitResultBlock(b, shares[i]!, i + 1));
  // Each fitted block is ≤ its share and the shares sum to ≤ the pool, so this
  // is ≤ maxChars. The slice is a mathematical backstop for the degenerate
  // case where the joiners alone exceed the cap (thousands of calls in a turn).
  const message = `${head}${fitted.join('\n\n')}${tail}`;
  return { message: message.length > maxChars ? message.slice(0, maxChars) : message, clamped: true };
}
const RECOVER_HINT =
  'No valid tool call was found. To call a tool, emit a fenced block tagged spycore:tool whose body is {"tool": <name>, "args": { ... }}. If you are finished, reply with your final answer as plain text and no fenced block.';

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const maxTurns = clampTurns(opts.maxTurns);
  const maxToolCallsPerTurn = clampToolCallsPerTurn(opts.maxToolCallsPerTurn);
  const model = opts.model ?? 'charon';
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const apiUrlOverride = opts.apiUrlOverride;
  const { events, emit } = createEventSink(opts);

  // A-8 - mid-turn steering. `steerInbox` holds user messages that arrived
  // while a turn was in flight; at the next step boundary they are folded
  // into the outgoing message as a user-steer section (message path, never
  // the system prompt - A-6/H-1). `settled` flips the moment the run
  // returns, so a late steer is refused instead of silently dropped.
  const steerInbox: string[] = [];
  let settled = false;
  const handle: AgentRunHandle = {
    steer: (text: string): boolean => {
      if (settled || text.trim().length === 0) return false;
      steerInbox.push(text.trim());
      return true;
    },
  };
  if (opts.onHandle) {
    try {
      opts.onHandle(handle);
    } catch {
      /* the hook is best-effort */
    }
  }
  /** Drain the steer inbox into the outgoing message; '' when empty. */
  const foldSteering = (message: string): string => {
    if (steerInbox.length === 0) return message;
    const steers = steerInbox.splice(0, steerInbox.length);
    const section = steers
      .map(
        (s) =>
          '---\nUSER STEER (this arrived mid-run - treat it as a new user message: ' +
          'fold it into your plan from the next step, do not restart work already done):\n' +
          `${s}\n---`,
      )
      .join('\n');
    return `${message}\n\n${section}`;
  };

  // Shared cost/runaway budget (tokens/time/turns). Spans the whole run when
  // the orchestrator passes the same instance to every phase + verify fix.
  const budget = opts.budget;
  const { hasTurnBudget, emitBudget, emitBudgetStop } = createBudgetReporter(budget, emit);

  const { skillsByName, skillsSection } = loadRunSkills(opts.cwd, emit);

  const { changes, record, recordDelta, persist } = createRunJournal(opts);
  // Web tools default ON; `--no-web` / `agentWebTools=false` arrive as
  // opts.webTools === false and remove them from prompt + declarations +
  // dispatch below.
  const webEnabled = opts.webTools !== false;
  const ctx = createToolContext(opts, { emit, record, skillsByName, webEnabled });

  const isApprovalInFlight = trackApprovalInFlight(ctx);
  const delegateDepth = resolveDelegateDepth(opts.delegateDepth);
  // H-10: only the orchestrator (top-level run) is offered `delegate` -
  // leaf runs are withheld it from the catalogue AND refused at dispatch.
  // MAX_DELEGATE_DEPTH stays as the defence-in-depth refusal at the gate.
  const delegateEnabled =
    roleForDepth(delegateDepth) === 'orchestrator' && delegateDepth < MAX_DELEGATE_DEPTH;
  const delegator = createDelegator({ opts, ctx, emit, provider, model, apiUrlOverride, budget, delegateDepth, runAgent });
  ctx.delegator = delegator;

  const counters: TurnCounters = { toolCalls: 0, turnCallStart: 0, toolCallCapNote: null };
  const { dispatchTurnCalls } = createRunDispatcher({ opts, ctx, emit, recordDelta, maxToolCallsPerTurn, counters });

  const { mcpBridge, mcpSection, conversationId, nativeMode, toolDecls, fireRunState } = await openRunSession({
    opts, ctx, emit, provider, model, apiUrlOverride, webEnabled, delegateEnabled,
    toolsets: { disabled: opts.disabledToolsets },
  });

  // A-6 + H-1 - the cache-sacred invariant. The system prompt is committed
  // once, on the first turn of a fresh conversation, and never rebuilt after:
  // mid-conversation injections ride the message/tool-result path (`pending`
  // below), never the system prompt, so the provider's KV-cache prefix stays
  // warm for the whole run. `verify` is a tripwire for any future code path
  // that would regenerate the system mid-run - it throws instead of silently
  // breaking the cache.
  const promptCache = createPromptCacheGuard();

  const result = (over: Partial<AgentResult> & Pick<AgentResult, 'finalText' | 'turns' | 'toolCalls'>): AgentResult => {
    settled = true; // A-8: no more steering once the run has returned
    persist();
    return {
      reachedMaxTurns: false,
      cancelled: false,
      events,
      changedFiles: changes.length,
      conversationId,
      budgetStop: null,
      ...over,
    };
  };

  // A-2: the tiered loop detector - one per run. Fed after every dispatched
  // turn; `warn`/`veto` notices go back to the model in-band (prepended to
  // the next turn's message), a `breaker` ends the run gracefully - the
  // journal is persisted, so the session stays healthy. Returns the
  // model-facing notice to prepend (null when silent), or the graceful
  // breaker result to return immediately.
  const loopDetector = createLoopDetector();
  const checkLoop = (
    turn: number,
    calls: Array<{ tool: string; args: Record<string, unknown>; command?: string | undefined }>,
    results: Array<ToolResult | null>,
  ): { notice: string | null; breaker: AgentResult | null } => {
    const trace: LoopCallTrace[] = [];
    for (let i = 0; i < calls.length; i += 1) {
      const res = results[i];
      if (!res) continue;
      const tool = ctx.extraTools?.get(calls[i]!.tool) ?? REGISTRY.get(calls[i]!.tool);
      trace.push({
        tool: calls[i]!.tool,
        argsKey: JSON.stringify(calls[i]!.args),
        ok: res.ok,
        content: res.content,
        mutating: tool?.mutating === true,
      });
      // A-9: the same record feeds the evidence check at close.
      evidenceCalls.push({ tool: calls[i]!.tool, ok: res.ok, command: calls[i]!.command ?? res.command });
    }
    const verdict = loopDetector.observeTurn({ turn, calls: trace });
    if (verdict.level === 'none' || !verdict.notice) return { notice: null, breaker: null };
    emit({ type: 'loop_notice', level: verdict.level, text: verdict.notice, turn });
    if (verdict.level === 'breaker') {
      return {
        notice: null,
        breaker: result({ finalText: verdict.notice, turns: turn, toolCalls: counters.toolCalls }),
      };
    }
    return { notice: verdict.notice, breaker: null };
  };

  /**
   * A-9 - close out a model final answer: run the evidence check first (warn
   * only, never block), then emit `final` and return. Every model-produced
   * final answer goes through here.
   */
  const finalizeAnswer = (turn: number, text: string): AgentResult => {
    for (const warning of checkEvidenceClaims(text, evidenceCalls)) {
      emit({ type: 'evidence_warn', text: warning, turn });
    }
    emit({ type: 'final', text });
    return result({
      finalText: text,
      turns: turn,
      toolCalls: counters.toolCalls,
      ...(turnBudgetHit ? { budgetStop: 'turns' as const } : {}),
      ...(hitTurnCap && !turnBudgetHit ? { reachedMaxTurns: true } : {}),
    });
  };

  // The system prompt travels separately from the first message so providers
  // with a native top-level system slot (Anthropic/Google) can use it. The
  // SpyCore + OpenAI-compatible providers re-join `${system}\n\n${message}`,
  // reproducing the exact bytes this loop used to send as one string. It is
  // passed only on turn 1 of a fresh conversation - continuations already have
  // it (server-side history for SpyCore, adapter session state for BYOK).
  let pending: string;
  let pendingSystem: string | undefined;
  // Image attachments (FILE IDs) ride the FIRST turn of a fresh conversation
  // only - cleared after delivery, exactly like pendingSystem. Continuations
  // (verify fix-ups) never re-send them.
  let pendingAttachments: string[] | undefined;
  // NATIVE mode: the tool results to feed back on a continuation turn (set after
  // a tool round; cleared/overwritten each round). Fenced mode never sets it.
  let pendingToolResults: ToolResultDecl[] | undefined;
  // Empty-completion guard: the backing model occasionally returns a turn with
  // no text AND no tool calls mid-run (observed live in the release bench -
  // the run ended "final" with the task half-done). One nudge retry per run;
  // a second empty turn is accepted as the final answer like before.
  let emptyFinalRetried = false;
  if (opts.conversationId) {
    // Continuing - the system prompt + prior turns are already in this
    // conversation; send just the new instruction (e.g. the verify feedback).
    pending = opts.continueMessage ?? 'Continue the task.';
  } else {
    // H-7: the durable-memory snapshot is taken ONCE, at session start, and
    // rendered into the system prompt as a frozen block. Mid-run `memory`
    // writes take effect on the NEXT session, never this one.
    const durableMemorySection = renderDurableMemoryBlock(loadDurableMemorySnapshot());
    const firstTurn = assembleFirstTurn({
      opts, emit, provider, maxTurns, nativeMode, skillsSection, mcpSection, webEnabled, delegateEnabled,
      toolsets: { disabled: opts.disabledToolsets },
      durableMemorySection,
    });
    pendingSystem = firstTurn.system;
    pending = firstTurn.message;
    pendingAttachments = firstTurn.attachments;
    // A-6 + H-1: commit the turn-1 system bytes - the cache-sacred invariant.
    promptCache.commit(firstTurn.system);
  }
  // F4: the previous turn's `usage` `input` - the full assembled context the
  // model just read - is the exact reading for the auto-compact decision.
  let lastInputTokens = 0;
  // F4: one-shot auto-compact trigger, conversation-scoped.
  const autoCompact = createAutoCompactTrigger();

  /**
   * F4: check the context meter BEFORE starting another turn. Fires at most
   * once per approach (see auto-compact.ts) and never while an approval gate
   * is open. A fired signal is a front-end instruction: warn the user and
   * run the existing compact flow, then let the run continue - the server
   * keeps the same conversation id, so the next turn reads the summary.
   */
  const checkAutoCompact = (turn: number): void => {
    const pct = autoCompactPct(lastInputTokens, model);
    if (autoCompact.check(pct, isApprovalInFlight()) && pct !== null) {
      emit({ type: 'context_full', turn, pct, inputTokens: lastInputTokens });
    }
  };

  // The turn ceiling. With an explicit --max-turns this is a whole-run budget
  // stop (controlled, exit 0); otherwise it's the built-in iteration guard.
  const finishTurnLimit = (turns: number, finalText: string): AgentResult => {
    if (hasTurnBudget) {
      emitBudgetStop('turns');
      return result({ finalText, turns, toolCalls: counters.toolCalls, budgetStop: 'turns' });
    }
    emit({ type: 'max_turns', turns });
    return result({ finalText, turns, toolCalls: counters.toolCalls, reachedMaxTurns: true });
  };

  // The whole turn loop is wrapped so the MCP bridge is ALWAYS torn down - on a
  // normal finish, a budget/abort early-return, or a thrown provider error. The
  // body keeps its indentation; `finally` runs on every `return` below.
  //
  // A-7: the loop runs to `maxTurns + 1` - the last turn is RESERVED as a
  // summary-only step. Instead of a hard cut at the cap, the model gets one
  // final turn to summarize; tool calls emitted there are never dispatched.
  const summaryTurn = maxTurns + 1;
  // A-9: every tool call of the run, for the evidence check at close.
  const evidenceCalls: EvidenceCall[] = [];
  let hitTurnCap = false;
  let turnBudgetHit = false;
  try {
  for (let turn = 1; turn <= summaryTurn; turn += 1) {
    const isSummaryTurn = turn === summaryTurn;
    // Per-turn tool-call cap bookkeeping: the baseline resets every turn.
    counters.turnCallStart = counters.toolCalls;
    counters.toolCallCapNote = null;
    // The previous turn fully completed (streamed + tools dispatched + next
    // input assembled) - a resumable step boundary.
    if (turn > 1) fireRunState(turn - 1);
    if (opts.signal?.aborted) {
      return result({ finalText: '', turns: turn - 1, toolCalls: counters.toolCalls, cancelled: true });
    }

    // Budget gate: stop gracefully BEFORE starting another model round-trip,
    // so a hit cap never interrupts an in-flight edit. The reserved summary
    // step is exempt from the TURNS cap - it IS the graceful close - but
    // never from the time cap or an abort.
    const preStop = budget?.check();
    if (preStop && !(isSummaryTurn && preStop === 'turns')) {
      emitBudgetStop(preStop);
      return result({ finalText: '', turns: turn - 1, toolCalls: counters.toolCalls, budgetStop: preStop });
    }

    if (!isSummaryTurn) budget?.addTurn();

    // A-7: entering the reserved step means the turn cap was hit - say so
    // once (the stop event the old hard cut emitted), then hand the model
    // its summary-only instruction. Nothing dispatched on this turn can be a
    // tool call; see the summary block after streaming.
    if (isSummaryTurn) {
      if (hasTurnBudget) {
        emitBudgetStop('turns');
        turnBudgetHit = true;
      } else {
        emit({ type: 'max_turns', turns: maxTurns });
      }
      hitTurnCap = true;
      pending = SUMMARY_ONLY_MESSAGE;
      pendingToolResults = undefined;
    }

    // F4: auto-compact at the context ceiling - checked before burning more
    // context on another turn, never while an approval gate is open.
    if (turn > 1) checkAutoCompact(turn);

    // A-8: the step boundary - fold any mid-turn user messages into the
    // outgoing message as a user-steer section. Skipped on the reserved
    // summary turn (the run is ending; nothing left to steer).
    if (!isSummaryTurn) pending = foldSteering(pending);

    let reply: string;
    let replyToolCalls: ProviderToolCallLite[] = [];
    try {
      // A-6 + H-1: the system prompt goes out at most once per run (turn 1
      // of a fresh conversation). Verify the bytes before they go out - a
      // future code path that regenerates the system mid-run trips here
      // instead of silently breaking the provider's KV-cache prefix.
      if (pendingSystem !== undefined) promptCache.verify(pendingSystem);
      const turnRes = await streamTurn({
        provider,
        conversationId,
        model,
        message: pending,
        system: pendingSystem,
        apiUrlOverride,
        signal: opts.signal,
        // NATIVE: declare tools every turn; feed back the prior round's results.
        tools: nativeMode ? toolDecls : undefined,
        toolResults: pendingToolResults,
        attachments: pendingAttachments,
        onToken: (chunk) => emit({ type: 'assistant_token', turn, chunk }),
        onSkills: (activated) => emit({ type: 'skills', turn, skills: activated }),
        onToolStarted: nativeMode
          ? (index, name) => emit({ type: 'tool_call_started', turn, index, name })
          : undefined,
        // Mid-turn: only the wall-clock budget can trip while text streams
        // (tokens/turns are known only at the boundary).
        shouldStop: budget ? () => budget.check() === 'time' : undefined,
      });
      reply = turnRes.text;
      replyToolCalls = turnRes.toolCalls;
      lastInputTokens = turnRes.inputTokens; // F4: the reading for the next turn's auto-compact check
      pendingSystem = undefined; // delivered with turn 1; later turns send only the message
      pendingAttachments = undefined; // delivered with turn 1, exactly like the system prompt
      pendingToolResults = undefined; // consumed; the native branch re-sets it per round
      budget?.addTokens(turnRes.inputTokens, turnRes.outputTokens);
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof SpycoreCliError && err.message === 'Cancelled')) {
        return result({ finalText: '', turns: turn - 1, toolCalls: counters.toolCalls, cancelled: true });
      }
      throw err;
    }
    emitBudget();

    // A turn the time budget cut short mid-stream: stop now, discarding the
    // partial reply (we never act on it → no half-applied mutation).
    if (budget?.check() === 'time') {
      emitBudgetStop('time');
      return result({ finalText: '', turns: turn, toolCalls: counters.toolCalls, budgetStop: 'time' });
    }

    // A-7: the reserved final step - summary only. Any tool call the model
    // emits on this turn is NOT dispatched; the prose (possibly empty) is
    // the final answer. finalizeAnswer runs the A-9 evidence check first.
    if (isSummaryTurn) {
      const prose = nativeMode ? reply.trim() : parseTurn(reply).prose;
      return finalizeAnswer(turn, prose);
    }

    // ── NATIVE mode ── tool calls come from the provider's tool_calls event,
    // not from parsing text. Dispatch is the SAME path as fenced (approval,
    // catastrophic guard, secrets, byte-cap, checkpoint); only the call source
    // and the next-turn feedback shape (toolResults vs a text message) differ.
    if (nativeMode) {
      const narration = reply.trim();
      if (replyToolCalls.length === 0) {
        // Empty-completion guard (see declaration above): nudge once instead
        // of accepting an empty turn as the final answer.
        if (narration.length === 0 && !emptyFinalRetried && turn < maxTurns) {
          emptyFinalRetried = true;
          emit({ type: 'parse_error', turn, message: 'empty reply - nudging once' });
          pending =
            'Your reply was empty. Continue the TASK now: call the next tool, or give your final answer as plain text.';
          pendingToolResults = undefined;
          continue;
        }
        // No tool call → the assistant's text is the final answer.
        return finalizeAnswer(turn, narration);
      }
      if (narration.length > 0) emit({ type: 'narration', turn, text: narration });

      // Parse every call's arguments first: a malformed-arguments call feeds an
      // error result back to the model without dispatching, and without
      // disturbing the parallel/serial batching of its siblings.
      const parsedCalls = replyToolCalls.map((call) => {
        let args: Record<string, unknown> = {};
        let argError: string | null = null;
        try {
          const parsedArgs = JSON.parse(call.arguments && call.arguments.length > 0 ? call.arguments : '{}');
          if (parsedArgs && typeof parsedArgs === 'object' && !Array.isArray(parsedArgs)) {
            args = parsedArgs as Record<string, unknown>;
          } else {
            argError = 'arguments were not a JSON object';
          }
        } catch (err) {
          argError = `arguments were not valid JSON (${err instanceof Error ? err.message : String(err)})`;
        }
        return { id: call.id, name: call.name, args, argError };
      });
      const dispatched = await dispatchTurnCalls(
        turn,
        parsedCalls.map((p, index) => ({ tool: p.name, args: p.args, argError: p.argError, index })),
      );
      if (dispatched === null) {
        return result({ finalText: '', turns: turn, toolCalls: counters.toolCalls, cancelled: true });
      }
      const results: ToolResultDecl[] = [];
      for (let i = 0; i < parsedCalls.length; i += 1) {
        const res = dispatched[i];
        // A `null` slot is a call the per-turn cap skipped - the cap event
        // and the in-band note already fired inside dispatchTurnCalls.
        if (res === null || res === undefined) break;
        const p = parsedCalls[i]!;
        // The server caps EACH toolResults[].content at 32,000 chars. The
        // result budget + hook reserve already guarantee that; this is the
        // defense-in-depth backstop that keeps a future budget regression a
        // truncation instead of a 400. A no-op under DEFAULT_LIMITS.
        results.push({ id: p.id, name: p.name, content: clampToWireMax(res.content) });
      }

      // A-2: feed the dispatched turn to the loop detector - warn/veto
      // notices lead the next turn's message, a breaker ends the run here.
      const loopCheck = checkLoop(
        turn,
        parsedCalls.map((p) => ({
          tool: p.name,
          args: p.args,
          command: p.name === 'run_command' && typeof p.args.command === 'string' ? p.args.command : undefined,
        })),
        dispatched,
      );
      if (loopCheck.breaker) return loopCheck.breaker;

      // Next turn: feed results back as a tool-result continuation. When the
      // per-turn cap fired, the model also gets the in-band notice so the
      // skipped calls are never silent.
      pendingToolResults = results;
      pending = counters.toolCallCapNote ?? '';
      if (loopCheck.notice) pending = `${loopCheck.notice}\n\n${pending}`;
      continue;
    }

    const parsed = parseTurn(reply);

    // No actionable tool call this turn.
    if (parsed.calls.length === 0) {
      const malformed = parsed.errors.length > 0 || parsed.hasUnclosedBlock;
      if (malformed) {
        const detail = parsed.errors[0]?.message ?? 'an incomplete tool block';
        emit({ type: 'parse_error', turn, message: detail });
        // A-7: no hard cut here either - a malformed turn at the cap falls
        // through to the reserved summary step like any other turn.
        pending = `Your previous message could not be used (${detail}). ${RECOVER_HINT}`;
        continue;
      }
      // Empty-completion guard (see declaration above): nudge once instead
      // of accepting an empty turn as the final answer.
      if (parsed.prose.trim().length === 0 && !emptyFinalRetried && turn < maxTurns) {
        emptyFinalRetried = true;
        emit({ type: 'parse_error', turn, message: 'empty reply - nudging once' });
        pending = `Your reply was empty. Continue the TASK now. ${CONTINUE_HINT}`;
        continue;
      }
      // Genuine final answer.
      return finalizeAnswer(turn, parsed.prose);
    }

    // Narration that preceded the tool calls (if any).
    if (parsed.prose.length > 0) {
      emit({ type: 'narration', turn, text: parsed.prose });
    }

    const total = parsed.calls.length;
    const feedback: string[] = [];
    const fencedResults = await dispatchTurnCalls(
      turn,
      parsed.calls.map((call, index) => ({ tool: call.tool, args: call.args, argError: null, index })),
    );
    if (fencedResults === null) {
      return result({ finalText: '', turns: turn, toolCalls: counters.toolCalls, cancelled: true });
    }
    for (let i = 0; i < parsed.calls.length; i += 1) {
      const res = fencedResults[i];
      // A `null` slot is a call the per-turn cap skipped - the cap event and
      // the in-band note already fired inside dispatchTurnCalls.
      if (res === null || res === undefined) break;
      const call = parsed.calls[i]!;
      feedback.push(formatResultForModel(i, total, call.tool, call.args, res.ok, res.summary, res.content));
    }

    // A-2: feed the dispatched turn to the loop detector - warn/veto notices
    // lead the next turn's message, a breaker ends the run here.
    const loopCheck = checkLoop(
      turn,
      parsed.calls.map((call) => ({
        tool: call.tool,
        args: call.args,
        command:
          call.tool === 'run_command' && typeof call.args.command === 'string'
            ? call.args.command
            : undefined,
      })),
      fencedResults,
    );
    if (loopCheck.breaker) return loopCheck.breaker;

    // The fenced continuation goes out as ONE `message` field - the same field
    // the 1.8 clamp guards on turn 1. Clamp it here too, for EVERY turn.
    // When the per-turn cap fired, its notice joins the feedback so the
    // skipped calls are never silent.
    if (counters.toolCallCapNote) feedback.push(counters.toolCallCapNote);
    const continuation = assembleFencedContinuation(turn, feedback);
    if (continuation.clamped) {
      emit({
        type: 'context_clamped',
        text: `Trimmed the tool results to fit the ${WIRE_MESSAGE_MAX_CHARS.toLocaleString('en-US')}-character message limit. Nothing was dropped silently - each cut is marked in the message.`,
      });
    }
    pending = loopCheck.notice ? `${loopCheck.notice}\n\n${continuation.message}` : continuation.message;
  }

  // Unreachable in practice - the reserved summary turn always returns above -
  // but kept as the backstop so the loop can never fall off its end.
  return finishTurnLimit(summaryTurn, '');
  } finally {
    if (mcpBridge) await mcpBridge.shutdown();
    // M1: LSP servers were promised graceful shutdown (manager.ts docstring)
    // but shutdownLspManagers() was never called - wire it here so long-lived
    // TUI sessions don't accumulate language servers.
    // M4: only shut down at the TOP level (delegateDepth === 0). A delegated
    // child runs in-process on the same cwd with the shared module-level
    // manager cache; shutting down here would kill the parent's warm servers.
    if (delegateDepth === 0) {
      const { shutdownLspManagers } = await import('./lsp/manager.js');
      await shutdownLspManagers().catch(() => {});
    }
  }
}
