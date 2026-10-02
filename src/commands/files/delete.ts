import { Command, Option } from 'commander';
import { api } from '../../lib/api.js';
import { fail, success, warn } from '../../lib/output.js';
import { readSingleLineInput } from '../../lib/prompt.js';
import {
  EXIT_USER_ERROR,
  SpycoreCliError,
  isSpycoreCliError,
} from '../../lib/errors.js';
import { display, sanitizeForDisplay } from '../../lib/sanitize-display.js';

interface FileDetail {
  id: string;
  filename: string;
}

export function registerFilesDeleteCommand(program: Command): void {
  program
    .command('delete <id>')
    .description('Delete an uploaded file')
    .addOption(new Option('-y, --yes', 'Skip the confirmation prompt'))
    .action(async (id: string, opts: { yes?: boolean }, cmd: Command) => {
      const root = cmd.parent?.parent;
      const parentOpts = root?.opts<{ apiUrl?: string }>() ?? {};

      // Fetch the file metadata first so the confirmation can name it
      // and so we surface a friendly 404 before sending the DELETE.
      let file: FileDetail | null = null;
      try {
        file = await api.get<FileDetail>(`/api/files/${encodeURIComponent(id)}`, {
          apiUrlOverride: parentOpts.apiUrl,
        });
      } catch (err) {
        if (isSpycoreCliError(err) && err.code === EXIT_USER_ERROR) {
          throw new SpycoreCliError(
            `File not found: ${id}`,
            EXIT_USER_ERROR,
            'Run `spycore files list` to see available IDs.',
          );
        }
        throw err;
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
        // ⭐ THE APPROVAL PROMPT. `file.filename` is server-supplied, and
        // SECURITY.md §2 names "restyled or overwritten approval prompts" as
        // the threat the sanitizer exists to stop. Until F-2c-9 this line was
        // raw while line 71 below sanitized the SAME value — an omission, not
        // a decision (SPY-248).
        const label = file?.filename ? display`${id} (${file.filename})` : id;
        const answer = (
          await readSingleLineInput(`Delete file ${label}? (y/N): `)
        )
          .trim()
          .toLowerCase();
        if (answer !== 'y' && answer !== 'yes') {
          warn('Cancelled.');
          return;
        }
      }

      await api.delete(`/api/files/${encodeURIComponent(id)}`, {
        apiUrlOverride: parentOpts.apiUrl,
      });
      success(
        file?.filename
          ? `Deleted ${id} (${sanitizeForDisplay(file.filename)})`
          : `Deleted ${id}`,
      );
    });
}
