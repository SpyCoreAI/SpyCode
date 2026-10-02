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
    // soft fail — never propagate
  }
}

export function flushUpdateBanner(): void {
  if (!pending) return;
  if (!isInteractive()) return;

  // The version strings come from a REMOTE registry response — sanitize so a
  // poisoned value can't drive the terminal (escape/OSC injection).
  const current = sanitizeForDisplay(pending.current);
  const latest = sanitizeForDisplay(pending.latest);
  const lines = [
    '',
    chalk.dim('  ╭───────────────────────────────────────────────────────────╮'),
    chalk.dim('  │  ') +
      `Update available: ${chalk.dim(current)} → ${chalk.green(latest)}` +
      chalk.dim('       │'),
    chalk.dim('  │  ') +
      `Run: ${chalk.bold('spycore update')}` +
      chalk.dim('                                       │'),
    chalk.dim('  ╰───────────────────────────────────────────────────────────╯'),
  ];
  process.stderr.write(lines.join('\n') + '\n');
  pending = null;
}

/** Test hook. */
export function __setPendingForTests(value: PendingBanner | null): void {
  pending = value;
}
