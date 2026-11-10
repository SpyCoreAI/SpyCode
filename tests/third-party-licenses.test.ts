import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * THIRD-PARTY-LICENSES must be TRUE, not merely up to date - R4-1.
 *
 * `gen-third-party-licenses.mjs --check` proves only idempotency: the file
 * is byte-identical to what the generator emits. It cannot catch a WRONG
 * generator. The generator's license-file regex required `.` or end-of-string
 * after `LICENSE`, so hyphenated names (LICENSE-MIT, LICENSE-MIT.txt,
 * license-mit, license-cc0) never matched, and four entries were shipped
 * with the false claim "(No license file was distributed with this
 * package...)" - including type-fest@5.8.0, whose (MIT OR CC0-1.0)
 * disjunction then reproduced ZERO of two option texts.
 *
 * This test pins the TRUTH of the shipped notice, in both directions:
 *   - `--check` passing proves the committed file is what the CURRENT
 *     generator emits, so a regressed regex cannot hide behind a stale file
 *     (the check fails) and a regenerated false file cannot hide behind the
 *     check (the content assertions below fail).
 *   - The four fixed entries must reproduce their license texts.
 *   - The three entries that genuinely ship no license file must STILL say
 *     so, pinning that the wider matcher did not start over-matching.
 *
 * The test never writes: it reads the committed file, and `--check` only
 * compares. A failure here means regenerate with
 * `node scripts/gen-third-party-licenses.mjs` and re-read the entries.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/gen-third-party-licenses.mjs', import.meta.url));
const NOTICE = fileURLToPath(new URL('../THIRD-PARTY-LICENSES', import.meta.url));

const SEP = `\n${'='.repeat(78)}\n`;

function blockFor(nameAtVersion: string): string {
  // R4-CI1: normalise CRLF before splitting on the LF separator. A Windows
  // checkout converts THIRD-PARTY-LICENSES to CRLF (the repo had no
  // .gitattributes), which made the split find 0 blocks and failed all 4
  // tests on the Windows CI legs while Ubuntu/macOS stayed green.
  // .gitattributes now forces LF for this file; the normalisation stays as
  // defence in depth, so a CRLF copy still reads.
  const content = readFileSync(NOTICE, 'utf8').replace(/\r\n/g, '\n');
  const blocks = content.split(SEP).slice(1);
  // The file must be non-trivial, or every lookup below holds vacuously.
  expect(blocks.length).toBeGreaterThanOrEqual(100);
  const block = blocks.find((b) => b.startsWith(`${nameAtVersion}\n`));
  expect(block, `THIRD-PARTY-LICENSES must contain an entry for ${nameAtVersion}`).toBeDefined();
  return block as string;
}

describe('THIRD-PARTY-LICENSES - the shipped legal notice must be true (R4-1)', () => {
  test('the committed notice is what the current generator emits', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    expect(out).toMatch(/THIRD-PARTY-LICENSES up to date \(\d+ packages resolved at install time\)\./);
    const count = Number(/up to date \((\d+) packages/.exec(out)?.[1] ?? '0');
    expect(count).toBe(186);
  });

  test('hyphenated license filenames are reproduced, not denied', () => {
    for (const [pkg, copyright] of [
      ['emoji-regex@10.6.0', 'Copyright Mathias Bynens'],
      ['emoji-regex@8.0.0', 'Copyright Mathias Bynens'],
      ['ignore@7.0.6', 'Copyright (c) 2013 Kael Zhang'],
    ] as const) {
      const block = blockFor(pkg);
      expect(block, `${pkg} must reproduce its MIT text`).toContain(copyright);
      expect(block, `${pkg} must reproduce its MIT text`).toContain('Permission is hereby granted, free of charge');
      expect(block, `${pkg} must NOT claim no license file was distributed`).not.toContain('No license file was distributed');
    }
  });

  test('type-fest@5.8.0 reproduces BOTH options of its (MIT OR CC0-1.0) disjunction', () => {
    const block = blockFor('type-fest@5.8.0');
    expect(block).toContain('License: (MIT OR CC0-1.0)');
    // Each option is reproduced under its own file label, shortest first
    // (license-cc0 before license-mit: equal length, alphabetical).
    expect(block).toContain('License file: license-cc0');
    expect(block).toContain('CC0 1.0 Universal');
    expect(block).toContain('License file: license-mit');
    expect(block).toContain('MIT License');
    expect(block).toContain('Copyright (c) Sindre Sorhus');
    expect(block).not.toContain('No license file was distributed');
  });

  test('packages that genuinely ship no license file still say so (no over-match)', () => {
    // Verified by hand at the R4-1 fix: these package dirs contain no
    // license file anywhere in the package, so the "No license file" line
    // is TRUE for them - and the wider regex must not have invented one.
    for (const pkg of ['eastasianwidth@0.2.0', 'type-fest@2.19.0', 'yoga-layout@3.2.1'] as const) {
      const block = blockFor(pkg);
      expect(block, `${pkg} genuinely ships no license file`).toContain('No license file was distributed with this package.');
    }
  });
});
