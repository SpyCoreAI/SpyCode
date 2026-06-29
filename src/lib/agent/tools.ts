/**
 * Tool framework for the SpyCode agent: the read-only tools plus the mutating
 * write_file / edit_file tools.
 *
 * Every tool is sandboxed to the agent's working directory and honours secret
 * protection (secrets.ts) for BOTH reads and writes. Read tools also respect
 * `.gitignore` and always skip node_modules/.git/build/dist. Mutating tools
 * never apply blindly — they compute a diff and pause for approval via
 * `ctx.requestApproval`, then write atomically (temp file + rename).
 *
 * Tool output is identity-safe. `globby` and `diff` are imported lazily so
 * merely registering the command (the CLI hot path) never pulls them in.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { spawn } from 'node:child_process';
import { loadSecretGuard } from './secrets.js';
import { computeFileDiff } from './diff.js';
import { parseSkillFile, type DiscoveredSkill } from './skills.js';
import type { ApprovalRequest, RequestApproval, ToolResultKind } from './approval.js';
import type { RecordedChange } from './checkpoint.js';
import type { ToolDecl } from '../providers/types.js';

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

/** Limits that bound every tool's work + output. */
export interface ToolLimits {
  /** Hard ceiling on a single file's size for read_file (bytes). */
  maxFileBytes: number;
  /** Cap on the content string fed back to the model (bytes). */
  maxResultBytes: number;
  /** Cap on grep matches surfaced. */
  maxMatches: number;
  /** Cap on list_dir / glob entries surfaced. */
  maxEntries: number;
}

export const DEFAULT_LIMITS: ToolLimits = {
  maxFileBytes: 5 * 1024 * 1024,
  maxResultBytes: 32 * 1024,
  maxMatches: 200,
  maxEntries: 500,
};

/** Shared execution context handed to every tool. */
export interface ToolContext {
  /** Absolute working directory — the sandbox root. */
  cwd: string;
  limits: ToolLimits;
  signal?: AbortSignal | undefined;
  /** Pause-for-approval hook used by mutating tools + run_command. */
  requestApproval?: RequestApproval | undefined;
  /** Timeout (ms) for run_command; defaults to 120s when unset. */
  commandTimeoutMs?: number | undefined;
  /** Plan mode: when true, mutating tools are blocked at dispatch. */
  planMode?: boolean | undefined;
  /** Called after a file mutation is successfully applied (checkpoint journal). */
  recordChange?: ((change: RecordedChange) => void) | undefined;
  /**
   * Installed skills, keyed by exact name (discovered by the loop). load_skill
   * resolves ONLY through this map — a skill name is a lookup key, never a
   * filesystem path.
   */
  skills?: ReadonlyMap<string, DiscoveredSkill> | undefined;
  /** Names already loaded this session — repeats return a short notice instead of the full body. */
  loadedSkills?: Set<string> | undefined;
  /**
   * Per-run dynamic tools layered OVER the static REGISTRY — today this is the
   * MCP bridge's `mcp__<server>__<tool>` wrappers. Dispatch consults these
   * first, so the static registry (and its tests) stay untouched while external
   * tools become callable for the lifetime of one run. Empty/undefined ⇒ exactly
   * the built-in behaviour.
   */
  extraTools?: ReadonlyMap<string, ToolDefinition> | undefined;
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
  /** True for tools that change the workspace — blocked during plan mode. */
  mutating?: boolean;
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
   * express). Built-in tools omit it — their schema is derived from
   * `parameters` by `buildToolDeclarations`.
   */
  jsonSchema?: Record<string, unknown>;
  /** Receives args that already passed schema validation (unless externalArgs). */
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

/** Expected failure (bad path, missing file, binary, …). Caught by dispatch. */
export class ToolError extends Error {}

// ─────────────────────── sandbox core ───────────────────────

/** Directory names that are ALWAYS excluded, regardless of .gitignore. */
const ALWAYS_IGNORE_NAMES = new Set(['node_modules', '.git', 'build', 'dist']);
/** Glob ignore patterns mirroring ALWAYS_IGNORE_NAMES (for globby calls). */
const ALWAYS_IGNORE_GLOBS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/.git',
  '**/.git/**',
  '**/build',
  '**/build/**',
  '**/dist',
  '**/dist/**',
];

/** Convert a path to forward-slash form for glob patterns / display. */
function toPosix(p: string): string {
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
 * Bound symlinks: the realpath of the target — or of its nearest existing
 * ancestor when the target doesn't exist — must stay inside realpath(cwd).
 * Defeats a symlink inside cwd that points outside it.
 */
function assertNoSymlinkEscape(cwd: string, resolved: string): void {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    return; // cwd unresolved — lexical check already passed
  }
  let probe = resolved;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return; // reached filesystem root without existing
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    return;
  }
  const rel = relative(realCwd, real);
  if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new ToolError('path escapes the working directory via a symlink');
  }
}

/** Full sandbox check: lexical confinement + symlink bounding. */
function safeResolve(ctx: ToolContext, p: string): string {
  const resolved = resolveInside(ctx.cwd, p);
  assertNoSymlinkEscape(ctx.cwd, resolved);
  return resolved;
}

/** True for content that is almost certainly not text (NUL or many controls). */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  if (len === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < len; i += 1) {
    const b = buf[i] as number;
    if (b === 0) return true; // NUL ⇒ binary
    // Control chars excluding \t(9) \n(10) \v(11) \f(12) \r(13).
    if (b < 9 || (b > 13 && b < 32)) suspicious += 1;
  }
  return suspicious / len > 0.3;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** A path is "ignored" if any segment is an excluded dir or git ignores it. */
async function isIgnoredPath(cwd: string, abs: string): Promise<boolean> {
  const rel = relative(cwd, abs);
  if (rel.split(/[\\/]/).some((seg) => ALWAYS_IGNORE_NAMES.has(seg))) return true;
  const { isGitIgnoredSync } = await import('globby');
  const ignored = isGitIgnoredSync({ cwd });
  return ignored(abs);
}

// ─────────────────────── arg accessors ───────────────────────
// Dispatch validates types against the schema before execute() runs, so these
// narrowing reads are safe.

function reqString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string') throw new ToolError(`"${key}" is required`);
  return v;
}
function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}
function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' && Number.isInteger(v) ? v : undefined;
}

// ───────────────────────── tools ─────────────────────────

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file inside the working directory. Use offset (1-based start line) and limit (line count) for large files; the result reports the total line count when truncated. Binary files are skipped.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working directory' },
      offset: { type: 'integer', description: 'Optional 1-based line to start from' },
      limit: { type: 'integer', description: 'Optional maximum number of lines to return' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const rel = reqString(args, 'path');
    const abs = safeResolve(ctx, rel);
    if (!existsSync(abs)) throw new ToolError(`file not found: ${rel}`);
    const st = statSync(abs);
    if (st.isDirectory()) throw new ToolError(`"${rel}" is a directory — use list_dir`);
    if (!st.isFile()) throw new ToolError(`"${rel}" is not a regular file`);
    const isSecret = await loadSecretGuard(ctx.cwd);
    if (isSecret(abs)) throw new ToolError(`blocked: sensitive path "${rel}"`);
    if (await isIgnoredPath(ctx.cwd, abs)) {
      throw new ToolError(`"${rel}" is gitignored or in an excluded directory and is not readable`);
    }
    if (st.size > ctx.limits.maxFileBytes) {
      throw new ToolError(
        `file too large to read (${fmtBytes(st.size)}); narrow with grep or offset/limit`,
      );
    }
    const buf = readFileSync(abs);
    if (looksBinary(buf)) {
      return { ok: true, summary: 'binary file skipped', content: `[binary file ${rel} (${fmtBytes(st.size)}) — not shown]` };
    }
    const lines = buf.toString('utf8').split('\n');
    const totalLines = lines.length;
    const offset = optInt(args, 'offset');
    const limit = optInt(args, 'limit');
    const start = offset !== undefined ? Math.max(0, offset - 1) : 0;
    const end = limit !== undefined ? Math.min(totalLines, start + Math.max(0, limit)) : totalLines;
    const slice = lines.slice(start, end);
    const sliced = offset !== undefined || limit !== undefined;
    // The total line count always rides in the summary, which is fed back to
    // the model in the result header. So even when dispatch byte-caps the
    // content, the model still learns the file's true length and can re-read
    // a window with offset/limit. (Byte-capping is centralized in dispatch.)
    const summary = sliced
      ? `lines ${start + 1}-${start + slice.length} of ${totalLines}`
      : `${totalLines} line${totalLines === 1 ? '' : 's'}`;
    return { ok: true, summary, content: slice.join('\n') };
  },
};

const listDirTool: ToolDefinition = {
  name: 'list_dir',
  description:
    'List the immediate entries of a directory (defaults to the working directory). Directories end with "/". Respects .gitignore and skips node_modules/.git/build/dist.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to the working directory (default ".")' },
    },
  },
  async execute(args, ctx) {
    const rel = optString(args, 'path') ?? '.';
    const abs = safeResolve(ctx, rel);
    if (!existsSync(abs)) throw new ToolError(`directory not found: ${rel}`);
    if (!statSync(abs).isDirectory()) throw new ToolError(`"${rel}" is not a directory — use read_file`);

    const { isGitIgnoredSync } = await import('globby');
    const ignored = isGitIgnoredSync({ cwd: ctx.cwd });
    const isSecret = await loadSecretGuard(ctx.cwd);
    const dirents = readdirSync(abs, { withFileTypes: true });
    const entries: string[] = [];
    for (const d of dirents) {
      if (ALWAYS_IGNORE_NAMES.has(d.name)) continue;
      const childAbs = join(abs, d.name);
      if (ignored(childAbs)) continue;
      // Hide secret paths. For directories, also probe a child so subtree
      // ignore patterns (e.g. "private/") hide the entire directory entry.
      if (isSecret(childAbs) || (d.isDirectory() && isSecret(join(childAbs, '__probe__')))) continue;
      entries.push(d.isDirectory() ? `${d.name}/` : d.name);
    }
    entries.sort((a, b) => a.localeCompare(b));
    const total = entries.length;
    const shown = entries.slice(0, ctx.limits.maxEntries);
    let content = shown.length > 0 ? shown.join('\n') : '(empty)';
    if (total > shown.length) content += `\n[+${total - shown.length} more]`;
    return { ok: true, summary: `${total} entr${total === 1 ? 'y' : 'ies'}`, content };
  },
};

const globTool: ToolDefinition = {
  name: 'glob',
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts"). Returns matching paths relative to the working directory. Respects .gitignore and skips node_modules/.git/build/dist.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'A glob pattern, e.g. "**/*.test.ts"' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    const pattern = reqString(args, 'pattern');
    const { globby } = await import('globby');
    let matches: string[];
    try {
      matches = await globby(pattern, {
        cwd: ctx.cwd,
        gitignore: true,
        dot: true,
        onlyFiles: true,
        ignore: ALWAYS_IGNORE_GLOBS,
        suppressErrors: true,
      });
    } catch {
      throw new ToolError(`invalid glob pattern: ${pattern}`);
    }
    const isSecret = await loadSecretGuard(ctx.cwd);
    matches = matches.filter((f) => !isSecret(join(ctx.cwd, f)));
    matches.sort((a, b) => a.localeCompare(b));
    const total = matches.length;
    const shown = matches.slice(0, ctx.limits.maxEntries);
    let content = shown.length > 0 ? shown.join('\n') : '(no matches)';
    if (total > shown.length) content += `\n[+${total - shown.length} more]`;
    return { ok: true, summary: `${total} file${total === 1 ? '' : 's'}`, content };
  },
};

const grepTool: ToolDefinition = {
  name: 'grep',
  description:
    'Search file contents with a JavaScript regular expression. Returns matches as "path:line:text". Optionally scope to a path (file or directory) or a glob. Pattern may be bare ("useState") or /pattern/flags ("/usestate/i"). Respects .gitignore.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex source, or /pattern/flags' },
      path: { type: 'string', description: 'Optional file or directory to limit the search' },
      glob: { type: 'string', description: 'Optional glob to limit which files are searched' },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    const patternStr = reqString(args, 'pattern');
    const re = compileRegex(patternStr);
    const pathArg = optString(args, 'path');
    const globArg = optString(args, 'glob');

    let patterns: string[];
    if (globArg) {
      patterns = [globArg];
    } else if (pathArg) {
      const abs = safeResolve(ctx, pathArg);
      if (existsSync(abs) && statSync(abs).isFile()) {
        patterns = [toPosix(relative(ctx.cwd, abs))];
      } else {
        const base = toPosix(relative(ctx.cwd, abs));
        patterns = [base ? `${base}/**/*` : '**/*'];
      }
    } else {
      patterns = ['**/*'];
    }

    const { globby } = await import('globby');
    const files = await globby(patterns, {
      cwd: ctx.cwd,
      gitignore: true,
      dot: true,
      onlyFiles: true,
      ignore: ALWAYS_IGNORE_GLOBS,
      suppressErrors: true,
    });
    files.sort((a, b) => a.localeCompare(b));
    const isSecret = await loadSecretGuard(ctx.cwd);

    const surfaced: string[] = [];
    const filesWithMatch = new Set<string>();
    let totalMatches = 0;
    let bytes = 0;
    for (const f of files) {
      if (ctx.signal?.aborted) break;
      const abs = join(ctx.cwd, f);
      if (isSecret(abs)) continue; // never surface secret-file contents
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      if (looksBinary(buf)) continue;
      const fileLines = buf.toString('utf8').split('\n');
      for (let i = 0; i < fileLines.length; i += 1) {
        const line = fileLines[i] as string;
        if (!re.test(line)) continue;
        totalMatches += 1;
        filesWithMatch.add(f);
        if (surfaced.length < ctx.limits.maxMatches && bytes < ctx.limits.maxResultBytes) {
          const trimmed = line.length > 200 ? `${line.slice(0, 200)}…` : line;
          const entry = `${f}:${i + 1}:${trimmed}`;
          surfaced.push(entry);
          bytes += entry.length + 1;
        }
      }
    }
    let content = surfaced.length > 0 ? surfaced.join('\n') : '(no matches)';
    if (totalMatches > surfaced.length) {
      content += `\n[+${totalMatches - surfaced.length} more matches]`;
    }
    const summary = `${totalMatches} match${totalMatches === 1 ? '' : 'es'} in ${filesWithMatch.size} file${filesWithMatch.size === 1 ? '' : 's'}`;
    return { ok: true, summary, content };
  },
};

const repoMapTool: ToolDefinition = {
  name: 'repo_map',
  description:
    'A compact overview of the project to orient yourself: top-level structure, detected languages, key files (package.json/README/etc.) and package.json scripts. Output is bounded.',
  parameters: { type: 'object', properties: {} },
  async execute(_args, ctx) {
    const { isGitIgnoredSync, globby } = await import('globby');
    const ignored = isGitIgnoredSync({ cwd: ctx.cwd });

    const topDirs: string[] = [];
    const topFiles: string[] = [];
    for (const d of readdirSync(ctx.cwd, { withFileTypes: true })) {
      if (ALWAYS_IGNORE_NAMES.has(d.name)) continue;
      if (ignored(join(ctx.cwd, d.name))) continue;
      if (d.isDirectory()) topDirs.push(`${d.name}/`);
      else topFiles.push(d.name);
    }
    topDirs.sort((a, b) => a.localeCompare(b));
    topFiles.sort((a, b) => a.localeCompare(b));

    const all = await globby(['**/*'], {
      cwd: ctx.cwd,
      gitignore: true,
      dot: false,
      onlyFiles: true,
      ignore: ALWAYS_IGNORE_GLOBS,
      suppressErrors: true,
    });
    const sample = all.slice(0, 8000);
    const extCount = new Map<string, number>();
    for (const f of sample) {
      const ext = extname(f).toLowerCase();
      if (ext) extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
    }
    const langs = topLanguages(extCount);

    const KEY_FILES = [
      'package.json', 'pnpm-workspace.yaml', 'README.md', 'README',
      'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'go.mod',
      'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle', 'Makefile',
      'Dockerfile', 'docker-compose.yml', '.gitignore',
    ];
    const keyPresent = KEY_FILES.filter((k) => existsSync(join(ctx.cwd, k)));

    let pkgInfo = '';
    const pkgPath = join(ctx.cwd, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pj = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          name?: unknown;
          description?: unknown;
          scripts?: Record<string, unknown>;
        };
        const scripts = pj.scripts && typeof pj.scripts === 'object' ? Object.keys(pj.scripts) : [];
        const desc = typeof pj.description === 'string' ? ` — "${pj.description.slice(0, 120)}"` : '';
        const name = typeof pj.name === 'string' ? pj.name : '(unnamed)';
        pkgInfo = `package.json: ${name}${desc}`;
        if (scripts.length > 0) pkgInfo += `\n  scripts: ${scripts.slice(0, 14).join(', ')}`;
      } catch {
        /* ignore malformed package.json */
      }
    }

    const lines: string[] = [];
    lines.push(`Working directory: ${ctx.cwd}`);
    lines.push('');
    lines.push('Top level:');
    for (const d of topDirs.slice(0, 50)) lines.push(`  ${d}`);
    for (const f of topFiles.slice(0, 50)) lines.push(`  ${f}`);
    lines.push('');
    if (langs.length > 0) {
      lines.push(`Languages: ${langs.map((l) => `${l.lang} (${l.count})`).join(', ')}`);
    }
    lines.push(`Files scanned: ${all.length}${all.length > sample.length ? ' (sampled 8000)' : ''}`);
    if (keyPresent.length > 0) lines.push(`Key files: ${keyPresent.join(', ')}`);
    if (pkgInfo) {
      lines.push('');
      lines.push(pkgInfo);
    }

    const summary = `${topDirs.length} dir${topDirs.length === 1 ? '' : 's'}, ${langs.length} lang${langs.length === 1 ? '' : 's'}`;
    return { ok: true, summary, content: lines.join('\n') };
  },
};

const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.java': 'Java',
  '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++',
  '.cs': 'C#', '.php': 'PHP', '.scala': 'Scala', '.sh': 'Shell', '.bash': 'Shell',
  '.json': 'JSON', '.md': 'Markdown', '.mdx': 'Markdown', '.css': 'CSS', '.scss': 'CSS',
  '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte', '.yml': 'YAML', '.yaml': 'YAML',
  '.sql': 'SQL', '.prisma': 'Prisma', '.toml': 'TOML', '.proto': 'Protobuf',
};

function topLanguages(extCount: Map<string, number>): Array<{ lang: string; count: number }> {
  const byLang = new Map<string, number>();
  for (const [ext, count] of extCount) {
    const lang = EXT_LANG[ext];
    if (!lang) continue;
    byLang.set(lang, (byLang.get(lang) ?? 0) + count);
  }
  return [...byLang.entries()]
    .map(([lang, count]) => ({ lang, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

/** Compile a regex from a bare source or a `/pattern/flags` literal. */
function compileRegex(input: string): RegExp {
  const literal = /^\/(.+)\/([gimsuy]*)$/s.exec(input);
  try {
    if (literal) return new RegExp(literal[1] as string, literal[2]);
    return new RegExp(input);
  } catch {
    throw new ToolError(`invalid regular expression: ${input}`);
  }
}

// ─────────────────────── skills ───────────────────────

const loadSkillTool: ToolDefinition = {
  name: 'load_skill',
  description:
    'Load the full instructions of an installed skill by its EXACT name from the "# Skills" list. Call this before relying on a skill, then follow the loaded instructions. Loading the same skill twice returns a short notice, not the content again.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Exact skill name from the # Skills list' },
    },
    required: ['name'],
  },
  async execute(args, ctx) {
    const name = reqString(args, 'name').trim();
    const skills = ctx.skills;
    if (!skills || skills.size === 0) {
      throw new ToolError('no skills are installed — answer from your own knowledge');
    }
    // STRICT lookup: the name is a key into the discovered set, never a path.
    // "../x", absolute paths, or any unknown string fail here identically.
    const skill = skills.get(name);
    if (!skill) {
      throw new ToolError(`unknown skill "${name}". Available: ${[...skills.keys()].join(', ')}`);
    }
    if (ctx.loadedSkills?.has(name)) {
      return {
        ok: true,
        summary: 'already loaded',
        content: `Skill "${name}" was already loaded earlier in this session — its instructions are in the conversation above. Apply them; do not reload.`,
      };
    }
    // Read via the absolute path recorded at DISCOVERY time (CLI-controlled).
    let raw: string;
    try {
      raw = readFileSync(skill.path, 'utf8');
    } catch {
      throw new ToolError(`skill "${name}" could not be read — it may have been removed`);
    }
    const { body } = parseSkillFile(raw, name);
    ctx.loadedSkills?.add(name);
    const lines = body.split('\n').length;
    return {
      ok: true,
      summary: `${lines} line${lines === 1 ? '' : 's'}`,
      content: `SKILL "${name}" — follow these instructions where relevant:\n\n${body}`,
    };
  },
};

// ─────────────────────── mutating tools ───────────────────────

let tmpCounter = 0;

/** Write `content` to `abs` atomically: temp file in the same dir + rename. */
function writeAtomic(abs: string, content: string): void {
  const dir = dirname(abs);
  mkdirSync(dir, { recursive: true });
  tmpCounter += 1;
  const tmp = join(dir, `.${basename(abs)}.spycore-${process.pid}-${tmpCounter}.tmp`);
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, abs);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

interface MutationSpec {
  tool: 'write_file' | 'edit_file';
  rel: string;
  abs: string;
  isNew: boolean;
  oldText: string;
  newText: string;
}

/** Shared write/edit tail: diff → approval pause → atomic apply (or skip). */
async function applyMutation(ctx: ToolContext, spec: MutationSpec): Promise<ToolResult> {
  if (!spec.isNew && spec.oldText === spec.newText) {
    return {
      ok: true,
      kind: 'applied',
      added: 0,
      removed: 0,
      isNew: false,
      summary: 'no change',
      content: `${spec.rel} already has the requested content; nothing to write.`,
    };
  }
  const fd = await computeFileDiff(spec.oldText, spec.newText);
  const request: ApprovalRequest = {
    kind: 'write',
    tool: spec.tool,
    path: spec.rel,
    isNew: spec.isNew,
    added: fd.added,
    removed: fd.removed,
    diff: fd.lines,
    truncated: fd.truncated,
    hiddenLines: fd.hiddenLines,
  };
  const outcome = ctx.requestApproval
    ? await ctx.requestApproval(request)
    : { approved: false, reason: 'approval is unavailable in this context' };
  if (!outcome.approved) {
    return {
      ok: false,
      kind: 'rejected',
      added: fd.added,
      removed: fd.removed,
      isNew: spec.isNew,
      summary: 'rejected',
      content: `Write to "${spec.rel}" was not applied: ${outcome.reason ?? 'rejected by user'}. The file is unchanged.`,
    };
  }
  writeAtomic(spec.abs, spec.newText);
  // Journal the applied change so `spycore rewind` can undo it. Record the
  // REAL resolved target (post-symlink): if the path rode through a
  // symlinked directory inside cwd, the journal must name the file that was
  // actually modified, so rewind restores the right bytes in the right place.
  let journalPath = spec.abs;
  try {
    journalPath = realpathSync(spec.abs);
  } catch {
    /* freshly-created exotic path — fall back to the lexical absolute */
  }
  ctx.recordChange?.({
    path: journalPath,
    op: spec.isNew ? 'create' : 'modify',
    before: spec.isNew ? null : spec.oldText,
    after: spec.newText,
  });
  const stat = fd.removed > 0 ? `+${fd.added} -${fd.removed}` : `+${fd.added}`;
  return {
    ok: true,
    kind: 'applied',
    added: fd.added,
    removed: fd.removed,
    isNew: spec.isNew,
    summary: stat,
    content: `Applied ${spec.tool} to ${spec.rel} (${fd.added} line(s) added, ${fd.removed} removed).`,
  };
}

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  mutating: true,
  description:
    'Create a new file or overwrite an existing one (UTF-8). The change is shown to the user as a diff and applied only after they approve. Sensitive paths are blocked.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working directory' },
      content: { type: 'string', description: 'Full new contents of the file' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const rel = reqString(args, 'path');
    const content = reqString(args, 'content');
    const abs = safeResolve(ctx, rel);
    const isSecret = await loadSecretGuard(ctx.cwd);
    if (isSecret(abs)) throw new ToolError(`blocked: sensitive path "${rel}"`);
    const exists = existsSync(abs);
    if (exists && statSync(abs).isDirectory()) {
      throw new ToolError(`"${rel}" is a directory`);
    }
    const oldBuf = exists ? readFileSync(abs) : Buffer.alloc(0);
    const oldText = exists && !looksBinary(oldBuf) ? oldBuf.toString('utf8') : '';
    return applyMutation(ctx, { tool: 'write_file', rel, abs, isNew: !exists, oldText, newText: content });
  },
};

const editFileTool: ToolDefinition = {
  name: 'edit_file',
  mutating: true,
  description:
    'Replace an exact string in an existing file. old_str MUST occur exactly once (include surrounding context to make it unique); 0 or multiple matches are rejected without writing. The change is shown as a diff and applied only after approval.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to the working directory' },
      old_str: { type: 'string', description: 'Exact text to replace — must be unique in the file' },
      new_str: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old_str', 'new_str'],
  },
  async execute(args, ctx) {
    const rel = reqString(args, 'path');
    const oldStr = reqString(args, 'old_str');
    const newStr = reqString(args, 'new_str');
    if (oldStr.length === 0) throw new ToolError('old_str must not be empty');
    const abs = safeResolve(ctx, rel);
    const isSecret = await loadSecretGuard(ctx.cwd);
    if (isSecret(abs)) throw new ToolError(`blocked: sensitive path "${rel}"`);
    if (!existsSync(abs)) throw new ToolError(`file not found: ${rel}`);
    if (!statSync(abs).isFile()) throw new ToolError(`"${rel}" is not a regular file`);
    const buf = readFileSync(abs);
    if (looksBinary(buf)) throw new ToolError(`"${rel}" appears to be binary; refusing to edit`);
    const current = buf.toString('utf8');
    const count = current.split(oldStr).length - 1;
    if (count === 0) {
      throw new ToolError(`old_str was not found in ${rel}; it must occur exactly once`);
    }
    if (count > 1) {
      throw new ToolError(
        `old_str occurs ${count} times in ${rel}; it must occur exactly once — add more surrounding context`,
      );
    }
    const idx = current.indexOf(oldStr);
    const next = current.slice(0, idx) + newStr + current.slice(idx + oldStr.length);
    return applyMutation(ctx, { tool: 'edit_file', rel, abs, isNew: false, oldText: current, newText: next });
  },
};

// ─────────────────────── shell command tool ───────────────────────

export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const SIGTERM_GRACE_MS = 2_000;
const MAX_CAPTURE_BYTES = 1024 * 1024; // memory guard on captured output

/**
 * A SMALL safety net (NOT a sandbox): hard-block obviously catastrophic
 * commands BEFORE the approval prompt, so even --yes cannot run them. The real
 * protections are the cwd, the approval prompt, and the timeout; OS-level
 * sandboxing is a later phase. Returns a reason string, or null when allowed.
 * Deliberately not exhaustive — it only covers the obvious destroyers (and may
 * over-match, e.g. inside an echo string, which is acceptable for a safety net).
 */
export function matchesCatastrophic(command: string): string | null {
  return matchCatastrophicInner(command, 0);
}

/**
 * Pull the payload strings out of common shell-wrapper forms (`sh -c "…"`,
 * `bash -c '…'`, bare-word payloads) so the matcher can scan INSIDE them.
 * A wrapper must not defeat the net (red-team vector D); deeper obfuscation
 * (base64 | sh, $IFS splicing, eval chains) is out of scope by design — the
 * approval prompt remains the primary control.
 */
function extractWrapperPayloads(command: string): string[] {
  const out: string[] = [];
  const re = /\b(?:sh|bash|zsh|dash|ksh)\s+(?:[^|;&"']*\s)?-c\s+("((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const dq = m[2];
    const sq = m[3];
    const bare = m[4];
    if (typeof dq === 'string') out.push(dq.replace(/\\(.)/g, '$1'));
    else if (typeof sq === 'string') out.push(sq);
    else if (typeof bare === 'string') out.push(bare);
  }
  return out;
}

function matchCatastrophicInner(command: string, depth: number): string | null {
  const c = command.replace(/\s+/g, ' ').trim();
  const lc = c.toLowerCase();

  // Fork bomb, any spacing: :(){ :|:& };:
  if (c.replace(/\s+/g, '').includes(':(){:|:&};:')) return 'fork bomb';

  // rm with BOTH recursive and force flags … A quote, command separator, OR a
  // PATH SEPARATOR before the word counts as a boundary, so `"rm" -rf /`,
  // `sh -c "rm -rf /"`, and pathed invocations (`/bin/rm`, `/usr/bin/rm`) all
  // match — we key on the basename `rm`, not on the leading path (CL3).
  const padded = ` ${lc} `;
  const hasRm = /[\s;&|("'/]rm['"]?\s/.test(padded);
  const recursive = /\s-{1,2}[a-z]*r/.test(lc) || /--recursive\b/.test(lc);
  const force = /\s-{1,2}[a-z]*f/.test(lc) || /--force\b/.test(lc);
  if (hasRm && recursive && force) {
    if (/--no-preserve-root/.test(lc)) return 'rm --no-preserve-root';
    // … aimed at the filesystem root or HOME. The target may be quote-wrapped
    // (`rm -rf "/"`), and the HOME var may be braced (`${HOME}`) and preceded
    // by a quote / `=` / `:` / path separator (`rm -rf "$HOME"`) — CL4.
    const rootOrTilde = /[\s]["']?(\/|\/\*|~|~\/)(\s|$|\*|\/|['"])/.test(padded);
    const homeVar = /[\s"'=:/]\$\{?home\}?(\s|$|\*|\/|['"])/.test(padded);
    if (rootOrTilde || homeVar) return 'rm -rf on / ~ or $HOME';
    // … aimed at a top-level system directory
    if (/[\s]\/(usr|etc|bin|sbin|var|lib|boot|sys|dev|root|opt)(\/\S*)?(\s|$)/.test(padded)) {
      return 'rm -rf on a system directory';
    }
  }

  // Format a filesystem
  if (/\bmkfs(\.\w+)?\b/.test(lc)) return 'mkfs (format filesystem)';

  // Write a raw block device with dd
  if (/\bdd\b[^\n]*\bof=\/dev\/(sd|hd|disk|rdisk|nvme|vd)/.test(lc)) return 'dd to a block device';

  // Redirect/overwrite a raw block device
  if (/>\s*\/dev\/(sd|hd|disk|rdisk|nvme|vd)/.test(lc)) return 'overwrite a block device';

  // Scan inside sh/bash/zsh -c payloads (bounded recursion for nesting).
  if (depth < 3) {
    for (const payload of extractWrapperPayloads(c)) {
      const hit = matchCatastrophicInner(payload, depth + 1);
      if (hit) return hit;
    }
  }

  return null;
}

export interface CommandRun {
  combined: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Run `command` via the shell in its OWN process group (detached) so the whole
 * process tree can be killed on timeout or abort. Captures combined
 * stdout+stderr (hard byte cap). On timeout: SIGTERM the group, then SIGKILL
 * after a grace period. An aborted `signal` (Ctrl+C / loop abort) kills the
 * group the same way. Never rejects — failures resolve as a run result.
 */
/** Shared command executor: spawn in `cwd` in its own process group, capture
 *  combined output (byte-capped), enforce `timeoutMs` (SIGTERM→SIGKILL the
 *  group), and kill the group on abort. Used by run_command AND self-verify. */
export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<CommandRun> {
  return new Promise<CommandRun>((resolve) => {
    const start = Date.now();
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let combined = '';
    let capped = false;
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

    const capture = (buf: Buffer): void => {
      if (capped) return;
      combined += buf.toString('utf8');
      if (combined.length > MAX_CAPTURE_BYTES) {
        combined = `${combined.slice(0, MAX_CAPTURE_BYTES)}\n[output capped at ${fmtBytes(MAX_CAPTURE_BYTES)}]`;
        capped = true;
      }
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const killGroup = (sig: NodeJS.Signals): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, sig); // negative pid → the whole process group
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };
    const scheduleHardKill = (): void => {
      if (killTimer) return;
      killTimer = setTimeout(() => killGroup('SIGKILL'), SIGTERM_GRACE_MS);
    };
    const onAbort = (): void => {
      killGroup('SIGTERM');
      scheduleHardKill();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort);
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      scheduleHardKill();
    }, timeoutMs);

    const done = (exitCode: number | null, sig: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({ combined, exitCode, signal: sig, timedOut, durationMs: Date.now() - start });
    };

    child.on('error', (err) => {
      capture(Buffer.from(`${combined ? '\n' : ''}spawn error: ${err instanceof Error ? err.message : String(err)}`));
      done(null, null);
    });
    child.on('close', (code, sig) => done(code, sig));
  });
}

/** Last `n` lines of `text`, also byte-capped, for the UI scrollback tail. */
export function tailLines(text: string, n: number, maxBytes = 4000): string {
  const lines = text.replace(/\n+$/, '').split('\n');
  const tail = lines.length > n ? lines.slice(lines.length - n) : lines;
  let out = tail.join('\n');
  if (out.length > maxBytes) out = `…${out.slice(out.length - maxBytes)}`;
  return out;
}

const runCommandTool: ToolDefinition = {
  name: 'run_command',
  mutating: true,
  description:
    'Run a shell command in the working directory (build, test, lint, git, install, …). The command is shown to the user for approval before it runs. PREFER the dedicated file tools (read_file/write_file/edit_file/grep/glob) over cat/sed/find/echo-to-file. Returns combined stdout+stderr, exit code, and duration; long-running commands time out.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
    },
    required: ['command'],
  },
  async execute(args, ctx) {
    const command = reqString(args, 'command').trim();
    if (command.length === 0) throw new ToolError('command must not be empty');
    // Safety net BEFORE approval, so --yes cannot bypass it.
    const danger = matchesCatastrophic(command);
    if (danger) throw new ToolError(`blocked: refusing to run a catastrophic command (${danger})`);

    const request: ApprovalRequest = { kind: 'command', command };
    const outcome = ctx.requestApproval
      ? await ctx.requestApproval(request)
      : { approved: false, reason: 'approval is unavailable in this context' };
    if (!outcome.approved) {
      return {
        ok: false,
        kind: 'rejected',
        command,
        summary: 'rejected',
        content: `Command was not run: ${outcome.reason ?? 'rejected by user'}.`,
      };
    }

    const timeoutMs = ctx.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const run = await runShellCommand(command, ctx.cwd, timeoutMs, ctx.signal);
    const duration = `${(run.durationMs / 1000).toFixed(1)}s`;
    const status = run.timedOut
      ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : run.exitCode !== null
        ? `exit ${run.exitCode}`
        : `killed${run.signal ? ` (${run.signal})` : ''}`;
    const ok = !run.timedOut && run.exitCode === 0;
    const body = run.combined.replace(/\n+$/, '');
    const content = `$ ${command}\n${body.length > 0 ? body : '(no output)'}\n[${status}, ${duration}]`;
    return {
      ok,
      kind: 'command',
      command,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      outputTail: tailLines(run.combined, 40),
      summary: `${status} (${duration})`,
      content,
    };
  },
};

// ─────────────────────── registry ───────────────────────

const ALL_TOOLS: ToolDefinition[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  repoMapTool,
  loadSkillTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
];

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
 * Central dispatch: look up the tool, validate args against its schema, run
 * it, and byte-cap the result. NEVER throws — every failure mode (unknown
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
  const tool = ctx.extraTools?.get(name) ?? REGISTRY.get(name);
  if (!tool) {
    const available = [...toolNames(), ...(ctx.extraTools ? [...ctx.extraTools.keys()] : [])];
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
    const res = await tool.execute(args, ctx);
    return capContent(res, ctx.limits.maxResultBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Surface the real reason (file not found / blocked / …) in the summary
    // for expected ToolErrors so the UI line is informative.
    const summary =
      err instanceof ToolError ? (message.length > 60 ? `${message.slice(0, 60)}…` : message) : 'error';
    return { ok: false, summary, content: `Error: ${message}` };
  }
}

function capContent(res: ToolResult, maxBytes: number): ToolResult {
  if (res.content.length <= maxBytes) return res;
  return {
    ...res,
    content: `${res.content.slice(0, maxBytes)}\n\n[result truncated to ${fmtBytes(maxBytes)}]`,
  };
}

/** Render the tool catalogue for the system prompt (optionally read-only only). */
export function describeToolsForPrompt(opts: { readOnlyOnly?: boolean } = {}): string {
  const tools = opts.readOnlyOnly ? ALL_TOOLS.filter((t) => !t.mutating) : ALL_TOOLS;
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
 * mode (plan phase) the mutating built-ins and all MCP tools are excluded — the
 * same `!mutating` predicate `describeToolsForPrompt` uses, so the model is
 * offered exactly what it could call. A name that can't satisfy the server's
 * charset is dropped (it would 400 the whole request) rather than sent.
 */
export function buildToolDeclarations(opts: {
  readOnlyOnly?: boolean;
  extraTools?: ReadonlyMap<string, ToolDefinition> | undefined;
} = {}): ToolDecl[] {
  const out: ToolDecl[] = [];
  const builtins = opts.readOnlyOnly ? ALL_TOOLS.filter((t) => !t.mutating) : ALL_TOOLS;
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
  if (tool === 'grep') {
    const pat = optString(args, 'pattern') ?? '';
    const scope = optString(args, 'glob') ?? optString(args, 'path');
    return scope ? `"${pat}" in ${scope}` : `"${pat}"`;
  }
  if (tool === 'run_command') {
    const cmd = optString(args, 'command') ?? '';
    return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
  }
  // MCP tools (`mcp__server__tool`): show a compact one-line view of the args.
  if (tool.startsWith('mcp__')) {
    const json = Object.keys(args).length > 0 ? JSON.stringify(args) : '';
    return json.length > 80 ? `${json.slice(0, 80)}…` : json;
  }
  return '';
}
