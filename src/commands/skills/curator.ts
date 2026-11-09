/**
 * `spycore skills curator` - the skill lifecycle (H-13).
 *
 * Without flags it REPORTS: stale skills (idle past the threshold), pinned
 * skills, and archived skills - read-only. Flags act:
 *   --archive        move every listed stale skill to .archive/ (never delete)
 *   --pin <name>     exempt a skill from every curator transition
 *   --unpin <name>   lift the exemption
 *   --stale-days <n> inactivity threshold in days (default 90)
 *
 * Only user-global skills are ever touched; project skills and the sync
 * ledger's official skills are always off-limits. Archiving is the ceiling -
 * nothing is ever deleted.
 */
import { Command, Option } from 'commander';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { userSkillsDir } from '../../lib/agent/skills.js';
import {
  archiveSkill,
  DEFAULT_STALE_DAYS,
  findStaleSkills,
  pinSkill,
  readCuratorState,
  SKILL_ARCHIVE_DIRNAME,
  unpinSkill,
} from '../../lib/agent/skill-curator.js';
import { officialSkillNames } from '../../lib/skills-sync.js';
import { parseIntFlag } from '../../lib/numeric-flags.js';
import { readSingleLineInput } from '../../lib/prompt.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { formatOption, getOutputOptions, info, json, print, resolveFormat, success, warn } from '../../lib/output.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';

/** A --pin target must be a real user-global skill directory - pinning a name that does not exist used to silently succeed. */
function requireUserSkill(name: string, userDir: string): void {
  if (
    name.length === 0 ||
    name.startsWith('.') ||
    name.includes('/') ||
    name.includes('\\')
  ) {
    throw new SpycoreCliError(
      `Invalid skill name "${name}".`,
      EXIT_USER_ERROR,
      'Skill names are plain directory names under the user skills directory.',
    );
  }
  let st;
  try {
    st = statSync(join(userDir, name));
  } catch {
    throw new SpycoreCliError(
      `No user-global skill named "${name}".`,
      EXIT_USER_ERROR,
      'See `spycore skills list` for installed skills.',
    );
  }
  if (!st.isDirectory()) {
    throw new SpycoreCliError(
      `"${name}" is not a skill directory.`,
      EXIT_USER_ERROR,
      'See `spycore skills list` for installed skills.',
    );
  }
}

export function registerCurator(group: Command): void {
  group
    .command('curator')
    .description('Skill lifecycle: report stale skills, archive (never delete), pin/unpin')
    .addOption(formatOption())
    .addOption(new Option('--stale-days <n>', 'Inactivity threshold in days').default(String(DEFAULT_STALE_DAYS)))
    .addOption(new Option('--archive', 'Archive every listed stale skill (never deletes)'))
    .addOption(new Option('--yes', 'Archive without the confirmation prompt (only with --archive)'))
    .addOption(new Option('--pin <name>', 'Exempt a skill from every curator transition'))
    .addOption(new Option('--unpin <name>', 'Lift a pin'))
    .action(
      async (opts: { format?: string; staleDays?: string; archive?: boolean; yes?: boolean; pin?: string; unpin?: string }) => {
        const userDir = userSkillsDir();
        // Pin/unpin first. A bare --pin/--unpin keeps its old early return;
        // combined with --archive it falls through so the archive is NOT
        // silently dropped.
        if (opts.pin) {
          const name = opts.pin.trim();
          requireUserSkill(name, userDir);
          pinSkill(name, userDir);
          success(`Pinned "${sanitizeForDisplay(name)}" - exempt from stale detection and archiving.`);
          if (!opts.archive) return;
        }
        if (opts.unpin) {
          const name = opts.unpin.trim();
          // Same existence check as --pin: unpinning a name that does not
          // exist used to print success for an operation that did nothing.
          // And a name that exists but is not pinned is refused too, so
          // the success message only ever follows a real unpin.
          requireUserSkill(name, userDir);
          if (!readCuratorState(userDir).pinned.includes(name)) {
            throw new SpycoreCliError(
              `Skill "${name}" is not pinned.`,
              EXIT_USER_ERROR,
              'See `spycore skills curator` for currently pinned skills.',
            );
          }
          unpinSkill(name, userDir);
          success(`Unpinned "${sanitizeForDisplay(name)}".`);
          if (!opts.archive) return;
        }
        // Invalid input errors instead of silently defaulting: --stale-days
        // abc used to become 90.
        const staleDays = parseIntFlag(opts.staleDays, 'stale-days', { min: 1, defaultValue: DEFAULT_STALE_DAYS });
        // The sync ledger's official skills are off-limits, like project skills.
        const exclude = officialSkillNames();
        const stale = findStaleSkills({ userDir, inactiveDays: staleDays, exclude });
        const pinned = readCuratorState(userDir).pinned;
        let archived: string[] = [];
        try {
          archived = existsSync(join(userDir, SKILL_ARCHIVE_DIRNAME))
            ? readdirSync(join(userDir, SKILL_ARCHIVE_DIRNAME), { withFileTypes: true })
                .filter((d) => d.isDirectory())
                .map((d) => d.name)
                .sort()
            : [];
        } catch {
          archived = [];
        }

        if (opts.archive) {
          // Bulk archiving used to run with no confirmation at all. A
          // destructive-by-volume move needs consent: --yes, or an
          // interactive y/N prompt; non-interactive without --yes refuses.
          if (stale.length > 0 && !opts.yes) {
            if (process.stdin.isTTY !== true || getOutputOptions().json) {
              throw new SpycoreCliError(
                `Refusing to archive ${stale.length} skill${stale.length === 1 ? '' : 's'} without confirmation in a non-interactive session.`,
                EXIT_USER_ERROR,
                'Re-run with --archive --yes to archive non-interactively.',
              );
            }
            const answer = (
              await readSingleLineInput(
                `Archive ${stale.length} stale skill${stale.length === 1 ? '' : 's'} (moves to ${SKILL_ARCHIVE_DIRNAME}/ - never deletes)? (y/N): `,
              )
            )
              .trim()
              .toLowerCase();
            if (answer !== 'y' && answer !== 'yes') {
              info('Cancelled - nothing was archived.');
              return;
            }
          }
          let n = 0;
          for (const s of stale) {
            try {
              const { archivedTo } = archiveSkill(s.name, userDir);
              n += 1;
              if (!getOutputOptions().json) {
                print(`archived ${sanitizeForDisplay(s.name)} -> ${sanitizeForDisplay(archivedTo)}`);
              }
            } catch (err) {
              warn(`could not archive "${sanitizeForDisplay(s.name)}": ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          if (getOutputOptions().json) {
            json({ archived: n, staleDays });
            return;
          }
          success(`Archived ${n} skill${n === 1 ? '' : 's'} (recoverable under ${SKILL_ARCHIVE_DIRNAME}/ - nothing was deleted).`);
          return;
        }

        if (resolveFormat(opts.format) === 'json' || getOutputOptions().json) {
          json({
            userDir,
            staleDays,
            stale: stale.map((s) => ({ name: s.name, lastActivityAt: s.lastActivityAt, reason: s.reason })),
            pinned,
            archived,
          });
          return;
        }
        if (stale.length === 0) {
          info(`No stale skills (nothing user-global idle ${staleDays}+ days).`);
        } else {
          print(`Stale skills (idle ${staleDays}+ days, user-global only):`);
          for (const s of stale) {
            print(`  ${sanitizeForDisplay(s.name)} - ${sanitizeForDisplay(s.reason)}`);
          }
          print('');
          print('Archive them with `spycore skills curator --archive` (moves to .archive/ - never deletes).');
        }
        if (pinned.length > 0) {
          print('');
          print(`Pinned (exempt): ${pinned.map((p) => sanitizeForDisplay(p)).join(', ')}`);
        }
        if (archived.length > 0) {
          print(`Archived: ${archived.map((a) => sanitizeForDisplay(a)).join(', ')}`);
        }
      },
    );
}
