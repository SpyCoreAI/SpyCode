import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command, Option } from 'commander';
import { discoverSkills } from '../../lib/agent/skills.js';
import { officialSkillNames } from '../../lib/skills-sync.js';
import { isPromptCancelled, readSingleLineInput } from '../../lib/prompt.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { getOutputOptions, info, json, success, warn } from '../../lib/output.js';

/**
 * `spycore skills remove <name>` — delete a USER-CREATED or PROJECT skill
 * directory (y/N confirm unless --yes). Official skills (recorded in the
 * .sync.json ledger) are REFUSED: `skills sync` owns them — removing the
 * files by hand would just re-download on the next sync, and the ledger
 * would be left lying about what exists.
 */
export function registerRemove(group: Command): void {
  group
    .command('remove <name>')
    .description('Remove a user-created or project skill (official skills are owned by `skills sync`)')
    .addOption(new Option('-y, --yes', 'Remove without asking for confirmation'))
    .action(async (nameArg: string, opts: { yes?: boolean }) => {
      const cwd = process.cwd();
      const name = nameArg.trim();
      const skills = discoverSkills(cwd);
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        throw new SpycoreCliError(
          `No skill named "${name}".`,
          EXIT_USER_ERROR,
          skills.length > 0
            ? `Installed: ${skills.map((s) => s.name).join(', ')}`
            : 'No skills are installed — see `spycore skills list`.',
        );
      }
      // Ledger-owned user-global skills belong to sync. (A PROJECT skill with
      // an official name is user content shadowing it — that one is removable.)
      if (skill.source === 'user' && officialSkillNames().has(skill.name)) {
        throw new SpycoreCliError(
          `"${name}" is an official skill — \`spycore skills sync\` owns it.`,
          EXIT_USER_ERROR,
          'Official skills are managed by sync (removing the files would just re-download on the next sync). Only user-created and project skills can be removed.',
        );
      }

      const dir = dirname(skill.path);
      if (!opts.yes) {
        if (process.stdin.isTTY !== true) {
          throw new SpycoreCliError(
            'Refusing to remove without confirmation in a non-interactive session.',
            EXIT_USER_ERROR,
            'Pass --yes to confirm.',
          );
        }
        try {
          const answer = (await readSingleLineInput(`Remove ${skill.source} skill "${name}" (${dir})? [y/N] › `))
            .trim()
            .toLowerCase();
          if (answer !== 'y' && answer !== 'yes') {
            info('Aborted — nothing was removed.');
            return;
          }
        } catch (err) {
          if (isPromptCancelled(err)) {
            warn('Cancelled — nothing was removed.');
            process.exitCode = 130;
            return;
          }
          throw err;
        }
      }

      rmSync(dir, { recursive: true, force: true });
      if (getOutputOptions().json) {
        json({ removed: name, source: skill.source, path: dir });
        return;
      }
      success(`Removed ${skill.source} skill "${name}" (${dir}).`);
    });
}
