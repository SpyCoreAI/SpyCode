#!/usr/bin/env node
/**
 * audit-resolved-install.mjs — audit WHAT A USER'S INSTALL ACTUALLY RESOLVES.
 *
 * ⭐⭐ THE GAP THIS EXISTS TO CLOSE. Every advisory instrument in this
 * repository audits THE WORKSPACE: `pnpm audit` over the monorepo, resolved
 * through `pnpm-lock.yaml` and constrained by `pnpm-workspace.yaml`'s
 * `overrides`. None of that reaches a user. The published tarball contains no
 * lockfile and no overrides — it carries 15 caret ranges plus one optional
 * dependency, and the INSTALLING USER's package manager resolves them from the
 * registry, fresh, at install time.
 *
 * So an advisory recorded as "FIXED here, not allowlisted" by an override is
 * fixed in a file the published artifact never reads. F-2c-25 measured that
 * gap directly and found it decides real cases in both directions:
 *
 *   · 13 of 18 override keys name packages that are not in the CLI's install
 *     closure at all — they are server/web/mobile exposures.
 *   · The CRITICAL `shell-quote` advisory, recorded as "reached by the
 *     PUBLISHED CLI through ink > react-devtools-core", is not reachable that
 *     way: `react-devtools-core` is an OPTIONAL PEER of ink, and a fresh
 *     install of the published package does not install it. Neither it nor
 *     `shell-quote` is present. The record's mechanism was wrong AND its
 *     control was inert; the conclusion was safe by luck.
 *   · The three keys that DO name packages in the closure — `fast-uri`,
 *     `form-data`, `ws` — all resolve at or above their security floor from
 *     the upstream ranges alone, with no override involved.
 *
 * ⭐ AND WHY A ONE-OFF MEASUREMENT IS NOT AN ANSWER. That result is DATED. A
 * caret range resolves differently tomorrow, with no commit here. The
 * exposure of the published artifact is a moving target, so it needs an
 * instrument that re-asks, not a paragraph in a batch record.
 *
 * WHAT IT DOES
 *   Synthesises a package.json containing ONLY the CLI's `dependencies` and
 *   `optionalDependencies` — the manifest a user receives — in a temp dir with
 *   no lockfile and no overrides, resolves it with `npm install
 *   --package-lock-only`, and runs `npm audit` over that resolution.
 *
 *   node scripts/audit-resolved-install.mjs              # measure (network)
 *   node scripts/audit-resolved-install.mjs --json       # machine-readable
 *   node scripts/audit-resolved-install.mjs --self-test  # verdict logic, offline
 *
 * EXIT CODES
 *   0  no high/critical advisory in the resolved closure
 *   1  at least one high/critical advisory  (or a malformed audit payload)
 *   3  PRECONDITION — no network / npm unavailable. Never a false green.
 *
 * ⭐ EXIT 3 IS NOT A PASS. `pnpm audit`'s own wrapper learned this the hard way
 * (F-2c-21): a precondition that reports success is a control that has been
 * switched off. This one reports SKIPPED and says why.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The verdict, derived from an `npm audit --json` payload.
 *
 * ⭐⭐ IT REFUSES A PAYLOAD IT CANNOT READ, AND THAT IS THE POINT. Twice in this
 * arc a security verdict has been computed as `parsed.advisories ?? {}` or
 * `parsed.vulnerabilities ?? {}` — a payload missing the key then produces an
 * empty set, a clean count, and exit 0. A missing key is a BROKEN MEASUREMENT,
 * never a clean one.
 */
export function verdictFrom(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'audit payload is not an object', findings: [] };
  }
  if (!('vulnerabilities' in payload)) {
    return { ok: false, reason: 'audit payload has no `vulnerabilities` key — the measurement failed', findings: [] };
  }
  const vulns = payload.vulnerabilities;
  if (vulns === null || typeof vulns !== 'object' || Array.isArray(vulns)) {
    return { ok: false, reason: '`vulnerabilities` is not an object', findings: [] };
  }
  const findings = [];
  for (const [name, info] of Object.entries(vulns)) {
    const severity = info && typeof info === 'object' ? info.severity : undefined;
    if (severity !== 'high' && severity !== 'critical') continue;
    const via = info && Array.isArray(info.via) ? info.via : [];
    const titles = via.filter((v) => v && typeof v === 'object').map((v) => `${v.title ?? '?'} (${v.url ?? '?'})`);
    findings.push({ name, severity, titles: titles.length > 0 ? titles : ['(no advisory detail in payload)'] });
  }
  findings.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: findings.length === 0, reason: null, findings };
}

/** The manifest a user receives: production ranges only, no lockfile, no overrides. */
export function publishedManifest(cliPkg) {
  return {
    name: 'spycore-cli-resolved-install-probe',
    version: '0.0.0',
    private: true,
    dependencies: { ...(cliPkg.dependencies ?? {}) },
    optionalDependencies: { ...(cliPkg.optionalDependencies ?? {}) },
  };
}

// ───────────────────────────────── self-test ─────────────────────────────────

const SELF_TEST_CASES = [
  {
    name: 'a clean payload passes',
    payload: { vulnerabilities: {} },
    want: { ok: true, findings: 0 },
  },
  {
    name: 'a high advisory fails',
    payload: { vulnerabilities: { lodash: { severity: 'high', via: [{ title: 'Command Injection', url: 'GHSA-x' }] } } },
    want: { ok: false, findings: 1 },
  },
  {
    name: 'a critical advisory fails',
    payload: { vulnerabilities: { 'shell-quote': { severity: 'critical', via: [{ title: 'RCE', url: 'GHSA-y' }] } } },
    want: { ok: false, findings: 1 },
  },
  {
    name: 'moderate and low do NOT fail the gate',
    payload: {
      vulnerabilities: {
        a: { severity: 'moderate', via: [{ title: 'm' }] },
        b: { severity: 'low', via: [{ title: 'l' }] },
      },
    },
    want: { ok: true, findings: 0 },
  },
  {
    name: '⭐ a payload with NO `vulnerabilities` key FAILS — it is not a clean zero',
    payload: { metadata: { vulnerabilities: { high: 0 } } },
    want: { ok: false, findings: 0 },
  },
  {
    name: '⭐ `vulnerabilities: null` FAILS rather than reading as empty',
    payload: { vulnerabilities: null },
    want: { ok: false, findings: 0 },
  },
  {
    name: '⭐ an ARRAY payload FAILS rather than iterating to zero',
    payload: [],
    want: { ok: false, findings: 0 },
  },
  {
    name: 'a null payload FAILS',
    payload: null,
    want: { ok: false, findings: 0 },
  },
  {
    name: 'several highs are all reported, not just the first',
    payload: {
      vulnerabilities: {
        z: { severity: 'high', via: [{ title: 'z' }] },
        a: { severity: 'critical', via: [{ title: 'a' }] },
      },
    },
    want: { ok: false, findings: 2 },
  },
  {
    name: 'a high with a non-array `via` still fails and still names the package',
    payload: { vulnerabilities: { p: { severity: 'high', via: 'q' } } },
    want: { ok: false, findings: 1 },
  },
  {
    name: 'the published manifest carries ONLY prod + optional deps',
    manifest: { dependencies: { a: '^1' }, optionalDependencies: { b: '^2' }, devDependencies: { c: '^3' } },
    wantManifest: { deps: ['a'], opt: ['b'], hasDev: false },
  },
  {
    name: 'a manifest with no optionalDependencies still produces the key',
    manifest: { dependencies: { a: '^1' } },
    wantManifest: { deps: ['a'], opt: [], hasDev: false },
  },
];

function selfTest() {
  let ran = 0;
  let failed = 0;
  for (const c of SELF_TEST_CASES) {
    ran += 1;
    if (c.manifest) {
      const m = publishedManifest(c.manifest);
      const got = {
        deps: Object.keys(m.dependencies),
        opt: Object.keys(m.optionalDependencies),
        hasDev: 'devDependencies' in m,
      };
      const ok = JSON.stringify(got) === JSON.stringify(c.wantManifest);
      if (!ok) {
        failed += 1;
        console.error(`  FAIL ${c.name}\n       want ${JSON.stringify(c.wantManifest)}\n       got  ${JSON.stringify(got)}`);
      }
      continue;
    }
    const v = verdictFrom(c.payload);
    const ok = v.ok === c.want.ok && v.findings.length === c.want.findings;
    if (!ok) {
      failed += 1;
      console.error(`  FAIL ${c.name}\n       want ok=${c.want.ok} findings=${c.want.findings}\n       got  ok=${v.ok} findings=${v.findings.length} (${v.reason ?? 'no reason'})`);
    }
  }
  // ⭐ A PASS MUST BE PROVED ABLE TO SEE A CASE. F-I1 of the pre-publish review:
  // three instruments reported PASS over zero executed assertions, because
  // nothing ratcheted the CASE count. This refuses to report success on an
  // empty run, and the floor is a literal so it cannot be silently lowered.
  const FLOOR = 12;
  if (ran < FLOOR) {
    console.error(`SELF-TEST INVALID — ${ran} cases ran, floor is ${FLOOR}. A green over an empty run is not a green.`);
    return 1;
  }
  if (failed > 0) {
    console.error(`SELF-TEST FAILED — ${failed} of ${ran}`);
    return 1;
  }
  console.log(`SELF-TEST OK — ${ran} cases, both directions (clean passes, high/critical fails, malformed REFUSES).`);
  return 0;
}

// ───────────────────────────────── live run ──────────────────────────────────

function liveRun(asJson) {
  let dir;
  try {
    execFileSync('npm', ['--version'], { stdio: 'pipe' });
  } catch {
    console.error('SKIPPED (exit 3) — npm is not available on this host.');
    return 3;
  }
  const cliPkg = JSON.parse(readFileSync(join(CLI_DIR, 'package.json'), 'utf8'));
  const manifest = publishedManifest(cliPkg);
  try {
    dir = mkdtempSync(join(tmpdir(), 'spycore-resolved-'));
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    try {
      execFileSync('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], {
        cwd: dir,
        stdio: 'pipe',
        timeout: 300_000,
      });
    } catch (err) {
      console.error(`SKIPPED (exit 3) — could not resolve the published manifest (offline registry?): ${String(err?.message ?? err).split('\n')[0]}`);
      return 3;
    }
    let raw;
    try {
      raw = execFileSync('npm', ['audit', '--json', '--omit', 'dev'], { cwd: dir, stdio: 'pipe', timeout: 300_000 }).toString();
    } catch (err) {
      // npm audit exits non-zero WHEN IT FINDS SOMETHING — that is a result,
      // not a failure, and its stdout still carries the payload.
      raw = err?.stdout ? err.stdout.toString() : '';
      if (raw.trim().length === 0) {
        console.error(`SKIPPED (exit 3) — npm audit produced no payload: ${String(err?.message ?? err).split('\n')[0]}`);
        return 3;
      }
    }
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      console.error('FAILED — npm audit did not emit parseable JSON. A measurement that cannot be read is not a clean one.');
      return 1;
    }
    const verdict = verdictFrom(payload);
    const resolved = countResolved(dir);
    if (asJson) {
      console.log(JSON.stringify({ resolvedPackages: resolved, ...verdict }, null, 2));
    } else {
      console.log(`Resolved the PUBLISHED manifest fresh (no lockfile, no overrides): ${resolved} packages.`);
      if (verdict.reason) console.error(`FAILED — ${verdict.reason}`);
      else if (verdict.ok) console.log('No high or critical advisory in the closure a fresh install resolves.');
      else {
        console.error(`FAILED — ${verdict.findings.length} high/critical advisory package(s) in the closure a fresh install resolves:`);
        for (const f of verdict.findings) {
          console.error(`  [${f.severity}] ${f.name}`);
          for (const t of f.titles) console.error(`      ${t}`);
        }
      }
    }
    return verdict.ok && verdict.reason === null ? 0 : 1;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

function countResolved(dir) {
  try {
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
    return Object.keys(lock.packages ?? {}).filter((k) => k.length > 0).length;
  } catch {
    return -1;
  }
}

/**
 * ⭐ RUN ONLY WHEN EXECUTED, NEVER ON IMPORT — and compared on REAL PATHS.
 *
 * Two defects from this repository's own instrument audit are avoided here on
 * purpose. F-I8: reading argv and calling `process.exit` at module scope while
 * also exporting functions, so any importer is killed by the module it imported
 * (which is what happened the first time this file was pinned). F-I2: writing
 * the guard as ``import.meta.url === `file://${process.argv[1]}` `` — a form
 * that compares a PERCENT-ENCODED URL against a raw path, so three instruments
 * silently skipped their entire bodies, self-test included, under a checkout
 * path containing a space. Both sides are decoded and realpath'd instead.
 */
function isMain() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exit(process.argv.includes('--self-test') ? selfTest() : liveRun(process.argv.includes('--json')));
}
