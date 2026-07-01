import { Command } from 'commander';
import { registerMemoryListCommand } from './list.js';
import { registerMemoryShowCommand } from './show.js';
import { registerMemoryAddCommand } from './add.js';
import { registerMemoryDeleteCommand } from './delete.js';

/**
 * `spycore memory <subcommand>` — view, add, and delete memories that
 * supplement chat context. Mirrors the semantics of the SpyCore Memory
 * feature so a user's CLI workflow doesn't drift from the rest of the product.
 */
export function registerMemoryCommand(program: Command): void {
  const group = program
    .command('memory')
    .description('List, view, add, and delete memories');

  registerMemoryListCommand(group);
  registerMemoryShowCommand(group);
  registerMemoryAddCommand(group);
  registerMemoryDeleteCommand(group);

  group
    .command('help', { isDefault: true, hidden: true })
    .description('Show help for the memory subcommand')
    .action(() => {
      group.help();
    });
}
