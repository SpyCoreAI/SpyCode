import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

/**
 * C-1 (GHSA-vfj7-8cjw-p6xm) - the braces backport pin.
 *
 * No published braces release fixes the advisory (every release through 3.0.3
 * is affected; there is no 3.0.4 on npm), so the fix is backported via
 * `patchedDependencies` in pnpm-workspace.yaml (patches/braces@3.0.3.patch:
 * upstream micromatch/braces#72 - a 100-deep nesting cap in parse plus depth
 * guards and AST cycle detection in expand/compile/stringify).
 *
 * These tests resolve the EXACT braces copy the CLI's runtime dependency
 * (globby) loads and prove the patch is applied there. If the patch entry is
 * removed or stops applying, the install still succeeds (pnpm only warns) but
 * these tests go red.
 */
const require = createRequire(import.meta.url);
const globbyEntry = require.resolve('globby');
const bracesEntry = require.resolve('braces', { paths: [globbyEntry] });
// eslint-disable-next-line @typescript-eslint/no-require-imports
const braces = require(bracesEntry) as {
  (pattern: string, options?: object): string[];
  expand(pattern: string, options?: object): string[];
};

describe('braces security backport (GHSA-vfj7-8cjw-p6xm)', () => {
  test('the resolved braces is the patched 3.0.3', () => {
    expect(bracesEntry).toContain('braces@3.0.3');
  });

  test('deeply nested braces are rejected instead of overflowing the stack', () => {
    // 200 deep: under the 10000-char input cap, over the 100-deep nesting cap.
    const deep = '{'.repeat(200) + 'a,b' + '}'.repeat(200);
    expect(() => braces(deep)).toThrow(/exceeds max depth/);
  });

  test('deeply nested parens are rejected', () => {
    const deep = '('.repeat(200) + ')'.repeat(200);
    expect(() => braces(deep)).toThrow(/exceeds max depth/);
  });

  test('ordinary patterns still expand', () => {
    expect(braces('a/{b,c}/d', { expand: true })).toEqual(['a/b/d', 'a/c/d']);
    expect(braces.expand('src/*.{ts,js}')).toEqual(['src/*.ts', 'src/*.js']);
  });

  test('globby still matches through the patched braces', async () => {
    const { globby } = (await import('globby')) as typeof import('globby');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'spycli-braces-'));
    try {
      writeFileSync(join(dir, 'a.ts'), '');
      writeFileSync(join(dir, 'b.js'), '');
      const found = await globby('*.{ts,js}', { cwd: dir });
      expect(found.sort()).toEqual(['a.ts', 'b.js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
