/**
 * dependency-audit.mjs - the mandatory dependency audit gate (M-6).
 *
 * No shebang, deliberately: the unit tests import `evaluateAuditReport`
 * from this file, and Vite's SSR transform rejects a shebang mid-file.
 * The script is always run via `node scripts/dependency-audit.mjs`, never
 * executed directly.
 *
 * Runs `pnpm audit --json` and fails on ANY high/critical advisory EXCEPT the
 * single known-patched one:
 *
 *   braces@3.0.3 / GHSA-vfj7-8cjw-p6xm
 *
 * No published braces release fixes that advisory (every release through 3.0.3
 * is affected; there is no 3.0.4 on npm), so the fix is backported via
 * `patchedDependencies` in pnpm-workspace.yaml. The exception is therefore
 * conditional, not a blanket waiver: it is granted ONLY while
 *   1. the advisory is exactly GHSA-vfj7-8cjw-p6xm,
 *   2. the affected package is exactly braces@3.0.3, and
 *   3. the backport patch is present AND recorded in pnpm-workspace.yaml AND
 *      the lockfile carries its patch hash.
 * If any of the three stops holding, the audit fails.
 *
 * Fail-closed on registry errors: an audit that cannot run is not a clean audit.
 *
 * Why spawnSync, not execFileSync: pnpm audit exits 1 whenever any advisory
 * at or above the audit level (default: low) remains, so execFileSync threw
 * before the gate below ever evaluated - the gate was dead code and the job
 * failed on any advisory at all. spawnSync lets the JSON report be parsed
 * regardless of exit status; the gate below still decides pass/fail, and
 * endpoint errors / non-JSON output still fail closed.
 *
 *   node scripts/dependency-audit.mjs
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const KNOWN = {
  ghsa: 'GHSA-vfj7-8cjw-p6xm',
  pkg: 'braces',
  version: '3.0.3',
  patchFile: 'patches/braces@3.0.3.patch',
};

// R4-5: the `pnpm audit` spawn is bounded, matching the sibling instrument
// (audit-resolved-install.mjs: 300_000 on both of its network calls). An
// audit that never returns is not a clean audit - without this the only
// bound was the CI job's 30-minute timeout, and locally the gate hung
// `prepublishOnly` with no output at all.
export const AUDIT_TIMEOUT_MS = 300_000;

function fail(msg) {
  console.error(`[dependency-audit] FAIL: ${msg}`);
  process.exit(1);
}
function say(msg) {
  console.log(`[dependency-audit] ${msg}`);
}

/** The backport patch must be present and wired, or the exception is void. */
function patchIsWired() {
  const patchPath = join(ROOT, KNOWN.patchFile);
  if (!existsSync(patchPath)) return 'patch file missing';
  const ws = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8');
  if (!ws.includes('braces@3.0.3: patches/braces@3.0.3.patch')) {
    return 'pnpm-workspace.yaml does not record the patch';
  }
  const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  if (!/braces@3\.0\.3\(patch_hash=/.test(lock)) return 'lockfile carries no patch hash for braces@3.0.3';
  return null;
}

/**
 * Resolve the `pnpm` binary to spawn. Same Windows constraint as
 * `src/lib/gh.ts` `resolveGhCommand`: Node's bare-name spawn skips
 * `.cmd`/`.bat` shims on PATH, and pnpm is normally installed exactly as
 * one (corepack ships `pnpm.cmd`). On Windows, probe PATH ourselves -
 * directory by directory, extensions in PATHEXT order - and spawn the
 * resolved path; on POSIX the bare name works as-is. Null when no `pnpm`
 * of any form is on PATH.
 *
 * The overrides exist so the win32 walk is unit-testable on Linux: pass
 * `platform: 'win32'` with a `pathEnv`/`pathext` and the same code runs
 * against real temp dirs. Without them the live platform and environment
 * are used.
 */
export function resolvePnpmCommand(overrides = {}) {
  const platform = overrides.platform ?? process.platform;
  if (platform !== 'win32') return 'pnpm';
  const exts = (overrides.pathext ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  for (const dir of (overrides.pathEnv ?? process.env.PATH ?? '').split(';')) {
    if (dir.length === 0) continue;
    for (const ext of exts) {
      const candidate = join(dir, `pnpm${ext}`);
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
 * Quote one token for a `cmd.exe /d /s /c` command line - the same
 * two-layer quoting as `src/lib/gh.ts` `buildCmdCommandLine` (this script
 * is plain JS and cannot import the TS module, so the ~10 lines live in
 * both places; keep them in agreement). `cmd.exe` expands `%VAR%` even
 * inside quotes and `^` is its escape character; the child then parses
 * with the MSVC argv rules, where a backslash before a quote - and a
 * trailing run of backslashes - decides whether the quote is a delimiter.
 * `"` is escaped as `\"` (cmd.exe passes it through, MSVC yields a
 * literal quote); `$`, backtick and `\` are literal to cmd.exe and need
 * no escaping.
 *
 * This quoting is the INNER layer only. How the finished command line
 * reaches `cmd.exe` is `buildPnpmSpawn`'s job - the 3e code passed it as
 * a plain argv element, Node re-quoted it (each inner `"` became `\"`),
 * and `cmd.exe /s` stripped only the outer pair, leaving the command
 * name literally `\"C:\...\pnpm.CMD\"` ("not recognized", branch CI run
 * 42501464919). The inner quoting was never wrong; the transport was.
 */
export function buildCmdCommandLine(tokens) {
  return tokens.map(quoteCmdToken).join(' ');
}

function quoteCmdToken(token) {
  // MSVC layer first: backslashes before a quote double, and a trailing run
  // of backslashes doubles, so a trailing `\"` cannot swallow the closing quote.
  let body = token.replace(/(\\*)"/g, (_m, slashes) => `${slashes}${slashes}\\"`);
  body = body.replace(/(\\+)$/, '$1$1');
  // cmd.exe layer: escape ^ first, so the caret introduced for % is not doubled.
  body = body.replace(/\^/g, '^^').replace(/%/g, '^%');
  return `"${body}"`;
}

/**
 * Build the spawn for a resolved `pnpm` command - the same two transport
 * rules as `src/lib/gh.ts` `buildGhSpawn` (same failure, same fix; this
 * script is plain JS and cannot import the TS module, so the shape is
 * duplicated with a cross-reference - keep them in agreement):
 *
 * 1. The `/c` argument carries its own outer pair of quotes around the
 *    already-quoted command line: `cmd.exe /s` strips exactly the first
 *    and last quote and leaves the rest unchanged (Microsoft cmd docs).
 * 2. Node must NOT re-quote the `/c` argument - its default argv quoting
 *    escapes each inner `"` as `\"`, which `/s` then leaves literal
 *    (`'\"C:\...\pnpm.CMD\"' is not recognized`, branch CI run
 *    42501464919). `windowsVerbatimArguments: true` disables that
 *    re-quoting; it is what Node sets automatically when `shell` is CMD.
 *
 * A resolved `.exe` spawns directly, as before. The `platform` override
 * exists so the win32 shape is unit-testable on Linux; without it the
 * live platform is used.
 */
export function buildPnpmSpawn(pnpm, args, platform = process.platform) {
  const useCmd = platform === 'win32' && /\.(?:cmd|bat)$/i.test(pnpm);
  if (!useCmd) return { file: pnpm, argv: args, windowsVerbatimArguments: false };
  return {
    file: process.env.ComSpec ?? 'cmd.exe',
    argv: ['/d', '/s', '/c', `"${buildCmdCommandLine([pnpm, ...args])}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * CLI entry point: run `pnpm audit --json` and judge it. Guarded so that
 * importing this module (the unit tests import `evaluateAuditReport`) does
 * NOT run the audit - only `node scripts/dependency-audit.mjs` does.
 */
function runFromCli() {
  const pnpm = resolvePnpmCommand();
  if (pnpm === null) fail('pnpm audit did not run: spawnSync pnpm ENOENT');
  // A resolved .cmd/.bat file cannot be spawned directly on Windows -
  // libuv returns EINVAL (measured in branch CI: `spawnSync
  // C:\...\pnpm.CMD EINVAL`). Run it via cmd.exe /d /s /c, built by
  // buildPnpmSpawn: the /c argument is double-wrapped and passed
  // verbatim, so cmd.exe /s strips the outer pair and the inner quoting
  // survives (see buildPnpmSpawn - the 3e single-wrapped form was
  // re-quoted by Node into '\"C:\...\pnpm.CMD\"', branch CI 42501464919).
  // `shell: true` is NOT the substitute: Node joins file and args with
  // bare spaces (child_process.js normalizeSpawnArguments), so an
  // argument with a space would split. A resolved .exe spawns directly,
  // as before.
  const target = buildPnpmSpawn(pnpm, ['audit', '--json']);
  const res = spawnSync(target.file, target.argv, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: AUDIT_TIMEOUT_MS,
    windowsVerbatimArguments: target.windowsVerbatimArguments,
  });
  if (res.error) {
    if (res.error.code === 'ETIMEDOUT') {
      fail(`pnpm audit did not run: timed out after ${AUDIT_TIMEOUT_MS / 1000}s - the registry or pnpm hung; refusing a vacuous pass`);
    }
    fail(`pnpm audit did not run: ${res.error.message}`);
  }
  const raw = res.stdout || '';
  if (!raw.trim()) {
    fail(`pnpm audit produced no output${res.stderr ? `: ${String(res.stderr).slice(0, 500)}` : ''}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    fail(`pnpm audit returned non-JSON output${res.stderr ? `: ${String(res.stderr).slice(0, 500)}` : ''}`);
  }
  main(data);
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) runFromCli();

/**
 * The verdict logic, pure and unit-testable (see tests/dependency-audit.test.ts).
 * Throws an Error for every fail-closed shape; returns the scan summary otherwise.
 */
/**
 * Exact version match for the known-advisory waiver. `String(versions)
 * .includes('3.0.3')` matched by SUBSTRING, so a future `3.0.30` (or any
 * range/token containing `3.0.3` as a prefix) would have been waived
 * silently. Split the field into version tokens - stripping range
 * operators (`<`, `<=`, `>=`, `^`, `~`, `=`) and list separators - and
 * require one token to equal the waived version exactly.
 */
function versionsMatchExactly(versions, version) {
  const tokens = String(versions)
    .split(/[\s,;]+/)
    .map((t) => t.replace(/^(>=|<=|>|<|=|\^|~)+/, ''))
    .filter((t) => t.length > 0);
  return tokens.includes(version);
}

export function evaluateAuditReport(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('audit report is not an object');
  }
  if (data.error) {
    throw new Error(`audit endpoint error: ${data.error.code || ''} ${data.error.message || ''}`.trim());
  }
  // NON-VACUOUS GUARD. A report without the `advisories` key is NOT a clean
  // audit - it is a shape change or an error payload that still parsed as
  // JSON. The old code defaulted a missing key to `[]` and exited 0 with
  // "clean: 0 advisories scanned", passing vacuously. A real clean audit
  // carries the key with an empty object; only a missing key fails here.
  // R4-1: the same applies to a PRESENT-but-malformed value. `null`, a
  // string, or a number used to collapse to `[]` through the ternary below
  // and pass as a clean 0-advisory scan, so the key-presence check alone
  // did not close the hole. `advisories` must be an object or an array -
  // mirroring `verdictFrom` in scripts/audit-resolved-install.mjs, which
  // rejects a non-object `vulnerabilities` value outright.
  if (!('advisories' in data)) {
    throw new Error(
      'audit report has no `advisories` key - cannot tell a clean audit from a changed/error payload; refusing a vacuous pass',
    );
  }
  // pnpm's JSON nests advisories under `advisories` (object keyed by GHSA id or
  // an array); be liberal in what we accept, strict in what we allow.
  const adv = data.advisories;
  if (adv === null || typeof adv !== 'object') {
    throw new Error(
      '`advisories` is not an object or array - cannot tell a clean audit from a changed/error payload; refusing a vacuous pass',
    );
  }
  const list = Array.isArray(adv) ? adv : Object.values(adv);

  const HIGH = new Set(['high', 'critical']);
  // npm's severity domain. A severity outside it is a payload this gate
  // cannot read - R4-2: the old form lowercased whatever it was given and
  // skipped anything not high/critical, so a malformed entry or an unknown
  // severity ('severe') verdicted clean.
  const KNOWN_SEVERITIES = new Set(['low', 'moderate', 'high', 'critical']);
  let blocked = 0;
  let waived = 0;
  for (const a of list) {
    if (a === null || typeof a !== 'object' || Array.isArray(a)) {
      throw new Error(
        'advisory entry is not an object - cannot tell a clean audit from a changed/error payload; refusing a vacuous pass',
      );
    }
    if (typeof a.severity !== 'string') {
      throw new Error(
        'advisory entry has no readable severity - cannot tell a clean audit from a changed/error payload; refusing a vacuous pass',
      );
    }
    const severity = a.severity.toLowerCase();
    if (!KNOWN_SEVERITIES.has(severity)) {
      throw new Error(
        `advisory entry has unknown severity \`${a.severity}\` - cannot tell a clean audit from a changed/error payload; refusing a vacuous pass`,
      );
    }
    if (!HIGH.has(severity)) continue;
    const id = a.id || a.ghsaId || a.advisoryId || '';
    const pkg = a.package_name || a.packageName || a.module_name || '';
    const versions = a.vulnerable_versions || a.vulnerableVersions || '';
    const isKnown =
      String(id).toUpperCase() === KNOWN.ghsa.toUpperCase() &&
      pkg === KNOWN.pkg &&
      versionsMatchExactly(versions, KNOWN.version);
    if (isKnown) {
      const hole = patchIsWired();
      if (hole) throw new Error(`known advisory ${KNOWN.ghsa} is NOT patched (${hole}) - refusing the exception`);
      waived += 1;
      say(`known-patched advisory waived: ${KNOWN.ghsa} (${KNOWN.pkg}@${KNOWN.version}) - backport verified wired`);
      continue;
    }
    blocked += 1;
    console.error(
      `[dependency-audit] BLOCKED: ${id} severity=${severity} package=${pkg} versions=${versions} title=${a.title || ''}`,
    );
  }

  if (blocked > 0) throw new Error(`${blocked} high/critical advisorie(s) above the gate`);
  return { scanned: list.length, waived, blocked: 0 };
}

function main(data) {
  let result;
  try {
    result = evaluateAuditReport(data);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  say(`clean: ${result.scanned} advisorie(s) scanned, ${result.waived} known-patched waived, 0 high/critical outstanding`);
}
