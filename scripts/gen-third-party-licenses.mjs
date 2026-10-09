#!/usr/bin/env node
/**
 * gen-third-party-licenses.mjs - regenerate THIRD-PARTY-LICENSES.
 *
 *  F-2c-25 - THIS SCRIPT'S PREMISE WAS FALSE, AND IT WAS FALSE IN A SHIPPED
 * LEGAL NOTICE. It said "tsup bundles (inlines) our permissive runtime deps
 * into build/*.js, so we redistribute their code", and the file it generates
 * said the same thing to every user who read it. Measured on the actual built
 * artifact: **0 of the 122 packages it called "Bundled" appear in `build/` at
 * all.** All 15 `dependencies` and the 1 `optionalDependencies` entry are
 * emitted as bare import specifiers and resolved by the INSTALLING USER's
 * package manager - tsup externalises every production dependency on the node
 * platform, regardless of the six names `tsup.config.ts` lists explicitly.
 *
 *  The premise was carried unverified through the pre-publish audit AND
 * through the review that found it, in both cases because it was stated
 * confidently somewhere upstream. It was settled by building the package and
 * reading the output, which took one command.
 *
 * SCOPE, and why it changed with the premise: this used to prune the closure at
 * `react`/`ink`/`@inkjs/ui`/`keytar` on the grounds that those four "are not
 * bundled". That is now known to be true of every root, so the distinction
 * described nothing and the list was arbitrarily partial (122 of 186). The
 * scope is now the FULL transitive production closure of `dependencies` plus
 * `optionalDependencies` - what a normal install actually resolves.
 *
 * It aggregates notices from the license data ALREADY present in node_modules;
 * it adds NO dependency (plain Node builtins only) and never touches the
 * network.
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

const LICENSE_FILE_RE = /^(licen[sc]e|copying|notice|unlicense)(\.|$)/i;

/**
 * Node-style upward node_modules walk. The resolved dir is realpath'd so that
 * under pnpm - where the top-level entry is a symlink into the content-addressed
 * store - the recursion continues from the REAL store location, whose siblings
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

// ── walk the closure a normal install resolves ──────────────────────────────
const cliPkg = readJson(join(CLI_DIR, 'package.json'));
const roots = [
  ...Object.keys(cliPkg.dependencies ?? {}),
  ...Object.keys(cliPkg.optionalDependencies ?? {}),
].sort();

const collected = new Map(); // key `name@version` → { name, version, license, homepage, text }
const missing = [];

function visit(dep, fromDir) {
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

for (const root of roots) visit(root, CLI_DIR);

const entries = [...collected.values()].sort((a, b) =>
  a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);

if (missing.length) {
  console.warn(`warning: could not resolve ${[...new Set(missing)].sort().join(', ')}`);
}

// ── render ──────────────────────────────────────────────────────────────────
const header = `SpyCode CLI (@spycore/cli) - Third-Party Software Notices

THIS PACKAGE DOES NOT BUNDLE THIRD-PARTY CODE.

Its published build/ directory contains first-party code only. Every runtime
dependency is emitted as an ordinary import and is resolved by YOUR package
manager, at install time, from the version ranges declared in package.json.
None of the packages listed below is inlined into this artifact, and none of
their code is redistributed by it.

An earlier version of this notice said the opposite - that the build step
inlined these packages - and that statement was incorrect. It has been
corrected against the built artifact.

The notices are reproduced here as a record of the license surface that a
normal install resolves, so the CLI's dependency closure can be reviewed
without installing it. Once installed, each package also carries its own
license file in your node_modules, and that copy is the one that travels with
the code you run.

This file is generated from the installed package metadata by
scripts/gen-third-party-licenses.mjs - do not edit it by hand.

Dependencies resolved at install time (${entries.length}) - this closure includes the
optional native keychain binding \`keytar\`, which your platform may skip:
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
    console.error('THIRD-PARTY-LICENSES is out of date - run: node scripts/gen-third-party-licenses.mjs');
    process.exit(1);
  }
  console.log(`THIRD-PARTY-LICENSES up to date (${entries.length} packages resolved at install time).`);
} else {
  writeFileSync(OUT_FILE, output, 'utf8');
  console.log(`Wrote ${OUT_FILE} (${entries.length} packages resolved at install time).`);
}
