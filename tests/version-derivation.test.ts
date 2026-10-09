import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readClientVersion } from '../src/lib/agent/mcp-client.js';

/**
 * VERSION DERIVATION - every version the CLI emits comes from ONE manifest (F-2c-3).
 *
 * WHY THIS EXISTS
 * tests/version-consistency.test.ts pins package.json against the CHANGELOG
 * heading. Nothing pinned the other direction: that the versions the CLI
 * actually EMITS are derived from that manifest rather than typed by hand. The
 * inventory found 14 sites stating a version, and the hand-written ones are the
 * ones that go stale - the Homebrew formula and the Scoop manifest have said
 * 0.5.0 since the 0.5.0 release and cannot follow a bump, and a dead
 * `__CLI_VERSION__` build define sat in tsup.config.ts with no consumers.
 *
 * FOUR INDEPENDENT MECHANISMS READ THE MANIFEST AT RUN TIME, which is three
 * more than the question needs:
 * 1. src/index.ts            - fixed relative path, feeds --version, the
 * `version` and `schema` commands, the update
 * checker and the update banner (5 emissions)
 * 2. src/lib/config.ts       - readCliVersion(), walks up for `conf` migrations
 * 3. src/lib/agent/mcp-client.ts - readClientVersion(), walks up, for
 * MCP clientInfo. EXPORTED, and its own comment
 * says it is exported to be SHARED.
 * 4. src/commands/acp.ts     - an inline copy of exactly that walk, for ACP
 * agentInfo, which does NOT use the exported one.
 * They agree today. Nothing made them agree, so this does: the test below drives
 * the real readers and compares them to the manifest, so a divergence is red
 * rather than a support ticket about two different versions in one session.
 *
 * WHAT IT OBSERVES (weak-pin form (e))
 * - `readClientVersion()` is CALLED, not read as text: break its walk and this
 * goes red.
 * - The emission sites are derived from src/index.ts's source, so introducing a
 * hand-typed version at any of the five turns the census red.
 * - The no-literal ratchet catches a NEW hard-coded version anywhere in src.
 *
 * WHAT IT CANNOT SEE
 * -  RESOLVED, NOT DEFERRED (F-2c-26): homebrew-spycore/ and scoop-spycore/
 * are GONE. They were the two hand-written version sites this census could
 * not reach, stuck at 0.5.0 across two shipped releases because they carried
 * SHA256 placeholders for six archives no workflow builds and the cli-v0.5.0
 * release carries zero assets. Removed rather than bumped - a channel that
 * promises an artifact nothing produces cannot be made correct by a version
 * number. So the out-of-reach hand-written set is now EMPTY, and any future
 * tap must arrive with a gate binding its version to package.json.
 * - Git tags. `cli-v0.4.0` and `cli-v0.6.0` do not exist although both
 * versions shipped - a repo-level fact no package test can reach.
 * - Whether a version is CORRECT, only that it is consistent. Semver honesty
 * (F-2a #4) is a release decision, not a derivable property.
 */

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string };

function walkSrc(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walkSrc(join(dir, e.name), rel));
    else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(rel);
  }
  return out;
}

describe('version derivation - one manifest, no hand-typed copies', () => {
  test('the MCP clientInfo reader returns the manifest version', () => {
    // Driven, not grepped: this is the reader an MCP server actually sees.
    expect(readClientVersion()).toBe(pkg.version);
  });

  test('every version the entry point emits is passed pkg.version, never a literal', () => {
    // fileURLToPath, not URL.pathname: on Windows the latter yields `/C:/…`,
    // which readFileSync cannot open - the census would fail for a reason that
    // has nothing to do with the property it guards.
    const src = readFileSync(join(pkgDir, 'src', 'index.ts'), 'utf8');
    for (const emission of [
      /\.version\(\s*pkg\.version\s*,/, // the top-level --version flag
      /registerVersionCommand\(\s*program\s*,\s*pkg\.version\s*\)/,
      /registerUpdateCommand\(\s*program\s*,\s*pkg\.version\s*\)/,
      /registerSchemaCommand\(\s*program\s*,\s*pkg\.version\s*\)/,
      /currentVersion:\s*pkg\.version/, // the update banner
    ]) {
      expect(src, `an emission site stopped deriving from pkg.version: ${emission}`).toMatch(
        emission,
      );
    }
  });

  test('no source file hard-codes a version literal (the 0.0.0 fallback aside)', () => {
    // The ONLY sanctioned semver literal is the '0.0.0' sentinel each reader
    // returns when it cannot locate the manifest. Anything else is a future
    // false claim with a date attached.
    const srcRoot = join(pkgDir, 'src');
    const offenders: string[] = [];
    for (const rel of walkSrc(srcRoot)) {
      const text = readFileSync(join(srcRoot, rel), 'utf8').replace(/\r\n/g, '\n');
      for (const line of text.split('\n')) {
        if (line.trimStart().startsWith('*')) continue; // prose in a doc comment
        for (const m of line.matchAll(/['"](\d+\.\d+\.\d+)['"]/g)) {
          if (m[1] !== '0.0.0') offenders.push(`${rel}: ${m[1]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the build config declares no frozen version define', () => {
    // A build-time define cannot be corrected without a rebuild, so it is the
    // one version mechanism that can be wrong in a shipped artifact with a
    // correct manifest sitting next to it. F-2a #48 found one, dead, here.
    //
    // CODE ONLY, NOT PROSE. The first version of this assertion went red on
    // the COMMENT that explains why the define was removed - a guard parsing the
    // repo's own commentary, which is the exact defect F-2b2 shipped and had to
    // fix. A control that cannot tell code from the note about the code will
    // fire on its own documentation forever.
    const tsup = readFileSync(join(pkgDir, 'tsup.config.ts'), 'utf8')
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'))
      .join('\n');
    expect(tsup).not.toMatch(/__CLI_VERSION__/);
    expect(tsup).not.toMatch(/define:\s*\{[^}]*[Vv]ersion/);
  });

  test('the manifest-reading mechanisms are exactly the four counted ones', () => {
    // A ratchet on the SHAPE: a fifth reader must be classified here rather than
    // appearing silently. Four is already three more than the question needs -
    // acp.ts re-implements the helper mcp-client.ts exports for sharing
    // (destination F-2c-4) - and this makes that duplication impossible to grow.
    const srcRoot = join(pkgDir, 'src');
    const READERS: Record<string, string> = {
      'index.ts': 'fixed relative path; feeds all five emissions',
      'lib/config.ts': 'readCliVersion() - conf migrations',
      'lib/agent/mcp-client.ts': 'readClientVersion() - MCP clientInfo; EXPORTED to be shared',
      'commands/acp.ts': 'inline copy for ACP agentInfo - should use the exported one (F-2c-4)',
    };
    const found = walkSrc(srcRoot)
      .filter((rel) => {
        const text = readFileSync(join(srcRoot, rel), 'utf8');
        // A real read of OUR manifest: a readFileSync whose path joins package.json.
        return /readFileSync\(\s*(?:path[A-Za-z]*\.)?join\([^)]*['"]package\.json['"]/.test(text);
      })
      .sort();
    expect(found).toEqual(Object.keys(READERS).sort());
  });
});
