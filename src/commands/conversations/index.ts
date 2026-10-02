import { Command } from 'commander';
import { registerConversationsListCommand } from './list.js';
import { registerConversationsShowCommand } from './show.js';
import { registerConversationsDeleteCommand } from './delete.js';
import { registerConversationsExportCommand } from './export.js';

/**
 * `spycore conversations <subcommand>` — view, manage, and export
 * conversation history. The four subcommands are intentionally tiny and
 * each lives in its own file so they're trivially navigable.
 */
export function registerConversationsCommand(program: Command): void {
  const group = program
    .command('conversations')
    .description('List, view, delete, and export conversations');

  registerConversationsListCommand(group);
  registerConversationsShowCommand(group);
  registerConversationsDeleteCommand(group);
  registerConversationsExportCommand(group);

  group
    .command('help', { isDefault: true, hidden: true })
    .description('Show help for the conversations subcommand')
    .action(() => {
      group.help();
    });
}
