import { Command } from 'commander';
import chalk from 'chalk';
import { getOutputOptions, info, json, print, success } from '../lib/output.js';
import {
  checkForUpdates,
  detectInstallMethod,
  updateCommandFor,
  __resetUpdateCache,
} from '../lib/version-check.js';

/**
 * `spycore update` — checks the npm registry for a newer release and
 * tells the user how to upgrade. Deliberately does NOT shell out to a
 * package manager: auto-execution of arbitrary upgrade commands is a
 * sharp edge we don't want, so we surface the exact command and let the
 * human run it.
 */
export function registerUpdateCommand(program: Command, currentVersion: string): void {
  program
    .command('update')
    .description('Check for a newer @spycore/cli release and show how to upgrade')
    .option('--check', 'Only check (default behaviour) — exits 0 if up-to-date, 1 if update available')
    .action(async (opts: { check?: boolean }) => {
      // Force a fresh lookup on explicit invocation — the daily cache is
      // for the passive banner, not for the user who just typed `update`.
      __resetUpdateCache();
      const result = await checkForUpdates({ currentVersion });
      const method = detectInstallMethod();
      const upgradeCmd = updateCommandFor(method);

      if (getOutputOptions().json) {
        json({
          current: currentVersion,
          latest: result?.latest ?? null,
          hasUpdate: result?.hasUpdate ?? false,
          installMethod: method,
          upgradeCommand: upgradeCmd,
        });
        if (opts.check && result?.hasUpdate) {
          process.exit(1);
        }
        return;
      }

      if (!result) {
        info('Could not reach the npm registry. Try again later.');
        return;
      }

      if (!result.hasUpdate) {
        success(`You're on the latest version (${result.current}).`);
        return;
      }

      print(`Update available: ${chalk.dim(result.current)} → ${chalk.green(result.latest)}`);
      print(`Detected install method: ${chalk.cyan(method)}`);
      print('');
      print(`Run: ${chalk.bold(upgradeCmd)}`);

      if (opts.check) process.exit(1);
    });
}
