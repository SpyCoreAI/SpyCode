/**
 * The TUI `/commit` flow - PHASE-1 1.6, wrapping the 1.5 commit machinery.
 *
 * This is the render-agnostic CORE (the registry philosophy): all git reads,
 * generation, review-loop and the confirm-gated write go through the EXACT
 * functions `spycore commit` uses (lib/git.ts + lib/git-generate.ts) - no
 * new git-write path exists here. The surface supplies IO (the Ink session
 * wires its interact primitive; tests wire fakes).
 *
 * Differences from the flat command, by design:
 *  - commit only - `--push` stays with `spycore commit` (one push surface);
 *  - errors NEVER throw out of the flow (an Ink session must survive) -
 *    they land as `notify('error', …)` and the flow returns uncommitted.
 */
import {
  commitWithMessageFile,
  hasStagedChanges,
  isDetachedHead,
  isGitRepo,
  mergeInProgress,
  recentSubjects,
  shortStatus,
  stageAll,
  stagedDiff,
  stagedStat,
} from '../git.js';
import {
  buildCommitPrompt,
  generateText,
  regenerateText,
  reviewLoop,
  type GenerateOpts,
} from '../git-generate.js';
import { isSpycoreCliError } from '../errors.js';
import type { ModelSlug } from '../models.js';
import { sanitizeForDisplay } from '../sanitize-display.js';

export interface CommitFlowIo {
  /** Session-idiom notice (the Ink session pushes a Notice item). */
  notify(kind: 'info' | 'success' | 'warning' | 'error', text: string): void;
  /** Show the current candidate message (already display-sanitized). */
  present(text: string): void;
  /** One-line answer to a question (accept/edit/regenerate/cancel, y/N). */
  ask(question: string): Promise<string>;
  /** A full replacement commit message. */
  readText(question: string): Promise<string>;
}

export interface CommitFlowOpts {
  cwd: string;
  /** The session's ACTIVE chat model - generation runs on it, charged normally. */
  model: ModelSlug;
  apiUrlOverride?: string | undefined;
  io: CommitFlowIo;
}

export interface CommitFlowResult {
  committed: boolean;
  hash?: string;
  subject?: string;
}

/** Cap on the status listing echoed in the stage-all offer. */
const STATUS_ECHO_CAP = 1_500;

export async function runCommitFlow(opts: CommitFlowOpts): Promise<CommitFlowResult> {
  const { cwd, io } = opts;
  const notCommitted: CommitFlowResult = { committed: false };

  // ── Guard rails - identical checks to `spycore commit`, no writes. ──
  if (!isGitRepo(cwd)) {
    io.notify('error', 'Not a git repository - /commit needs one.');
    return notCommitted;
  }
  if (isDetachedHead(cwd)) {
    io.notify('error', 'HEAD is detached - check out a branch first.');
    return notCommitted;
  }
  if (mergeInProgress(cwd)) {
    io.notify('error', 'A merge is in progress - finish or abort it first.');
    return notCommitted;
  }

  // ── Staging: staged-only by default; stage-all only on an explicit yes. ──
  if (!hasStagedChanges(cwd)) {
    const status = shortStatus(cwd);
    if (!status) {
      io.notify('warning', 'Nothing to commit - working tree clean.');
      return notCommitted;
    }
    io.notify(
      'info',
      `Nothing staged. Unstaged changes:\n${sanitizeForDisplay(status).slice(0, STATUS_ECHO_CAP)}`,
    );
    const answer = (await io.ask('Stage all changes? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      io.notify('warning', 'Cancelled - nothing staged, nothing committed.');
      return notCommitted;
    }
    const staged = stageAll(cwd);
    if (!staged.ok) {
      io.notify('error', `Staging failed: ${sanitizeForDisplay(staged.stderr.trim())}`);
      return notCommitted;
    }
    io.notify('info', 'Staged all changes.');
  }

  // ── Generate through the existing charged chat contract (1.5). ──
  const gen: GenerateOpts = { model: opts.model, apiUrlOverride: opts.apiUrlOverride };
  const prompt = buildCommitPrompt({
    stat: stagedStat(cwd),
    diff: stagedDiff(cwd),
    recentLog: recentSubjects(cwd, 5),
  });
  io.notify('info', 'Generating commit message…');
  let generated;
  try {
    generated = await generateText(prompt, gen);
  } catch (err) {
    const hint = isSpycoreCliError(err) && err.hint ? ` ${err.hint}` : '';
    io.notify('error', `${err instanceof Error ? err.message : String(err)}${hint}`);
    return notCommitted;
  }

  // ── Review gate - the SAME reviewLoop state machine as `spycore commit`. ──
  let review;
  try {
    review = await reviewLoop(generated.text, {
      present: (text) => io.present(sanitizeForDisplay(text)),
      ask: () => io.ask('[a]ccept / [e]dit / [r]egenerate / [c]ancel: '),
      readEdit: () => io.readText('New message (Enter to finish):'),
      regenerate: async () => {
        io.notify('info', 'Regenerating…');
        return regenerateText(generated.conversationId, gen);
      },
    });
  } catch (err) {
    const hint = isSpycoreCliError(err) && err.hint ? ` ${err.hint}` : '';
    io.notify('error', `${err instanceof Error ? err.message : String(err)}${hint}`);
    return notCommitted;
  }
  if (review.action !== 'accept') {
    io.notify('warning', 'Cancelled - nothing committed.');
    return notCommitted;
  }

  // ── Commit via message FILE - the 1.5 write path, confirm already given. ──
  const committed = commitWithMessageFile(cwd, review.text);
  if (!committed.ok) {
    io.notify('error', `git commit failed: ${sanitizeForDisplay(committed.stderr)}`);
    return notCommitted;
  }
  const subject = review.text.split('\n')[0] ?? '';
  io.notify('success', `Committed ${committed.hash} - ${sanitizeForDisplay(subject)}`);
  return { committed: true, hash: committed.hash, subject };
}
