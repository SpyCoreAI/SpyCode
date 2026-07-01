#!/usr/bin/env node
/**
 * gen-third-party-licenses.mjs — regenerate THIRD-PARTY-LICENSES.
 *
 * tsup bundles (inlines) our permissive runtime deps into build/*.js, so we
 * redistribute their code; MIT/ISC/BSD require their copyright + permission
 * notices to travel with that distribution. This script aggregates those
 * notices from the license data ALREADY present in node_modules — it adds NO
 * dependency (plain Node builtins only) and never touches the network.
 *
 * Scope = the transitive prod-dependency closure of the BUNDLED deps (every
 * `dependencies` entry that tsup does NOT mark `external`), pruned at the
 * external boundary (react/ink/@inkjs/ui/keytar resolve from the user's
 * node_modules at runtime and carry their own license dirs there).
 *
 *   node scripts/gen-third-party-licenses.mjs            # write the file
 *   node scripts/gen-third-party-licenses.mjs --check    # fail if out of date
 *
 * Output is deterministic (closure sorted by name@version) so --check is a
 * clean idempotency gate.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(CLI_DIR, 'THIRD-PARTY-LICENSES');

// Kept in lockstep with tsup.config.ts `external`. These are NOT bundled, so
// their licenses ship with the user's own install, not our artifact.
const EXTERNAL_ROOTS = new Set(['keytar', 'react', 'ink', '@inkjs/ui']);

const LICENSE_FILE_RE = /^(licen[sc]e|copying|notice|unlicense)(\.|$)/i;

/**
 * Node-style upward node_modules walk. The resolved dir is realpath'd so that
 * under pnpm — where the top-level entry is a symlink into the content-addressed
 * store — the recursion continues from the REAL store location, whose siblings
 * are the package's own (flattened) dependencies.
 */
function resolveDepDir(fromDir, dep) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', dep, 'package.json');
    if (existsSync(candidate)) {
      try {
        return realpathSync(dirname(candidate));
      } catch {
        return dirname(candidate);
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function spdx(pkg) {
  if (typeof pkg.license === 'string') return pkg.license;
  if (pkg.license && typeof pkg.license === 'object' && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(' OR ');
  return 'UNKNOWN';
}

function findLicenseText(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const file = names
    .filter((n) => LICENSE_FILE_RE.test(n))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))[0];
  if (!file) return null;
  const full = join(dir, file);
  try {
    if (!statSync(full).isFile()) return null;
    return readFileSync(full, 'utf8').replace(/\r\n/g, '\n').trim();
  } catch {
    return null;
  }
}

function homepageOf(pkg) {
  if (typeof pkg.homepage === 'string' && pkg.homepage) return pkg.homepage;
  const r = pkg.repository;
  let url = typeof r === 'string' ? r : r && typeof r.url === 'string' ? r.url : '';
  if (!url) return '';
  url = url.replace(/^git\+/, '').replace(/\.git$/, '');
  // Normalise an scp-style `git@host:owner/repo` to an https URL.
  const scp = url.match(/^git@([^:]+):(.+)$/);
  if (scp) url = `https://${scp[1]}/${scp[2]}`;
  // Normalise a bare `owner/repo` shorthand to a full GitHub URL.
  if (!/^[a-z]+:\/\//i.test(url) && /^[\w.-]+\/[\w.-]+$/.test(url)) {
    url = `https://github.com/${url}`;
  }
  return url;
}

// ── walk the bundled closure ────────────────────────────────────────────────
const cliPkg = readJson(join(CLI_DIR, 'package.json'));
const bundledRoots = Object.keys(cliPkg.dependencies ?? {}).filter((d) => !EXTERNAL_ROOTS.has(d));

const collected = new Map(); // key `name@version` → { name, version, license, homepage, text }
const missing = [];

function visit(dep, fromDir) {
  if (EXTERNAL_ROOTS.has(dep)) return;
  const dir = resolveDepDir(fromDir, dep);
  if (!dir) {
    missing.push(dep);
    return;
  }
  const pkg = readJson(join(dir, 'package.json'));
  const key = `${pkg.name}@${pkg.version}`;
  if (collected.has(key)) return;
  collected.set(key, {
    name: pkg.name,
    version: pkg.version,
    license: spdx(pkg),
    homepage: homepageOf(pkg),
    text: findLicenseText(dir),
  });
  for (const child of Object.keys(pkg.dependencies ?? {})) visit(child, dir);
}

for (const root of bundledRoots) visit(root, CLI_DIR);

const entries = [...collected.values()].sort((a, b) =>
  a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);

if (missing.length) {
  console.warn(`warning: could not resolve ${[...new Set(missing)].sort().join(', ')}`);
}

// ── render ──────────────────────────────────────────────────────────────────
const header = `SpyCode CLI (@spycore/cli) — Third-Party Software Notices

The SpyCode CLI is distributed as a bundle: its build step inlines the
permissive open-source packages listed below into the published artifact. Their
licenses require the copyright and permission notices to be reproduced in
distributions, so they are collected here.

This file is generated from the installed package metadata by
scripts/gen-third-party-licenses.mjs — do not edit it by hand.

Packages kept external (react, ink, @inkjs/ui, keytar) are resolved from your
own node_modules at install time and carry their licenses there; they are not
inlined into this artifact and so are not reproduced here.

Bundled packages (${entries.length}):
${entries.map((e) => `  - ${e.name}@${e.version} (${e.license})`).join('\n')}
`;

const sep = `\n${'='.repeat(78)}\n`;

const blocks = entries.map((e) => {
  const lines = [
    `${e.name}@${e.version}`,
    `License: ${e.license}`,
  ];
  if (e.homepage) lines.push(`Homepage: ${e.homepage}`);
  lines.push('');
  lines.push(
    e.text ??
      `(No license file was distributed with this package. Its declared SPDX license is ${e.license}.)`,
  );
  return lines.join('\n');
});

const output = `${header}${sep}${blocks.join(sep)}\n`;

if (process.argv.includes('--check')) {
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
  if (current !== output) {
    console.error('THIRD-PARTY-LICENSES is out of date — run: node scripts/gen-third-party-licenses.mjs');
    process.exit(1);
  }
  console.log(`THIRD-PARTY-LICENSES up to date (${entries.length} bundled packages).`);
} else {
  writeFileSync(OUT_FILE, output, 'utf8');
  console.log(`Wrote ${OUT_FILE} (${entries.length} bundled packages).`);
}
