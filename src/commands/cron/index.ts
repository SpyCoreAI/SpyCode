import { Command } from 'commander';
import { registerCronAddCommand } from './add.js';
import { registerCronListCommand } from './list.js';
import { registerCronRemoveCommand } from './remove.js';

/**
 * `spycore cron <subcommand>` - manage scheduled prompts: entries stored in
 * the local CLI config dir (see store.ts for why this is client-local and
 * what the platform API does and doesn't expose).
 */
export function registerCronCommand(program: Command): void {
  const group = program
    .command('cron')
    .description('Add, list, and remove scheduled prompts');

  registerCronAddCommand(group);
  registerCronListCommand(group);
  registerCronRemoveCommand(group);

  group
    .command('help', { isDefault: true, hidden: true })
    .description('Show help for the cron subcommand')
    .action(() => {
      group.help();
    });
}
