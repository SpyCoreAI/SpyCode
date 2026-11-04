import { existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command, Option } from 'commander';
import { CHANGELOG_FILE, initChangelogFile } from '../lib/codebase-changelog.js';
import { GUIDE_FILE, initCodebaseGuide } from '../lib/codebase-guide.js';
import { MEMORY_FILE, initMemoryFile } from '../lib/memory.js';
import { isPromptCancelled, readSingleLineInput } from '../lib/prompt.js';
import { getOutputOptions, json, print, success, warn, fail } from '../lib/output.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../lib/errors.js';
import { sanitizeForDisplay } from '../lib/sanitize-display.js';

/**
 * `spycore init` - bootstrap a project for SpyCode (feature F19).
 *
 * Generates the three living-memory files at the current working directory:
 *   SPYCODE.md            via initMemoryFile      (src/lib/memory.ts)
 *   CODEBASE_GUIDE.md     via initCodebaseGuide   (src/lib/codebase-guide.ts)
 *   CODEBASE_CHANGELOG.md via initChangelogFile   (src/lib/codebase-changelog.ts)
 *
 * This is the non-interactive twin of the `/init` slash command
 * (src/lib/slash/registry.ts): it calls the SAME generators, so the files it
 * produces are byte-identical to the in-chat flow's. The generation logic
 * itself is never duplicated here.
 *
 * Idempotency: an existing file is NEVER overwritten or duplicated - it is
 * skipped and reported. `--force` switches to overwrite mode, which still
 * prompts once in an interactive session before destroying anything
 * (`--yes` skips the prompt; a non-interactive session without `--yes`
 * refuses, matching the conversations/delete and git-workflow convention).
 * `--dry-run` previews the plan (create / overwrite / skip) without writing
 * anything and without prompting.
 *
 * One failing file never blocks the others - each file is attempted
 * independently and per-file errors are reported at the end.
 */

interface InitTarget {
  /** Display/file name, e.g. 'SPYCODE.md'. */
  file: string;
  /** Absolute path the file lives at (or would). */
  path: string;
  /** Runs the file's existing generator; resolves `{ created, path }`. */
  generate: () => Promise<{ created: boolean; path: string }>;
}

type FileAction = 'created' | 'skipped' | 'overwritten';

interface InitFileOutcome {
  file: string;
  path: string;
  existed: boolean;
  /** What happened - or, under --dry-run, what WOULD happen. */
  action: FileAction;
  error?: string | undefined;
}

interface InitOpts {
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
  yes?: boolean | undefined;
}

/** y/N confirm via the existing prompt primitive. Cancel (Ctrl+C) = no. */
async function confirm(question: string): Promise<boolean> {
  try {
    const answer = (await readSingleLineInput(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } catch (err) {
    if (isPromptCancelled(err)) return false;
    throw err;
  }
}

function targetsFor(cwd: string): InitTarget[] {
  const root = resolve(cwd);
  return [
    {
      file: MEMORY_FILE,
      path: join(root, MEMORY_FILE),
      generate: () => initMemoryFile(cwd),
    },
    {
      file: GUIDE_FILE,
      path: join(root, GUIDE_FILE),
      generate: () => initCodebaseGuide(cwd),
    },
    {
      file: CHANGELOG_FILE,
      path: join(root, CHANGELOG_FILE),
      generate: async () => initChangelogFile(cwd),
    },
  ];
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description(
      'Bootstrap SpyCode project memory: generate SPYCODE.md, CODEBASE_GUIDE.md and CODEBASE_CHANGELOG.md',
    )
    .addOption(new Option('--force', 'Overwrite existing files (prompts for confirmation interactively)'))
    .addOption(new Option('--dry-run', 'Preview what would be created, overwritten, or skipped without writing anything'))
    .addOption(new Option('-y, --yes', 'Skip the overwrite confirmation prompt'))
    .action(async (opts: InitOpts) => {
      const cwd = process.cwd();
      const force = opts.force === true;
      const dryRun = opts.dryRun === true;
      const targets = targetsFor(cwd);

      // ── Overwrite gate: --force on existing files needs explicit consent. ──
      const existing = targets.filter((t) => existsSync(t.path));
      if (force && !dryRun && existing.length > 0 && opts.yes !== true) {
        if (process.stdin.isTTY !== true) {
          // No confirmation possible in non-interactive shells; bail rather
          // than silently destroying user-edited files in a CI script.
          fail(
            new SpycoreCliError(
              'Refusing to overwrite existing project files without confirmation in non-TTY mode.',
              EXIT_USER_ERROR,
              'Pass --yes to confirm.',
            ),
          );
          return; // fail() exits in production; the return keeps stubbed-exit tests honest.
        }
        const names = existing.map((t) => t.file).join(', ');
        const ok = await confirm(`Overwrite ${names}? Existing content will be replaced.`);
        if (!ok) {
          print('Cancelled.');
          return;
        }
      }

      // ── Run every file independently: one failure never blocks the others. ──
      const outcomes: InitFileOutcome[] = [];
      for (const target of targets) {
        const existed = existsSync(target.path);
        if (dryRun) {
          const action: FileAction = !existed ? 'created' : force ? 'overwritten' : 'skipped';
          outcomes.push({ file: target.file, path: target.path, existed, action });
          continue;
        }
        try {
          if (existed && !force) {
            outcomes.push({ file: target.file, path: target.path, existed, action: 'skipped' });
            continue;
          }
          if (existed && force) {
            // Force-overwrite reuses the SAME generator: remove first so the
            // never-overwrite init function writes a fresh file.
            unlinkSync(target.path);
          }
          const result = await target.generate();
          outcomes.push({
            file: target.file,
            path: result.path,
            existed,
            action: existed ? 'overwritten' : result.created ? 'created' : 'skipped',
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          outcomes.push({ file: target.file, path: target.path, existed, action: 'skipped', error: message });
          warn(`Failed to generate ${target.file}: ${sanitizeForDisplay(message)}`);
        }
      }

      const failed = outcomes.filter((o) => o.error !== undefined);

      if (getOutputOptions().json) {
        json({
          dryRun,
          force,
          files: outcomes.map((o) => ({
            file: o.file,
            path: o.path,
            existed: o.existed,
            action: o.action,
            ...(o.error !== undefined ? { error: o.error } : {}),
          })),
        });
        if (failed.length > 0) process.exitCode = 1;
        return;
      }

      for (const o of outcomes) {
        const name = sanitizeForDisplay(o.file);
        if (o.error !== undefined) continue; // already warned above
        if (dryRun) {
          if (o.action === 'created') print(`[dry-run] would create ${name}`);
          else if (o.action === 'overwritten') print(`[dry-run] would overwrite ${name}`);
          else print(`[dry-run] ${name} already exists - would skip (use --force to overwrite)`);
        } else if (o.action === 'created') {
          success(`Created ${name}`);
        } else if (o.action === 'overwritten') {
          success(`Overwrote ${name}`);
        } else {
          print(`${name} already exists - skipped (use --force to overwrite)`);
        }
      }

      if (failed.length > 0) {
        fail(
          new SpycoreCliError(
            `init completed with ${failed.length} error${failed.length === 1 ? '' : 's'}.`,
            EXIT_USER_ERROR,
          ),
        );
      }
    });
}
