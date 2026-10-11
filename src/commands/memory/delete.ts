import { Command, Option } from 'commander';
import { api } from '../../lib/api.js';
import { fail, success, warn } from '../../lib/output.js';
import { readSingleLineInput } from '../../lib/prompt.js';
import {
  EXIT_USER_ERROR,
  SpycoreCliError,
} from '../../lib/errors.js';

export function registerMemoryDeleteCommand(program: Command): void {
  program
    .command('delete [id]')
    .description('Delete a memory (use --all to clear everything)')
    .addOption(new Option('-y, --yes', 'Skip the confirmation prompt'))
    .addOption(new Option('--all', 'Delete every memory (irreversible)'))
    .action(
      async (
        id: string | undefined,
        opts: { yes?: boolean; all?: boolean },
        cmd: Command,
      ) => {
        const root = cmd.parent?.parent;
        const parentOpts = root?.opts<{ apiUrl?: string }>() ?? {};

        if (opts.all) {
          if (!opts.yes) {
            if (process.stdin.isTTY !== true) {
              fail(
                new SpycoreCliError(
                  'Refusing --all without --yes in non-TTY mode.',
                  EXIT_USER_ERROR,
                ),
              );
            }
            const answer = (
              await readSingleLineInput(
                'Delete ALL memories? Type "delete everything" to confirm: ',
              )
            ).trim();
            if (answer !== 'delete everything') {
              warn('Cancelled.');
              return;
            }
          }
          await api.delete('/api/memory', {
            apiUrlOverride: parentOpts.apiUrl,
            body: { confirm: 'delete everything' },
          });
          success('All memories cleared');
          return;
        }

        if (!id) {
          throw new SpycoreCliError(
            'Specify a memory id, or use --all.',
            EXIT_USER_ERROR,
            'Run `spycore memory list` to see available IDs.',
          );
        }

        if (!opts.yes) {
          if (process.stdin.isTTY !== true) {
            fail(
              new SpycoreCliError(
                'Refusing to delete without confirmation in non-TTY mode.',
                EXIT_USER_ERROR,
                'Pass --yes to confirm.',
              ),
            );
          }
          const answer = (
            await readSingleLineInput(`Delete memory ${id}? (y/N): `)
          )
            .trim()
            .toLowerCase();
          if (answer !== 'y' && answer !== 'yes') {
            warn('Cancelled.');
            return;
          }
        }

        await api.delete(`/api/memory/${encodeURIComponent(id)}`, {
          apiUrlOverride: parentOpts.apiUrl,
        });
        success(`Deleted ${id}`);
      },
    );
}
