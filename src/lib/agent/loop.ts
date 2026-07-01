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
import { saveSession, type RecordedChange } from './checkpoint.js';
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
  /** Timeout (ms) for run_command (defaults to 120s). */
  commandTimeoutMs?: number | undefined;
  /** Plan mode: block mutating tools; the final answer is a plan to approve. */
  planMode?: boolean | undefined;
  /**
   * Tool-call wire protocol: 'auto' (default) uses NATIVE function-calling when
   * the SpyCore server advertises it (capabilities.nativeTools) and falls back
   * to FENCED otherwise; 'fenced' forces the text protocol; 'native' requires
   * native support and errors if the server/provider doesn't offer it.
   */
  toolProtocol?: 'auto' | 'native' | 'fenced' | undefined;
  /** Execute phase: the approved plan, injected into the task context. */
  approvedPlan?: string | undefined;
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
  /** Continue this existing conversation instead of opening a new one (verify fix-up). */
  conversationId?: string | undefined;
  /** First message when continuing — e.g. the verify-failure feedback. */
  continueMessage?: string | undefined;
  /** External change recorder; when set, the caller owns checkpoint persistence. */
  recordChange?: ((change: RecordedChange) => void) | undefined;
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
  onEvent?: (event: AgentEvent) => void;
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

const SYSTEM_PROMPT = (cwd: string, maxTurns: number, skillsSection: string, mcpSection: string): string =>
  `You are SpyCode, SpyCore's autonomous coding agent, running in a sandboxed terminal session in this directory:
  ${cwd}

Accomplish the user's TASK: explore the project with the read tools, MODIFY files with write_file / edit_file, and run shell commands with run_command (build, test, lint, git, install, …). When you are done, give a clear final answer. You cannot touch anything outside the working directory.

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
${describeToolsForPrompt()}${skillsSection}${mcpSection}

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
- Sensitive paths (.env, private keys, .git, .ssh, and anything in .spycoreignore) are blocked for BOTH reading and writing.
- Read tools hide .gitignore'd files and node_modules/.git/build/dist.
- You have a budget of ${maxTurns} tool-calling turns — be efficient; prefer repo_map / glob / grep to orient before reading whole files.
- Never reveal internal model identifiers or upstream provider names.`;

const PLAN_SYSTEM_PROMPT = (cwd: string, maxTurns: number, skillsSection: string): string =>
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
${describeToolsForPrompt({ readOnlyOnly: true })}${skillsSection}

# Output the plan
When you understand the task, reply with your FINAL answer (NO tool block): a one-line summary, then a NUMBERED plan listing the files you will create or edit and any commands you will run. Keep it concise. Do NOT begin implementing — the plan is shown to the user for approval first.

# Constraints
- Paths are relative to the working directory; you cannot read outside it.
- Sensitive paths (.env, keys, .git, .ssh, .spycoreignore) and .gitignore'd files are hidden.
- Budget: ${maxTurns} tool-calling turns. Never reveal internal model identifiers or upstream provider names.`;

// NATIVE-mode prompts: identical guidance to the fenced prompts MINUS the
// `spycore:tool` wire mechanics — the tools are declared to the model via the
// provider's native tool-calling, so there is no fenced block to describe. The
// skills catalog + MCP catalog stay (load_skill is just a native tool now).
const NATIVE_SYSTEM_PROMPT = (cwd: string, maxTurns: number, skillsSection: string, mcpSection: string): string =>
  `You are SpyCode, SpyCore's autonomous coding agent, running in a sandboxed terminal session in this directory:
  ${cwd}

Accomplish the user's TASK: explore the project with the read tools, MODIFY files with write_file / edit_file, and run shell commands with run_command (build, test, lint, git, install, …). When you are done, give a clear final answer. You cannot touch anything outside the working directory.

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
- Sensitive paths (.env, private keys, .git, .ssh, and anything in .spycoreignore) are blocked for BOTH reading and writing.
- Read tools hide .gitignore'd files and node_modules/.git/build/dist.
- You have a budget of ${maxTurns} tool-calling turns — be efficient; prefer repo_map / glob / grep to orient before reading whole files.
- Never reveal internal model identifiers or upstream provider names.`;

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
- Budget: ${maxTurns} tool-calling turns. Never reveal internal model identifiers or upstream provider names.`;

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
function formatResultForModel(
  index: number,
  total: number,
  tool: string,
  args: Record<string, unknown>,
  ok: boolean,
  summary: string,
  content: string,
): string {
  const header = `Tool ${index + 1}/${total}: ${tool}(${JSON.stringify(args)}) → ${ok ? 'OK' : 'ERROR'} (${summary})`;
  return `${header}\n${content}`;
}

const CONTINUE_HINT =
  'Continue: call more tools with spycore:tool blocks, or give your final answer as plain text (no fenced block).';
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
  const ctx: ToolContext = {
    cwd: opts.cwd,
    limits: opts.limits ?? DEFAULT_LIMITS,
    signal: opts.signal,
    requestApproval: opts.requestApproval,
    commandTimeoutMs: opts.commandTimeoutMs,
    planMode: opts.planMode,
    skills: skillsByName,
    loadedSkills: opts.loadedSkills ?? new Set<string>(),
    recordChange: (c) => {
      changes.push(c);
      externalRecorder?.(c);
    },
  };

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
  // Tool declarations for native mode: read-only subset in the plan phase, the
  // full set (built-ins + MCP) in execute. Recomputed per runAgent call, so the
  // plan and execute phases declare their correct sets.
  const toolDecls = nativeMode
    ? buildToolDeclarations({ readOnlyOnly: opts.planMode === true, extraTools: ctx.extraTools })
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
    pendingSystem = opts.planMode
      ? nativeMode
        ? NATIVE_PLAN_SYSTEM_PROMPT(opts.cwd, maxTurns, skillsSection)
        : PLAN_SYSTEM_PROMPT(opts.cwd, maxTurns, skillsSection)
      : nativeMode
        ? NATIVE_SYSTEM_PROMPT(opts.cwd, maxTurns, skillsSection, mcpSection)
        : SYSTEM_PROMPT(opts.cwd, maxTurns, skillsSection, mcpSection);
    // Read-at-start project context: APPEND the precomputed <spycode-context>
    // block AFTER the core identity/safety/tool prompt so it supplements — and
    // never overrides — the agent's operating rules. Computed once per task by
    // the orchestrator and identical across the plan + execute phases.
    if (opts.projectContext && opts.projectContext.trim().length > 0) {
      pendingSystem = `${pendingSystem}\n\n${opts.projectContext}`;
    }
    pending = `TASK: ${opts.task}`;
    if (opts.approvedPlan && opts.approvedPlan.trim().length > 0) {
      pending += `\n\nThe user reviewed and APPROVED this plan — carry it out now:\n${opts.approvedPlan}`;
    }
    if (opts.planMode && opts.planFeedback && opts.planFeedback.trim().length > 0) {
      pending += `\n\nThe user gave feedback on your previous plan: "${opts.planFeedback}". Revise the plan accordingly.`;
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
          : await dispatchTool(call.name, args!, ctx);
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
        results.push({ id: call.id, name: call.name, content: res.content });
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
      const res = await dispatchTool(call.tool, call.args, ctx);
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

    pending = `TOOL RESULTS (turn ${turn}):\n\n${feedback.join('\n\n')}\n\n${CONTINUE_HINT}`;
  }

  return finishTurnLimit(maxTurns, '');
  } finally {
    if (mcpBridge) await mcpBridge.shutdown();
  }
}
