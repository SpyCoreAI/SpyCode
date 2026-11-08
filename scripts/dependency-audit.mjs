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
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const KNOWN = {
  ghsa: 'GHSA-vfj7-8cjw-p6xm',
  pkg: 'braces',
  version: '3.0.3',
  patchFile: 'patches/braces@3.0.3.patch',
};

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
 * CLI entry point: run `pnpm audit --json` and judge it. Guarded so that
 * importing this module (the unit tests import `evaluateAuditReport`) does
 * NOT run the audit - only `node scripts/dependency-audit.mjs` does.
 */
function runFromCli() {
  const res = spawnSync('pnpm', ['audit', '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.error) fail(`pnpm audit did not run: ${res.error.message}`);
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
  if (!('advisories' in data)) {
    throw new Error(
      'audit report has no `advisories` key - cannot tell a clean audit from a changed/error payload; refusing a vacuous pass',
    );
  }
  // pnpm's JSON nests advisories under `advisories` (object keyed by GHSA id or
  // an array); be liberal in what we accept, strict in what we allow.
  const adv = data.advisories;
  const list = Array.isArray(adv) ? adv : adv && typeof adv === 'object' ? Object.values(adv) : [];
  if (!Array.isArray(list)) throw new Error('unexpected pnpm audit JSON shape');

  const HIGH = new Set(['high', 'critical']);
  let blocked = 0;
  let waived = 0;
  for (const a of list) {
    const severity = String(a.severity || '').toLowerCase();
    if (!HIGH.has(severity)) continue;
    const id = a.id || a.ghsaId || a.advisoryId || '';
    const pkg = a.package_name || a.packageName || a.module_name || '';
    const versions = a.vulnerable_versions || a.vulnerableVersions || '';
    const isKnown =
      String(id).toUpperCase() === KNOWN.ghsa.toUpperCase() &&
      pkg === KNOWN.pkg &&
      String(versions).includes(KNOWN.version);
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
