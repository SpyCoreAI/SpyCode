import { Command, Option } from 'commander';
import chalk from 'chalk';
import { relative } from 'node:path';
import {
  applyRewind,
  listSessions,
  loadSession,
  markSessionDone,
  planRewind,
} from '../lib/agent/checkpoint.js';
import { isResumable } from '../lib/agent/resume.js';
import { getOutputOptions, json, print, success, warn } from '../lib/output.js';
import { readSingleLineInput } from '../lib/prompt.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../lib/errors.js';
import { sanitizeForDisplay } from '../lib/sanitize-display.js';

interface RewindOpts {
  yes?: boolean;
  session?: string;
  list?: boolean;
}

function relTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 5) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function relTo(cwd: string, abs: string): string {
  const r = relative(cwd, abs);
  return r.length > 0 && !r.startsWith('..') ? r : abs;
}

export function registerRewindCommand(program: Command): void {
  program
    .command('rewind')
    .description("Undo the last agent session's file changes in this directory")
    .addOption(new Option('-y, --yes', 'Apply without the confirmation prompt'))
    .addOption(new Option('--session <id>', 'Rewind a specific session id (see --list)'))
    .addOption(new Option('--list', 'List recent agent sessions for this directory'))
    .action(async (opts: RewindOpts) => {
      const isJson = getOutputOptions().json;
      const cwd = process.cwd();

      // ── --list ──────────────────────────────────────────────────────────
      if (opts.list) {
        const sessions = listSessions(cwd);
        if (isJson) {
          json({
            cwd,
            sessions: sessions.map((s) => ({
              id: s.id,
              startedAt: s.startedAt,
              files: s.changes.length,
              task: s.task,
              // Interrupted runs recorded with resume support can be continued
              // with `spycore agent --resume <id>` (additive field; always
              // false for sessions written before resume support).
              resumable: isResumable(s),
            })),
          });
          return;
        }
        if (sessions.length === 0) {
          print('No agent sessions recorded for this directory.');
          return;
        }
        print('Recent agent sessions (newest first):');
        for (const s of sessions) {
          const resumeTag = isResumable(s) ? `  ${chalk.dim('↻ resumable')}` : '';
          print(
            `  ${s.id}  ${chalk.dim(relTime(s.startedAt))}  ${s.changes.length} file${s.changes.length === 1 ? '' : 's'}  ${chalk.dim(truncate(s.task, 56))}${resumeTag}`,
          );
        }
        print(chalk.dim('Rewind the newest with `spycore rewind`, or a specific one with `--session <id>`.'));
        return;
      }

      // ── Load the session to rewind ────────────────────────────────────────
      // Bare rewind targets the newest session WITH file changes: interrupted
      // runs may journal a resume record before any write, and today's "rewind
      // the newest change" behavior must not be shadowed by a changeless record.
      const session = opts.session
        ? loadSession(cwd, opts.session)
        : listSessions(cwd).find((s) => s.changes.length > 0) ?? null;
      if (!session) {
        if (opts.session) {
          throw new SpycoreCliError(
            `No session "${opts.session}" for this directory.`,
            EXIT_USER_ERROR,
            'List sessions with `spycore rewind --list`.',
          );
        }
        if (isJson) {
          json({ cwd, applied: false, restored: 0, skipped: 0, message: 'nothing to rewind' });
          return;
        }
        print('Nothing to rewind - no agent file changes are recorded for this directory.');
        return;
      }

      const steps = planRewind(session);
      const actionable = steps.filter((s) => s.action !== 'skip');

      // ── Preview (text mode) ───────────────────────────────────────────────
      if (!isJson) {
        print(
          `Rewind session ${session.id} (${relTime(session.startedAt)}) - ${session.changes.length} change${session.changes.length === 1 ? '' : 's'}:`,
        );
        for (const s of steps) {
          // Paths recorded by the agent run - repo/agent-authored names.
          const rel = sanitizeForDisplay(relTo(cwd, s.change.path));
          if (s.action === 'delete') print(`  ${chalk.red('delete ')} ${rel} ${chalk.dim('(created by the agent)')}`);
          else if (s.action === 'restore') print(`  ${chalk.green('restore')} ${rel}`);
          else
            print(
              `  ${chalk.dim(`skip     ${rel} - ${sanitizeForDisplay(s.reason ?? '')}`)}`,
            );
        }
        // THE BOUND, STATED WHERE THE USER RELIES ON IT. The journal now
        // covers the opaque tools - run_command, MCP, hooks - by observing the
        // workspace around each call, and that coverage has real edges. Naming
        // them in the documents alone would put the limit somewhere the person
        // about to press "y" is not reading. A partial capability described
        // precisely beats a total one described falsely, and this is the moment
        // the description has to be in front of them.
        print(
          chalk.dim(
            'Covers workspace files the run changed. NOT journaled, so not restored: paths outside this\n' +
              'directory, ignored paths (.gitignore, node_modules, .git, build, dist), binary and very large\n' +
              'files, and effects that are not file contents (network calls, pushes, installed packages).',
          ),
        );
      }

      // ── Decide whether to apply ───────────────────────────────────────────
      let proceed = Boolean(opts.yes);
      let cancelled = false;
      if (actionable.length > 0 && !proceed) {
        if (process.stdin.isTTY === true && !isJson) {
          const ans = (
            await readSingleLineInput(
              `Restore ${actionable.length} change${actionable.length === 1 ? '' : 's'}? (y/N): `,
            )
          )
            .trim()
            .toLowerCase();
          proceed = ans === 'y' || ans === 'yes';
          cancelled = !proceed;
        }
        // else: non-interactive (or --json) without --yes → preview only.
      }

      let restored = 0;
      let skipped = steps.length - actionable.length;
      let applied = false;
      if (actionable.length > 0 && proceed) {
        // cwd bounds the empty-parent pruning for deleted created files, so a
        // rewind takes back the directories the run's writes implicitly made.
        const r = applyRewind(steps, cwd);
        restored = r.restored;
        skipped = r.skipped;
        markSessionDone(cwd, session.id);
        applied = true;
      }

      // ── Output ────────────────────────────────────────────────────────────
      if (isJson) {
        json({
          cwd,
          session: session.id,
          startedAt: session.startedAt,
          applied,
          restored,
          skipped,
          steps: steps.map((s) => ({
            path: s.change.path,
            op: s.change.op,
            action: s.action,
            reason: s.reason ?? null,
          })),
        });
        return;
      }
      if (actionable.length === 0) {
        warn('Nothing to restore - every change was modified after the agent ran, or is already gone.');
      } else if (applied) {
        success(`Rewound ${restored} change${restored === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`);
      } else if (cancelled) {
        warn('Rewind cancelled - nothing changed.');
      } else {
        warn('Non-interactive - re-run with --yes to apply the rewind.');
      }
    });
}
