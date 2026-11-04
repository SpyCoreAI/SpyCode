import { Command } from 'commander';
import { registerProjectsListCommand } from './list.js';
import { registerProjectsAddCommand } from './add.js';
import { registerProjectsRemoveCommand } from './remove.js';

/**
 * `spycore projects <subcommand>` — client-side project workspace registry
 * (F30 scaffolding).
 *
 * The platform has no project/workspace sync API (see store.ts), so this is
 * deliberately CLIENT-LOCAL: `add` records a directory in
 * <configDir>/projects.json, `list` shows the registry with a SPYCODE.md
 * presence marker, and `remove` unregisters. No subcommand performs any
 * network I/O.
 *
 * INTEGRATION NOTE: wire this into the CLI with one import + one call in
 * src/index.ts —
 *   import { registerProjectsCommand } from './commands/projects/index.js';
 *   registerProjectsCommand(program);
 * (left to the merge wave; this branch only adds new files).
 */
export function registerProjectsCommand(program: Command): void {
  const group = program
    .command('projects')
    .description('Register and list local project workspaces (no cloud sync yet)');

  registerProjectsListCommand(group);
  registerProjectsAddCommand(group);
  registerProjectsRemoveCommand(group);

  group
    .command('help', { isDefault: true, hidden: true })
    .description('Show help for the projects subcommand')
    .action(() => {
      group.help();
    });
}
