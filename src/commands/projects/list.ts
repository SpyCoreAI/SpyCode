import { Command } from 'commander';
import { formatOption, json, print, resolveFormat } from '../../lib/output.js';
import { display } from '../../lib/sanitize-display.js';
import { hasSpycodeMd, loadProjects, type ProjectEntry } from './store.js';

interface ProjectRow extends ProjectEntry {
  hasSpycodeMd: boolean;
}

/**
 * `spycore projects list` — list the locally registered project workspaces.
 * Purely local: reads <configDir>/projects.json, makes no network calls.
 */
export function registerProjectsListCommand(group: Command): void {
  group
    .command('list')
    .description('List registered project workspaces (local registry only)')
    .addOption(formatOption())
    .action((opts: { format?: string }) => {
      const entries = loadProjects();
      const rows: ProjectRow[] = entries.map((e) => ({
        ...e,
        hasSpycodeMd: hasSpycodeMd(e.path),
      }));

      if (resolveFormat(opts.format) === 'json') {
        json({ projects: rows });
        return;
      }

      if (rows.length === 0) {
        print('No projects registered yet — run `spycore projects add <path>`.');
        return;
      }

      print(`Registered projects (${rows.length}):`);
      for (const row of rows) {
        const marker = row.hasSpycodeMd ? 'SPYCODE.md' : 'no SPYCODE.md';
        print(display`  ${row.name}  →  ${row.path}  [${marker}]`);
      }
    });
}
