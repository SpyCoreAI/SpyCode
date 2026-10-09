/**
 * The agent tool registry and the public face of the tool framework.
 *
 * This module holds what every tool call goes through: the registry
 * (`ALL_TOOLS`, whose order drives the prompt catalogue and the native
 * declarations), argument validation, the dispatch timeout, `dispatchTool`
 * and its result cap, the prompt catalogue, the native tool declarations and
 * the UI label of a call. The rest of the framework lives in three modules:
 *
 *   tool-core.ts       the tool contracts and the sandbox core
 *   builtin-tools.ts   the built-in tools and the shell executor
 *   command-screen.ts  the run_command screener
 *
 * Every name that was public here before those modules existed is
 * re-exported below, so importers are unchanged. The helpers and tool
 * definitions the three modules export for each other are not re-exported.
 *
 * Every FILESYSTEM tool is sandboxed to the agent's working directory - bounded
 * on where a path RESOLVES, so a symlink cannot leave it - and honours secret
 * protection (secrets.ts) for BOTH reads and writes.
 *
 * `run_command` is the stated exception and always has been: it hands a string
 * to a shell, so it is bounded by its cwd, the catastrophic net and the
 * approval gate, NOT by the path sandbox or the secret guard. The header used
 * to say "every tool" without that carve-out, which run_command's own code
 * contradicted (F-2a #30). The agent system prompts in loop.ts made the
 * narrower "sensitive paths are blocked" claim, which IS true of every tool that
 * takes a path - and F-2c-3 scoped it.  Measuring which tools each prompt
 * actually offers split the four: the two that offer run_command now name it as
 * the exception, while the two PLAN prompts were left ALONE because plan mode
 * filters every mutating tool, so run_command is absent and the unqualified
 * claim is true there. The same sentence was false in two prompts and true in
 * two, which reading alone could not have told apart.
 *
 * Read tools also respect `.gitignore` and always skip
 * node_modules/.git/build/dist. Mutating tools
 * never apply blindly - they compute a diff and pause for approval via
 * `ctx.requestApproval`, then write atomically (temp file + rename).
 *
 * Tool output is identity-safe. This module imports nothing lazily itself:
 * `globby`, `diff`, the LSP modules and the API client are loaded lazily where
 * they are used, so merely registering the command (the CLI hot path) never
 * pulls them in.
 */
import { resultTruncMarker } from '../wire-limits.js';
import type { ToolDecl } from '../providers/types.js';
// F1 sub-agent orchestration: the `delegate` tool definition and its name.
// delegate.ts imports only TYPES back from this module, so there is no
// runtime cycle.
import { DELEGATE_TOOL_NAME, delegateTool } from './delegate.js';
import {
  optString,
  ToolError,
  type ToolContext,
  type ToolDefinition,
  type ToolParameters,
  type ToolResult,
} from './tool-core.js';
import {
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  repoMapTool,
  diagnosticsTool,
  loadSkillTool,
  webSearchTool,
  fetchUrlTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
} from './builtin-tools.js';

// ──────────────────── public surface ────────────────────
// The names that moved out of this module, re-exported from their new homes.

// The tool contracts and the sandbox core (tool-core.ts).
export type {
  JsonSchemaType,
  JsonSchemaProperty,
  ToolParameters,
  ToolLimits,
  ToolContext,
  ToolResult,
  ToolDefinition,
} from './tool-core.js';
export { MAX_RESULT_CHARS, DEFAULT_LIMITS, ToolError } from './tool-core.js';

// The built-in tools and the shell executor (builtin-tools.ts).
export type { CommandRun } from './builtin-tools.js';
export {
  WEB_CONTENT_MAX_CHARS,
  wrapUntrustedWebContent,
  DEFAULT_COMMAND_TIMEOUT_MS,
  runShellCommand,
  tailLines,
} from './builtin-tools.js';

// The command screener (command-screen.ts).
export {
  matchesCatastrophic,
  MAX_SCREEN_DEPTH,
  SHELLS,
  COMMAND_CARRIERS,
  SAFE_DEVICES,
  SAFE_DEVICE_ROLES,
  stripExpansions,
  SYSTEM_TREE_SEGMENTS,
  DATA_CONTAINER_SEGMENTS,
  INSTALL_CONTAINER_SEGMENTS,
  DEVICE_WRITE_VERBS,
  INTERPRETERS,
  INTERPRETER_CODE_FLAGS,
} from './command-screen.js';

// ─────────────────────── registry ───────────────────────

const ALL_TOOLS: ToolDefinition[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  repoMapTool,
  diagnosticsTool,
  loadSkillTool,
  webSearchTool,
  fetchUrlTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  // F1: sub-agent orchestration. A static built-in (not an extraTool) so it
  // appears in the prompt catalogue, the native declarations, and dispatch
  // uniformly; depth-gated at dispatch and withheld from the catalogue at the
  // max depth (see delegate.ts).
  delegateTool,
];

/** Filter for the web-tools OFF switch: `webEnabled: false` removes them. */
function selectTools(opts: {
  readOnlyOnly?: boolean;
  webEnabled?: boolean;
  delegateEnabled?: boolean;
}): ToolDefinition[] {
  return ALL_TOOLS.filter((t) => !opts.readOnlyOnly || !t.mutating)
    .filter((t) => opts.webEnabled !== false || !t.web)
    .filter((t) => opts.delegateEnabled !== false || t.name !== DELEGATE_TOOL_NAME);
}

export const REGISTRY: ReadonlyMap<string, ToolDefinition> = new Map(
  ALL_TOOLS.map((t) => [t.name, t]),
);

export function toolNames(): string[] {
  return [...REGISTRY.keys()];
}

/** Validate `args` against a tool's schema. Returns human-readable errors. */
export function validateArgs(params: ToolParameters, args: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const key of params.required ?? []) {
    if (args[key] === undefined || args[key] === null) {
      errors.push(`missing required parameter "${key}"`);
    }
  }
  for (const [key, val] of Object.entries(args)) {
    const prop = params.properties[key];
    if (!prop) {
      errors.push(`unknown parameter "${key}"`);
      continue;
    }
    if (val === undefined || val === null) continue;
    const t = prop.type;
    if (t === 'string' && typeof val !== 'string') errors.push(`"${key}" must be a string`);
    else if (t === 'number' && typeof val !== 'number') errors.push(`"${key}" must be a number`);
    else if (t === 'integer' && (typeof val !== 'number' || !Number.isInteger(val))) {
      errors.push(`"${key}" must be an integer`);
    } else if (t === 'boolean' && typeof val !== 'boolean') errors.push(`"${key}" must be a boolean`);
  }
  return errors;
}

/**
 * CLI-wide bound on one tool dispatch: 10 minutes. Individual tools carry
 * their own timeouts, but the dispatch itself can wedge - a hung child
 * process, a stuck hook, a tool that never settles - and nothing else bounds
 * that. A timeout here is a ToolError, so dispatchTool shapes it into the
 * usual `ok:false` result; it never throws.
 */
export const DEFAULT_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run `work` under the dispatch timeout. While `ctx.isApprovalInFlight`
 * holds, the deadline slides instead of expiring: an open approval prompt
 * means a human is deciding, and that time must not consume the tool's
 * budget. A non-positive budget disables the timeout entirely.
 */
function withDispatchTimeout<T>(ctx: ToolContext, work: () => Promise<T>): Promise<T> {
  const budget = ctx.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  if (!(budget > 0)) return work();
  return new Promise<T>((resolve, reject) => {
    let deadline = Date.now() + budget;
    const timer = setInterval(() => {
      if (ctx.isApprovalInFlight?.()) {
        deadline = Date.now() + budget; // a human is deciding: slide, don't bill
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new ToolError(`tool dispatch timed out after ${Math.round(budget / 1000)}s`));
      }
    }, 1000);
    // The watchdog must not hold the process open on its own.
    timer.unref?.();
    work().then(
      (value) => {
        clearInterval(timer);
        resolve(value);
      },
      (err) => {
        clearInterval(timer);
        reject(err);
      },
    );
  });
}

/**
 * Central dispatch: look up the tool, validate args against its schema, run
 * it, and byte-cap the result. NEVER throws - every failure mode (unknown
 * tool, bad args, execute error) comes back as a structured `ok:false` result
 * the loop can hand to the model for recovery.
 */
export async function dispatchTool(
  name: string,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Per-run dynamic tools (MCP) shadow nothing built-in; they're consulted
  // first so an `mcp__…` id resolves, then the static registry.
  let tool = ctx.extraTools?.get(name) ?? REGISTRY.get(name);
  // Web tools OFF: treat them exactly like unregistered tools (the loop also
  // removed them from the prompt/declarations, so the model never saw them -
  // this guard covers a guessed or replayed call).
  if (tool?.web && ctx.webToolsEnabled === false) tool = undefined;
  if (!tool) {
    const available = [
      ...selectTools({ webEnabled: ctx.webToolsEnabled }).map((t) => t.name),
      ...(ctx.extraTools ? [...ctx.extraTools.keys()] : []),
    ];
    return {
      ok: false,
      summary: `unknown tool`,
      content: `Error: unknown tool "${name}". Available tools: ${available.join(', ')}.`,
    };
  }
  if (ctx.planMode && tool.mutating) {
    return {
      ok: false,
      summary: 'planning mode',
      content: `Error: "${name}" is disabled in planning mode. Investigate with the read-only tools, then output your NUMBERED plan as your final answer (no tool block). Do not write, edit, or run anything yet.`,
    };
  }
  const args: Record<string, unknown> =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  // External tools (MCP) carry arbitrary/nested JSON Schemas validated by the
  // server; the scalar check would wrongly reject them, so skip it for those.
  if (!tool.externalArgs) {
    const errs = validateArgs(tool.parameters, args);
    if (errs.length > 0) {
      return {
        ok: false,
        summary: `invalid arguments`,
        content: `Error: invalid arguments for "${name}": ${errs.join('; ')}.`,
      };
    }
  }
  try {
    // `delegate` is exempt: it is bounded by the shared run budget, and
    // orphaning a running child agent on timeout would be worse than waiting.
    const res =
      tool.name === DELEGATE_TOOL_NAME
        ? await tool.execute(args, ctx)
        : await withDispatchTimeout(ctx, () => tool.execute(args, ctx));
    return capContent(res, ctx.limits.maxResultChars);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surface the real reason (file not found / blocked / …) in the summary
    // for expected ToolErrors so the UI line is informative.
    const summary =
      err instanceof ToolError ? (message.length > 60 ? `${message.slice(0, 60)}…` : message) : 'error';
    return { ok: false, summary, content: `Error: ${message}` };
  }
}

/**
 * Cut a tool result to its char budget. `maxChars` budgets the BODY; the
 * marker rides on top, which is why `MAX_RESULT_CHARS` subtracts
 * `RESULT_TRUNC_MARKER_MAX_CHARS` from the wire cap up front.
 */
function capContent(res: ToolResult, maxChars: number): ToolResult {
  if (res.content.length <= maxChars) return res;
  return {
    ...res,
    content: `${res.content.slice(0, maxChars)}${resultTruncMarker(maxChars)}`,
  };
}

/** Render the tool catalogue for the system prompt (optionally read-only only;
 * `webEnabled: false` removes the web tools entirely; `delegateEnabled: false`
 * withholds the `delegate` tool - used for runs already at the max delegation
 * depth, where dispatch would refuse it anyway). */
export function describeToolsForPrompt(
  opts: { readOnlyOnly?: boolean; webEnabled?: boolean; delegateEnabled?: boolean } = {},
): string {
  const tools = selectTools(opts);
  return tools.map((t) => {
    const params = Object.entries(t.parameters.properties).map(([k, p]) => {
      const required = (t.parameters.required ?? []).includes(k);
      return `${k}${required ? '' : '?'}: ${p.type}`;
    });
    const sig = `${t.name}(${params.join(', ')})`;
    return `- ${sig}\n    ${t.description}`;
  }).join('\n');
}

/** Server cap on a native tool description; we stay just under it. */
const TOOL_DESCRIPTION_CAP = 1000;
/** Server-accepted tool-name charset (mirrors /api/chat/stream validation). */
const NATIVE_TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Convert a built-in tool's scalar `ToolParameters` to a JSON Schema object. */
function parametersToJsonSchema(p: ToolParameters): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(p.properties)) {
    properties[key] = { type: prop.type, description: prop.description };
  }
  const required = p.required ?? [];
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function toToolDecl(t: ToolDefinition): ToolDecl {
  const description =
    t.description.length > TOOL_DESCRIPTION_CAP
      ? `${t.description.slice(0, TOOL_DESCRIPTION_CAP - 1)}…`
      : t.description;
  // MCP wrappers carry the server's real JSON Schema; built-ins derive theirs.
  const parameters = t.jsonSchema ?? parametersToJsonSchema(t.parameters);
  return { name: t.name, description, parameters };
}

/**
 * Build native tool declarations from the registry: the built-ins (read-only +
 * mutating + load_skill) plus any per-run `extraTools` (MCP). In `readOnlyOnly`
 * mode (plan phase) the mutating built-ins and all MCP tools are excluded - the
 * same `!mutating` predicate `describeToolsForPrompt` uses, so the model is
 * offered exactly what it could call. A name that can't satisfy the server's
 * charset is dropped (it would 400 the whole request) rather than sent.
 */
export function buildToolDeclarations(opts: {
  readOnlyOnly?: boolean;
  extraTools?: ReadonlyMap<string, ToolDefinition> | undefined;
  webEnabled?: boolean;
  /** False withholds `delegate` - the max-depth run's catalogue omits it. */
  delegateEnabled?: boolean;
} = {}): ToolDecl[] {
  const out: ToolDecl[] = [];
  const builtins = selectTools(opts);
  for (const t of builtins) out.push(toToolDecl(t));
  if (opts.extraTools) {
    for (const t of opts.extraTools.values()) {
      if (opts.readOnlyOnly && t.mutating) continue; // MCP are all mutating
      out.push(toToolDecl(t));
    }
  }
  return out.filter((d) => NATIVE_TOOL_NAME_RE.test(d.name));
}

/** A short, identity-safe label of a call's primary argument, for the UI. */
export function describeCallArg(tool: string, args: Record<string, unknown>): string {
  if (
    tool === 'read_file' ||
    tool === 'list_dir' ||
    tool === 'write_file' ||
    tool === 'edit_file'
  ) {
    return optString(args, 'path') ?? (tool === 'list_dir' ? '.' : '');
  }
  if (tool === 'glob') return optString(args, 'pattern') ?? '';
  if (tool === 'load_skill') return optString(args, 'name') ?? '';
  if (tool === 'web_search') {
    const q = optString(args, 'query') ?? '';
    return `"${q.length > 80 ? `${q.slice(0, 80)}…` : q}"`;
  }
  if (tool === 'fetch_url') {
    const u = optString(args, 'url') ?? '';
    return u.length > 80 ? `${u.slice(0, 80)}…` : u;
  }
  if (tool === 'grep') {
    const pat = optString(args, 'pattern') ?? '';
    const scope = optString(args, 'glob') ?? optString(args, 'path');
    return scope ? `"${pat}" in ${scope}` : `"${pat}"`;
  }
  if (tool === 'run_command') {
    const cmd = optString(args, 'command') ?? '';
    return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
  }
  if (tool === DELEGATE_TOOL_NAME) {
    const t = optString(args, 'task') ?? '';
    return t.length > 80 ? `${t.slice(0, 80)}…` : t;
  }
  // MCP tools (`mcp__server__tool`): show a compact one-line view of the args.
  if (tool.startsWith('mcp__')) {
    const json = Object.keys(args).length > 0 ? JSON.stringify(args) : '';
    return json.length > 80 ? `${json.slice(0, 80)}…` : json;
  }
  return '';
}
