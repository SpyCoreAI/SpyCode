/**
 * GitHub CLI (`gh`) seam for `spycore pr` — PHASE-1 1.5.
 *
 * PR creation shells out to the USER'S OWN `gh` binary; there is never a
 * GitHub API client in this package. This module is the single boundary so
 * tests can mock it and the command stays free of child_process wiring.
 */
import { execFileSync } from 'node:child_process';

const GH_TIMEOUT_MS = 60_000;

/** True when a `gh` binary is on PATH. */
export function ghAvailable(): boolean {
  try {
    execFileSync('gh', ['--version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GH_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/** True when `gh auth status` reports an authenticated account. */
export function ghAuthed(): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GH_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export interface GhPrCreateOpts {
  cwd: string;
  title: string;
  /** Body is passed via FILE — it never rides a shell argv. */
  bodyFile: string;
  base?: string | undefined;
  draft?: boolean | undefined;
}

/**
 * `gh pr create` — WRITE, reachable only behind the command's confirmation
 * gate. Returns gh's stdout (the PR URL) on success; throws gh's own stderr
 * message on failure so the caller can surface it verbatim (sanitized at
 * the display boundary).
 */
export function ghPrCreate(opts: GhPrCreateOpts): string {
  const args = ['pr', 'create', '--title', opts.title, '--body-file', opts.bodyFile];
  if (opts.base) args.push('--base', opts.base);
  if (opts.draft) args.push('--draft');
  try {
    return execFileSync('gh', args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GH_TIMEOUT_MS,
      encoding: 'utf8',
    })
      .toString()
      .trim();
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    throw new Error(stderr || e.message || 'gh pr create failed');
  }
}
