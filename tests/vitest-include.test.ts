import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * F-2c-14 §1 — THE GLOB THAT RUNS THE REPO-SCOPED GATES, PINNED FROM INSIDE
 * THE PACKAGE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ⭐⭐ WHY THIS PIN EXISTS, AND WHY IT LIVES HERE RATHER THAN NEXT TO THE GATES.
 *
 * The five repo-scoped gates moved to `<repo>/tests/cli-gates/`. They still run
 * because `vitest.config.ts` includes `../../tests/cli-gates/**\/*.test.ts`.
 * That glob is the ONLY thing connecting them to a runner — and a glob that
 * stops matching does not fail, it simply contributes zero files. Deleting the
 * line would silently un-run five gates and 27 tests while every suite stayed
 * green. That is the exact failure shape this batch exists to remove, one level
 * up from where it was found.
 *
 * ⭐ A pin placed in `tests/cli-gates/` could not close this: if the glob
 * breaks, that pin is not collected either, so it cannot report. The check has
 * to live on the side that always runs — inside the package.
 *
 * ⭐⭐ AND IT IS PORTABLE, WHICH IS WHY IT IS ALLOWED TO BE HERE AT ALL. It
 * reads `vitest.config.ts`, a file that ships to the public mirror byte for
 * byte, and asserts a property of that file's TEXT. It therefore asserts
 * exactly the same thing in the monorepo and in the export tree, with no
 * environment conditional — the standard the five relocated files could not
 * meet, and the reason they had to leave.
 *
 * WHAT THIS CANNOT SEE, stated rather than discovered later:
 *   - It proves the glob is DECLARED, not that any file currently matches it.
 *     If `tests/cli-gates/` were deleted wholesale, this pin still passes; the
 *     roster pin in `tests/cli-gates/gate-roster.test.ts` is what covers the
 *     members, and deleting BOTH directories at once is visible only in a diff.
 *   - It says nothing about whether the gates themselves are correct.
 */

const CONFIG = fileURLToPath(new URL('../vitest.config.ts', import.meta.url));

/** The literal that must appear in the include array, in the form it is written. */
const GATES_GLOB = "'../../tests/cli-gates/**/*.test.ts'";

describe('vitest include — the repo-scoped gates keep their runner', () => {
  test('vitest.config.ts is readable and declares an include array', () => {
    const src = readFileSync(CONFIG, 'utf8');
    // Reached-assertion: a truncated or unreadable config would make the
    // binding below pass by matching nothing meaningful.
    expect(src.length, 'read no vitest config — this pin would be vacuous').toBeGreaterThan(200);
    expect(src, 'no include array found — re-point this pin').toMatch(/include:\s*\[/);
  });

  test('the include array still carries the tests/cli-gates glob', () => {
    const src = readFileSync(CONFIG, 'utf8');
    const include = src.match(/include:\s*\[([^\]]*)\]/);
    expect(include, 'include array not parseable — re-point this pin').not.toBeNull();

    expect(
      include![1],
      'vitest.config.ts no longer includes ../../tests/cli-gates/**/*.test.ts. Five ' +
        'repo-scoped gates (27 tests) live there and this glob is the only thing that ' +
        'runs them. Removing it does not turn anything red — it just stops collecting ' +
        'them — which is why this pin exists. Restore the glob, or move the gates back ' +
        'and accept that they will be published to the mirror again.',
    ).toContain(GATES_GLOB);
  });

  test('the package-local glob is still there too, so this file itself is collected', () => {
    const src = readFileSync(CONFIG, 'utf8');
    const include = src.match(/include:\s*\[([^\]]*)\]/);
    expect(include![1]).toContain("'tests/**/*.test.ts'");
  });
});
