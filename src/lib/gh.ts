/**
 * GitHub CLI (`gh`) seam for `spycore pr` - PHASE-1 1.5.
 *
 * PR creation shells out to the USER'S OWN `gh` binary; there is never a
 * GitHub API client in this package. This module is the single boundary so
 * tests can mock it and the command stays free of child_process wiring.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';

const GH_TIMEOUT_MS = 60_000;

/**
 * Resolve the `gh` binary to spawn.
 *
 * On POSIX the bare name works: the shell's PATH lookup finds it. On
 * Windows it does not: Node's bare-name spawn skips `.cmd`/`.bat` shims on
 * PATH (a `gh.cmd` in the first PATH directory loses to a real `gh.exe`
 * later on PATH - measured in branch CI, where the fake `gh.cmd` was never
 * invoked and the real GitHub CLI answered instead). So on Windows, probe
 * PATH ourselves - directory by directory, extensions in PATHEXT order,
 * the same resolution `cmd.exe` itself performs - and spawn the resolved
 * path, which Node executes (a `.cmd` path is wrapped in `cmd.exe`).
 * Null when no `gh` of any form is on PATH.
 */
export function resolveGhCommand(): string | null {
  if (process.platform !== 'win32') return 'gh';
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      const candidate = join(dir, `gh${ext}`);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        /* try the next candidate */
      }
    }
  }
  return null;
}

/** Spawn `gh`, resolved for the platform. Throws when no `gh` is on PATH. */
function runGh(args: string[], cwd?: string): string {
  const cmd = resolveGhCommand();
  if (cmd === null) throw new Error('gh: command not found on PATH');
  return execFileSync(cmd, args, {
    ...(cwd !== undefined ? { cwd } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GH_TIMEOUT_MS,
    encoding: 'utf8',
  })
    .toString()
    .trim();
}

/** True when a `gh` binary is on PATH. */
export function ghAvailable(): boolean {
  try {
    runGh(['--version']);
    return true;
  } catch {
    return false;
  }
}

/** True when `gh auth status` reports an authenticated account. */
export function ghAuthed(): boolean {
  try {
    runGh(['auth', 'status']);
    return true;
  } catch {
    return false;
  }
}

export interface GhPrCreateOpts {
  cwd: string;
  title: string;
  /** Body is passed via FILE - it never rides a shell argv. */
  bodyFile: string;
  base?: string | undefined;
  draft?: boolean | undefined;
}

/**
 * `gh pr create` - WRITE, reachable only behind the command's confirmation
 * gate. Returns gh's stdout (the PR URL) on success; throws gh's own stderr
 * message on failure so the caller can surface it verbatim (sanitized at
 * the display boundary).
 */
export function ghPrCreate(opts: GhPrCreateOpts): string {
  const args = ['pr', 'create', '--title', opts.title, '--body-file', opts.bodyFile];
  if (opts.base) args.push('--base', opts.base);
  if (opts.draft) args.push('--draft');
  try {
    return runGh(args, opts.cwd);
  } catch (err) {
    const e = err as { stderr?: unknown; message?: string };
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : '';
    throw new Error(stderr || e.message || 'gh pr create failed');
  }
}
