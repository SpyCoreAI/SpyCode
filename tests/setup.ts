/**
 * Force non-TTY mode on process.stdin, stdout and stderr for every test —
 * the suite must behave identically no matter what terminal invokes it.
 *
 * stdin: several commands (conversations delete, files download, files
 * delete, memory delete) refuse to run destructively in a non-TTY without
 * `-y/--yes`, and their tests assert that refusal. With a real terminal on
 * stdin the guards would drop into a confirmation prompt and wait forever.
 *
 * stdout/stderr: command-level tests assert the PLAIN render path, but the
 * product (correctly) routes on stdout TTY-ness — e.g. `spycore agent`
 * mounts the interactive Ink UI when stdout is a terminal. Under a real
 * terminal or pty (vitest's forks inherit it) the in-process command tests
 * would mount Ink and hang to timeout. CI runners are never TTYs, so this
 * also pins local runs to exactly what CI exercises.
 *
 * columns/rows: table and wrap widths derive from the terminal size
 * (`process.stdout.columns`), so a narrow invoking terminal would change
 * truncation behaviour mid-assertion. CI streams report undefined; pin that.
 *
 * Tests that *need* TTY behaviour stub `isTTY` to true explicitly (with
 * `configurable: true`, which this setup preserves) and restore it after.
 */
for (const stream of [process.stdin, process.stdout, process.stderr]) {
  if (stream) {
    Object.defineProperty(stream, 'isTTY', {
      value: false,
      configurable: true,
      writable: true,
    });
    for (const dim of ['columns', 'rows'] as const) {
      Object.defineProperty(stream, dim, {
        value: undefined,
        configurable: true,
        writable: true,
      });
    }
  }
}
