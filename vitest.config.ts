import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    /**
     * ⭐⭐ F-2c-14 §1 — TWO POPULATIONS, TWO ADDRESSES, ONE RUNNER.
     *
     * `tests/` holds tests OF THIS PACKAGE. They are portable by nature: every
     * path they name ships with the package, so they assert the same property
     * in the monorepo and in the public mirror's export tree.
     *
     * `../../tests/cli-gates/` holds REPO-SCOPED GATES — pins whose SUBJECT is
     * monorepo-private (the server config tree, docs/CODEBASE_GUIDE.md and the
     * monorepo's git history, and the two manifest-excluded release scripts).
     * Five of them used to live in `tests/` because that is where a vitest
     * runner happened to exist. They were exported to the public mirror, where
     * their subjects cannot exist, and the result was 17 tests that the source
     * exercises and the mirror does not: 8 red, 5 that never registered, and
     * — the reason per-file conditionals were never a fix — 4 that vanished
     * SILENTLY behind an `existsSync` guard inside a file that still reported
     * PASS. They now live outside the package and are never published.
     *
     * ⭐ THIS SECOND ENTRY IS INTENTIONALLY EMPTY IN THE PUBLIC MIRROR. The
     * mirror's root IS this package, so `../../tests/cli-gates/` is above it and
     * matches nothing there — which is the whole point, and is measured rather
     * than assumed (the export tree runs green with this line present).
     *
     * ⭐ IT MUST NOT BE DELETED. `tests/vitest-include.test.ts` asserts this
     * exact glob is present, and asserts it identically in both trees, so the
     * repo-scoped gates cannot be silently un-run by an edit to this file.
     */
    include: ['tests/**/*.test.ts', '../../tests/cli-gates/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    isolate: true,
    testTimeout: 10_000,
    // Each test mutates the conf-backed CLI config, so let vitest mock
    // out the singleton via a fresh tmpdir per test (see tests/helpers).
    clearMocks: true,
    restoreMocks: true,
    // Forces process.stdin.isTTY = false in every worker so the four
    // non-TTY-refusal tests (conversations delete, files download,
    // files delete, memory delete) are deterministic in interactive
    // shells too — not just CI runners. See tests/setup.ts.
    setupFiles: ['./tests/setup.ts'],
  },
});
