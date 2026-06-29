import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
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
