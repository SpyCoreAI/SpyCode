import { Command } from 'commander';
import { registerFilesListCommand } from './list.js';
import { registerFilesShowCommand } from './show.js';
import { registerFilesDownloadCommand } from './download.js';
import { registerFilesDeleteCommand } from './delete.js';
import { registerFilesUploadCommand } from './upload.js';

/**
 * `spycore files <subcommand>` — list, view, upload, download, and
 * delete files in the user's storage. Each subcommand is intentionally
 * tiny and lives in its own file so they're easy to navigate.
 */
export function registerFilesCommand(program: Command): void {
  const group = program
    .command('files')
    .description('List, upload, download, and delete files');

  registerFilesListCommand(group);
  registerFilesShowCommand(group);
  registerFilesUploadCommand(group);
  registerFilesDownloadCommand(group);
  registerFilesDeleteCommand(group);

  group
    .command('help', { isDefault: true, hidden: true })
    .description('Show help for the files subcommand')
    .action(() => {
      group.help();
    });
}
