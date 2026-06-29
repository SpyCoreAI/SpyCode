import { Command, Option } from 'commander';
import { api } from '../../lib/api.js';
import { readSingleLineInput } from '../../lib/prompt.js';
import { fail, success } from '../../lib/output.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';

export function registerConversationsDeleteCommand(program: Command): void {
  program
    .command('delete <id>')
    .description('Permanently delete a conversation and its messages')
    .addOption(new Option('-y, --yes', 'Skip the confirmation prompt'))
    .action(
      async (id: string, opts: { yes?: boolean }, cmd: Command) => {
        const root = cmd.parent?.parent;
        const parentOpts = root?.opts<{ apiUrl?: string }>() ?? {};

        if (!opts.yes) {
          if (process.stdin.isTTY !== true) {
            // No confirmation possible in non-interactive shells; bail rather
            // than silently deleting in a CI script.
            fail(
              new SpycoreCliError(
                'Refusing to delete without confirmation in non-TTY mode.',
                EXIT_USER_ERROR,
                'Pass --yes to confirm.',
              ),
            );
          }
          const answer = (
            await readSingleLineInput(
              `Delete conversation ${id}? This cannot be undone (y/N): `,
            )
          )
            .trim()
            .toLowerCase();
          if (answer !== 'y' && answer !== 'yes') {
            success('Cancelled.');
            return;
          }
        }

        await api.delete(`/conversations/${id}`, {
          apiUrlOverride: parentOpts.apiUrl,
        });
        success(`Deleted ${id}`);
      },
    );
}
