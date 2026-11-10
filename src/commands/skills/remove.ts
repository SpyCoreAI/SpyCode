import { rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';
import { Command, Option } from 'commander';
import { discoverSkills, projectSkillsDir, userSkillsDir } from '../../lib/agent/skills.js';
import { officialSkillNames } from '../../lib/skills-sync.js';
import { isPromptCancelled, readSingleLineInput } from '../../lib/prompt.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { getOutputOptions, info, json, success, warn } from '../../lib/output.js';

/**
 * True when `dir` is strictly inside one of the skills roots (user-global
 * or this cwd's project skills). The skills directory itself is NOT inside
 * itself - deleting it would wipe every skill. Exported for tests.
 */
export function isWithinSkillsRoots(dir: string, cwd: string): boolean {
  const abs = resolvePath(dir);
  const roots = [resolvePath(userSkillsDir()), resolvePath(projectSkillsDir(cwd))];
  return roots.some((root) => {
    const rel = relative(root, abs);
    return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel);
  });
}
/**
 * `spycore skills remove <name>` - delete a USER-CREATED or PROJECT skill
 * directory (y/N confirm unless --yes). Official skills (recorded in the
 * .sync.json ledger) are REFUSED: `skills sync` owns them - removing the
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
      // Management command: the user explicitly asked, so every skill is
      // visible regardless of workspace trust (the agent run stays gated).
      const skills = discoverSkills(cwd, { includeUntrustedProject: true });
      const skill = skills.find((s) => s.name === name);
      if (!skill) {
        throw new SpycoreCliError(
          `No skill named "${name}".`,
          EXIT_USER_ERROR,
          skills.length > 0
            ? `Installed: ${skills.map((s) => s.name).join(', ')}`
            : 'No skills are installed - see `spycore skills list`.',
        );
      }
      // Ledger-owned user-global skills belong to sync. (A PROJECT skill with
      // an official name is user content shadowing it - that one is removable.)
      if (skill.source === 'user' && officialSkillNames().has(skill.name)) {
        throw new SpycoreCliError(
          `"${name}" is an official skill - \`spycore skills sync\` owns it.`,
          EXIT_USER_ERROR,
          'Official skills are managed by sync (removing the files would just re-download on the next sync). Only user-created and project skills can be removed.',
        );
      }

      const dir = resolvePath(dirname(skill.path));
      // Containment: the recursive delete below must stay inside a skills
      // directory. discoverSkills is trusted to only return paths under
      // those roots, but a compromised or buggy discovery result must never
      // turn `skills remove` into a recursive delete of an arbitrary tree -
      // verify here, at the point of the delete.
      if (!isWithinSkillsRoots(dir, cwd)) {
        throw new SpycoreCliError(
          `Refusing to remove "${name}": its directory (${dir}) is outside the skills directories.`,
          EXIT_USER_ERROR,
          'The discovered skill path is not one this command will delete - inspect the skill and remove it by hand if it is really yours.',
        );
      }
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
            info('Aborted - nothing was removed.');
            return;
          }
        } catch (err) {
          if (isPromptCancelled(err)) {
            warn('Cancelled - nothing was removed.');
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
