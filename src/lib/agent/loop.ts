/**
 * Client-side agent prompt-loop.
 *
 * The CLI streams text from /api/chat/stream; the model emits tool calls as
 * `spycore:tool` fenced blocks (see protocol.ts). Each turn we stream the
 * reply, parse complete tool blocks once the turn finishes, execute them via
 * the read-only tool registry, then feed the results back as the next message
 * — looping until the model answers with no tool block (final answer) or we
 * hit the turn cap.
 *
 * The loop emits a structured `AgentEvent` stream so any front-end (the Ink
 * UI, a plain-text renderer, or `--json`) can present progress identically.
 */
import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';
import { clampWireAssembly, type WirePart } from '../wire-clamp.js';
import { WIRE_MESSAGE_MAX_CHARS, clampToWireMax } from '../wire-limits.js';
import { SpyCoreProvider } from '../providers/spycore.js';
import type { Provider, ToolDecl, ToolResultDecl } from '../providers/types.js';
import { parseTurn } from './protocol.js';
import { buildSkillsCatalog, discoverSkills, type DiscoveredSkill } from './skills.js';
import { setupMcpBridge, type McpBridge } from './mcp.js';
import type { ResolvedMcpServer } from './mcp-config.js';
import {
  buildToolDeclarations,
  DEFAULT_LIMITS,
  describeCallArg,
  describeToolsForPrompt,
  dispatchTool,
  type ToolContext,
  type ToolLimits,
  type ToolResult,
} from './tools.js';
import type { ToolResultKind, RequestApproval } from './approval.js';
import type { EffectiveCommandRules } from './command-rules.js';
import { saveSession, type RecordedChange } from './checkpoint.js';
import {
  closePause,
  diffWorkspace,
  openPause,
  pauseNotice,
  snapshotWorkspace,
  uncapturedNotice,
  type PauseCensus,
  type WorkspaceSnapshot,
} from './workspace-delta.js';
import type { Budget, BudgetReason } from './budget.js';

export const MIN_TURNS = 1;
export const MAX_TURNS_CAP = 200;
export const DEFAULT_MAX_TURNS = 25;

export type AgentModelSlug = 'charon' | 'styx' | 'hermes' | 'minos';

/**
 * The default model-call provider: SpyCore's backend (server-side skills /
 * memory / search / quota + identity protection). Stateless on the client, so a
 * shared singleton is fine; callers may pass their own provider (e.g. a BYOK
 * OpenAI-compatible one) via `RunAgentOptions.provider`.
 */
const DEFAULT_PROVIDER: Provider = new SpyCoreProvider();

/** Progress events emitted by the loop, in order. */
export type AgentEvent =
  | { type: 'assistant_token'; turn: number; chunk: string }
  | { type: 'narration'; turn: number; text: string }
  | {
      type: 'tool_call';
      turn: number;
      index: number;
      tool: string;
      arg: string;
      args: Record<string, unknown>;
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
    }
  | { type: 'parse_error'; turn: number; message: string }
  /** NATIVE tool-use: the model named a tool mid-stream — an early "⚙ <tool> …" hint. */
  | { type: 'tool_call_started'; turn: number; index: number; name: string }
  /** Server-side skills the SpyCore backend activated this turn (informational; spycore provider only). */
  | { type: 'skills'; turn: number; skills: string[] }
  /** A connected MCP server (dim, informational): startup warning or a ready summary. */
  | { type: 'mcp_notice'; level: 'warn' | 'info'; text: string }
  /** PHASE-1 1.6: a lifecycle-hook diagnostic (block reasons, warns, timeouts). */
  | { type: 'hook_notice'; level: 'warn' | 'info'; text: string }
  /** PHASE-1 1.10: a command-rule decision — an allowlist auto-approval
   *  (info, naming the matched rule; never silent) or a deny (warn). */
  | { type: 'rule_notice'; level: 'warn' | 'info'; text: string }
  /** PHASE-1 1.8: the first-turn assembly was clamped to the wire message cap
   *  (explicit in-band markers were left at each cut — nothing silent). */
  | { type: 'context_clamped'; text: string }
  | { type: 'final'; text: string }
  | { type: 'max_turns'; turns: number }
  /** Running budget after a turn — only emitted when a cap is configured. */
  | { type: 'budget'; tokensUsed: number; turnsUsed: number; elapsedMs: number }
  /** A cap was hit: the run stops gracefully (a controlled stop, not an error). */
  | {
      type: 'budget_stop';
      reason: BudgetReason;
      cap: number;
      tokensUsed: number;
      turnsUsed: number;
      elapsedMs: number;
    };

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
   * by the command layer — global user scope plus trust+approval-gated
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
   * native declarations, AND dispatch — the model never sees them.
   */
  webTools?: boolean | undefined;
  /**
   * Observe the workspace around each OPAQUE tool call (`run_command`, MCP
   * tools, tool hooks) so their changes reach the journal. ⭐ Default OFF —
   * only `true` (from `--observe` or `agentObserveWorkspace=true`) takes the
   * before/after snapshot at all. See `SPY-416`.
   *
   * ⭐ OFF IS NOT "NO JOURNAL". `write_file` and `edit_file` report their own
   * changes and keep doing so; what is lost is exactly the opaque set. The run
   * says so ONCE, the first time an opaque call runs unobserved — a silently
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
   * marker phrase to the plan-injection header AT INJECTION TIME — the marker
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
   * string into every phase. It is APPENDED to the core system prompt — after
   * the agent's identity/safety/tool protocol, supplementing but NEVER
   * overriding them — on the first turn of a fresh conversation. Continuations
   * (verify fix-ups carry `conversationId`) inherit it from history, so it is
   * never re-read or re-injected per phase/turn. Empty/undefined → no-op,
   * leaving the system prompt byte-identical to a memory-free build.
   */
  projectContext?: string | undefined;
  /**
   * Image attachments: uploaded SpyCore FILE IDs, sent through the stream
   * request's existing `attachments` field on the FIRST turn of a fresh
   * conversation (the server resolves them to imageUrls for vision models —
   * exactly the web chat contract). Continuations never re-send them; their
   * takeaways live in the conversation history.
   */
  attachments?: string[] | undefined;
  /**
   * Inlined text attachments: pre-built, delimited per-file blocks appended
   * to the `TASK: …` first message. User-owned content — no untrusted-content
   * wrapper. Computed once by the command layer and identical across the
   * plan + execute phases.
   */
  attachedContext?: string | undefined;
  /** Continue this existing conversation instead of opening a new one (verify fix-up). */
  conversationId?: string | undefined;
  /** First message when continuing — e.g. the verify-failure feedback. */
  continueMessage?: string | undefined;
  /** External change recorder; when set, the caller owns checkpoint persistence. */
  recordChange?: ((change: RecordedChange) => void) | undefined;
  /**
   * ⭐⭐ F-2c-48 · `C-UX45` — the BATCH sink for the observation window's delta.
   *
   * One opaque call can change hundreds of files, and the window discovers them
   * all at one instant. Handing them over one at a time makes the recorder rewrite
   * the whole journal once per record — O(N²), unbounded in N, and the observer is
   * what makes N large. This sink receives the whole delta so the journal is
   * committed once.
   *
   * ⭐ Optional, and the fallback is the per-record path, so a caller that omits it
   * still journals exactly the same records — it just pays the quadratic again.
   * That silence is why `observer-window.test.ts` asserts mechanically that every
   * call site wiring `recordChange` also wires this: a new site added later is
   * otherwise a cost regression nothing reddens.
   */
  recordChanges?: ((changes: readonly RecordedChange[]) => void) | undefined;
  /**
   * Session-wide set of skill names already loaded via load_skill. Pass ONE
   * set across plan/execute/verify phases so a repeat load returns a short
   * notice instead of re-injecting the full body. Defaults to per-call.
   */
  loadedSkills?: Set<string> | undefined;
  /** Shared cost/runaway budget (tokens/time/turns) spanning the whole run. */
  budget?: Budget | undefined;
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
   * requestApproval — nothing a hook returns can approve or auto-confirm
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
   * stream on purpose — `--json` output stays byte-identical when unused. The
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

export interface AgentResult {
  finalText: string;
  turns: number;
  toolCalls: number;
  reachedMaxTurns: boolean;
  cancelled: boolean;
  events: AgentEvent[];
  /** Number of files the run created/modified (journaled for `spycore rewind`). */
  changedFiles: number;
  /** The conversation this run used — pass back as `conversationId` to continue it. */
  conversationId: string;
  /** Set when a cost/runaway cap stopped the run (a controlled stop, not failure). */
  budgetStop: BudgetReason | null;
}

function clampTurns(n: number | undefined): number {
  const v = Number.isFinite(n) ? Number(n) : DEFAULT_MAX_TURNS;
  return Math.max(MIN_TURNS, Math.min(MAX_TURNS_CAP, Math.floor(v)));
}

const SYSTEM_PROMPT = (cwd: string, maxTurns: number, skillsSection: string, mcpSection: string, webEnabled: boolean): string =>
  `You are SpyCode, SpyCore's autonomous coding agent, running in a sandboxed terminal session in this directory:
  ${cwd}

Accomplish the user's TASK: explore the project with the read tools, MODIFY files with write_file / edit_file, and run shell commands with run_command (build, test, lint, git, install, …). When you are done, give a clear final answer. The file tools cannot reach outside the working directory; run_command runs a shell there, so keep its commands inside it too.

# Calling tools
To call a tool, emit a fenced code block whose info string is exactly \`spycore:tool\`. The body is ONE JSON object: {"tool": <name>, "args": { ... }}.

\`\`\`spycore:tool
{"tool": "read_file", "args": {"path": "src/index.ts"}}
\`\`\`

Protocol rules:
- Put NOTHING except the JSON inside the fences. Any explanation goes OUTSIDE the fences.
- You may emit MULTIPLE blocks in one message to run several tools at once.
- After emitting tool blocks, STOP and wait — the results will be sent back to you, then you continue.
- When the task is complete, reply with your FINAL answer as plain text and DO NOT emit any tool block. That ends the session.

# Tools
${describeToolsForPrompt({ webEnabled })}${skillsSection}${mcpSection}

# Editing files
- Use edit_file for small, targeted changes and write_file for new files or full rewrites.
- edit_file does an exact string replace: old_str MUST occur EXACTLY once in the file. Include enough surrounding context to make it unique. If it matches 0 or many times the edit is rejected — add more context and retry.
- read a file before editing it so old_str matches byte-for-byte.
- Every write is shown to the user as a diff and applied only after they approve. A write may come back "rejected by user" or "approval required" — if so, do not blindly retry the identical write; adjust or move on.

# Running commands
- Use run_command for build/test/lint/git/install and other shell tasks. PREFER the dedicated file tools (read_file/write_file/edit_file/grep/glob) over cat/sed/find/echo-to-file — they are safer and need no shell.
- Every command is shown to the user for approval before it runs, exactly like a write; it may come back rejected — adapt rather than re-running the same command.
- Avoid destructive commands; obviously catastrophic ones (e.g. rm -rf /) are hard-blocked.

# Constraints
- Paths are relative to the working directory; ".." escapes and absolute paths outside it are rejected.
- Sensitive paths (.env, private keys, .git, .ssh, and anything in .spycoreignore) are blocked for BOTH reading and writing by every tool that takes a path. run_command is the exception: it runs a shell, so it is bounded by the approval gate and the catastrophic-command guard, NOT by this rule. Do not use it to read or write a sensitive path.
- Read tools hide .gitignore'd files and node_modules/.git/build/dist.
- You have a budget of ${maxTurns} tool-calling turns — be efficient; prefer repo_map / glob / grep to orient before reading whole files.
- Only ever refer to models by their public SpyCore names.`;

const PLAN_SYSTEM_PROMPT = (cwd: string, maxTurns: number, skillsSection: string, webEnabled: boolean): string =>
  `You are SpyCode, SpyCore's autonomous coding agent, in PLANNING MODE in this directory:
  ${cwd}

Right now your job is to PLAN, not to act. Investigate the project with the READ-ONLY tools to understand what the TASK requires, then output a concise NUMBERED plan and STOP. You will NOT implement anything in this phase — write_file, edit_file, and run_command are DISABLED and will return an error if called.

# Calling tools
To call a tool, emit a fenced code block whose info string is exactly \`spycore:tool\`. The body is ONE JSON object: {"tool": <name>, "args": { ... }}.

\`\`\`spycore:tool
{"tool": "read_file", "args": {"path": "src/index.ts"}}
\`\`\`

Protocol rules:
- Put NOTHING except the JSON inside the fences. Explanation goes OUTSIDE the fences.
- You may emit MULTIPLE blocks in one message to investigate several things at once.
- After emitting tool blocks, STOP and wait — the results come back, then you continue investigating.

# Read-only tools (planning phase)
${describeToolsForPrompt({ readOnlyOnly: true, webEnabled })}${skillsSection}

# Output the plan
When you understand the task, reply with your FINAL answer (NO tool block): a one-line summary, then a NUMBERED plan listing the files you will create or edit and any commands you will run. Keep it concise. Do NOT begin implementing — the plan is shown to the user for approval first.

# Constraints
- Paths are relative to the working directory; you cannot read outside it.
- Sensitive paths (.env, keys, .git, .ssh, .spycoreignore) and .gitignore'd files are hidden.
- Budget: ${maxTurns} tool-calling turns. Only ever refer to models by their public SpyCore names.`;

// NATIVE-mode prompts: identical guidance to the fenced prompts MINUS the
// `spycore:tool` wire mechanics — the tools are declared to the model via the
// provider's native tool-calling, so there is no fenced block to describe. The
// skills catalog + MCP catalog stay (load_skill is just a native tool now).
const NATIVE_SYSTEM_PROMPT = (cwd: string, maxTurns: number, skillsSection: string, mcpSection: string): string =>
  `You are SpyCode, SpyCore's autonomous coding agent, running in a sandboxed terminal session in this directory:
  ${cwd}

Accomplish the user's TASK: explore the project with the read tools, MODIFY files with write_file / edit_file, and run shell commands with run_command (build, test, lint, git, install, …). When you are done, give a clear final answer. The file tools cannot reach outside the working directory; run_command runs a shell there, so keep its commands inside it too.

# Tools
Call the available tools directly using your native tool-calling. You may call several at once; their results are sent back to you and you continue. When the task is complete, reply with your FINAL answer as plain text and call NO tool — that ends the session.${skillsSection}${mcpSection}

# Editing files
- Use edit_file for small, targeted changes and write_file for new files or full rewrites.
- edit_file does an exact string replace: old_str MUST occur EXACTLY once in the file. Include enough surrounding context to make it unique. If it matches 0 or many times the edit is rejected — add more context and retry.
- read a file before editing it so old_str matches byte-for-byte.
- Every write is shown to the user as a diff and applied only after they approve. A write may come back "rejected by user" or "approval required" — if so, do not blindly retry the identical write; adjust or move on.

# Running commands
- Use run_command for build/test/lint/git/install and other shell tasks. PREFER the dedicated file tools (read_file/write_file/edit_file/grep/glob) over cat/sed/find/echo-to-file — they are safer and need no shell.
- Every command is shown to the user for approval before it runs, exactly like a write; it may come back rejected — adapt rather than re-running the same command.
- Avoid destructive commands; obviously catastrophic ones (e.g. rm -rf /) are hard-blocked.

# Constraints
- Paths are relative to the working directory; ".." escapes and absolute paths outside it are rejected.
- Sensitive paths (.env, private keys, .git, .ssh, and anything in .spycoreignore) are blocked for BOTH reading and writing by every tool that takes a path. run_command is the exception: it runs a shell, so it is bounded by the approval gate and the catastrophic-command guard, NOT by this rule. Do not use it to read or write a sensitive path.
- Read tools hide .gitignore'd files and node_modules/.git/build/dist.
- You have a budget of ${maxTurns} tool-calling turns — be efficient; prefer repo_map / glob / grep to orient before reading whole files.
- Only ever refer to models by their public SpyCore names.`;

const NATIVE_PLAN_SYSTEM_PROMPT = (cwd: string, maxTurns: number, skillsSection: string): string =>
  `You are SpyCode, SpyCore's autonomous coding agent, in PLANNING MODE in this directory:
  ${cwd}

Right now your job is to PLAN, not to act. Investigate the project with the READ-ONLY tools to understand what the TASK requires, then output a concise NUMBERED plan and STOP. You will NOT implement anything in this phase — only read-only tools are offered to you; there is no write/edit/run tool available yet.

# Tools
Call the available READ-ONLY tools directly using your native tool-calling to investigate. Their results are sent back to you and you continue investigating.${skillsSection}

# Output the plan
When you understand the task, reply with your FINAL answer (call NO tool): a one-line summary, then a NUMBERED plan listing the files you will create or edit and any commands you will run. Keep it concise. Do NOT begin implementing — the plan is shown to the user for approval first.

# Constraints
- Paths are relative to the working directory; you cannot read outside it.
- Sensitive paths (.env, keys, .git, .ssh, .spycoreignore) and .gitignore'd files are hidden.
- Budget: ${maxTurns} tool-calling turns. Only ever refer to models by their public SpyCore names.`;

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
  /** Image attachments (FILE IDs) — first turn of a fresh conversation only. */
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
 * and ends the turn, so we return the partial text — the caller then stops the
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
 * JSON in the header alone, blowing the wire cap and — once the assembler
 * clamps — crowding the actual tool RESULT out of the turn. The model already
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
 * Assemble the FENCED continuation turn — N formatted tool results joined into
 * ONE `message` field, which the server caps at 32,000 chars. Turn 1 has gone
 * through `clampWireAssembly` since 1.8; continuation turns went out RAW, so a
 * single oversized result 400'd the whole run (FIX BATCH 2 / B2).
 *
 * Under budget the output is BYTE-IDENTICAL to the unclamped string, so a
 * normal run's wire (and its `--json` transcript) does not move at all. Over
 * budget, results share the remaining space by water-filling: small results
 * survive whole, and only the oversized ones are cut — each with an explicit
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
  const model = opts.model ?? 'charon';
  const provider = opts.provider ?? DEFAULT_PROVIDER;
  const apiUrlOverride = opts.apiUrlOverride;
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent): void => {
    events.push(e);
    opts.onEvent?.(e);
  };

  // Shared cost/runaway budget (tokens/time/turns). Spans the whole run when
  // the orchestrator passes the same instance to every phase + verify fix.
  const budget = opts.budget;
  const hasTurnBudget = !!budget && budget.caps.maxTurns !== undefined;
  const emitBudget = (): void => {
    if (!budget?.hasCaps) return;
    const s = budget.snapshot();
    emit({ type: 'budget', tokensUsed: s.tokensUsed, turnsUsed: s.turnsUsed, elapsedMs: s.elapsedMs });
  };
  const emitBudgetStop = (reason: BudgetReason): void => {
    if (!budget) return;
    const s = budget.snapshot();
    const cap =
      reason === 'tokens'
        ? budget.caps.maxTokens ?? 0
        : reason === 'time'
          ? budget.caps.maxTimeMs ?? 0
          : budget.caps.maxTurns ?? 0;
    emit({ type: 'budget_stop', reason, cap, tokensUsed: s.tokensUsed, turnsUsed: s.turnsUsed, elapsedMs: s.elapsedMs });
  };

  // Installed skills (project + user-global). With zero skills the catalog is
  // '' and the system prompt is byte-identical to pre-skills builds. Discovery
  // never throws; failures degrade to an empty set.
  const skills: DiscoveredSkill[] = discoverSkills(opts.cwd);
  const skillsByName: ReadonlyMap<string, DiscoveredSkill> = new Map(skills.map((s) => [s.name, s]));
  const skillsSection = buildSkillsCatalog(skills);

  const changes: RecordedChange[] = [];
  const externalRecorder = opts.recordChange;
  const externalBatchRecorder = opts.recordChanges;
  /**
   * ⭐ The observation window's delta, handed over as ONE batch so the caller's
   * journal is committed once rather than once per record. Falls back to the
   * per-record sink, so the records — and the journal — are identical either way.
   *
   * ⭐ `ctx.recordChange` is deliberately NOT used here: inside the window it is
   * swapped for the self-journaling tracker, and by this point the tracker has
   * already been restored. Going through the same two sinks the tracker wraps keeps
   * exactly one definition of "where a change goes".
   */
  const recordDelta = (delta: readonly RecordedChange[]): void => {
    if (delta.length === 0) return;
    for (const c of delta) changes.push(c);
    if (externalBatchRecorder) externalBatchRecorder(delta);
    else for (const c of delta) externalRecorder?.(c);
  };
  // Web tools default ON; `--no-web` / `agentWebTools=false` arrive as
  // opts.webTools === false and remove them from prompt + declarations +
  // dispatch below.
  const webEnabled = opts.webTools !== false;
  const ctx: ToolContext = {
    cwd: opts.cwd,
    limits: opts.limits ?? DEFAULT_LIMITS,
    signal: opts.signal,
    requestApproval: opts.requestApproval,
    commandTimeoutMs: opts.commandTimeoutMs,
    planMode: opts.planMode,
    webToolsEnabled: webEnabled,
    apiUrlOverride: opts.apiUrlOverride,
    skills: skillsByName,
    loadedSkills: opts.loadedSkills ?? new Set<string>(),
    // PHASE-1 1.10: rules + the visible-notice sink. Every rule decision is
    // surfaced as a rule_notice event — an auto-approval is never silent.
    commandRules: opts.commandRules,
    onCommandRuleNotice: (n) => {
      const cmd = n.command.length > 80 ? `${n.command.slice(0, 80)}…` : n.command;
      emit(
        n.kind === 'deny'
          ? {
              type: 'rule_notice',
              level: 'warn',
              text: `denied by the ${n.rule.scope} deny rule "${n.rule.entry}": ${cmd}`,
            }
          : {
              type: 'rule_notice',
              level: 'info',
              text: `auto-approved by the ${n.rule.scope} allow rule "${n.rule.entry}": ${cmd}`,
            },
      );
    },
    recordChange: (c) => {
      changes.push(c);
      externalRecorder?.(c);
    },
  };

  // PHASE-1 1.6: wrap tool dispatch with the lifecycle-hook bridge — ONE
  // wrapper for both the fenced and native call sites. No hooks → direct
  // dispatchTool, byte-identical behavior. Blocking-only influence: a
  // pre-tool block substitutes an error result WITHOUT dispatching; nothing
  // here touches requestApproval — an allowed call still runs the normal
  // approval flow inside dispatchTool. The hook layer is failure-isolated.
  /**
   * ⭐⭐ THE OBSERVATION WINDOW — how an OPAQUE mutation reaches the journal.
   *
   * `write_file` / `edit_file` report themselves. `run_command`, every MCP tool
   * and any hook that runs around a tool call hand work to another process, so
   * the only way to know what they changed is to look before and after.
   * Measured at HEAD before this existed: 5 of the 7 mutation paths one run has
   * were outside the journal while three shipped documents promised `rewind`
   * undoes "everything the last run changed".
   *
   * ⭐ The window wraps the WHOLE bracket — pre-tool hook, dispatch, post-tool
   * hook — because a hook is a user-configured shell command that mutates as
   * freely as `run_command` does. Session-level hooks (`session-start`,
   * `prompt-submit`, `session-end`) fire outside any tool call and are outside
   * the window; that boundary is stated in SECURITY.md rather than blurred.
   *
   * ⭐⭐ F-2c-48 — BUT THE APPROVAL PAUSE IS NOT PART OF IT. The bracket contains
   * a prompt whose length is a human decision, and everything that wrote during
   * those seconds was journaled as the call's work — including the user's own
   * edits, which `spycore rewind` then reverted and deleted. The pause is now
   * bracketed by a size-and-timestamp census and folded into the baseline; see
   * the barrier below and `closePause`. ⭐ The bracket itself is UNCHANGED, which
   * is what keeps the pre-tool hook — which runs before the prompt — journaled.
   *
   * ⭐ It opens ONLY when there is something to journal into and something
   * opaque to journal: no recorder ⇒ no snapshot; a self-reporting tool with no
   * hooks configured ⇒ no snapshot. So a read-only turn, and a run whose only
   * mutations are file writes, cost exactly what they cost before.
   *
   * ⭐⭐ AND IT IS OPT-IN, DEFAULT OFF. Measured through these very calls:
   * ~30 ms per opaque call on a 298-file package, ~375 ms on a 2,472-file
   * monorepo, ~1.4 s at the 20,000-file cap — twice per call, because the
   * window takes a before AND an after picture. That is real money for a user
   * who does not want the journal. ⭐⭐ AND IT IS NOT ONLY TIME: the snapshot
   * reads the FULL PLAINTEXT of every file the ignore rules do not hide and
   * stores it on disk, which the published `0.6.0` never did — so the DEFAULT
   * IS OFF (`SPY-416`), and `--observe` / `agentObserveWorkspace=true` turns it
   * on. The default is pinned rather than merely the flag; a default that flips
   * silently is the whole hazard, in either direction.
   */
  const opaqueTool = (name: string): boolean => {
    if (name === 'write_file' || name === 'edit_file') return false;
    const t = ctx.extraTools?.get(name) ?? undefined;
    return name === 'run_command' || t?.mutating === true;
  };

  // ⭐⭐ `SPY-416` / R-CLI-1 — OPT-IN. Only an explicit `true` — from
  // `--observe` or from `agentObserveWorkspace=true` — opens the window, so a
  // missing option and an undefined config value both leave it CLOSED and
  // nothing is read or written. The default is pinned rather than merely the
  // flag, because a default that flips silently is the whole hazard — and that
  // is as true of flipping ON as of flipping OFF.
  const observeEnabled = opts.observeWorkspace === true;
  let saidUnobserved = false;

  const dispatchObserved = async (
    name: string,
    args: Record<string, unknown>,
    run: () => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    const wantsWindow =
      Boolean(ctx.recordChange) && (opaqueTool(name) || Boolean(opts.hooks?.hasAny));
    if (wantsWindow && !observeEnabled) {
      // ⭐ Told ONCE, at the first opaque call, and never on a read-only run:
      // a user who set the key months ago must still learn that THIS run's
      // shell commands are not undoable. Silence here would ship exactly the
      // "rewind undoes everything" gap the observer exists to close.
      if (!saidUnobserved) {
        saidUnobserved = true;
        emit({
          type: 'hook_notice',
          level: 'warn',
          text: 'workspace observation is off (the default) — changes made by shell commands, MCP tools and hooks are NOT journaled and `spycore rewind` will not restore them; file-tool writes still are. Turn it on with --observe, or `spycore config set agentObserveWorkspace true`',
        });
      }
      return run();
    }
    if (!wantsWindow) return run();
    let before: WorkspaceSnapshot | null = null;
    try {
      before = await snapshotWorkspace(opts.cwd);
    } catch {
      before = null;
    }
    // Paths the tool journals itself inside this window are excluded from the
    // diff, so one change can never be recorded twice — a double record would
    // make `rewind` restore an intermediate state rather than the prior one.
    const selfJournaled = new Set<string>();
    const outer = ctx.recordChange;
    ctx.recordChange = (c) => {
      selfJournaled.add(c.path);
      outer?.(c);
    };
    /**
     * ⭐⭐ F-2c-48 · `C-LC8` — THE APPROVAL PAUSE IS TAKEN OUT OF THE WINDOW.
     *
     * The bracket below spans the pre-tool hook, the dispatch and the post-tool
     * hook, and the dispatch contains an approval prompt whose length is a human
     * decision. Everything that wrote during those seconds was a difference the
     * observer could see and could not attribute, so it was journaled as this
     * call's work — and `spycore rewind` then reverted the user's own edits and
     * deleted the user's own new files, with `planRewind`'s no-clobber guard
     * structurally unable to intervene (the foreign content IS the journal's
     * `after`, so the shas match and the restore proceeds).
     *
     * ⭐ Wrapping `ctx.requestApproval` for the window's lifetime is the same
     * swap-and-restore idiom `ctx.recordChange` uses two lines above, and it is
     * enough BECAUSE F-2c-45 made the approval channel single and unskippable:
     * all three gated sites inside a window — `write_file`/`edit_file`, a command,
     * and every MCP tool — end at `resolveApproval(ctx.requestApproval, …)`. Before
     * that rebuild an `allow` rule skipped the channel entirely, so a barrier
     * installed here would have been void for exactly the users who configured a
     * rule. ⭐ The pre-approval path still returns INSIDE `resolveApproval` without
     * reaching the resolver, which is correct: there is no human pause to remove.
     *
     * ⭐ The pause is FOLDED INTO THE BASELINE rather than excluded — see
     * `closePause`. Attribution stays complete in both directions: the command's
     * own write to a file the user also touched is journaled with the USER's
     * content as `before`, which is what `rewind` should restore.
     */
    const baseline = before;
    const outerApproval = ctx.requestApproval;
    if (outerApproval) {
      ctx.requestApproval = async (req) => {
        if (baseline === null) return outerApproval(req);
        let census: PauseCensus | null = null;
        try {
          census = await openPause(baseline);
        } catch {
          census = null;
        }
        try {
          return await outerApproval(req);
        } finally {
          if (census !== null) {
            try {
              const notice = pauseNotice(await closePause(baseline, census));
              if (notice) emit({ type: 'hook_notice', level: 'info', text: notice });
            } catch {
              /* observation must never break the run — the decision is already made */
            }
          }
        }
      };
    }
    let res: ToolResult;
    try {
      res = await run();
    } finally {
      ctx.recordChange = outer;
      ctx.requestApproval = outerApproval;
    }
    if (before === null) {
      // ⭐ A workspace we could not observe is REPORTED, never silent. This is
      // the branch that keeps the shipped sentence honest when the caps bite.
      if (opaqueTool(name)) {
        emit({
          type: 'hook_notice',
          level: 'warn',
          text: `workspace too large to journal — changes made by "${name}" are NOT undoable with \`spycore rewind\``,
        });
      }
      return res;
    }
    try {
      const delta = await diffWorkspace(before, selfJournaled);
      recordDelta(delta.changes);
      const notice = uncapturedNotice(delta.uncaptured);
      if (notice) emit({ type: 'hook_notice', level: 'warn', text: notice });
    } catch {
      /* observation must never break the run — the tool already succeeded */
    }
    return res;
  };

  const dispatchHooked = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const hooks = opts.hooks;
    if (!hooks?.hasAny) return dispatchTool(name, args, ctx);
    try {
      const pre = await hooks.preTool(name, args);
      for (const n of pre.notices) emit({ type: 'hook_notice', level: 'warn', text: n });
      if (pre.blocked) {
        return {
          ok: false,
          summary: 'blocked by a user hook',
          content: `Error: this tool call was blocked by a user pre-tool hook${pre.reason ? ` — ${pre.reason}` : ''}. Do not retry the same call; adjust your approach or finish without it.`,
        };
      }
    } catch {
      /* the hook layer can never break the run */
    }
    const res = await dispatchTool(name, args, ctx);
    try {
      const post = await hooks.postTool(name, res.ok, res.summary);
      for (const n of post.notices) emit({ type: 'hook_notice', level: 'info', text: n });
      if (post.feedback) {
        // Appended AFTER dispatch's capContent. Safe by arithmetic, not luck:
        // `MAX_RESULT_CHARS` already reserved HOOK_FEEDBACK_APPEND_MAX_CHARS
        // (this `\n\n` + the widest possible block), so the sum still fits the
        // server's 32,000-char wire cap — and the cap can never have cut this
        // block's closing sentinel, because it only ever cuts `res.content`.
        return { ...res, content: `${res.content}\n\n${post.feedback}` };
      }
    } catch {
      /* isolated */
    }
    return res;
  };

  /** The single call the loop uses: observation on the outside, hooks inside. */
  const dispatchWithHooks = async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => dispatchObserved(name, args, () => dispatchHooked(name, args));

  // MCP bridge: spawn + initialize every ENABLED server, register their tools as
  // `mcp__<server>__<tool>` in ctx.extraTools, and surface a catalog for the
  // prompt. Skipped in plan mode (MCP tools are mutating ⇒ blocked there anyway)
  // and a no-op when zero servers are configured — so the prompt stays
  // byte-identical to an MCP-free build. Per-server start failures degrade to a
  // dim warning; the run continues with the built-ins.
  const mcpBridge: McpBridge | null = opts.planMode
    ? null
    : await setupMcpBridge({
        cwd: opts.cwd,
        signal: opts.signal,
        requestApproval: opts.requestApproval,
        callTimeoutMs: opts.commandTimeoutMs,
        onWarn: (text) => emit({ type: 'mcp_notice', level: 'warn', text }),
        ...(opts.confirmProjectMcpTrust ? { confirmProjectMcpTrust: opts.confirmProjectMcpTrust } : {}),
      });
  if (mcpBridge) {
    ctx.extraTools = mcpBridge.tools;
    if (mcpBridge.toolCount > 0) {
      emit({
        type: 'mcp_notice',
        level: 'info',
        text: `${mcpBridge.toolCount} MCP tool${mcpBridge.toolCount === 1 ? '' : 's'} from ${mcpBridge.serverCount} server${mcpBridge.serverCount === 1 ? '' : 's'}`,
      });
    }
  }
  const mcpSection = mcpBridge?.promptSection ?? '';

  // Continue an existing conversation (verify fix-up) or open a fresh one.
  // The provider owns session creation: SpyCore opens a server-side
  // conversation; a BYOK provider mints a local handle for its client-side
  // history. Continuations reuse the same handle (and the same provider
  // instance), so BYOK history survives a verify fix-up.
  const conversationId =
    opts.conversationId ?? (await provider.createConversation({ model, apiUrlOverride }));

  // Tool-call protocol: NATIVE when the SpyCore server advertised it and the
  // user didn't force fenced; FENCED otherwise (old server, BYOK provider, or
  // --tool-protocol fenced). 'native' is a hard requirement — error (after
  // tearing down the bridge) rather than silently degrade. Capability was
  // captured at createConversation; continuations read the same stashed value.
  const toolProtocol = opts.toolProtocol ?? 'auto';
  const serverNativeCapable =
    provider.id === 'spycore' && (provider.supportsNativeTools?.(conversationId) ?? false);
  if (toolProtocol === 'native' && !serverNativeCapable) {
    await mcpBridge?.shutdown();
    throw new SpycoreCliError(
      'Native tool-use is not available for this run.',
      EXIT_USER_ERROR,
      provider.id !== 'spycore'
        ? 'BYOK providers use the fenced protocol — omit --tool-protocol.'
        : 'The server did not advertise native tool-use (older deployment). Omit --tool-protocol, or pass --tool-protocol fenced.',
    );
  }
  const nativeMode = toolProtocol === 'fenced' ? false : serverNativeCapable;
  // Step-boundary hook: report the bound conversation + protocol immediately,
  // then each completed turn (fired at the top of the NEXT turn). Isolated so
  // a hook failure can never break the run.
  const fireRunState = (turnsCompleted: number): void => {
    if (!opts.onRunState) return;
    try {
      opts.onRunState({ conversationId, nativeTools: nativeMode, turnsCompleted });
    } catch {
      /* the hook is best-effort */
    }
  };
  fireRunState(0);
  // Tool declarations for native mode: read-only subset in the plan phase, the
  // full set (built-ins + MCP) in execute. Recomputed per runAgent call, so the
  // plan and execute phases declare their correct sets.
  const toolDecls = nativeMode
    ? buildToolDeclarations({ readOnlyOnly: opts.planMode === true, extraTools: ctx.extraTools, webEnabled })
    : undefined;

  // Persist the change journal once at the run's end (best-effort — a journal
  // write failure must not break the run). When an external recorder is given
  // (the orchestrator accumulates a whole session, including verify fix-ups),
  // the orchestrator owns persistence instead.
  let persisted = false;
  const persist = (): void => {
    if (externalRecorder || persisted || changes.length === 0) return;
    persisted = true;
    saveSession({ cwd: opts.cwd, task: opts.task, changes });
  };
  const result = (over: Partial<AgentResult> & Pick<AgentResult, 'finalText' | 'turns' | 'toolCalls'>): AgentResult => {
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

  // The system prompt travels separately from the first message so providers
  // with a native top-level system slot (Anthropic/Google) can use it. The
  // SpyCore + OpenAI-compatible providers re-join `${system}\n\n${message}`,
  // reproducing the exact bytes this loop used to send as one string. It is
  // passed only on turn 1 of a fresh conversation — continuations already have
  // it (server-side history for SpyCore, adapter session state for BYOK).
  let pending: string;
  let pendingSystem: string | undefined;
  // Image attachments (FILE IDs) ride the FIRST turn of a fresh conversation
  // only — cleared after delivery, exactly like pendingSystem. Continuations
  // (verify fix-ups) never re-send them.
  let pendingAttachments: string[] | undefined;
  // NATIVE mode: the tool results to feed back on a continuation turn (set after
  // a tool round; cleared/overwritten each round). Fenced mode never sets it.
  let pendingToolResults: ToolResultDecl[] | undefined;
  // Empty-completion guard: the backing model occasionally returns a turn with
  // no text AND no tool calls mid-run (observed live in the release bench —
  // the run ended "final" with the task half-done). One nudge retry per run;
  // a second empty turn is accepted as the final answer like before.
  let emptyFinalRetried = false;
  if (opts.conversationId) {
    // Continuing — the system prompt + prior turns are already in this
    // conversation; send just the new instruction (e.g. the verify feedback).
    pending = opts.continueMessage ?? 'Continue the task.';
  } else {
    const systemCore = opts.planMode
      ? nativeMode
        ? NATIVE_PLAN_SYSTEM_PROMPT(opts.cwd, maxTurns, skillsSection)
        : PLAN_SYSTEM_PROMPT(opts.cwd, maxTurns, skillsSection, webEnabled)
      : nativeMode
        ? NATIVE_SYSTEM_PROMPT(opts.cwd, maxTurns, skillsSection, mcpSection)
        : SYSTEM_PROMPT(opts.cwd, maxTurns, skillsSection, mcpSection, webEnabled);
    // First-turn assembly as ORDERED PARTS (1.8): the same strings, joiners
    // and order as the historical concatenation — the part structure only
    // exists so the wire clamp below can cut in priority order.
    //   system prompt (never cut) → project context (the precomputed
    //   <spycode-context> block, APPENDED after the core identity/safety/tool
    //   prompt so it supplements — never overrides — the operating rules) →
    //   TASK → inlined text attachments → plan bits.
    const firstTurnParts: WirePart[] = [
      { body: systemCore, kind: 'fixed', label: 'system prompt' },
    ];
    if (opts.projectContext && opts.projectContext.trim().length > 0) {
      firstTurnParts.push({
        pre: '\n\n',
        body: opts.projectContext,
        kind: 'injection',
        label: 'project context',
      });
    }
    const taskPartIdx = firstTurnParts.length;
    firstTurnParts.push({
      pre: '\n\n',
      body: `TASK: ${opts.task}`,
      kind: 'user',
      label: 'task',
    });
    if (opts.attachedContext && opts.attachedContext.trim().length > 0) {
      firstTurnParts.push({
        pre: '\n\n',
        body: opts.attachedContext,
        kind: 'attachments',
        label: 'attached files',
      });
    }
    if (opts.approvedPlan && opts.approvedPlan.trim().length > 0) {
      firstTurnParts.push({
        pre: '\n\n',
        body: `The user reviewed${opts.planEdited ? ', EDITED,' : ''} and APPROVED this plan — carry it out now:\n${opts.approvedPlan}`,
        kind: 'user',
        label: 'approved plan',
      });
    }
    if (opts.planMode && opts.planFeedback && opts.planFeedback.trim().length > 0) {
      firstTurnParts.push({
        pre: '\n\n',
        body: `The user gave feedback on your previous plan: "${opts.planFeedback}". Revise the plan accordingly.`,
        kind: 'user',
        label: 'plan feedback',
      });
    }
    // 1.8: the single assembly-time clamp, SpyCore wire only — its provider
    // re-joins `${system}\n\n${message}` into ONE message field under the
    // server's hard 32,000-char cap (an oversized project-context block could
    // previously 400 the run at start). Priority task/user content > attached
    // files > project-context tail; every cut leaves an explicit in-band
    // marker + a one-line event — never silent. BYOK providers carry `system`
    // natively with no such wire cap and stay byte-identical.
    let firstTurnTexts = firstTurnParts.map(
      (p) => `${p.pre ?? ''}${p.body}${p.post ?? ''}`,
    );
    if (provider.id === 'spycore') {
      const clamped = clampWireAssembly(firstTurnParts);
      if (clamped.warning) emit({ type: 'context_clamped', text: clamped.warning });
      firstTurnTexts = clamped.texts;
    }
    // Reassemble across the system/message seam: everything before TASK is
    // the system prompt; the rest is the message, minus the leading joiner
    // the SpyCore/OpenAI-compatible providers re-add on re-join (BYOK sends
    // `system` separately — for it the joiner never existed on the wire).
    pendingSystem = firstTurnTexts.slice(0, taskPartIdx).join('');
    pending = firstTurnTexts.slice(taskPartIdx).join('').replace(/^\n\n/, '');
    if (opts.attachments && opts.attachments.length > 0) {
      pendingAttachments = opts.attachments;
    }
  }
  let toolCalls = 0;

  // The turn ceiling. With an explicit --max-turns this is a whole-run budget
  // stop (controlled, exit 0); otherwise it's the built-in iteration guard.
  const finishTurnLimit = (turns: number, finalText: string): AgentResult => {
    if (hasTurnBudget) {
      emitBudgetStop('turns');
      return result({ finalText, turns, toolCalls, budgetStop: 'turns' });
    }
    emit({ type: 'max_turns', turns });
    return result({ finalText, turns, toolCalls, reachedMaxTurns: true });
  };

  // The whole turn loop is wrapped so the MCP bridge is ALWAYS torn down — on a
  // normal finish, a budget/abort early-return, or a thrown provider error. The
  // body keeps its indentation; `finally` runs on every `return` below.
  try {
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    // The previous turn fully completed (streamed + tools dispatched + next
    // input assembled) — a resumable step boundary.
    if (turn > 1) fireRunState(turn - 1);
    if (opts.signal?.aborted) {
      return result({ finalText: '', turns: turn - 1, toolCalls, cancelled: true });
    }

    // Budget gate: stop gracefully BEFORE starting another model round-trip,
    // so a hit cap never interrupts an in-flight edit.
    const preStop = budget?.check();
    if (preStop) {
      emitBudgetStop(preStop);
      return result({ finalText: '', turns: turn - 1, toolCalls, budgetStop: preStop });
    }

    budget?.addTurn();
    let reply: string;
    let replyToolCalls: ProviderToolCallLite[] = [];
    try {
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
      pendingSystem = undefined; // delivered with turn 1; later turns send only the message
      pendingAttachments = undefined; // delivered with turn 1, exactly like the system prompt
      pendingToolResults = undefined; // consumed; the native branch re-sets it per round
      budget?.addTokens(turnRes.inputTokens, turnRes.outputTokens);
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof SpycoreCliError && err.message === 'Cancelled')) {
        return result({ finalText: '', turns: turn - 1, toolCalls, cancelled: true });
      }
      throw err;
    }
    emitBudget();

    // A turn the time budget cut short mid-stream: stop now, discarding the
    // partial reply (we never act on it → no half-applied mutation).
    if (budget?.check() === 'time') {
      emitBudgetStop('time');
      return result({ finalText: '', turns: turn, toolCalls, budgetStop: 'time' });
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
          emit({ type: 'parse_error', turn, message: 'empty reply — nudging once' });
          pending =
            'Your reply was empty. Continue the TASK now: call the next tool, or give your final answer as plain text.';
          pendingToolResults = undefined;
          continue;
        }
        // No tool call → the assistant's text is the final answer.
        emit({ type: 'final', text: narration });
        return result({ finalText: narration, turns: turn, toolCalls });
      }
      if (narration.length > 0) emit({ type: 'narration', turn, text: narration });

      const results: ToolResultDecl[] = [];
      // Parallel calls dispatch SEQUENTIALLY in index order so the approval UX
      // stays one-at-a-time.
      for (let i = 0; i < replyToolCalls.length; i += 1) {
        if (opts.signal?.aborted) {
          return result({ finalText: '', turns: turn, toolCalls, cancelled: true });
        }
        const call = replyToolCalls[i]!;
        toolCalls += 1;
        // Malformed-arguments guard: a non-JSON / non-object args string feeds
        // an error result back to the model instead of crashing the run.
        let args: Record<string, unknown> | null = null;
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
        emit({
          type: 'tool_call',
          turn,
          index: i,
          tool: call.name,
          arg: args ? describeCallArg(call.name, args) : '',
          args: args ?? {},
        });
        const res: ToolResult = argError
          ? {
              ok: false,
              summary: 'invalid arguments',
              content: `Error: ${call.name} ${argError}. Re-issue the call with valid JSON arguments.`,
            }
          : await dispatchWithHooks(call.name, args!);
        emit({
          type: 'tool_result',
          turn,
          index: i,
          tool: call.name,
          ok: res.ok,
          summary: res.summary,
          kind: res.kind,
          added: res.added,
          removed: res.removed,
          isNew: res.isNew,
          command: res.command,
          outputTail: res.outputTail,
        });
        // The server caps EACH toolResults[].content at 32,000 chars. The
        // result budget + hook reserve already guarantee that; this is the
        // defense-in-depth backstop that keeps a future budget regression a
        // truncation instead of a 400. A no-op under DEFAULT_LIMITS.
        results.push({ id: call.id, name: call.name, content: clampToWireMax(res.content) });
      }

      if (turn >= maxTurns) {
        return finishTurnLimit(turn, '');
      }
      // Next turn: feed results back as a tool-result continuation (no message).
      pendingToolResults = results;
      pending = '';
      continue;
    }

    const parsed = parseTurn(reply);

    // No actionable tool call this turn.
    if (parsed.calls.length === 0) {
      const malformed = parsed.errors.length > 0 || parsed.hasUnclosedBlock;
      if (malformed) {
        const detail = parsed.errors[0]?.message ?? 'an incomplete tool block';
        emit({ type: 'parse_error', turn, message: detail });
        if (turn >= maxTurns) {
          return finishTurnLimit(turn, parsed.prose);
        }
        pending = `Your previous message could not be used (${detail}). ${RECOVER_HINT}`;
        continue;
      }
      // Empty-completion guard (see declaration above): nudge once instead
      // of accepting an empty turn as the final answer.
      if (parsed.prose.trim().length === 0 && !emptyFinalRetried && turn < maxTurns) {
        emptyFinalRetried = true;
        emit({ type: 'parse_error', turn, message: 'empty reply — nudging once' });
        pending = `Your reply was empty. Continue the TASK now. ${CONTINUE_HINT}`;
        continue;
      }
      // Genuine final answer.
      emit({ type: 'final', text: parsed.prose });
      return result({ finalText: parsed.prose, turns: turn, toolCalls });
    }

    // Narration that preceded the tool calls (if any).
    if (parsed.prose.length > 0) {
      emit({ type: 'narration', turn, text: parsed.prose });
    }

    const total = parsed.calls.length;
    const feedback: string[] = [];
    for (let i = 0; i < parsed.calls.length; i += 1) {
      if (opts.signal?.aborted) {
        return result({ finalText: '', turns: turn, toolCalls, cancelled: true });
      }
      const call = parsed.calls[i]!;
      toolCalls += 1;
      emit({
        type: 'tool_call',
        turn,
        index: i,
        tool: call.tool,
        arg: describeCallArg(call.tool, call.args),
        args: call.args,
      });
      const res = await dispatchWithHooks(call.tool, call.args);
      emit({
        type: 'tool_result',
        turn,
        index: i,
        tool: call.tool,
        ok: res.ok,
        summary: res.summary,
        kind: res.kind,
        added: res.added,
        removed: res.removed,
        isNew: res.isNew,
        command: res.command,
        outputTail: res.outputTail,
      });
      feedback.push(formatResultForModel(i, total, call.tool, call.args, res.ok, res.summary, res.content));
    }

    if (turn >= maxTurns) {
      return finishTurnLimit(turn, '');
    }

    // The fenced continuation goes out as ONE `message` field — the same field
    // the 1.8 clamp guards on turn 1. Clamp it here too, for EVERY turn.
    const continuation = assembleFencedContinuation(turn, feedback);
    if (continuation.clamped) {
      emit({
        type: 'context_clamped',
        text: `Trimmed the tool results to fit the ${WIRE_MESSAGE_MAX_CHARS.toLocaleString('en-US')}-character message limit. Nothing was dropped silently — each cut is marked in the message.`,
      });
    }
    pending = continuation.message;
  }

  return finishTurnLimit(maxTurns, '');
  } finally {
    if (mcpBridge) await mcpBridge.shutdown();
  }
}
