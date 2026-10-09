/**
 * Git helpers for the first-class git commands (`spycore commit` / `pr` /
 * `branch`) - PHASE-1 1.5.
 *
 * This is the ONE home for command-surface git execution. Every call goes
 * through the same execFileSync discipline the 1.4 drift guard established
 * (`lib/agent/resume.ts` `currentGitHead`): argv-array (never a shell),
 * piped stdio, a hard timeout. That module stays untouched - its single
 * read predates this one and is pinned by the resume tests.
 *
 * NOTHING here writes without being asked: the write helpers (stageAll,
 * commitWithMessageFile, pushCurrentBranch, createAndSwitchBranch) are only
 * reachable behind the commands' explicit confirmation gates.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GIT_TIMEOUT_MS = 15_000;
/** Diffs can be large; give reads a generous buffer (default is 1 MB). */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git with argv semantics. Never throws - failures come back ok:false. */
export function runGit(cwd: string, args: string[]): GitResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
    });
    return { ok: true, stdout: stdout.toString(), stderr: '' };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof e.stdout === 'string' ? e.stdout : String(e.stdout ?? ''),
      stderr: typeof e.stderr === 'string' ? e.stderr : String(e.stderr ?? ''),
    };
  }
}

/** True when cwd is inside a git work tree. */
export function isGitRepo(cwd: string): boolean {
  const r = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout.trim() === 'true';
}

/** Current branch name, or null when HEAD is detached / unreadable. */
export function currentBranch(cwd: string): string | null {
  const r = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!r.ok) return null;
  const name = r.stdout.trim();
  return name && name !== 'HEAD' ? name : null;
}

/** True when HEAD exists but no branch is checked out. */
export function isDetachedHead(cwd: string): boolean {
  const r = runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.ok && r.stdout.trim() === 'HEAD';
}

/** True while a merge is in progress (MERGE_HEAD present). */
export function mergeInProgress(cwd: string): boolean {
  return runGit(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).ok;
}

/** True when the index has staged changes. */
export function hasStagedChanges(cwd: string): boolean {
  // --quiet exits 1 when there ARE differences.
  return !runGit(cwd, ['diff', '--cached', '--quiet']).ok;
}

/** True when the working tree has any change (staged, unstaged, untracked). */
export function hasAnyChanges(cwd: string): boolean {
  const r = runGit(cwd, ['status', '--porcelain']);
  return r.ok && r.stdout.trim().length > 0;
}

/** `git status --porcelain` for the offer-to-stage listing. */
export function shortStatus(cwd: string): string {
  return runGit(cwd, ['status', '--porcelain']).stdout.trimEnd();
}

/** Staged file list with change kinds. */
export function stagedStat(cwd: string): string {
  return runGit(cwd, ['diff', '--cached', '--stat', '--no-color']).stdout.trimEnd();
}

/**
 * Staged diff, colorless. Binary changes surface only as git's own
 * "Binary files … differ" summary line - no hunks ever enter the prompt.
 */
export function stagedDiff(cwd: string): string {
  return runGit(cwd, ['diff', '--cached', '--no-color']).stdout;
}

/** Working-tree diff vs HEAD (staged + unstaged) - branch-name grounding. */
export function workingDiff(cwd: string): string {
  return runGit(cwd, ['diff', 'HEAD', '--no-color']).stdout;
}

/** Newest N commit subjects - style context for generation. */
export function recentSubjects(cwd: string, n: number): string {
  const r = runGit(cwd, ['log', '--oneline', '--no-color', `-${n}`]);
  return r.ok ? r.stdout.trimEnd() : '';
}

/** Stage everything. WRITE - reachable only behind an explicit confirmation. */
export function stageAll(cwd: string): GitResult {
  return runGit(cwd, ['add', '-A']);
}

/**
 * Commit with the message read from a FILE (mirrors our own no `-m`
 * discipline - the message never rides a shell argv). WRITE - confirm-gated.
 * Returns the new short hash on success.
 */
export function commitWithMessageFile(
  cwd: string,
  message: string,
): { ok: boolean; hash: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'spycore-commit-'));
  const file = join(dir, 'COMMIT_MSG');
  try {
    writeFileSync(file, message.endsWith('\n') ? message : `${message}\n`, 'utf8');
    const r = runGit(cwd, ['commit', '-F', file]);
    if (!r.ok) return { ok: false, hash: '', stderr: r.stderr.trim() };
    const head = runGit(cwd, ['rev-parse', '--short', 'HEAD']);
    return { ok: true, hash: head.stdout.trim(), stderr: '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** True when the repo has at least one remote configured. */
export function hasRemote(cwd: string): boolean {
  const r = runGit(cwd, ['remote']);
  return r.ok && r.stdout.trim().length > 0;
}

/**
 * The remote's default branch (e.g. `main`), read from the local
 * origin/HEAD symref. Null when unset - callers fall back to --base.
 */
export function defaultBaseBranch(cwd: string): string | null {
  const r = runGit(cwd, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (!r.ok) return null;
  const full = r.stdout.trim(); // "origin/main"
  const slash = full.indexOf('/');
  return slash > 0 ? full.slice(slash + 1) : null;
}

/** Upstream tracking ref of the current branch, or null when none is set. */
export function upstreamRef(cwd: string): string | null {
  const r = runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  return r.ok ? r.stdout.trim() : null;
}

/** Count of local commits the upstream doesn't have (0 when fully pushed). */
export function unpushedCount(cwd: string): number {
  const r = runGit(cwd, ['rev-list', '--count', '@{upstream}..HEAD']);
  if (!r.ok) return 0;
  const n = Number.parseInt(r.stdout.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Commit subjects on this branch that the base doesn't have. */
export function branchLog(cwd: string, base: string): GitResult {
  return runGit(cwd, ['log', '--oneline', '--no-color', `${base}..HEAD`]);
}

/** Merge-base diff of this branch vs the base (three-dot). */
export function branchDiff(cwd: string, base: string): GitResult {
  return runGit(cwd, ['diff', '--no-color', `${base}...HEAD`]);
}

/** Push the current branch. WRITE - reachable only behind `--push` + confirm. */
export function pushCurrentBranch(cwd: string): GitResult {
  const branch = currentBranch(cwd);
  if (!branch) return { ok: false, stdout: '', stderr: 'detached HEAD' };
  if (upstreamRef(cwd)) return runGit(cwd, ['push']);
  return runGit(cwd, ['push', '-u', 'origin', branch]);
}

/** True when a local branch with this name already exists. */
export function branchExists(cwd: string, name: string): boolean {
  return runGit(cwd, ['rev-parse', '-q', '--verify', `refs/heads/${name}`]).ok;
}

/** Create and switch to a new branch. WRITE - confirm-gated. */
export function createAndSwitchBranch(cwd: string, name: string): GitResult {
  return runGit(cwd, ['switch', '-c', name]);
}
