import { Command, Option } from 'commander';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { getOutputOptions, json, print, success } from '../../lib/output.js';
import { display } from '../../lib/sanitize-display.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import {
  findProject,
  hasSpycodeMd,
  loadProjects,
  saveProjects,
  type ProjectEntry,
} from './store.js';

const failUser = (msg: string): never => {
  throw new SpycoreCliError(msg, EXIT_USER_ERROR);
};

/** Project names are display identifiers, never paths: no separators. */
function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) failUser('Project name must not be empty.');
  if (/[/\\]/.test(trimmed)) {
    failUser(`Invalid project name ${JSON.stringify(trimmed)}: must not contain path separators.`);
  }
  return trimmed;
}

/**
 * `spycore projects add <path> [--name <name>]` — register a directory as a
 * project workspace. Purely local: appends to <configDir>/projects.json.
 * The directory must exist; SPYCODE.md is recommended but not required (a
 * warning is printed when it is missing).
 */
export function registerProjectsAddCommand(group: Command): void {
  group
    .command('add <path>')
    .description('Register a directory as a project workspace (local registry only)')
    .addOption(
      new Option('--name <name>', 'Project name (defaults to the directory name)'),
    )
    .action((pathArg: string, opts: { name?: string }) => {
      const absPath = resolve(pathArg);

      let isDir = false;
      try {
        isDir = existsSync(absPath) && statSync(absPath).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        failUser(
          `Not a directory: ${absPath}. \`spycore projects add\` registers an existing directory.`,
        );
      }

      const entries = loadProjects();

      const already = entries.find((e) => e.path === absPath);
      if (already) {
        failUser(
          `Already registered as ${JSON.stringify(already.name)}. ` +
            `Run \`spycore projects remove ${already.name}\` first to re-register it.`,
        );
      }

      const name = validateName(opts.name ?? basename(absPath));
      const nameTaken = findProject(entries, name);
      if (nameTaken) {
        failUser(
          `A project named ${JSON.stringify(name)} is already registered ` +
            `(${nameTaken.path}). Pass --name <name> to choose a different name.`,
        );
      }

      const entry: ProjectEntry = {
        name,
        path: absPath,
        addedAt: new Date().toISOString(),
      };
      entries.push(entry);
      saveProjects(entries);

      const withMd = hasSpycodeMd(absPath);
      if (getOutputOptions().json) {
        json({ project: { ...entry, hasSpycodeMd: withMd } });
        return;
      }
      success(display`Registered project ${name} → ${absPath}`);
      if (!withMd) {
        // Warn, don't fail: the directory is still a usable workspace, it
        // just has no SPYCODE.md memory file for `list` to recognise yet.
        print(
          display`  Note: ${absPath} has no SPYCODE.md yet — run \`spycore init\` there to create one.`,
        );
      }
    });
}
