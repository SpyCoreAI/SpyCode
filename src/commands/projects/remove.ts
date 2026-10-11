import { Command } from 'commander';
import { getOutputOptions, json, success } from '../../lib/output.js';
import { display } from '../../lib/sanitize-display.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { findProject, loadProjects, saveProjects } from './store.js';

/**
 * `spycore projects remove <name>` — unregister a project workspace.
 * Purely local: removes the entry from <configDir>/projects.json. Never
 * touches the directory itself and makes no network calls.
 */
export function registerProjectsRemoveCommand(group: Command): void {
  group
    .command('remove <name>')
    .description('Unregister a project workspace (local registry only)')
    .action((nameArg: string) => {
      const name = nameArg.trim();
      const entries = loadProjects();
      const existing = findProject(entries, name);
      if (!existing) {
        throw new SpycoreCliError(
          `No project named ${JSON.stringify(name)}. Run \`spycore projects list\` to see registered projects.`,
          EXIT_USER_ERROR,
        );
      }
      saveProjects(entries.filter((e) => e.name !== name));

      if (getOutputOptions().json) {
        json({ removed: name });
        return;
      }
      success(display`Removed project ${name}.`);
    });
}
