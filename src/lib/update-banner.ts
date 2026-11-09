import chalk from 'chalk';
import { checkForUpdates } from './version-check.js';
import { getOutputOptions } from './output.js';
import { sanitizeForDisplay } from './sanitize-display.js';

/**
 * Background check + deferred banner. Designed to be:
 *   - non-blocking (fire-and-forget; the caller never awaits it on hot paths)
 *   - silent in non-interactive contexts (CI, JSON output, no TTY)
 *   - cheap (cached 24h via version-check)
 *
 * The banner is held until `flushUpdateBanner()` is called near process
 * exit, so it never garbles command output.
 */

interface PendingBanner {
  current: string;
  latest: string;
}

let pending: PendingBanner | null = null;

function isInteractive(): boolean {
  if (!process.stdout.isTTY) return false;
  if (process.env.CI === 'true') return false;
  if (process.env.SPYCORE_NO_UPDATE_CHECK === '1') return false;
  if (getOutputOptions().json) return false;
  return true;
}

export async function maybeShowUpdateBanner(opts: {
  currentVersion: string;
}): Promise<void> {
  if (!isInteractive()) return;
  try {
    const result = await checkForUpdates({ currentVersion: opts.currentVersion });
    if (result?.hasUpdate) {
      pending = { current: result.current, latest: result.latest };
    }
  } catch {
    // soft fail - never propagate
  }
}

export function flushUpdateBanner(): void {
  if (!pending) return;
  if (!isInteractive()) return;

  // The version strings come from a REMOTE registry response - sanitize so a
  // poisoned value can't drive the terminal (escape/OSC injection), and cap
  // the length: the box is fixed-width, so a long version used to overflow
  // its border. The box inner width is 59 chars (2 leading spaces + 57 of
  // text); "Update available: " (19) + " → " (3) leaves 35 for both
  // versions, so each is capped at 16 chars.
  const current = capVersion(sanitizeForDisplay(pending.current));
  const latest = capVersion(sanitizeForDisplay(pending.latest));
  const border = '─'.repeat(BOX_INNER_WIDTH);
  const lines = [
    '',
    chalk.dim(`  ╭${border}╮`),
    boxLine(
      `Update available: ${chalk.dim(current)} → ${chalk.green(latest)}`,
    ),
    boxLine(`Run: ${chalk.bold('spycore update')}`),
    chalk.dim(`  ╰${border}╯`),
  ];
  process.stderr.write(lines.join('\n') + '\n');
  pending = null;
}

/** Chars between the │ borders of the banner box. */
const BOX_INNER_WIDTH = 59;
/** Chars of text after the leading two spaces inside the box. */
const BOX_TEXT_WIDTH = BOX_INNER_WIDTH - 2;
/** Max chars shown per version string (see flushUpdateBanner). */
const MAX_VERSION_CHARS = 16;

function capVersion(v: string): string {
  return v.length > MAX_VERSION_CHARS
    ? `${v.slice(0, MAX_VERSION_CHARS - 1)}…`
    : v;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * One box content line, padded to the box width from its VISIBLE length
 * (ANSI colour codes do not count). A line that still overflows - only
 * reachable if the fixed text itself grew - is cut to plain text at the
 * box width rather than overflowing the border.
 */
function boxLine(inner: string): string {
  const visible = stripAnsi(inner).length;
  if (visible > BOX_TEXT_WIDTH) {
    return chalk.dim('  │  ') + stripAnsi(inner).slice(0, BOX_TEXT_WIDTH) + chalk.dim('│');
  }
  return (
    chalk.dim('  │  ') +
    inner +
    ' '.repeat(BOX_TEXT_WIDTH - visible) +
    chalk.dim('│')
  );
}

/** Test hook. */
export function __setPendingForTests(value: PendingBanner | null): void {
  pending = value;
}
