/**
 * GitHub CLI (`gh`) seam for `spycore pr` - PHASE-1 1.5.
 *
 * PR creation shells out to the USER'S OWN `gh` binary; there is never a
 * GitHub API client in this package. This module is the single boundary so
 * tests can mock it and the command stays free of child_process wiring.
 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { join } from 'node:path';

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
 * path. Null when no `gh` of any form is on PATH.
 *
 * The overrides exist so the win32 walk is unit-testable on Linux: pass
 * `platform: 'win32'` with a `pathEnv`/`pathext` and the same code runs
 * against real temp dirs. Without them the live platform and environment
 * are used.
 */
export interface GhResolveOverrides {
  platform?: NodeJS.Platform;
  /** PATH value to search (win32 only). Defaults to `process.env.PATH`. */
  pathEnv?: string;
  /** PATHEXT value (win32 only). Defaults to `process.env.PATHEXT`. */
  pathext?: string;
}

export function resolveGhCommand(overrides: GhResolveOverrides = {}): string | null {
  const platform = overrides.platform ?? process.platform;
  if (platform !== 'win32') return 'gh';
  const exts = (overrides.pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  for (const dir of (overrides.pathEnv ?? process.env.PATH ?? '').split(';')) {
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

/**
 * Quote one token for a `cmd.exe /d /s /c` command line.
 *
 * Two parsers read the result in turn, so both layers must be satisfied:
 * `cmd.exe` first (it expands `%VAR%` even inside quotes, and `^` is its
 * escape character), then the MSVC argv parser of the child (backslash
 * before a quote, and a trailing run of backslashes, decide whether the
 * quote is a delimiter). `"` is escaped as `\"`: `cmd.exe` passes it
 * through and MSVC yields a literal quote - measured in branch CI, where
 * a POSIX-escaped `\"` arrived intact as one argument while `\$`, backtick
 * and `\\` arrived with their backslashes still attached. `$`, backtick
 * and `\` are literal to `cmd.exe` and need no escaping at all.
 *
 * This quoting is the INNER layer only. How the finished command line
 * reaches `cmd.exe` is `buildGhSpawn`'s job - the 3e code passed it as a
 * plain argv element, Node re-quoted it (each inner `"` became `\"`),
 * and `cmd.exe /s` stripped only the outer pair, leaving the command
 * name literally `\"C:\...\gh.CMD\"` ("not recognized", branch CI run
 * 42501464919). The inner quoting was never wrong; the transport was.
 */
export function buildCmdCommandLine(tokens: string[]): string {
  return tokens.map(quoteCmdToken).join(' ');
}

function quoteCmdToken(token: string): string {
  // MSVC layer first: backslashes before a quote double, and a trailing run
  // of backslashes doubles, so a trailing `\"` cannot swallow the closing quote.
  let body = token.replace(/(\\*)"/g, (_m, slashes: string) => `${slashes}${slashes}\\"`);
  body = body.replace(/(\\+)$/, '$1$1');
  // cmd.exe layer: escape ^ first, so the caret introduced for % is not doubled.
  body = body.replace(/\^/g, '^^').replace(/%/g, '^%');
  return `"${body}"`;
}

/** What to spawn for one `gh` invocation: the file, its argv, and whether
 * Node must pass argv verbatim on Windows. */
export interface GhSpawnTarget {
  file: string;
  argv: string[];
  windowsVerbatimArguments: boolean;
}

/**
 * Build the spawn for a resolved `gh` command.
 *
 * A resolved `.cmd`/`.bat` file cannot be spawned directly on Windows -
 * libuv returns EINVAL (the file is not an executable, only cmd.exe can
 * interpret it; Node docs, child_process "Spawning .bat and .cmd files on
 * Windows"). Run it via cmd.exe /d /s /c. Two transport rules, both
 * load-bearing - get either wrong and the fake is never invoked:
 *
 * 1. The `/c` argument carries its own outer pair of quotes around the
 *    already-quoted command line. `cmd.exe /s` strips exactly the first
 *    and last quote of the string and leaves the rest unchanged
 *    (Microsoft cmd docs), so the strip removes the outer pair and the
 *    inner quoting survives intact.
 * 2. Node must NOT re-quote the `/c` argument. Its default argv quoting
 *    wraps the string in quotes and escapes each inner `"` as `\"`; `/s`
 *    then strips the outer pair and leaves the command name literally
 *    `\"C:\...\gh.CMD\"` - "not recognized as an internal or external
 *    command", branch CI run 42501464919, all six `gh` tests and both
 *    `pnpm` tests. `windowsVerbatimArguments: true` disables that
 *    re-quoting (Node docs: "No quoting or escaping of arguments is done
 *    on Windows"); it is the same flag Node sets automatically when
 *    `shell` is CMD, which is why the `shell: true` executors never hit
 *    this. `shell: true` is NOT the substitute here: Node joins file and
 *    args with bare spaces (child_process.js normalizeSpawnArguments), so
 *    an argument with a space ('Test PR', a temp path) would split.
 *
 * A resolved `.exe` spawns directly, as before - the production binary
 * is an `.exe`, the `.cmd` path is the shim case (corepack-style
 * installs, and the test fake). The `platform` override exists so the
 * win32 shape is unit-testable on Linux; without it the live platform
 * is used.
 */
export function buildGhSpawn(
  cmd: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): GhSpawnTarget {
  const useCmd = platform === 'win32' && /\.(?:cmd|bat)$/i.test(cmd);
  if (!useCmd) return { file: cmd, argv: args, windowsVerbatimArguments: false };
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    argv: ['/d', '/s', '/c', `"${buildCmdCommandLine([cmd, ...args])}"`],
    windowsVerbatimArguments: true,
  };
}

/** Spawn `gh`, resolved for the platform. Throws when no `gh` is on PATH. */
function runGh(args: string[], cwd?: string): string {
  const cmd = resolveGhCommand();
  if (cmd === null) throw new Error('gh: command not found on PATH');
  const target = buildGhSpawn(cmd, args);
  // `windowsVerbatimArguments` is a valid runtime option - Node's docs
  // list it for execFile, and the async ExecFileOptions type carries it -
  // but @types/node@20.19.43 omits it from ExecFileSyncOptions, a types
  // gap. The spread below carries it past tsc without widening the rest
  // of the literal (spreads are exempt from excess-property checks).
  const verbatim: { windowsVerbatimArguments?: boolean } = target.windowsVerbatimArguments
    ? { windowsVerbatimArguments: true }
    : {};
  return execFileSync(target.file, target.argv, {
    ...(cwd !== undefined ? { cwd } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: GH_TIMEOUT_MS,
    encoding: 'utf8',
    ...verbatim,
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
