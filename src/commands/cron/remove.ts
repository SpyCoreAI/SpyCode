import { Command, Option } from 'commander';
import { fail, getOutputOptions, json, success } from '../../lib/output.js';
import { readSingleLineInput } from '../../lib/prompt.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { removeCronEntry } from './store.js';

export function registerCronRemoveCommand(program: Command): void {
  program
    .command('remove <id>')
    .description('Delete a scheduled prompt')
    .addOption(new Option('-y, --yes', 'Skip the confirmation prompt'))
    .action(async (id: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        if (process.stdin.isTTY !== true) {
          // No confirmation possible in non-interactive shells; bail rather
          // than silently deleting in a CI script - see conversations/delete.ts.
          fail(
            new SpycoreCliError(
              'Refusing to remove a scheduled prompt without confirmation in non-TTY mode.',
              EXIT_USER_ERROR,
              'Pass --yes to confirm.',
            ),
          );
        }
        const answer = (
          await readSingleLineInput(`Remove scheduled prompt ${id}? This cannot be undone (y/N): `)
        )
          .trim()
          .toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
          success('Cancelled.');
          return;
        }
      }

      const removed = removeCronEntry(id);
      if (!removed) {
        throw new SpycoreCliError(
          `No scheduled prompt with id "${id}".`,
          EXIT_USER_ERROR,
          'List scheduled prompts with `spycore cron list`.',
        );
      }

      if (getOutputOptions().json) {
        json({ removed: id });
        return;
      }
      success(`Removed scheduled prompt ${sanitizeForDisplay(id)}`);
    });
}
