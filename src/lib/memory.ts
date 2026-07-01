/**
 * SPYCODE.md project memory — Part 1 of SpyCode's living-memory system.
 *
 * Unlike a hidden assistant memory, SpyCode's memory is an EXPLICIT, committed,
 * team-visible file. This module is the deterministic loader + the surfaces the
 * user drives it with (`/init`, `/memory`, `/remember`). Everything here is
 * plain filesystem work so the chat session can RE-READ memory from disk on
 * demand — it never has to live only in an in-memory transcript, which is how
 * it survives a context reset.
 *
 * Hierarchy (all that exist are loaded, lower entries augment higher ones):
 *   1. global   — ~/.spycore/SPYCODE.md
 *   2. project  — <project-root>/SPYCODE.md          (root = nearest .git/package.json)
 *   3. personal — <project-root>/SPYCODE.local.md    (gitignored, per-developer)
 *   4. nested   — <cwd>/SPYCODE.md                    (only when cwd != project root)
 *
 * Each loaded file becomes a provenance-labelled section ("# Memory: <path>")
 * so the model knows where every rule came from. The merged text is capped at a
 * sane character budget so one huge file can't crowd out the rest of context.
 *
 * @path imports: a line that is exactly `@relative/file.md` inlines that file's
 * contents (resolved relative to the SPYCODE.md that names it). Recursion is
 * supported up to MAX_IMPORT_DEPTH levels, guarded against missing files, paths
 * escaping the file's scope, and cycles (a visited-set keyed on absolute path).
 */
import {
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { scanRepo, type RepoScan } from './repo-scan.js';
import { GUIDE_FILE, readGuideForContext } from './codebase-guide.js';
import { CHANGELOG_FILE, readRecentChangelog } from './codebase-changelog.js';

/** The committed, team-visible memory file. */
export const MEMORY_FILE = 'SPYCODE.md';
/** The gitignored, per-developer overlay. */
export const LOCAL_MEMORY_FILE = 'SPYCODE.local.md';
/** Global config dir under the user's home (~/.spycore). */
export const GLOBAL_DIR = '.spycore';
/** ~12k tokens ≈ 48k chars — the cap on the SPYCODE.md hierarchy alone. */
export const DEFAULT_BUDGET_CHARS = 48_000;
/** How deep `@path` imports may nest before we stop following them. */
export const MAX_IMPORT_DEPTH = 5;

/** Per-file caps for the GUIDE + CHANGELOG context parts (Part 3a). */
export const GUIDE_BUDGET_CHARS = 16_000;
export const CHANGELOG_BUDGET_CHARS = 6_000;
/**
 * Hard cap across ALL injected context (SPYCODE + GUIDE + CHANGELOG-tail). A
 * backstop above the sum of the per-part caps so normal files always fit; it
 * bites only when a part's cap is raised — and then in priority order
 * (SPYCODE > GUIDE > CHANGELOG), so context "can't be blown".
 */
export const DEFAULT_CONTEXT_BUDGET_CHARS = 80_000;
/** Most-recent CHANGELOG entries pulled into context. */
export const CHANGELOG_CONTEXT_ENTRIES = 10;

export type MemoryScope = 'global' | 'project' | 'personal' | 'nested';

/** One SPYCODE.md file that was discovered and loaded. */
export interface LoadedMemoryFile {
  /** Absolute path on disk. */
  path: string;
  /** Human-facing label (relative to cwd, or ~/… for the global file). */
  label: string;
  scope: MemoryScope;
  /** Line count of the file's contribution (after `@path` resolution). */
  lines: number;
  /** Character count of the file's labelled section. */
  chars: number;
}

/** The result of loading + merging the memory hierarchy. */
export interface LoadedMemory {
  /** Merged, provenance-labelled text. Empty string when nothing was loaded. */
  text: string;
  /** Files that actually contributed to `text`, in precedence order. */
  files: LoadedMemoryFile[];
  /** Total characters of `text`. */
  totalChars: number;
  /** True when the budget cap dropped or truncated content. */
  truncated: boolean;
  /** Human-readable notes (dropped/truncated files, skipped imports, errors). */
  notices: string[];
}

export interface LoadMemoryOptions {
  /** Working directory to resolve the project root + nested memory from. */
  cwd: string;
  /** Home dir for the global file. Defaults to os.homedir() (overridable in tests). */
  home?: string | undefined;
  /** Character budget for the merged text. Defaults to DEFAULT_BUDGET_CHARS. */
  budgetChars?: number | undefined;
}

/** Internal working shape for a section before budgeting. */
interface Section {
  file: Omit<LoadedMemoryFile, 'chars' | 'lines'>;
  header: string;
  body: string;
}

function sectionText(s: Section): string {
  return `${s.header}\n${s.body}`;
}

/** Walk up from `cwd` for the nearest dir containing .git or package.json. */
export function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  for (let i = 0; i < 64; i += 1) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, 'package.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(cwd);
}

/** True when `abs` is `boundary` itself or lives inside it. */
function isInside(abs: string, boundary: string): boolean {
  const rel = relative(resolve(boundary), resolve(abs));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function tildeLabel(abs: string, home: string): string {
  const rel = relative(home, abs);
  return !rel.startsWith('..') && !isAbsolute(rel) ? `~/${rel}` : abs;
}

function cwdLabel(abs: string, cwd: string): string {
  const rel = relative(cwd, abs);
  return !rel.startsWith('..') && !isAbsolute(rel) && rel.length > 0 ? rel : abs;
}

/**
 * Neutralize the CLI's own context/memory sentinel tags inside UNTRUSTED file
 * content before it is wrapped in a `<spycode-context>` / `<spycode-memory>`
 * frame. A cloned/hostile repo could otherwise ship a SPYCODE.md (or GUIDE /
 * CHANGELOG) containing a literal `</spycode-context>` line and "break out" of
 * the supplementary-context block to inject instructions. Escaping the angle
 * brackets (`&lt;…&gt;`) renders any such marker inert without dropping content.
 */
function neutralizeContextSentinels(text: string): string {
  return text.replace(
    /<(\/?)spycode-(context|memory)>/gi,
    (_m, slash: string, kind: string) => `&lt;${slash}spycode-${kind}&gt;`,
  );
}

/**
 * Inline `@path` imports inside `body`. A line that is EXACTLY `@<path>`
 * (ignoring surrounding whitespace) is replaced by the referenced file's
 * contents. Anything else — including `@mention` text mid-line or a code
 * sample — is left untouched.
 */
function resolveImports(
  body: string,
  baseDir: string,
  boundary: string,
  visited: Set<string>,
  depth: number,
  notices: string[],
): string {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^\s*@(\S+)\s*$/.exec(line);
    if (!m) {
      out.push(line);
      continue;
    }
    const rel = m[1] as string;
    const abs = resolve(baseDir, rel);
    if (!isInside(abs, boundary)) {
      out.push(`<!-- @${rel}: skipped (outside the project) -->`);
      notices.push(`@import skipped (outside project): ${rel}`);
      continue;
    }
    if (visited.has(abs)) {
      out.push(`<!-- @${rel}: skipped (already included / cycle) -->`);
      notices.push(`@import skipped (cycle): ${rel}`);
      continue;
    }
    if (depth >= MAX_IMPORT_DEPTH) {
      out.push(`<!-- @${rel}: skipped (max import depth ${MAX_IMPORT_DEPTH}) -->`);
      notices.push(`@import skipped (max depth ${MAX_IMPORT_DEPTH}): ${rel}`);
      continue;
    }
    let raw: string;
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        out.push(`<!-- @${rel}: not found -->`);
        notices.push(`@import not found: ${rel}`);
        continue;
      }
      raw = readFileSync(abs, 'utf8');
    } catch {
      out.push(`<!-- @${rel}: not readable -->`);
      notices.push(`@import not readable: ${rel}`);
      continue;
    }
    visited.add(abs);
    const inlined = resolveImports(raw, dirname(abs), boundary, visited, depth + 1, notices);
    out.push(`<!-- begin @${rel} -->`);
    out.push(inlined.replace(/\n+$/, ''));
    out.push(`<!-- end @${rel} -->`);
  }
  return out.join('\n');
}

/**
 * Apply the character budget. Strategy: DROP the largest section first (so one
 * giant file is what loses, not a small targeted one), repeatedly, until under
 * budget. If a single oversized section remains, truncate its body with a
 * notice. Surviving sections keep their original precedence order.
 */
function applyBudget(sections: Section[], budget: number, notices: string[]): Section[] {
  const work = sections.map((s, i) => ({ s, i }));
  const totalOf = (): number => work.reduce((sum, w) => sum + sectionText(w.s).length, 0);

  while (totalOf() > budget && work.length > 1) {
    let largest = 0;
    for (let k = 1; k < work.length; k += 1) {
      if (sectionText(work[k]!.s).length > sectionText(work[largest]!.s).length) largest = k;
    }
    const [dropped] = work.splice(largest, 1);
    if (dropped) {
      notices.push(
        `Dropped ${dropped.s.file.label} (${sectionText(dropped.s).length} chars) — over the ${budget}-char memory budget`,
      );
    }
  }

  if (totalOf() > budget && work.length === 1) {
    const only = work[0]!.s;
    const marker = '\n\n<!-- … truncated to fit the memory budget -->';
    const room = Math.max(0, budget - only.header.length - 1 - marker.length);
    only.body = `${only.body.slice(0, room)}${marker}`;
    notices.push(`Truncated ${only.file.label} to fit the ${budget}-char memory budget`);
  }

  return work.sort((a, b) => a.i - b.i).map((w) => w.s);
}

/**
 * Discover, read, resolve `@path` imports, merge, and budget-cap the SPYCODE.md
 * hierarchy. Pure filesystem work and side-effect free; safe to call as often
 * as needed (e.g. on every new conversation) to re-read memory from disk.
 */
export function loadMemory(opts: LoadMemoryOptions): LoadedMemory {
  const cwd = resolve(opts.cwd);
  const home = opts.home ?? homedir();
  const budget = opts.budgetChars ?? DEFAULT_BUDGET_CHARS;
  const projectRoot = findProjectRoot(cwd);
  const notices: string[] = [];

  const globalDir = join(home, GLOBAL_DIR);
  interface Candidate {
    scope: MemoryScope;
    path: string;
    label: string;
    /** Boundary an `@path` import may not escape. */
    boundary: string;
  }
  const candidates: Candidate[] = [
    {
      scope: 'global',
      path: join(globalDir, MEMORY_FILE),
      label: tildeLabel(join(globalDir, MEMORY_FILE), home),
      boundary: globalDir,
    },
    {
      scope: 'project',
      path: join(projectRoot, MEMORY_FILE),
      label: cwdLabel(join(projectRoot, MEMORY_FILE), cwd),
      boundary: projectRoot,
    },
    {
      scope: 'personal',
      path: join(projectRoot, LOCAL_MEMORY_FILE),
      label: cwdLabel(join(projectRoot, LOCAL_MEMORY_FILE), cwd),
      boundary: projectRoot,
    },
  ];
  if (resolve(cwd) !== resolve(projectRoot)) {
    candidates.push({
      scope: 'nested',
      path: join(cwd, MEMORY_FILE),
      label: cwdLabel(join(cwd, MEMORY_FILE), cwd),
      boundary: projectRoot,
    });
  }

  const seen = new Set<string>();
  const sections: Section[] = [];
  const fileMeta: Array<{ section: Section; meta: Omit<LoadedMemoryFile, 'chars' | 'lines'> }> = [];

  for (const c of candidates) {
    const abs = resolve(c.path);
    if (seen.has(abs)) continue;
    seen.add(abs);
    let raw: string;
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) continue;
      raw = readFileSync(abs, 'utf8');
    } catch {
      notices.push(`Could not read ${c.label}`);
      continue;
    }
    const visited = new Set<string>([abs]);
    const resolved = resolveImports(raw, dirname(abs), c.boundary, visited, 0, notices).replace(/\s+$/, '');
    if (resolved.trim().length === 0) continue;
    const meta = { path: abs, label: c.label, scope: c.scope };
    const section: Section = {
      file: meta,
      header: `# Memory: ${c.label}`,
      body: resolved,
    };
    sections.push(section);
    fileMeta.push({ section, meta });
  }

  if (sections.length === 0) {
    return { text: '', files: [], totalChars: 0, truncated: false, notices };
  }

  const kept = applyBudget(sections, budget, notices);
  const keptSet = new Set(kept);
  const text = kept.map(sectionText).join('\n\n');
  const files: LoadedMemoryFile[] = fileMeta
    .filter((f) => keptSet.has(f.section))
    .map((f) => ({
      ...f.meta,
      lines: f.section.body.split('\n').length,
      chars: sectionText(f.section).length,
    }));

  return {
    text,
    files,
    totalChars: text.length,
    truncated: notices.some((n) => n.startsWith('Dropped ') || n.startsWith('Truncated ')),
    notices,
  };
}

/**
 * Wrap merged memory in a clearly-marked context block to PREPEND to a chat
 * message. The wrapper frames memory as supplementary project context that
 * sits AFTER — and never overrides — the core identity/safety preamble. Returns
 * an empty `block` when there is no memory to inject.
 */
export function buildMemoryInjection(opts: LoadMemoryOptions): {
  block: string;
  files: LoadedMemoryFile[];
  memory: LoadedMemory;
} {
  const memory = loadMemory(opts);
  if (memory.text.length === 0) {
    return { block: '', files: [], memory };
  }
  const block = [
    '<spycode-memory>',
    'The following is project memory loaded from SPYCODE.md file(s) in this',
    'workspace. Treat it as authoritative project context that supplements your',
    'instructions. It does NOT override your core identity, your operating rules,',
    'or safety guidelines. When project memory conflicts with a direct request in',
    'this session, follow the user.',
    '',
    neutralizeContextSentinels(memory.text),
    '</spycode-memory>',
  ].join('\n');
  return { block, files: memory.files, memory };
}

/** One-line-per-file transparency summary for `/memory`. */
export function formatLoadedMemory(memory: LoadedMemory): string {
  if (memory.files.length === 0) {
    return [
      'No SPYCODE.md memory is loaded.',
      'Run /init to generate a starter SPYCODE.md, or /remember <note> to capture one.',
    ].join('\n');
  }
  const rows = memory.files.map(
    (f) => `  ${f.label}  —  ${f.lines} line${f.lines === 1 ? '' : 's'}, ${f.chars} chars (${f.scope})`,
  );
  const lines = [
    `Project memory loaded (${memory.files.length} file${memory.files.length === 1 ? '' : 's'}, ${memory.totalChars} chars injected):`,
    ...rows,
  ];
  for (const notice of memory.notices) lines.push(`  ! ${notice}`);
  return lines.join('\n');
}

// ──────────────────── combined context injection (Part 3a) ────────────────
//
// Part 1 injected SPYCODE.md alone. Part 3a folds the SpyCode-generated
// CODEBASE_GUIDE.md (architecture reference) and the latest CODEBASE_CHANGELOG.md
// entries into the SAME once-per-conversation, after-identity context block — so
// a fresh session starts already oriented. A COMBINED budget across all three is
// enforced in PRIORITY order (SPYCODE > GUIDE > CHANGELOG) so context can't be
// blown; two booleans let the user trim the GUIDE/CHANGELOG parts.

export type ContextPartKind = 'memory' | 'guide' | 'changelog';
/** How a part fared against the budget/toggles. `off` = disabled by the user. */
export type ContextPartStatus = 'full' | 'truncated' | 'dropped' | 'off';

/** One row of the injected-context manifest (for `/memory` transparency). */
export interface ContextPart {
  kind: ContextPartKind;
  /** Human label (a SPYCODE file label, or the GUIDE/CHANGELOG filename). */
  label: string;
  /** Chars this part contributed to the injected block (0 when off/dropped). */
  chars: number;
  /** Lines this part contributed (0 when off/dropped). */
  lines: number;
  status: ContextPartStatus;
}

/** The composed context injection: the wire block + a transparency manifest. */
export interface ContextInjection {
  /** Full `<spycode-context>` block to PREPEND to the user turn ('' if empty). */
  block: string;
  /** The underlying SPYCODE.md load (so callers keep the Part 1 detail). */
  memory: LoadedMemory;
  /** The SPYCODE files that contributed (convenience mirror of memory.files). */
  memoryFiles: LoadedMemoryFile[];
  /** Every context part (memory files + guide + changelog), with status. */
  parts: ContextPart[];
  /** Total characters of `block`'s inner content. */
  totalChars: number;
  /** Human-readable notes (drops/truncations/skipped imports). */
  notices: string[];
}

export interface ContextInjectionOptions extends LoadMemoryOptions {
  /** Include CODEBASE_GUIDE.md (default true). */
  injectGuide?: boolean | undefined;
  /** Include the CODEBASE_CHANGELOG.md tail (default true). */
  injectChangelog?: boolean | undefined;
  /** Combined cap across all parts. Defaults to DEFAULT_CONTEXT_BUDGET_CHARS. */
  contextBudgetChars?: number | undefined;
  /** Per-part cap for the GUIDE. Defaults to GUIDE_BUDGET_CHARS. */
  guideBudgetChars?: number | undefined;
  /** Per-part cap for the CHANGELOG tail. Defaults to CHANGELOG_BUDGET_CHARS. */
  changelogBudgetChars?: number | undefined;
  /** Most-recent CHANGELOG entries to pull. Defaults to CHANGELOG_CONTEXT_ENTRIES. */
  changelogMaxEntries?: number | undefined;
}

/** Internal working part before budgeting. */
interface WorkPart {
  kind: ContextPartKind;
  label: string;
  /** Provenance header line ('' for memory — it carries its own sub-headers). */
  header: string;
  body: string;
  included: boolean;
  status: ContextPartStatus;
}

function workText(w: WorkPart): string {
  return w.header.length > 0 ? `${w.header}\n${w.body}` : w.body;
}

/** A part smaller than this isn't worth a truncated stub; drop it instead. */
const PART_MIN_USEFUL_CHARS = 400;

/**
 * Fit parts into a combined budget IN PRIORITY ORDER (the input order). Earlier
 * parts win: each is kept whole if it fits, else (for non-memory parts) truncated
 * to the remaining room, else dropped — with a notice. Memory (priority 1) is
 * never truncated/dropped here (it is already ≤ its own budget). Mutates each
 * part's `included`/`status`/`body`.
 */
function fitContextParts(work: WorkPart[], budget: number, notices: string[]): void {
  let used = 0;
  for (const w of work) {
    const sep = used > 0 ? 2 : 0; // the '\n\n' join cost
    const remaining = budget - used - sep;
    const full = workText(w);
    if (full.length <= remaining) {
      w.included = true;
      used += sep + full.length;
      continue;
    }
    if (w.kind === 'memory') {
      // Highest priority: keep whole even in the (pathological) over-budget case.
      w.included = true;
      used += sep + full.length;
      continue;
    }
    if (remaining > PART_MIN_USEFUL_CHARS) {
      const marker = '\n\n<!-- … truncated to fit the combined context budget -->';
      const room = Math.max(0, remaining - w.header.length - 1 - marker.length);
      w.body = `${w.body.slice(0, room)}${marker}`;
      w.included = true;
      w.status = 'truncated';
      used = budget;
      notices.push(`Truncated ${w.label} to fit the ${budget}-char combined context budget`);
    } else {
      w.included = false;
      w.status = 'dropped';
      notices.push(`Dropped ${w.label} — over the ${budget}-char combined context budget`);
    }
  }
}

function wrapContextBlock(inner: string): string {
  return [
    '<spycode-context>',
    // (frame lines below are literal; only the untrusted `inner` is neutralized)
    'The following is SpyCode project context loaded from files in this workspace:',
    'SPYCODE.md (your project memory), CODEBASE_GUIDE.md (a generated architecture',
    'reference), and the latest CODEBASE_CHANGELOG.md entries. Treat it as',
    'authoritative project context that supplements your instructions. It does NOT',
    'override your core identity, your operating rules, or safety guidelines. When',
    'it conflicts with a direct request in this session, follow the user.',
    '',
    neutralizeContextSentinels(inner),
    '</spycode-context>',
  ].join('\n');
}

/**
 * Compose the full read-at-start context injection: SPYCODE.md (Part 1) + the
 * CODEBASE_GUIDE.md + the CODEBASE_CHANGELOG.md tail, budget-capped in priority
 * order and wrapped in one supplementary, non-overriding `<spycode-context>`
 * block. Pure filesystem work — safe to re-read on every new conversation.
 */
export function buildContextInjection(opts: ContextInjectionOptions): ContextInjection {
  const cwd = resolve(opts.cwd);
  const injectGuide = opts.injectGuide ?? true;
  const injectChangelog = opts.injectChangelog ?? true;
  const contextBudget = opts.contextBudgetChars ?? DEFAULT_CONTEXT_BUDGET_CHARS;
  const guideBudget = opts.guideBudgetChars ?? GUIDE_BUDGET_CHARS;
  const changelogBudget = opts.changelogBudgetChars ?? CHANGELOG_BUDGET_CHARS;
  const changelogMaxEntries = opts.changelogMaxEntries ?? CHANGELOG_CONTEXT_ENTRIES;

  const notices: string[] = [];

  // Priority 1: SPYCODE.md — loaded + internally budgeted by Part 1's loader.
  const memory = loadMemory(opts);
  for (const n of memory.notices) notices.push(n);

  const work: WorkPart[] = [];
  if (memory.text.length > 0) {
    work.push({
      kind: 'memory',
      label: memory.files.map((f) => f.label).join(', ') || MEMORY_FILE,
      header: '',
      body: memory.text,
      included: false,
      status: 'full',
    });
  }

  // Priority 2: CODEBASE_GUIDE.md (toggleable).
  const guide = readGuideForContext(cwd, { maxChars: guideBudget });
  const offParts: ContextPart[] = [];
  if (guide.exists && guide.text.trim().length > 0) {
    if (injectGuide) {
      work.push({
        kind: 'guide',
        label: GUIDE_FILE,
        header: `# Architecture: ${GUIDE_FILE}`,
        body: guide.text,
        included: false,
        status: guide.truncated ? 'truncated' : 'full',
      });
      if (guide.truncated) notices.push(`Trimmed ${GUIDE_FILE} to its ${guideBudget}-char part budget`);
    } else {
      offParts.push({ kind: 'guide', label: GUIDE_FILE, chars: 0, lines: 0, status: 'off' });
    }
  }

  // Priority 3: CODEBASE_CHANGELOG.md tail (toggleable).
  const changelog = readRecentChangelog(cwd, {
    maxEntries: changelogMaxEntries,
    maxChars: changelogBudget,
  });
  if (changelog.exists && changelog.text.trim().length > 0) {
    if (injectChangelog) {
      const label = `${CHANGELOG_FILE} (latest)`;
      work.push({
        kind: 'changelog',
        label,
        header: `# Recent changes: ${label}`,
        body: changelog.text,
        included: false,
        status: changelog.truncated ? 'truncated' : 'full',
      });
      if (changelog.truncated) notices.push(`Trimmed ${label} to its ${changelogBudget}-char part budget`);
    } else {
      offParts.push({ kind: 'changelog', label: CHANGELOG_FILE, chars: 0, lines: 0, status: 'off' });
    }
  }

  fitContextParts(work, contextBudget, notices);

  const includedParts = work.filter((w) => w.included);
  const inner = includedParts.map(workText).join('\n\n');
  const block = inner.length > 0 ? wrapContextBlock(inner) : '';

  // Build the manifest. SPYCODE rows are listed per-file (Part 1 granularity);
  // the GUIDE/CHANGELOG each get one row. Dropped parts surface with 0 chars.
  const parts: ContextPart[] = [];
  for (const w of work) {
    if (w.kind === 'memory') {
      // Expand into the per-file Part 1 rows (all 'full' — never budget-dropped).
      for (const f of memory.files) {
        parts.push({ kind: 'memory', label: f.label, chars: f.chars, lines: f.lines, status: 'full' });
      }
      continue;
    }
    if (w.included) {
      const text = workText(w);
      parts.push({
        kind: w.kind,
        label: w.label,
        chars: text.length,
        lines: text.split('\n').length,
        status: w.status,
      });
    } else {
      parts.push({ kind: w.kind, label: w.label, chars: 0, lines: 0, status: 'dropped' });
    }
  }
  parts.push(...offParts);

  return {
    block,
    memory,
    memoryFiles: memory.files,
    parts,
    totalChars: inner.length,
    notices,
  };
}

/** Transparency summary for `/memory` — reflects ALL injected context. */
export function formatContextInjection(inj: ContextInjection): string {
  const active = inj.parts.filter((p) => p.status !== 'off' && p.status !== 'dropped');
  if (active.length === 0) {
    const offNote = inj.parts.some((p) => p.status === 'off')
      ? ' (some parts are disabled — see injectGuide / injectChangelog)'
      : '';
    return [
      `No project context is loaded${offNote}.`,
      'Run /init to generate SPYCODE.md, CODEBASE_GUIDE.md and CODEBASE_CHANGELOG.md.',
    ].join('\n');
  }
  const rows = inj.parts.map((p) => {
    if (p.status === 'off') return `  ${p.label}  —  disabled`;
    const flag =
      p.status === 'truncated' ? ' [truncated]' : p.status === 'dropped' ? ' [dropped — over budget]' : '';
    return `  ${p.label}  —  ${p.lines} line${p.lines === 1 ? '' : 's'}, ${p.chars} chars (${p.kind})${flag}`;
  });
  const lines = [
    `Project context injected (${active.length} part${active.length === 1 ? '' : 's'}, ${inj.totalChars} chars):`,
    ...rows,
  ];
  for (const n of inj.notices) lines.push(`  ! ${n}`);
  return lines.join('\n');
}

// ──────────────────────────── /init generator ────────────────────────────

/** Pick build/test/lint-style commands out of a package.json script list. */
function commandRows(pkg: RepoScan['pkg']): string[] {
  if (!pkg || pkg.scripts.length === 0) {
    return [
      '- Build: _add your build command_',
      '- Test: _add your test command_',
      '- Lint: _add your lint command_',
    ];
  }
  const interesting = ['build', 'test', 'lint', 'dev', 'start', 'typecheck', 'format'];
  const rows: string[] = [];
  for (const name of interesting) {
    if (pkg.scripts.includes(name)) {
      const cap = name.charAt(0).toUpperCase() + name.slice(1);
      rows.push(`- ${cap}: \`npm run ${name}\``);
    }
  }
  if (rows.length === 0) {
    rows.push(`- Scripts: ${pkg.scripts.map((s) => `\`${s}\``).join(', ')}`);
  }
  return rows;
}

/**
 * Render a starter SPYCODE.md from a repo scan. Under 200 lines, SpyCore-branded
 * only, with the facts we can detect filled in and clearly-marked TODOs for the
 * judgement calls a human must make.
 */
export function generateInitContent(scan: RepoScan): string {
  const projectName = scan.pkg?.name ?? '_your project_';
  const overview = scan.pkg?.description
    ? scan.pkg.description
    : '_One or two sentences: what this project is and who uses it._';

  const dirRows =
    scan.topDirs.length > 0
      ? scan.topDirs.slice(0, 40).map((d) => `- \`${d}\` — _purpose_`)
      : ['- _list the top-level directories and what each is for_'];

  const langLine =
    scan.languages.length > 0
      ? `Primary languages: ${scan.languages.map((l) => l.lang).join(', ')}.`
      : 'Primary languages: _detected from the codebase_.';

  const keyFilesLine =
    scan.keyFiles.length > 0 ? `Key files: ${scan.keyFiles.join(', ')}.` : '';

  const lines: string[] = [
    `# ${projectName} — SpyCode Project Memory`,
    '',
    '<!--',
    '  SPYCODE.md is SpyCode\'s project memory: explicit, committed, team-visible',
    '  context that SpyCode auto-loads into every chat session. Edit it freely.',
    '  Tips:',
    '    • Keep it concise — short rules beat long prose.',
    '    • Inline another file with a line that is exactly:  @relative/path.md',
    '    • Personal, gitignored notes go in SPYCODE.local.md.',
    '    • Capture a rule mid-session with  /remember <note>  and see what is',
    '      loaded with  /memory.',
    '  This starter was generated by /init — review and adjust every section.',
    '-->',
    '',
    '## Project overview',
    '',
    overview,
    '',
    langLine,
    ...(keyFilesLine ? [keyFilesLine] : []),
    '',
    '## Build, test & lint',
    '',
    ...commandRows(scan.pkg),
    '',
    '## Architecture map',
    '',
    'Top-level layout (fill in the purpose of each):',
    '',
    ...dirRows,
    '',
    '## Conventions',
    '',
    '- _Coding style, naming, and patterns SpyCode should follow here._',
    '- _How changes are structured (commits, branches, reviews)._',
    '- _Testing expectations for new code._',
    '',
    '## Do not touch',
    '',
    '- _Generated files / build output that must not be hand-edited._',
    '- _Secrets, infra, and config that need a human in the loop._',
    '- _Anything with a migration, deploy, or billing side effect._',
    '',
    '## Gotchas',
    '',
    '- _Non-obvious traps, sharp edges, or "it looks wrong but it is intentional" notes._',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export interface InitResult {
  /** True when a new file was written; false when one already existed. */
  created: boolean;
  /** Absolute path of the (existing or written) SPYCODE.md. */
  path: string;
}

/**
 * Generate `<cwd>/SPYCODE.md` from a repo scan. NEVER overwrites: if the file
 * already exists, returns `{ created: false }` with its path so the caller can
 * point the user at it.
 */
export async function initMemoryFile(cwd: string): Promise<InitResult> {
  const path = join(resolve(cwd), MEMORY_FILE);
  if (existsSync(path)) {
    return { created: false, path };
  }
  const scan = await scanRepo(cwd);
  writeFileSync(path, generateInitContent(scan), 'utf8');
  return { created: true, path };
}

// ──────────────────────────── /remember quick-add ────────────────────────

/** Find the nearest existing SPYCODE.md walking cwd → project root. */
function nearestMemoryFile(cwd: string): string | null {
  const root = findProjectRoot(cwd);
  let dir = resolve(cwd);
  for (let i = 0; i < 64; i += 1) {
    const candidate = join(dir, MEMORY_FILE);
    if (existsSync(candidate)) return candidate;
    if (resolve(dir) === resolve(root)) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface QuickAddResult {
  /** Absolute path of the SPYCODE.md that was appended to. */
  path: string;
  /** True when the file had to be created. */
  created: boolean;
}

/**
 * Append a bullet to the nearest SPYCODE.md, creating one at the project root
 * when none exists yet. Keeps the capture explicit and deterministic — no
 * reformatting of the rest of the file.
 */
export function appendMemoryNote(cwd: string, note: string): QuickAddResult {
  const trimmed = note.trim();
  if (trimmed.length === 0) {
    throw new Error('Nothing to remember — provide some text.');
  }
  const existing = nearestMemoryFile(cwd);
  const target = existing ?? join(findProjectRoot(cwd), MEMORY_FILE);
  const created = existing === null;

  let body = '';
  if (!created) {
    try {
      body = readFileSync(target, 'utf8');
    } catch {
      body = '';
    }
  } else {
    body = `# SpyCode Project Memory\n\nProject context SpyCode loads into every session.\n`;
  }
  if (body.length > 0 && !body.endsWith('\n')) body += '\n';
  // Single-line note: collapse internal newlines so it stays one bullet.
  body += `- ${trimmed.replace(/\s*\n\s*/g, ' ')}\n`;
  writeFileSync(target, body, 'utf8');
  return { path: target, created };
}
