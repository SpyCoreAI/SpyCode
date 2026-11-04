import { Command } from 'commander';
import { registerConversationsListCommand } from './list.js';
import { registerConversationsShowCommand } from './show.js';
import { registerConversationsDeleteCommand } from './delete.js';
import { registerConversationsExportCommand } from './export.js';
import { registerConversationsForkCommand } from './fork.js';
import { registerConversationsHandoffCommand } from './handoff.js';
import { registerConversationsShareCommand } from './share.js';

/**
 * `spycore conversations <subcommand>` - view, manage, export, fork, hand off,
 * and share conversation history. The subcommands are intentionally tiny and
 * each lives in its own file so they're trivially navigable.
 */
export function registerConversationsCommand(program: Command): void {
  const group = program
    .command('conversations')
    .description('List, view, delete, export, fork, hand off, and share conversations and sessions');

  registerConversationsListCommand(group);
  registerConversationsShowCommand(group);
  registerConversationsDeleteCommand(group);
  registerConversationsExportCommand(group);
  registerConversationsForkCommand(group);
  registerConversationsHandoffCommand(group);
  registerConversationsShareCommand(group);

  group
    .command('help', { isDefault: true, hidden: true })
    .description('Show help for the conversations subcommand')
    .action(() => {
      group.help();
    });
}
