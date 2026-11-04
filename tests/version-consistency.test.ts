import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Version consistency (G-CLI-DOCS / B3).
 *
 * The CLI derives EVERY emitted version string from package.json at runtime:
 * `src/index.ts` reads `package.json` and hands `pkg.version` to the top-level
 * `--version` flag, the `version` command, the update checker, and the `schema`
 * command. So the emitted `--version` can never diverge from package.json - but
 * the human-maintained CHANGELOG heading can, and it did (it sat at an older
 * version than package.json until 0.6.0). This pins the two together: the top
 * `## X.Y.Z` CHANGELOG entry MUST equal package.json's version, and that version
 * must be valid semver.
 */

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const pkg = JSON.parse(
  readFileSync(join(pkgDir, 'package.json'), 'utf8'),
) as { version: string };
const changelog = readFileSync(join(pkgDir, 'CHANGELOG.md'), 'utf8');

describe('version consistency', () => {
  it('package.json version is valid semver', () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/);
  });

  it('the top CHANGELOG entry matches package.json version', () => {
    // The first "## X.Y.Z" heading (the current release) in the changelog.
    const m = changelog.match(/^##\s+(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/m);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(pkg.version);
  });
});
