/**
 * Write-at-end task lifecycle — Part 3b of SpyCode's living-memory system.
 *
 * After an agent task completes (the orchestrator's single end-of-run boundary,
 * right where it calls `saveSession`), this records what the task did into the
 * END-USER's project-root living-memory files:
 *   - PREPENDs a newest-first entry to ./CODEBASE_CHANGELOG.md (when it exists +
 *     ≥1 file was touched + the `autoChangelog` toggle is on), listing the
 *     files-touched grouped by kind + a one-line task summary, and
 *   - when the repo's top-level structure or package.json deps changed, NOTES it
 *     in the entry and (when `autoRefreshGuide` is on + the guide exists)
 *     regenerates ./CODEBASE_GUIDE.md via the Part 2 refresh path, which PRESERVES
 *     a "## Notes (manual)" section. The refresh is always surfaced so the user
 *     knows the file changed.
 *
 * It REUSES the loop's existing per-task change collector (`RecordedChange[]`,
 * accumulated via `ctx.recordChange` and already used for `spycore rewind`) —
 * the file-edit tools are the source of touched paths; nothing forks the loop.
 *
 * Failure isolation: every path is wrapped so a changelog/guide write can NEVER
 * throw into the agent flow — it degrades to a soft result with an `error` note.
 *
 * NOTE: these are the USER's per-repo files, written wherever the `spycore` CLI
 * runs; nothing here ever writes into the CLI's own source tree.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { RecordedChange } from './checkpoint.js';
import {
  CHANGELOG_FILE,
  appendChangelogEntry,
  formatChangelogEntry,
  nowStamp,
} from '../codebase-changelog.js';
import { GUIDE_FILE, refreshCodebaseGuide } from '../codebase-guide.js';

/** Top-level directories never counted as structural (mirrors repo-scan). */
const IGNORE_DIRS = new Set(['node_modules', '.git', 'build', 'dist']);

/** A cheap structural fingerprint of the repo: top-level dirs + dep names. */
export interface StructureSnapshot {
  /** Top-level directory names (sorted), excluding build/VCS dirs. */
  dirs: string[];
  /** Sorted package.json dependency + devDependency names. */
  deps: string[];
}

function topLevelDirs(cwd: string): string[] {
  try {
    return readdirSync(cwd, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !IGNORE_DIRS.has(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

function packageDeps(cwd: string): string[] {
  const p = join(cwd, 'package.json');
  if (!existsSync(p)) return [];
  try {
    const pj = JSON.parse(readFileSync(p, 'utf8')) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const names = [
      ...(pj.dependencies && typeof pj.dependencies === 'object' ? Object.keys(pj.dependencies) : []),
      ...(pj.devDependencies && typeof pj.devDependencies === 'object' ? Object.keys(pj.devDependencies) : []),
    ];
    return [...new Set(names)].sort();
  } catch {
    return [];
  }
}

/**
 * Capture the repo's structural fingerprint. Call at task START (so the end hook
 * can diff against it). Lightweight + sync; never throws.
 */
export function snapshotStructure(cwd: string): StructureSnapshot {
  const root = resolve(cwd);
  return { dirs: topLevelDirs(root), deps: packageDeps(root) };
}

export interface TouchedFiles {
  created: string[];
  modified: string[];
  deleted: string[];
}

function relPath(root: string, abs: string): string {
  const r = relative(root, abs);
  return r.length > 0 && !r.startsWith('..') ? r : abs;
}

/**
 * Reduce the loop's accumulated `RecordedChange[]` to relative paths grouped by
 * kind. Dedups per path (create beats modify when both occurred); a recorded
 * path that no longer exists at task end is reported as DELETED (catches a file
 * the agent wrote then removed via run_command, which the journal can't see).
 */
export function summarizeTouchedFiles(changes: RecordedChange[], cwd: string): TouchedFiles {
  const root = resolve(cwd);
  const kind = new Map<string, 'create' | 'modify'>();
  for (const c of changes) {
    if (kind.get(c.path) === 'create') continue; // create is sticky
    kind.set(c.path, c.op);
  }
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [abs, op] of kind) {
    const rel = relPath(root, abs);
    if (!existsSync(abs)) deleted.push(rel);
    else if (op === 'create') created.push(rel);
    else modified.push(rel);
  }
  created.sort();
  modified.sort();
  deleted.sort();
  return { created, modified, deleted };
}

export interface StructuralChange {
  newDirs: string[];
  removedDirs: string[];
  depsChanged: boolean;
  changed: boolean;
}

/** Diff two structural snapshots (before vs after the task). */
export function detectStructuralChange(
  before: StructureSnapshot,
  after: StructureSnapshot,
): StructuralChange {
  const beforeDirs = new Set(before.dirs);
  const afterDirs = new Set(after.dirs);
  const newDirs = after.dirs.filter((d) => !beforeDirs.has(d));
  const removedDirs = before.dirs.filter((d) => !afterDirs.has(d));
  const depsChanged = before.deps.join('\n') !== after.deps.join('\n');
  return {
    newDirs,
    removedDirs,
    depsChanged,
    changed: newDirs.length > 0 || removedDirs.length > 0 || depsChanged,
  };
}

/** Human note describing a structural change, or null when nothing changed. */
function structuralNote(sc: StructuralChange): string | null {
  if (!sc.changed) return null;
  const bits: string[] = [];
  if (sc.newDirs.length > 0) {
    bits.push(`new dir${sc.newDirs.length === 1 ? '' : 's'} ${sc.newDirs.map((d) => `\`${d}/\``).join(', ')}`);
  }
  if (sc.removedDirs.length > 0) {
    bits.push(
      `removed dir${sc.removedDirs.length === 1 ? '' : 's'} ${sc.removedDirs.map((d) => `\`${d}/\``).join(', ')}`,
    );
  }
  if (sc.depsChanged) bits.push('package.json dependencies changed');
  return `Note: project structure changed — ${bits.join('; ')}.`;
}

export interface FinalizeTaskMemoryInput {
  cwd: string;
  /** The user's request — the entry's one-line summary. */
  task: string;
  /** The loop's accumulated change journal for the whole task. */
  changes: RecordedChange[];
  /** Structural snapshot taken at task start (for the diff). */
  before: StructureSnapshot;
  /** Heading stamp override (tests pin this; defaults to now). */
  stamp?: string | undefined;
  /** Append the changelog entry (default true). */
  autoChangelog?: boolean | undefined;
  /** Refresh the guide on a structural change (default true). */
  autoRefreshGuide?: boolean | undefined;
}

export interface FinalizeTaskMemoryResult {
  /** True when a changelog entry was prepended. */
  appended: boolean;
  /** Absolute path of CODEBASE_CHANGELOG.md. */
  changelogPath: string;
  /** True when CODEBASE_GUIDE.md was regenerated. */
  guideRefreshed: boolean;
  /** The structural-change note baked into the entry, or null. */
  structuralNote: string | null;
  /** The files-touched summary used. */
  touched: TouchedFiles;
  /** A one-line notice for the orchestrator to surface, or null. */
  notice: string | null;
  /** Set when an isolated failure was swallowed. */
  error?: string | undefined;
}

/**
 * The write-at-end hook. Idempotent BY CONSTRUCTION: the orchestrator calls it
 * exactly ONCE per task (at its single `saveSession` boundary), so it writes at
 * most one entry per task — never per tool-call/turn/retry. Skips entirely when
 * no files were touched (no noise for pure Q&A turns). Never throws.
 */
export async function finalizeTaskMemory(
  input: FinalizeTaskMemoryInput,
): Promise<FinalizeTaskMemoryResult> {
  const cwd = resolve(input.cwd);
  const autoChangelog = input.autoChangelog ?? true;
  const autoRefreshGuide = input.autoRefreshGuide ?? true;
  const result: FinalizeTaskMemoryResult = {
    appended: false,
    changelogPath: join(cwd, CHANGELOG_FILE),
    guideRefreshed: false,
    structuralNote: null,
    touched: { created: [], modified: [], deleted: [] },
    notice: null,
  };
  try {
    // Skip-when-empty: pure Q&A / read-only turns leave no entry.
    if (input.changes.length === 0) return result;

    const touched = summarizeTouchedFiles(input.changes, cwd);
    result.touched = touched;

    const after = snapshotStructure(cwd);
    const sc = detectStructuralChange(input.before, after);
    const note = structuralNote(sc);
    result.structuralNote = note;

    // Guide refresh: only on a structural change, only when enabled, and only
    // when the guide ALREADY exists (never create it from the write path). The
    // refresh preserves the "## Notes (manual)" section. Isolated failure.
    if (sc.changed && autoRefreshGuide && existsSync(join(cwd, GUIDE_FILE))) {
      try {
        await refreshCodebaseGuide(cwd);
        result.guideRefreshed = true;
      } catch {
        /* a guide-refresh failure must not abort the changelog append */
      }
    }

    // Append the entry: requires the changelog file (the /init opt-in signal)
    // and the toggle. The structural + guide-refresh notes live in the entry.
    if (autoChangelog && existsSync(result.changelogPath)) {
      const notes: string[] = [];
      if (note) notes.push(note);
      if (result.guideRefreshed) {
        notes.push('Refreshed CODEBASE_GUIDE.md (structure changed; manual notes preserved).');
      }
      const entry = formatChangelogEntry({
        stamp: input.stamp ?? nowStamp(),
        summary: input.task,
        created: touched.created,
        modified: touched.modified,
        deleted: touched.deleted,
        notes,
      });
      const appended = appendChangelogEntry(cwd, entry);
      result.appended = appended.appended;
    }

    const bits: string[] = [];
    if (result.appended) bits.push('logged this task to CODEBASE_CHANGELOG.md');
    if (result.guideRefreshed) bits.push('refreshed CODEBASE_GUIDE.md (structure changed)');
    result.notice = bits.length > 0 ? `✓ SpyCode ${bits.join('; ')}.` : null;
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
}
