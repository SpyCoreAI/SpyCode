import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * ⭐⭐ THE INSTRUMENT THAT AUDITS WHAT A USER ACTUALLY INSTALLS — F-2c-25.
 *
 * Every advisory control in this repository audits THE WORKSPACE, through a
 * lockfile and a set of `overrides` that the published tarball does not carry.
 * A user's `npm i -g @spycore/cli` resolves 15 caret ranges plus one optional
 * dependency, from the registry, with none of that applied. The two populations
 * are different, and the difference decided real cases: of the 18 override keys
 * in `pnpm-workspace.yaml`, 13 name packages that are not in the CLI's install
 * closure at all, and the one recorded as a CRITICAL reachable "by the
 * PUBLISHED CLI" is not present in a fresh install by any path.
 *
 * ⭐ THE LIVE MEASUREMENT IS NOT RUN HERE, DELIBERATELY. It needs the registry,
 * and a test that silently passes when the network is down is worse than no
 * test — that is the `exit 3 ≠ pass` lesson this repo already paid for once.
 * What is pinned here is the instrument's VERDICT LOGIC, offline and
 * deterministically, including every fail-open shape that has actually reached
 * this codebase before.
 *
 * The live arm runs as `node scripts/audit-resolved-install.mjs`.
 */
const SCRIPT = fileURLToPath(new URL('../scripts/audit-resolved-install.mjs', import.meta.url));
/** Imported through a computed URL: the instrument is plain `.mjs` and carries
 *  no declaration file, and a static specifier would make `tsc` demand one. */
const SCRIPT_URL = new URL('../scripts/audit-resolved-install.mjs', import.meta.url).href;

describe('audit-resolved-install — the published-manifest advisory instrument', () => {
  test('its self-test passes, and reports how many cases actually RAN', () => {
    const out = execFileSync(process.execPath, [SCRIPT, '--self-test'], { encoding: 'utf8' });
    expect(out).toMatch(/SELF-TEST OK — \d+ cases/);
    // ⭐ A PASS MUST BE PROVED ABLE TO SEE A CASE. The pre-publish review found
    // three instruments printing PASS over zero executed assertions because
    // nothing ratcheted the case count. This asserts the number, not the word.
    const ran = Number(/SELF-TEST OK — (\d+) cases/.exec(out)?.[1] ?? '0');
    expect(ran).toBeGreaterThanOrEqual(12);
  });

  /**
   * ⭐⭐ THE FAIL-OPEN THIS ARC KEEPS FINDING. Twice, a security verdict was
   * computed as `parsed.<key> ?? {}`, so a payload missing that key produced an
   * empty set, a clean count and exit 0. Here the refusal is asserted directly
   * against the real exported predicate, not inferred from the self-test's
   * summary line.
   */
  test('a payload it cannot read is REFUSED, never read as a clean zero', async () => {
    const mod = (await import(SCRIPT_URL)) as unknown as {
      verdictFrom: (p: unknown) => { ok: boolean; reason: string | null; findings: unknown[] };
    };
    for (const malformed of [null, [], {}, { vulnerabilities: null }, { metadata: {} }, 'x', 7]) {
      const v = mod.verdictFrom(malformed);
      expect(v.ok, `must refuse ${JSON.stringify(malformed)}`).toBe(false);
      expect(v.reason, `must SAY why it refused ${JSON.stringify(malformed)}`).not.toBeNull();
    }
    // …and the control: a well-formed clean payload is genuinely clean, so the
    // refusal above is a discrimination and not a constant.
    const clean = mod.verdictFrom({ vulnerabilities: {} });
    expect(clean.ok).toBe(true);
    expect(clean.reason).toBeNull();
    // …and a well-formed dirty payload fails.
    const dirty = mod.verdictFrom({ vulnerabilities: { p: { severity: 'critical', via: [{ title: 't' }] } } });
    expect(dirty.ok).toBe(false);
  });

  /**
   * ⭐ The probe manifest must be the manifest a USER receives — production and
   * optional dependencies only. If devDependencies ever leaked in, the
   * instrument would be auditing this repository again instead of the artifact,
   * which is the exact confusion it was built to end.
   */
  test('the probe manifest is the PUBLISHED one — prod + optional, never dev', async () => {
    const mod = (await import(SCRIPT_URL)) as unknown as {
      publishedManifest: (p: unknown) => Record<string, unknown>;
    };
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const m = mod.publishedManifest(pkg) as {
      dependencies: Record<string, string>;
      optionalDependencies: Record<string, string>;
    };
    expect(Object.keys(m.dependencies).sort()).toEqual(Object.keys(pkg.dependencies ?? {}).sort());
    expect(Object.keys(m.optionalDependencies).sort()).toEqual(Object.keys(pkg.optionalDependencies ?? {}).sort());
    expect(m).not.toHaveProperty('devDependencies');
    // The manifest must be non-trivial, or the assertions above hold vacuously.
    expect(Object.keys(m.dependencies).length).toBeGreaterThanOrEqual(10);
  });
});
