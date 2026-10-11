#!/usr/bin/env node
/**
 * dependency-audit.mjs - the mandatory dependency audit gate (M-6).
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
 *   node scripts/dependency-audit.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

let raw;
try {
  raw = execFileSync('pnpm', ['audit', '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  fail(`pnpm audit did not run cleanly: ${(e && e.message) || e}`);
}
let data;
try {
  data = JSON.parse(raw);
} catch {
  fail('pnpm audit returned non-JSON output');
}
if (data && data.error) {
  fail(`audit endpoint error: ${data.error.code || ''} ${data.error.message || ''}`.trim());
}

// pnpm's JSON nests advisories under `advisories` (object keyed by GHSA id or
// an array); be liberal in what we accept, strict in what we allow.
const adv = data && data.advisories;
const list = Array.isArray(adv) ? adv : adv && typeof adv === 'object' ? Object.values(adv) : [];
if (!Array.isArray(list)) fail('unexpected pnpm audit JSON shape');

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
    if (hole) fail(`known advisory ${KNOWN.ghsa} is NOT patched (${hole}) - refusing the exception`);
    waived += 1;
    say(`known-patched advisory waived: ${KNOWN.ghsa} (${KNOWN.pkg}@${KNOWN.version}) - backport verified wired`);
    continue;
  }
  blocked += 1;
  console.error(
    `[dependency-audit] BLOCKED: ${id} severity=${severity} package=${pkg} versions=${versions} title=${a.title || ''}`,
  );
}

if (blocked > 0) fail(`${blocked} high/critical advisorie(s) above the gate`);
say(`clean: ${list.length} advisorie(s) scanned, ${waived} known-patched waived, 0 high/critical outstanding`);
