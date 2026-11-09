import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * THE GENERATOR MUST BE IMPORT-SAFE - R4-2 (phase 5 pass 4).
 *
 * `gen-third-party-licenses.mjs` ran its whole body at module scope - the
 * manifest read, the closure walk, the render, and the `--check`/write branch
 * - so a bare import regenerated THIRD-PARTY-LICENSES as a side effect (the
 * reviewer proved it live: the import printed "Wrote ... 186 packages" and
 * bumped the file's mtime; with no node_modules present it rewrote the file
 * to a 0-package notice). Under a `--check` argv it would have called
 * `process.exit(1)` inside the importer. That is the F-I8 shape the sibling
 * instruments already guard against. The CLI body now runs only behind
 * isMain(), and the pure helpers are exported so they can be unit-tested
 * without executing the generator.
 *
 * What is pinned here is the import itself (no output, no file touch) and the
 * helpers' behaviour. The CLI paths are covered by
 * tests/third-party-licenses.test.ts (`--check`) and by running the generator.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/gen-third-party-licenses.mjs', import.meta.url));
const CLI_DIR = fileURLToPath(new URL('..', import.meta.url));
const NOTICE = fileURLToPath(new URL('../THIRD-PARTY-LICENSES', import.meta.url));

/**
 * The specifier is a STATIC LITERAL, deliberately — not a computed string.
 * Vite's import-analysis can only rewrite a literal: it resolves this to the
 * root-relative `/scripts/gen-third-party-licenses.mjs` at transform time, so
 * the runner never resolves a path at run time. A computed specifier is
 * invisible to import-analysis and is resolved at run time against the test
 * file's own path, which on Windows is a drive-letter path.
 *
 * The bare SyntaxError that survived three specifier forms on the sibling
 * instrument was not the specifier at all: it was the script's shebang. On a
 * CRLF checkout (Windows) Vite's SSR transform emits the shebang mid-file,
 * where the runner rejects it as an unexpected token. The shebang has been
 * removed from this script too — it is never executed directly (no executable
 * bit, always run via `node <path>`) — so the failure mode is gone for every
 * line ending, not worked around for one of them.
 *
 * The `.mjs` carries a declaration file, so a literal import type-checks:
 * `scripts/gen-third-party-licenses.d.mts` supplies it. (A `.d.ts` does not
 * work for a `.mjs` module — the declaration must be `.d.mts`.)
 */
import {
  findLicenseTexts,
  homepageOf,
  isDisjunctive,
  resolveDepDir,
  spdx,
} from '../scripts/gen-third-party-licenses.mjs';

describe('gen-third-party-licenses - importing the generator must be side-effect free (R4-2)', () => {
  test('a bare import writes nothing - no output, no mtime move, byte-identical file', () => {
    const before = readFileSync(NOTICE);
    const beforeMtime = statSync(NOTICE).mtimeMs;
    // The reviewer's exact probe: a bare import, no other statement.
    const out = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "await import('./scripts/gen-third-party-licenses.mjs')"],
      { cwd: CLI_DIR, encoding: 'utf8' },
    );
    expect(out, 'importing the generator must print nothing - before the fix it printed "Wrote ..."').toBe('');
    expect(statSync(NOTICE).mtimeMs, 'importing the generator must not touch THIRD-PARTY-LICENSES').toBe(beforeMtime);
    expect(readFileSync(NOTICE).equals(before), 'importing the generator must not change THIRD-PARTY-LICENSES').toBe(true);
  });

  test('spdx reads every license shape the closure declares', () => {
    expect(spdx({ license: 'MIT' })).toBe('MIT');
    expect(spdx({ license: { type: 'Apache-2.0' } })).toBe('Apache-2.0');
    expect(spdx({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('MIT OR Apache-2.0');
    expect(spdx({})).toBe('UNKNOWN');
  });

  test('isDisjunctive splits OR from AND and from OR-without-boundaries', () => {
    expect(isDisjunctive('(MIT OR CC0-1.0)')).toBe(true);
    expect(isDisjunctive('MIT')).toBe(false);
    expect(isDisjunctive('MIT AND Apache-2.0')).toBe(false);
    // 'OR' without word boundaries is not a disjunction.
    expect(isDisjunctive('MOR')).toBe(false);
  });

  test('findLicenseTexts finds hyphenated names, shortest first, and skips non-files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'licenses-'));
    try {
      writeFileSync(join(dir, 'LICENSE'), 'root license\nline two\n');
      writeFileSync(join(dir, 'LICENSE-MIT'), 'MIT text');
      writeFileSync(join(dir, 'LICENSE-BSD'), 'BSD text');
      writeFileSync(join(dir, 'LICENSE-APACHE2'), 'Apache text');
      writeFileSync(join(dir, 'LICENSE-CRLF'), 'first\r\nsecond\r\n');
      writeFileSync(join(dir, 'README.md'), 'not a license');
      mkdirSync(join(dir, 'LICENSE-DIR'));
      const texts = findLicenseTexts(dir);
      expect(texts.map((t) => t.file)).toEqual([
        'LICENSE',
        'LICENSE-BSD',
        'LICENSE-MIT',
        'LICENSE-CRLF',
        'LICENSE-APACHE2',
      ]);
      expect(texts.find((t) => t.file === 'LICENSE')?.text).toBe('root license\nline two');
      // CRLF is normalised at the read, as in the shipped notice.
      expect(texts.find((t) => t.file === 'LICENSE-CRLF')?.text).toBe('first\nsecond');
      expect(findLicenseTexts(join(dir, 'no-such-dir'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolveDepDir walks up and realpaths through the pnpm store', () => {
    const react = resolveDepDir(CLI_DIR, 'react');
    expect(react).not.toBeNull();
    expect((react as string).endsWith(join('node_modules', 'react'))).toBe(true);
    expect(resolveDepDir(join(CLI_DIR, 'scripts'), 'chalk')).not.toBeNull();
    expect(resolveDepDir(CLI_DIR, 'no-such-package-xyz')).toBeNull();
  });

  test('homepageOf normalises every repository shape', () => {
    expect(homepageOf({ homepage: 'https://example.com' })).toBe('https://example.com');
    expect(homepageOf({ repository: 'git+https://github.com/foo/bar.git' })).toBe('https://github.com/foo/bar');
    expect(homepageOf({ repository: { url: 'git@github.com:foo/bar.git' } })).toBe('https://github.com/foo/bar');
    expect(homepageOf({ repository: 'foo/bar' })).toBe('https://github.com/foo/bar');
    expect(homepageOf({ homepage: '', repository: 'git+https://github.com/foo/bar.git' })).toBe(
      'https://github.com/foo/bar',
    );
    expect(homepageOf({})).toBe('');
  });
});
