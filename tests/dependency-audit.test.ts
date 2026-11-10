import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * H12 - the dependency audit passed VACUOUSLY when the `advisories` key was
 * absent: the missing key defaulted to `[]` and the script exited 0 with
 * "clean: 0 advisories scanned". A missing key is now a loud failure - a
 * real clean audit carries the key with an empty object.
 *
 * The specifier below is a STATIC LITERAL, deliberately - Vite's
 * import-analysis can only rewrite a literal (see
 * tests/resolved-install-audit.test.ts for why a computed specifier fails).
 */
import { AUDIT_TIMEOUT_MS, buildCmdCommandLine, buildPnpmSpawn, evaluateAuditReport, resolvePnpmCommand } from '../scripts/dependency-audit.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/dependency-audit.mjs', import.meta.url));

describe('evaluateAuditReport - the non-vacuous guard', () => {
  test('a report without the advisories key fails loudly', () => {
    expect(() => evaluateAuditReport({})).toThrow(/no `advisories` key/);
    expect(() => evaluateAuditReport({ metadata: { totalDependencies: 186 } })).toThrow(
      /no `advisories` key/,
    );
  });

  test('an error payload fails even though it parses as JSON', () => {
    expect(() =>
      evaluateAuditReport({ error: { code: 'ENOTFOUND', message: 'registry unreachable' } }),
    ).toThrow(/audit endpoint error/);
  });

  test('a present-but-malformed advisories value fails loudly (R4-1)', () => {
    // A present key with a non-object value used to collapse to [] and pass
    // as a clean 0-advisory scan - the same vacuous pass the missing-key
    // guard above was written for. An empty object/array is still a real
    // clean audit (see the next test); anything else refuses.
    expect(() => evaluateAuditReport({ advisories: null })).toThrow(/not an object or array/);
    expect(() => evaluateAuditReport({ advisories: 'oops' })).toThrow(/not an object or array/);
    expect(() => evaluateAuditReport({ advisories: 42 })).toThrow(/not an object or array/);
  });

  test('a real clean audit - advisories key present but empty - passes', () => {
    expect(evaluateAuditReport({ advisories: {} })).toEqual({ scanned: 0, waived: 0, blocked: 0 });
    expect(evaluateAuditReport({ advisories: [] })).toEqual({ scanned: 0, waived: 0, blocked: 0 });
  });

  test('a MALFORMED per-advisory entry fails loudly, never passes as clean (R4-2)', () => {
    // The old form read `a.severity` off whatever the entry was, so a
    // string, number, or boolean entry yielded severity '' and was skipped -
    // a payload whose EVERY entry was malformed verdicted clean. Only a null
    // entry failed, and only by accident (an unhandled TypeError).
    for (const malformed of ['high', 5, true, null]) {
      expect(() => evaluateAuditReport({ advisories: { X: malformed } })).toThrow(
        /not an object|no readable severity/,
      );
    }
    // An array is not an advisory object either.
    expect(() => evaluateAuditReport({ advisories: { X: [] } })).toThrow(/not an object/);
    // An object with no severity at all is unreadable, not low.
    expect(() => evaluateAuditReport({ advisories: { X: {} } })).toThrow(/no readable severity/);
  });

  test('an UNKNOWN severity fails loudly, never passes as clean (R4-2)', () => {
    // 'severe' is not in npm's severity domain; the old form skipped it as
    // not-high, so a payload carrying only unknown severities verdicted clean.
    expect(() => evaluateAuditReport({ advisories: { X: { severity: 'severe' } } })).toThrow(
      /unknown severity `severe`/,
    );
    expect(() => evaluateAuditReport({ advisories: { X: { severity: '' } } })).toThrow(
      /unknown severity ``/,
    );
  });

  test('the pnpm audit spawn is bounded at 300 s, matching the sibling instrument (R4-5)', () => {
    expect(AUDIT_TIMEOUT_MS).toBe(300_000);
  });

  test('a low-severity advisory passes; a high one blocks', () => {
    expect(
      evaluateAuditReport({
        advisories: { '1': { severity: 'low', package_name: 'foo', vulnerable_versions: '1.0.0' } },
      }),
    ).toEqual({ scanned: 1, waived: 0, blocked: 0 });
    expect(() =>
      evaluateAuditReport({
        advisories: {
          '2': { id: 'GHSA-xxxx-yyyy-zzzz', severity: 'high', package_name: 'foo', vulnerable_versions: '1.0.0' },
        },
      }),
    ).toThrow(/1 high\/critical advisorie/);
  });
});

describe('dependency-audit.mjs end-to-end (fake pnpm, no network)', () => {
  function runWithFakePnpm(payload: string): { status: number; output: string } {
    const dir = mkdtempSync(join(tmpdir(), 'spycli-depaudit-'));
    try {
      // Windows cannot execute the extensionless shell script, and a bare
      // `pnpm` spawn never resolves a `.cmd` shim on PATH (see
      // scripts/dependency-audit.mjs `resolvePnpmCommand`) - so the fake
      // there is a `pnpm.cmd` launcher over a node script, with the payload
      // carried in the environment instead of baked into the script text.
      // PATH is joined with `delimiter`, not a literal `:` - on Windows a
      // `:`-joined PATH is a single unresolvable entry, which is how the
      // first Windows run failed with `spawnSync pnpm ENOENT` before the
      // fake was ever reached.
      if (process.platform === 'win32') {
        writeFileSync(
          join(dir, 'pnpm-fake.mjs'),
          `process.stdout.write(process.env.FAKE_PNPM_PAYLOAD ?? '');\n`,
        );
        writeFileSync(join(dir, 'pnpm.cmd'), '@echo off\r\nnode "%~dp0pnpm-fake.mjs" %*\r\n');
      } else {
        const fake = join(dir, 'pnpm');
        writeFileSync(fake, `#!/bin/sh\nprintf '%s' '${payload.replace(/'/g, `'\\''`)}'\n`);
        chmodSync(fake, 0o755);
      }
      try {
        const out = execFileSync('node', [SCRIPT], {
          env: {
            ...process.env,
            PATH: `${dir}${delimiter}${process.env.PATH ?? ''}`,
            FAKE_PNPM_PAYLOAD: payload,
          },
          encoding: 'utf8',
        });
        return { status: 0, output: out };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test('a pnpm payload without advisories exits 1, not a vacuous 0', () => {
    const r = runWithFakePnpm('{"metadata":{"totalDependencies":186}}');
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/no `advisories` key/);
  });

  test('a pnpm payload with an empty advisories object exits 0', () => {
    const r = runWithFakePnpm('{"advisories":{}}');
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/clean: 0 advisorie\(s\) scanned/);
  });

  test('a pnpm payload with advisories: null exits 1, not a vacuous 0 (R4-1)', () => {
    const r = runWithFakePnpm('{"advisories":null}');
    expect(r.status).toBe(1);
    expect(r.output).toMatch(/not an object or array/);
  });
});

describe('resolvePnpmCommand + buildCmdCommandLine (injected win32, runs on Linux)', () => {
  const PATHEXT = '.COM;.EXE;.BAT;.CMD';

  // Files are planted with UPPERCASE extensions: the resolver walks PATHEXT
  // as given (uppercase, as Windows reports it), and this Linux filesystem
  // is case-sensitive - a lowercase pnpm.cmd would never match pnpm.CMD here.
  // On Windows the same lookup succeeds because NTFS is case-insensitive;
  // the walk order (dir-major, PATHEXT order) is what this pins.
  function fakeBin(files: string[]): string {
    const d = mkdtempSync(join(tmpdir(), 'spycli-depaudit-resolve-'));
    for (const f of files) {
      writeFileSync(join(d, f), '');
      chmodSync(join(d, f), 0o755);
    }
    return d;
  }

  test('dir-major walk: a .cmd in the first dir beats an .exe later on PATH', () => {
    const first = fakeBin(['pnpm.CMD']);
    const second = fakeBin(['pnpm.EXE']);
    try {
      expect(resolvePnpmCommand({ platform: 'win32', pathEnv: `${first};${second}`, pathext: PATHEXT })).toBe(
        join(first, 'pnpm.CMD'),
      );
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test('extension order within a dir: .exe beats .cmd; null when absent', () => {
    const d = fakeBin(['pnpm.CMD', 'pnpm.EXE']);
    const empty = fakeBin(['not-pnpm.CMD']);
    try {
      expect(resolvePnpmCommand({ platform: 'win32', pathEnv: d, pathext: PATHEXT })).toBe(join(d, 'pnpm.EXE'));
      expect(resolvePnpmCommand({ platform: 'win32', pathEnv: empty, pathext: PATHEXT })).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('posix returns the bare name', () => {
    expect(resolvePnpmCommand({ platform: 'linux' })).toBe('pnpm');
  });

  test('the cmd.exe command line quotes spaces and escapes " % ^', () => {
    expect(buildCmdCommandLine(['C:\\Temp\\pnpm.CMD', 'audit', '--json'])).toBe(
      '"C:\\Temp\\pnpm.CMD" "audit" "--json"',
    );
    expect(buildCmdCommandLine(['a"b'])).toBe('"a\\"b"');
    expect(buildCmdCommandLine(['100% ^x'])).toBe('"100^% ^^x"');
  });

  test('buildPnpmSpawn: a .cmd on win32 goes through cmd.exe, double-wrapped and verbatim', () => {
    const t = buildPnpmSpawn('C:\\Temp\\pnpm.CMD', ['audit', '--json'], 'win32');
    // Same rule as buildGhSpawn (see tests/gh-real.test.ts): the file is
    // `process.env.ComSpec` - the absolute path on real Windows, which is
    // what branch CI run 42507192367 returned - and the bare 'cmd.exe'
    // only when ComSpec is unset. Production code is unchanged.
    expect(t.file).toBe(process.env.ComSpec ?? 'cmd.exe');
    expect(t.argv).toEqual(['/d', '/s', '/c', '""C:\\Temp\\pnpm.CMD" "audit" "--json""']);
    expect(t.windowsVerbatimArguments).toBe(true);
  });

  test('buildPnpmSpawn: the double wrap survives cmd.exe /s', () => {
    // cmd.exe /s strips exactly the first and last quote of the /c
    // string and leaves the rest unchanged (Microsoft cmd docs); the
    // strip must yield the built command line, not a mangled one.
    const tokens = ['C:\\Temp\\pnpm.CMD', 'audit', '--json'];
    const t = buildPnpmSpawn(tokens[0] as string, tokens.slice(1), 'win32');
    const cArg = t.argv[3] as string;
    let stripped = cArg.startsWith('"') ? cArg.slice(1) : cArg;
    const last = stripped.lastIndexOf('"');
    if (last >= 0) stripped = stripped.slice(0, last) + stripped.slice(last + 1);
    expect(stripped).toBe(buildCmdCommandLine(tokens));
  });

  test('buildPnpmSpawn: a .exe on win32 and the bare name on posix spawn directly', () => {
    expect(buildPnpmSpawn('C:\\Temp\\pnpm.EXE', ['audit', '--json'], 'win32')).toEqual({
      file: 'C:\\Temp\\pnpm.EXE',
      argv: ['audit', '--json'],
      windowsVerbatimArguments: false,
    });
    expect(buildPnpmSpawn('pnpm', ['audit', '--json'], 'linux')).toEqual({
      file: 'pnpm',
      argv: ['audit', '--json'],
      windowsVerbatimArguments: false,
    });
  });
});

describe('known-advisory waiver matches the version exactly', () => {
  const known = (versions: string) => ({
    advisories: {
      '1': {
        id: 'GHSA-vfj7-8cjw-p6xm',
        severity: 'high',
        package_name: 'braces',
        vulnerable_versions: versions,
      },
    },
  });

  test('3.0.30 does NOT match the 3.0.3 waiver (substring trap)', () => {
    expect(() => evaluateAuditReport(known('3.0.30'))).toThrow(/1 high\/critical advisorie/);
  });

  test('an exact 3.0.3 token is still waived (patch wired in this tree)', () => {
    expect(evaluateAuditReport(known('3.0.3'))).toEqual({ scanned: 1, waived: 1, blocked: 0 });
  });

  test('a range token naming 3.0.3 exactly is still waived', () => {
    expect(evaluateAuditReport(known('<=3.0.3'))).toEqual({ scanned: 1, waived: 1, blocked: 0 });
  });
});
