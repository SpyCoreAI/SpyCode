/**
 * The tool contracts and the sandbox core shared by every agent tool: the
 * JSON-schema and tool types, the result budget, the limits, `ToolContext`,
 * the one `ToolError` class that dispatch recognises, path containment,
 * binary sniffing, the per-run secret and gitignore guards, and the argument
 * accessors.
 *
 * tools.ts re-exports every name that was public before this module existed,
 * so its public surface is unchanged. The helpers exported here for the tool
 * implementations are not re-exported.
 *
 * A leaf module among the agent tools: its runtime imports are node:path, the
 * secret guard, path containment, the wire limits and the hook budget. Every
 * other import is type-only. `globby` is imported lazily, so the CLI hot
 * path never pulls it in.
 */
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { loadSecretGuard, type SecretGuard } from './secrets.js';
import { isInsideReal, realRoot } from '../path-containment.js';
import { RESULT_TRUNC_MARKER_MAX_CHARS, WIRE_MESSAGE_MAX_CHARS } from '../wire-limits.js';
import { HOOK_FEEDBACK_APPEND_MAX_CHARS } from '../hooks.js';
import type { RequestApproval, ToolResultKind } from './approval.js';
import type { RecordedChange } from './checkpoint.js';
import type { DiscoveredSkill } from './skills.js';
import type { Delegator } from './delegate.js';
import type { CommandRule, EffectiveCommandRules } from './command-rules.js';

// ───────────────────────── types ─────────────────────────

/** Scalar JSON-schema types our tool args use (no nested objects/arrays). */
export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean';

export interface JsonSchemaProperty {
  type: JsonSchemaType;
  description: string;
}

/** A minimal, typed JSON-schema for a tool's parameters. */
export interface ToolParameters {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * The budget for ONE tool result's content, DERIVED from the server's wire cap
 * (FIX BATCH 2 / B2 - it used to be an independent `32 * 1024`, which put a
 * capped result at 32,799 chars and 400'd every continuation turn).
 *
 * Arithmetic - the whole point is that this adds up by construction:
 *
 * MAX_RESULT_CHARS                    27,704   (this constant)
 * + resultTruncMarker(…).length       ≤     40   (capContent rides on top)
 * + HOOK_FEEDBACK_APPEND_MAX_CHARS         4,256 (loop.ts appends AFTER the cap)
 * ───────────────────────────────────────────────
 * = WIRE_MESSAGE_MAX_CHARS                32,000 ✔ exactly the server's cap
 *
 * Reserving the hook append here (rather than re-capping after it) is what
 * keeps every wrapped block's CLOSING SENTINEL intact: the cap can only cut
 * the tool result's own tail, never the block appended behind it.
 */
export const MAX_RESULT_CHARS =
  WIRE_MESSAGE_MAX_CHARS - RESULT_TRUNC_MARKER_MAX_CHARS - HOOK_FEEDBACK_APPEND_MAX_CHARS;

/** Limits that bound every tool's work + output. */
export interface ToolLimits {
  /** Hard ceiling on a single file's size for read_file (bytes). */
  maxFileBytes: number;
  /** Cap on the content string fed back to the model, in CHARS (`.length`) -
   * the unit the server's `z.string().max()` measures. */
  maxResultChars: number;
  /** Cap on grep matches surfaced. */
  maxMatches: number;
  /** Cap on list_dir / glob entries surfaced. */
  maxEntries: number;
}

export const DEFAULT_LIMITS: ToolLimits = {
  maxFileBytes: 5 * 1024 * 1024,
  maxResultChars: MAX_RESULT_CHARS,
  maxMatches: 200,
  maxEntries: 500,
};

/** Shared execution context handed to every tool. */
export interface ToolContext {
  /** Absolute working directory - the sandbox root. */
  cwd: string;
  limits: ToolLimits;
  signal?: AbortSignal | undefined;
  /** Pause-for-approval hook used by mutating tools + run_command. */
  requestApproval?: RequestApproval | undefined;
  /** Timeout (ms) for run_command; defaults to 120s when unset. */
  commandTimeoutMs?: number | undefined;
  /**
   * CLI-wide timeout (ms) for one dispatchTool call; defaults to
   * DEFAULT_DISPATCH_TIMEOUT_MS when unset. Individual tools have their own
   * timeouts, but the dispatch itself can wedge (a hung child, a stuck
   * hook) - this bounds the whole call. 0 or negative disables.
   */
  dispatchTimeoutMs?: number | undefined;
  /**
   * True while an approval prompt is open. The dispatch deadline slides
   * instead of expiring while this holds, so human decision time is never
   * billed against the tool's budget. Wired by the loop.
   */
  isApprovalInFlight?: (() => boolean) | undefined;
  /** Plan mode: when true, mutating tools are blocked at dispatch. */
  planMode?: boolean | undefined;
  /** Called after a file mutation is successfully applied (checkpoint journal). */
  recordChange?: ((change: RecordedChange) => void) | undefined;
  /**
   * Installed skills, keyed by exact name (discovered by the loop). load_skill
   * resolves ONLY through this map - a skill name is a lookup key, never a
   * filesystem path.
   */
  skills?: ReadonlyMap<string, DiscoveredSkill> | undefined;
  /** Names already loaded this session - repeats return a short notice instead of the full body. */
  loadedSkills?: Set<string> | undefined;
  /**
   * Per-run dynamic tools layered OVER the static REGISTRY - today this is the
   * MCP bridge's `mcp__<server>__<tool>` wrappers. Dispatch consults these
   * first, so the static registry (and its tests) stay untouched while external
   * tools become callable for the lifetime of one run. Empty/undefined ⇒ exactly
   * the built-in behaviour.
   */
  extraTools?: ReadonlyMap<string, ToolDefinition> | undefined;
  /**
   * Web tools (web_search / fetch_url) enablement. `false` ⇒ dispatch treats
   * them as unknown tools (defence in depth - the loop also removes them from
   * the prompt/declarations, so the model never sees them). Unset/true ⇒ on.
   */
  webToolsEnabled?: boolean | undefined;
  /** `--api-url` override, threaded so the web tools hit the run's server. */
  apiUrlOverride?: string | undefined;
  /**
   * PHASE-1 1.10: resolved command allow/deny rules for run_command. Absent ⇒
   * the rule-decision block is skipped entirely and the approval flow is
   * byte-identical to a rule-free build.
   */
  commandRules?: EffectiveCommandRules | undefined;
  /**
   * PHASE-1 1.10: notice sink for rule decisions, wired by the loop to a
   * visible rule_notice event - an allowlist auto-approval is never silent.
   */
  onCommandRuleNotice?:
    | ((notice: { kind: 'auto_approve' | 'deny'; rule: CommandRule; command: string }) => void)
    | undefined;
  /**
   * F1 sub-agent orchestration: the loop's back-end for the `delegate` tool,
   * installed on every run's context (depth 0 at the top level; depth+1 for
   * each nested run). The tool executes through this - depth/model/budget
   * handling lives in loop.ts, so the tool itself stays provider-agnostic.
   * Absent only when tools are dispatched without a loop (unit tests).
   */
  delegator?: Delegator | undefined;
  /**
   * H-10 - delegation role of this run: 'orchestrator' (the top-level run)
   * or 'leaf' (a sub-agent spawned through `delegate`). Leaf runs are
   * withheld the recursive/dangerous tools (`delegate` itself, durable
   * memory writes) - stricter than the MAX_DELEGATE_DEPTH gate alone.
   * Unset ⇒ treated as 'orchestrator' (unit tests dispatching without a loop).
   */
  role?: 'orchestrator' | 'leaf' | undefined;
  /**
   * H-5 - toolsets disabled for this run (the per-surface gate, e.g. from
   * `toolsetsDisabled.<surface>`). Dispatch treats their tools as unknown;
   * the loop also withholds them from the prompt catalogue and the native
   * declarations, so the model never sees them.
   */
  disabledToolsets?: string[] | undefined;
  /**
   * Per-run memo for the expensive guards. The secret guard and the
   * gitignore predicate are built once per run (not once per tool call)
   * and cached here; the run's ToolContext is discarded with the run, so
   * nothing leaks across runs. Populated lazily by the accessors below -
   * callers never set it directly.
   */
  guardMemo?:
    | {
        secretGuard?: SecretGuard | undefined;
        gitignoreCheck?: ((abs: string) => boolean) | undefined;
      }
    | undefined;
}

export interface ToolResult {
  ok: boolean;
  /** One-line, identity-safe summary for the UI, e.g. `142 lines`. */
  summary: string;
  /** Full (already byte-capped) content to feed back to the model. */
  content: string;
  /** Set by mutating tools / run_command so the UI can pick the right glyph. */
  kind?: ToolResultKind;
  added?: number;
  removed?: number;
  isNew?: boolean;
  /** run_command: the command, its exit status, and a capped output tail. */
  command?: string;
  exitCode?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  outputTail?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameters;
  /** True for tools that change the workspace - blocked during plan mode. */
  mutating?: boolean;
  /**
   * True for the SpyCore web tools (web_search / fetch_url). Read-only -
   * allowed in plan mode, no per-call approval - but excluded EVERYWHERE
   * (prompt catalogue, native declarations, dispatch) when web tools are
   * disabled via `--no-web` / `agentWebTools=false`.
   */
  web?: boolean;
  /**
   * Skip dispatch's scalar-schema validation and hand `execute` the raw args
   * object. Set by external tools (MCP) whose JSON Schema is arbitrary/nested
   * and is validated by the server itself; `parameters` is then prompt-display
   * only. Built-in tools leave this unset and get the strict scalar check.
   */
  externalArgs?: boolean;
  /**
   * The FULL JSON Schema for native tool declarations. Set by MCP wrappers
   * (the server's real inputSchema, which the scalar `parameters` can't
   * express). Built-in tools omit it - their schema is derived from
   * `parameters` by `buildToolDeclarations`.
   */
  jsonSchema?: Record<string, unknown>;
  /** Receives args that already passed schema validation (unless externalArgs). */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

// ─────────────────────── self-registration ───────────────────────
// H-6: each tool definition registers itself on import - `builtin-tools.ts`
// registers every tool it defines, `delegate.ts` registers `delegate`. The
// registry in tools.ts is DERIVED from these calls, so no manual list can
// drift out of sync with the tool files. Registration order is the catalogue
// order (import order: built-ins first, `delegate` last); a duplicate name is
// a hard error, not a silent shadow.

const TOOL_REGISTRY: ToolDefinition[] = [];

/** Register one tool definition at module scope; called by each tool file on import. */
export function registerTool(def: ToolDefinition): void {
  if (TOOL_REGISTRY.some((t) => t.name === def.name)) {
    throw new Error(`duplicate tool registration: "${def.name}"`);
  }
  TOOL_REGISTRY.push(def);
}

/** The registered tools in registration (catalogue) order. */
export function registeredTools(): ToolDefinition[] {
  return [...TOOL_REGISTRY];
}

/** Expected failure (bad path, missing file, binary, …). Caught by dispatch. */
export class ToolError extends Error {}

// ─────────────────────── sandbox core ───────────────────────

/** Directory names that are ALWAYS excluded, regardless of .gitignore. */
export const ALWAYS_IGNORE_NAMES = new Set(['node_modules', '.git', 'build', 'dist']);
/**
 * R1-7 - a literal segment as a case-insensitive micromatch class: `build`
 * becomes `[bB][uU][iI][lL][dD]`, so the pattern matches `BUILD`, `Build`
 * and every other casing. The class is baked into the PATTERN, not applied
 * at the call site, so every consumer of this constant inherits it - a
 * `caseSensitiveMatch: false` option would only fix the call sites that
 * remember to pass it, and would also change how the user's own pattern
 * matches. Non-letters (`_`, `.`) pass through unchanged.
 */
function ciSegment(seg: string): string {
  return [...seg].map((c) => {
    const lo = c.toLowerCase();
    const hi = c.toUpperCase();
    return lo === hi ? c : `[${lo}${hi}]`;
  }).join('');
}
/** Glob ignore patterns mirroring ALWAYS_IGNORE_NAMES (for globby calls). */
export const ALWAYS_IGNORE_GLOBS = [...ALWAYS_IGNORE_NAMES].flatMap((d) => [
  `**/${ciSegment(d)}`,
  `**/${ciSegment(d)}/**`,
]);

/** Convert a path to forward-slash form for glob patterns / display. */
export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

/**
 * Resolve `p` strictly inside `cwd`. Rejects absolute paths outside cwd and
 * any `..` traversal. Returns the resolved absolute path (cwd itself allowed).
 */
function resolveInside(cwd: string, p: string): string {
  if (typeof p !== 'string' || p.trim().length === 0) {
    throw new ToolError('path must be a non-empty string');
  }
  const resolved = isAbsolute(p) ? resolvePath(p) : resolvePath(cwd, p);
  const rel = relative(cwd, resolved);
  if (rel === '') return resolved; // the cwd itself
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new ToolError(`path escapes the working directory: ${p}`);
  }
  return resolved;
}

/**
 * Bound symlinks: the realpath of the target - or of its nearest existing
 * ancestor when the target doesn't exist - must stay inside realpath(cwd).
 * Defeats a symlink inside cwd that points outside it.
 */
export function assertNoSymlinkEscape(cwd: string, resolved: string): void {
  if (!realPathInsideCwd(realRoot(cwd), resolved)) {
    throw new ToolError('path escapes the working directory via a symlink');
  }
}

/**
 * THE symlink bound: the realpath of `resolved` - or of its nearest existing
 * ancestor - must stay inside `realCwd`. Extracted so the path tools and the
 * ENUMERATION tools share one rule instead of two: two mechanisms guarding one
 * property is a bypass surface by construction, and this one had a measured
 * bypass (glob/grep/repo_map used a lexical check and returned file CONTENTS
 * from outside the workspace).
 *
 * Unresolvable ⇒ `true`, which is not a permission: it means "no extra
 * information", exactly as the previous assert returned without throwing, so
 * the lexical containment still governs and nothing is loosened.
 *
 * The walk itself now lives in `lib/path-containment.ts`. It was implemented
 * here AND in `secrets.ts` - the "one mechanism" this comment claims was true
 * within this file and false across the package, while two further boundaries
 * (`memory.ts`, `checkpoint.ts`) reasoned lexically with no realpath at all.
 * This is a thin alias so every caller in this file reads unchanged.
 */
function realPathInsideCwd(realCwd: string, resolved: string): boolean {
  return isInsideReal(realCwd, resolved);
}

/** Full sandbox check: lexical confinement + symlink bounding. */
export function safeResolve(ctx: ToolContext, p: string): string {
  const resolved = resolveInside(ctx.cwd, p);
  assertNoSymlinkEscape(ctx.cwd, resolved);
  return resolved;
}

/**
 * Reject a glob pattern that could read OUTSIDE the sandbox. `globby` resolves
 * patterns relative to `cwd`, so `../**` or `/etc/**` would enumerate - and via
 * grep, read - sibling/parent files. This is the read-side counterpart to the
 * `resolveInside` containment the path args already get. We reject absolute
 * patterns and any `..` path segment up front (a clear error the model can act
 * on); `makeContainmentFilter` then post-filters matches as the hard guarantee,
 * on where each result RESOLVES - this front check sees only the pattern text,
 * so it can never bound a symlink.
 */
/**
 * Does any brace-expansion of `pattern` contain a `..` path segment?
 * globby expands `{a,b}` AFTER this check runs, so a purely lexical
 * segment test misses `{../secret,foo}` (its `/`-separated segments are
 * `{..` and `secret,foo}`). The check is done per alternative instead:
 * find the first top-level `{…}` group, split it on top-level commas, and
 * recurse on `prefix + alternative + suffix` for each one. A group with
 * no top-level comma is a range (`{1..3}`) or a literal - neither can
 * introduce a `..` segment, so it is checked as written. Nested groups
 * recurse naturally; backslash-escaped braces are skipped.
 */
function globExpansionEscapes(pattern: string): boolean {
  let depth = 0;
  let groupStart = -1;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      i += 1; // escaped character - never a brace
      continue;
    }
    if (ch === '{') {
      if (depth === 0) groupStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && groupStart !== -1) {
        const prefix = pattern.slice(0, groupStart);
        const suffix = pattern.slice(i + 1);
        const content = pattern.slice(groupStart + 1, i);
        const alternatives = splitTopLevelCommas(content);
        if (alternatives.length <= 1) {
          // No comma: a range or a literal - the group expands to itself,
          // so it can never introduce a `..` segment. Replace it with a
          // placeholder and keep scanning: a LATER group may still expand
          // to an escape (`{1..3}/{../x,y}`).
          return globExpansionEscapes(`${prefix}\u0001${suffix}`);
        }
        return alternatives.some((alt) => globExpansionEscapes(prefix + alt + suffix));
      }
      if (depth < 0) depth = 0; // unbalanced `}` - treat as literal
    }
  }
  return pattern.split(/[\\/]/).some((seg) => seg === '..');
}

/** Split on commas that are not nested inside a deeper `{…}` group. */
function splitTopLevelCommas(content: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i]!;
    if (ch === '\\') {
      cur += ch;
      if (i + 1 < content.length) cur += content[i + 1]!;
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export function assertContainedGlob(pattern: string): void {
  // A leading '!' is globby's negation marker - inspect the path portion only.
  const p = pattern.startsWith('!') ? pattern.slice(1) : pattern;
  if (isAbsolute(p) || p.startsWith('/')) {
    throw new ToolError(`glob pattern escapes the working directory: ${pattern}`);
  }
  if (globExpansionEscapes(p)) {
    throw new ToolError(`glob pattern escapes the working directory: ${pattern}`);
  }
}

/**
 * Build the read-side confinement filter for one enumeration call: a globby
 * result (a path relative to `cwd`) stays inside the workspace only if it is
 * BOTH lexically contained AND resolves inside `realpath(cwd)`.
 *
 * THE SECOND HALF IS THE FIX. This was lexical only, and its own comment
 * claimed "a crafted pattern can never surface a file outside the workspace" -
 * true for crafted patterns, FALSE for symlinks, and it was the sentence that
 * stopped the next reader looking. globby follows symbolic links by default
 * (fast-glob `followSymbolicLinks: true`), so a symlinked directory inside cwd
 * yields a result that is lexically inside while its target is outside; grep
 * then read and surfaced those files' CONTENTS.
 *
 * The strict rule is the same `realPathInsideCwd` the path tools use, so there
 * is now ONE mechanism rather than two. `realpath(cwd)` is resolved once per
 * call rather than per result - measured at ~12 us per file, against a grep
 * loop that already stats and reads every file it considers.
 *
 * NOT `followSymbolicLinks: false`: that would also drop legitimate symlinked
 * files INSIDE the workspace (with `onlyFiles` they stop being files at all),
 * breaking exactly what the defence exists to protect. The bound belongs on
 * where a path RESOLVES, not on whether links are traversed.
 */
export function makeContainmentFilter(cwd: string): (relResult: string) => boolean {
  const realCwd = realRoot(cwd);
  return (relResult: string): boolean => {
    const resolved = resolvePath(cwd, relResult);
    const rel = relative(cwd, resolved);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return false;
    return realPathInsideCwd(realCwd, resolved);
  };
}

/**
 * True for UTF-16 text: a BOM, or NULs on one parity with text bytes on the
 * other across most of the sample. UTF-16LE writes `a\0b\0…` - the NUL in
 * every second byte made the old check call it binary, so read_file /
 * edit_file / write_file rejected UTF-16 files outright. The bar is high
 * (≥80% of byte pairs fit the pattern, ≥4 pairs) so real binary - whose NULs
 * sit next to non-text bytes - still reads as binary. Non-ASCII UTF-16
 * (CJK, emoji) has non-zero high bytes and only matches via the BOM; that
 * is the documented limit of the heuristic, not a second binary rule.
 */
function looksUtf16Text(buf: Buffer, len: number): boolean {
  const pairs = Math.floor(len / 2);
  if (pairs < 4) return false;
  const isTextByte = (b: number): boolean =>
    b === 9 || b === 10 || b === 11 || b === 12 || b === 13 || (b >= 32 && b <= 126) || b >= 128;
  let le = 0;
  let be = 0;
  for (let i = 0; i < pairs; i += 1) {
    const lo = buf[i * 2] as number;
    const hi = buf[i * 2 + 1] as number;
    if (hi === 0 && isTextByte(lo)) le += 1;
    if (lo === 0 && isTextByte(hi)) be += 1;
  }
  return Math.max(le, be) / pairs >= 0.8;
}

/** True for content that is almost certainly not text (NUL or many controls). */
export function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  if (len === 0) return false;
  // UTF-16 first: its NULs are text, not binary evidence.
  if (len >= 2) {
    const b0 = buf[0] as number;
    const b1 = buf[1] as number;
    if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff)) return false;
  }
  if (looksUtf16Text(buf, len)) return false;
  let suspicious = 0;
  for (let i = 0; i < len; i += 1) {
    const b = buf[i] as number;
    if (b === 0) return true; // NUL ⇒ binary
    // Control chars excluding \t(9) \n(10) \v(11) \f(12) \r(13).
    if (b < 9 || (b > 13 && b < 32)) suspicious += 1;
  }
  return suspicious / len > 0.3;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Memoized secret guard: built once per run, not once per tool call. */
export async function secretGuardFor(ctx: ToolContext): Promise<SecretGuard> {
  let g = ctx.guardMemo?.secretGuard;
  if (!g) {
    g = await loadSecretGuard(ctx.cwd);
    (ctx.guardMemo ??= {}).secretGuard = g;
  }
  return g;
}

/**
 * Memoized gitignore predicate: globby's isGitIgnoredSync({cwd}) rebuilds
 * the ignore matcher on every call, so the predicate is built once per run.
 * A `.gitignore` edit mid-run takes effect on the next run.
 */
export async function gitignoreCheckFor(ctx: ToolContext): Promise<(abs: string) => boolean> {
  let check = ctx.guardMemo?.gitignoreCheck;
  if (!check) {
    const { isGitIgnoredSync } = await import('globby');
    // followSymbolicLinks: false - same hazard as repo-map.ts: globby's
    // `**/.gitignore` scan follows symlinks by default with no cycle
    // protection, so a symlink escaping the tree makes the predicate build
    // descend forever and OOM the agent. Consumers never follow symlinked
    // directories, so a .gitignore inside one is unreachable anyway.
    const ignored = isGitIgnoredSync({ cwd: ctx.cwd, followSymbolicLinks: false });
    check = (abs: string): boolean => ignored(abs);
    (ctx.guardMemo ??= {}).gitignoreCheck = check;
  }
  return check;
}

/** A path is "ignored" if any segment is an excluded dir or git ignores it. */
export async function isIgnoredPath(ctx: ToolContext, abs: string): Promise<boolean> {
  const rel = relative(ctx.cwd, abs);
  if (rel.split(/[\\/]/).some((seg) => ALWAYS_IGNORE_NAMES.has(seg.toLowerCase()))) return true;
  return (await gitignoreCheckFor(ctx))(abs);
}

// ─────────────────────── arg accessors ───────────────────────
// Dispatch validates types against the schema before execute() runs, so these
// narrowing reads are safe.

export function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new ToolError(`"${key}" is required`);
  return v;
}
export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}
export function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}
