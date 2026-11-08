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
import { evaluateAuditReport } from '../scripts/dependency-audit.mjs';

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

  test('a real clean audit - advisories key present but empty - passes', () => {
    expect(evaluateAuditReport({ advisories: {} })).toEqual({ scanned: 0, waived: 0, blocked: 0 });
    expect(evaluateAuditReport({ advisories: [] })).toEqual({ scanned: 0, waived: 0, blocked: 0 });
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
});
