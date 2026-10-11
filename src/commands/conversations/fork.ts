import { Command } from 'commander';
import { branchSession, loadSession } from '../../lib/agent/checkpoint.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { getOutputOptions, json, success } from '../../lib/output.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';

export function registerConversationsForkCommand(program: Command): void {
  program
    .command('fork <id>')
    .description('Fork a session: create a new branch of an existing session (keeps a parent reference)')
    .action(async (id: string) => {
      const isJson = getOutputOptions().json;
      const cwd = process.cwd();

      // UX alias over the checkpoint branching mechanism: the new session is
      // a copy of the source's journal with a fresh id, and records the
      // source as its parent so the fork relationship is explicit.
      const newId = branchSession(cwd, id);
      if (!newId) {
        throw new SpycoreCliError(
          `No session "${id}" for this directory.`,
          EXIT_USER_ERROR,
          'List sessions with `spycore rewind --list`.',
        );
      }
      const forked = loadSession(cwd, newId);

      if (isJson) {
        json({
          cwd,
          id: newId,
          parentId: forked?.parentId ?? id,
          sourceId: id,
        });
        return;
      }
      success(
        `Forked session ${sanitizeForDisplay(id)} → ${sanitizeForDisplay(newId)} (parent: ${sanitizeForDisplay(forked?.parentId ?? id)}). Resume it with \`spycore agent --resume ${newId}\`.`,
      );
    });
}
