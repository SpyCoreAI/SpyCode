/**
 * Bare-invocation routing: only the truly bare `spycore` (no args, real TTY
 * on both ends) launches the TUI. Everything else keeps its old behavior.
 */
import { describe, expect, test } from 'vitest';
import { shouldLaunchTui } from '../src/ui/tui/entry.js';

describe('shouldLaunchTui', () => {
  test('bare spycore on a TTY launches the TUI', () => {
    expect(
      shouldLaunchTui({ argv: ['node', 'spycore'], stdinTTY: true, stdoutTTY: true }),
    ).toBe(true);
  });

  test('any subcommand keeps the old path', () => {
    expect(
      shouldLaunchTui({ argv: ['node', 'spycore', 'agent'], stdinTTY: true, stdoutTTY: true }),
    ).toBe(false);
  });

  test('--help and --version keep the old path', () => {
    for (const flag of ['--help', '-h', '--version', '-v', '--json', '--no-color']) {
      expect(
        shouldLaunchTui({ argv: ['node', 'spycore', flag], stdinTTY: true, stdoutTTY: true }),
      ).toBe(false);
    }
  });

  test('piped stdin or stdout never launches the TUI', () => {
    expect(
      shouldLaunchTui({ argv: ['node', 'spycore'], stdinTTY: false, stdoutTTY: true }),
    ).toBe(false);
    expect(
      shouldLaunchTui({ argv: ['node', 'spycore'], stdinTTY: true, stdoutTTY: false }),
    ).toBe(false);
    expect(
      shouldLaunchTui({ argv: ['node', 'spycore'], stdinTTY: false, stdoutTTY: false }),
    ).toBe(false);
  });

  test('empty-string arg is not the bare invocation', () => {
    expect(
      shouldLaunchTui({ argv: ['node', 'spycore', ''], stdinTTY: true, stdoutTTY: true }),
    ).toBe(false);
  });

  test('CI environment never launches the TUI', () => {
    expect(
      shouldLaunchTui({ argv: ['node', 'spycore'], stdinTTY: true, stdoutTTY: true, ci: 'true' }),
    ).toBe(false);
    expect(
      shouldLaunchTui({ argv: ['node', 'spycore'], stdinTTY: true, stdoutTTY: true, ci: '1' }),
    ).toBe(false);
  });

  test('TERM=dumb never launches the TUI', () => {
    expect(
      shouldLaunchTui({ argv: ['node', 'spycore'], stdinTTY: true, stdoutTTY: true, term: 'dumb' }),
    ).toBe(false);
  });

  test('missing ci/term fields default to launch (backwards compatible)', () => {
    expect(
      shouldLaunchTui({ argv: ['node', 'spycore'], stdinTTY: true, stdoutTTY: true }),
    ).toBe(true);
  });
});
