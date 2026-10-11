/**
 * Bare-invocation routing for the interactive TUI.
 *
 * `spycore` with no arguments on a real terminal launches the interactive
 * TUI; every other invocation (subcommands, flags, --help, --version, pipes)
 * keeps its existing behavior byte-identical. The predicate is pure so the
 * routing decision itself is unit-testable without spawning the CLI.
 */
export interface TuiEntryInput {
  /** process.argv as received (argv[0] = node, argv[1] = script). */
  argv: string[];
  stdinTTY: boolean;
  stdoutTTY: boolean;
  /** process.env.CI as received (may be undefined). */
  ci?: string | undefined;
  /** process.env.TERM as received (may be undefined). */
  term?: string | undefined;
}

export function shouldLaunchTui(input: TuiEntryInput): boolean {
  // Exactly `spycore` - no subcommand, no flags. `--help` / `--version` /
  // `--json` etc. all have argv.length >= 3 and keep their old behavior.
  if (input.argv.length !== 2) return false;
  // A real terminal on both ends: never launch Ink into a pipe, a redirected
  // file, or CI, where it would emit control codes into a sink or hang.
  if (!input.stdinTTY || !input.stdoutTTY) return false;
  if (input.ci) return false;
  if (input.term === 'dumb') return false;
  return true;
}
