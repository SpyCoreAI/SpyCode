/**
 * First-class git for SpyCode — PHASE-1 1.5.
 *
 *   spycore commit   AI Conventional-Commit message from the STAGED diff,
 *                    confirm-gated, committed via a message FILE (never -m).
 *   spycore pr       AI title/body from the branch-vs-base diff, created
 *                    through the user's own `gh` binary, confirm-gated.
 *   spycore branch   AI branch-name suggestion (kebab-case, type-prefixed),
 *                    confirm-gated create + switch.
 *
 * INVARIANTS (all tested):
 *  - No git write of any kind (add / commit / push / branch / pr) happens
 *    without an explicit interactive confirmation or the documented headless
 *    flags (`--yes`, `--all`). Cancel leaves the repository untouched.
 *  - Generation is a NORMAL charged one-shot through the existing chat
 *    contract (lib/git-generate.ts) — no new server surface.
 *  - A generated message can never carry an attribution trailer: the
 *    instruction forbids it and stripGenerationArtifacts removes any that
 *    slips through. Non-configurable.
 *  - Everything echoed to the terminal passes sanitizeForDisplay.
 */
import { Command, Option } from 'commander';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import chalk from 'chalk';
import type { Ora } from 'ora';
import { createSpinner } from '../lib/spinner.js';
import { isAuthenticated } from '../lib/auth.js';
import {
  EXIT_AUTH_ERROR,
  EXIT_USER_ERROR,
  SpycoreCliError,
} from '../lib/errors.js';
import {
  branchDiff,
  branchExists,
  branchLog,
  commitWithMessageFile,
  createAndSwitchBranch,
  currentBranch,
  defaultBaseBranch,
  hasRemote,
  hasStagedChanges,
  isDetachedHead,
  isGitRepo,
  mergeInProgress,
  pushCurrentBranch,
  recentSubjects,
  shortStatus,
  stageAll,
  stagedDiff,
  stagedStat,
  unpushedCount,
  upstreamRef,
  workingDiff,
} from '../lib/git.js';
import { ghAuthed, ghAvailable, ghPrCreate } from '../lib/gh.js';
import {
  buildBranchPrompt,
  buildCommitPrompt,
  buildPrPrompt,
  generateText,
  regenerateText,
  reviewLoop,
  sanitizeBranchName,
  splitTitleBody,
  type GenerateOpts,
} from '../lib/git-generate.js';
import { resolveModelSlug, type ModelSlug } from '../lib/models.js';
import { getOutputOptions, json as jsonOut } from '../lib/output.js';
import {
  isPromptCancelled,
  readMultilineInput,
  readSingleLineInput,
} from '../lib/prompt.js';
import { sanitizeForDisplay } from '../lib/sanitize-display.js';

/** Subject-length guidance from the Conventional Commits instruction. */
const SUBJECT_SOFT_MAX = 72;

interface ParentOpts {
  apiUrl?: string;
  json?: boolean;
}

function parentOpts(cmd: Command): ParentOpts {
  return cmd.parent?.opts<ParentOpts>() ?? {};
}

function isJsonMode(cmd: Command): boolean {
  return Boolean(parentOpts(cmd).json) || getOutputOptions().json;
}

/** Interactive = a real terminal on BOTH ends and not machine output. */
function isInteractive(jsonMode: boolean): boolean {
  return (
    !jsonMode &&
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true
  );
}

async function requireLogin(): Promise<void> {
  if (!(await isAuthenticated())) {
    throw new SpycoreCliError(
      'Not logged in.',
      EXIT_AUTH_ERROR,
      'Run `spycore login` to authenticate.',
    );
  }
}

/** Chat model for generation — image model rejected exactly like `spycore chat`. */
function resolveGenerationModel(input: string | undefined): ModelSlug {
  const model = resolveModelSlug(input);
  if (model === 'hephaestus') {
    throw new SpycoreCliError(
      'This command needs a chat model.',
      EXIT_USER_ERROR,
      'Pick one with --model (e.g. --model hermes).',
    );
  }
  return model;
}

/** Shared repo preconditions — clear errors BEFORE any write is reachable. */
function assertRepoReady(cwd: string): void {
  if (!isGitRepo(cwd)) {
    throw new SpycoreCliError(
      'Not a git repository.',
      EXIT_USER_ERROR,
      'Run this inside a repository (or `git init` first).',
    );
  }
  if (isDetachedHead(cwd)) {
    throw new SpycoreCliError(
      'HEAD is detached.',
      EXIT_USER_ERROR,
      'Check out a branch first (`git switch <branch>`).',
    );
  }
  if (mergeInProgress(cwd)) {
    throw new SpycoreCliError(
      'A merge is in progress.',
      EXIT_USER_ERROR,
      'Finish it (`git merge --continue`) or abort it (`git merge --abort`) first.',
    );
  }
}

function startSpinner(text: string, jsonMode: boolean): Ora | null {
  if (jsonMode || process.stdout.isTTY !== true) return null;
  return createSpinner({ text, stream: process.stderr }).start();
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

/**
 * Run the accept/edit/regenerate/cancel loop for interactive sessions, or
 * apply the headless rule: `--yes` accepts the generated text as-is, and a
 * non-interactive session WITHOUT `--yes` refuses — a write may never
 * happen without explicit consent.
 */
async function gateOnReview(opts: {
  what: string;
  initial: string;
  interactive: boolean;
  yes: boolean;
  conversationId: string;
  gen: GenerateOpts;
  jsonMode: boolean;
  present: (text: string) => void;
  askPrompt: string;
  readEdit: () => Promise<string>;
}): Promise<{ accepted: boolean; text: string }> {
  if (opts.yes) return { accepted: true, text: opts.initial };
  if (!opts.interactive) {
    throw new SpycoreCliError(
      `Refusing to ${opts.what} without confirmation in a non-interactive session.`,
      EXIT_USER_ERROR,
      'Re-run with --yes to accept the generated text.',
    );
  }
  try {
    const result = await reviewLoop(opts.initial, {
      present: opts.present,
      ask: () => readSingleLineInput(opts.askPrompt),
      readEdit: opts.readEdit,
      regenerate: async () => {
        const spinner = startSpinner('Regenerating…', opts.jsonMode);
        try {
          const text = await regenerateText(opts.conversationId, opts.gen);
          spinner?.stop();
          return text;
        } catch (err) {
          spinner?.fail();
          throw err;
        }
      },
    });
    return { accepted: result.action === 'accept', text: result.text };
  } catch (err) {
    if (isPromptCancelled(err)) return { accepted: false, text: opts.initial };
    throw err;
  }
}

function printCancelled(what: string): void {
  process.stderr.write(chalk.yellow(`✗ Cancelled — ${what}.\n`));
}

/** Bordered echo of a candidate message (display-sanitized). */
function presentBlock(label: string, text: string): void {
  const safe = sanitizeForDisplay(text);
  process.stderr.write(`\n${chalk.bold(label)}\n${chalk.dim('─'.repeat(40))}\n`);
  process.stderr.write(`${safe}\n${chalk.dim('─'.repeat(40))}\n`);
  const subject = safe.split('\n')[0] ?? '';
  if (subject.length > SUBJECT_SOFT_MAX) {
    process.stderr.write(
      chalk.yellow(`! Subject is ${subject.length} chars (guideline: ≤ ${SUBJECT_SOFT_MAX}).\n`),
    );
  }
}

// ────────────────────────── spycore commit ──────────────────────────────

interface CommitOpts {
  model?: string;
  all?: boolean;
  push?: boolean;
  yes?: boolean;
}

export function registerCommitCommand(program: Command): void {
  program
    .command('commit')
    .description(
      'Generate a Conventional Commit message from the staged diff, review it, and commit',
    )
    // Deliberately NO -m shorthand: git muscle-memory reads -m as "message".
    .addOption(new Option('--model <model>', 'Chat model for message generation'))
    .addOption(
      new Option('--all', 'Stage all changes first (required to stage in non-interactive runs)'),
    )
    .addOption(
      new Option('--push', 'Push after committing (asks first; --yes skips the ask)'),
    )
    .addOption(
      new Option('--yes', 'Accept the generated message and confirmations without prompting'),
    )
    .action(async (opts: CommitOpts, cmd: Command) => {
      const parent = parentOpts(cmd);
      const jsonMode = isJsonMode(cmd);
      const interactive = isInteractive(jsonMode);
      const cwd = process.cwd();

      await requireLogin();
      const model = resolveGenerationModel(opts.model);
      assertRepoReady(cwd);

      // ── Staging: default staged-only; stage-all only on explicit ask ──
      if (!hasStagedChanges(cwd)) {
        const status = shortStatus(cwd);
        if (!status) {
          throw new SpycoreCliError(
            'Nothing to commit — working tree clean.',
            EXIT_USER_ERROR,
          );
        }
        if (opts.all) {
          const staged = stageAll(cwd);
          if (!staged.ok) {
            throw new SpycoreCliError(
              'Staging failed.',
              EXIT_USER_ERROR,
              sanitizeForDisplay(staged.stderr.trim()),
            );
          }
          if (!jsonMode) process.stderr.write(chalk.dim('✓ Staged all changes (--all)\n'));
        } else if (interactive) {
          process.stderr.write(`${chalk.bold('Nothing staged. Unstaged changes:')}\n`);
          process.stderr.write(`${sanitizeForDisplay(status)}\n`);
          if (!(await confirm('Stage all changes?'))) {
            printCancelled('nothing staged, nothing committed');
            return;
          }
          const staged = stageAll(cwd);
          if (!staged.ok) {
            throw new SpycoreCliError(
              'Staging failed.',
              EXIT_USER_ERROR,
              sanitizeForDisplay(staged.stderr.trim()),
            );
          }
          process.stderr.write(chalk.dim('✓ Staged all changes\n'));
        } else {
          throw new SpycoreCliError(
            'Nothing staged.',
            EXIT_USER_ERROR,
            'Stage changes first (`git add -p`) or pass --all to stage everything.',
          );
        }
      }

      // ── Generate ──
      const gen: GenerateOpts = { model, apiUrlOverride: parent.apiUrl };
      const prompt = buildCommitPrompt({
        stat: stagedStat(cwd),
        diff: stagedDiff(cwd),
        recentLog: recentSubjects(cwd, 5),
      });
      const spinner = startSpinner('Generating commit message…', jsonMode);
      let generated;
      try {
        generated = await generateText(prompt, gen);
        spinner?.stop();
      } catch (err) {
        spinner?.fail();
        throw err;
      }

      // ── Review gate (no write without accept) ──
      const review = await gateOnReview({
        what: 'commit',
        initial: generated.text,
        interactive,
        yes: Boolean(opts.yes),
        conversationId: generated.conversationId,
        gen,
        jsonMode,
        present: (text) => presentBlock('Commit message', text),
        askPrompt: '[a]ccept / [e]dit / [r]egenerate / [c]ancel: ',
        readEdit: () =>
          readMultilineInput({ prompt: 'New message (finish with a blank line):\n' }),
      });
      if (!review.accepted) {
        printCancelled('nothing committed');
        return;
      }

      // ── Commit via message FILE ──
      const committed = commitWithMessageFile(cwd, review.text);
      if (!committed.ok) {
        throw new SpycoreCliError(
          'git commit failed.',
          EXIT_USER_ERROR,
          sanitizeForDisplay(committed.stderr),
        );
      }
      const subject = review.text.split('\n')[0] ?? '';
      if (jsonMode) {
        jsonOut({ committed: true, hash: committed.hash, subject });
      } else {
        process.stderr.write(
          chalk.green(`✓ Committed ${committed.hash} — ${sanitizeForDisplay(subject)}\n`),
        );
      }

      // ── Optional push: flag AND confirm ──
      if (opts.push) {
        if (!opts.yes) {
          if (!interactive) {
            throw new SpycoreCliError(
              'Refusing to push without confirmation in a non-interactive session.',
              EXIT_USER_ERROR,
              'Re-run with --push --yes to push non-interactively. The commit itself succeeded.',
            );
          }
          if (!(await confirm('Push to origin?'))) {
            if (!jsonMode) process.stderr.write(chalk.dim('Skipped push.\n'));
            return;
          }
        }
        const pushed = pushCurrentBranch(cwd);
        if (!pushed.ok) {
          throw new SpycoreCliError(
            'git push failed.',
            EXIT_USER_ERROR,
            sanitizeForDisplay(pushed.stderr.trim()),
          );
        }
        if (jsonMode) jsonOut({ pushed: true });
        else process.stderr.write(chalk.green('✓ Pushed\n'));
      }
    });
}

// ──────────────────────────── spycore pr ────────────────────────────────

interface PrOpts {
  model?: string;
  base?: string;
  draft?: boolean;
  yes?: boolean;
}

export function registerPrCommand(program: Command): void {
  program
    .command('pr')
    .description(
      'Generate a PR title and description from the branch diff and open it with the GitHub CLI',
    )
    .addOption(new Option('--model <model>', 'Chat model for title/body generation'))
    .addOption(new Option('--base <branch>', 'Base branch (default: the remote default branch)'))
    .addOption(new Option('--draft', 'Create the pull request as a draft'))
    .addOption(
      new Option('--yes', 'Accept the generated text and confirmations without prompting'),
    )
    .action(async (opts: PrOpts, cmd: Command) => {
      const parent = parentOpts(cmd);
      const jsonMode = isJsonMode(cmd);
      const interactive = isInteractive(jsonMode);
      const cwd = process.cwd();

      await requireLogin();
      const model = resolveGenerationModel(opts.model);
      assertRepoReady(cwd);

      // ── gh + remote preconditions ──
      if (!hasRemote(cwd)) {
        throw new SpycoreCliError(
          'No git remote configured.',
          EXIT_USER_ERROR,
          'Add one first: `git remote add origin <url>`.',
        );
      }
      if (!ghAvailable()) {
        throw new SpycoreCliError(
          'GitHub CLI (gh) not found.',
          EXIT_USER_ERROR,
          'Install it from https://cli.github.com and run `gh auth login`.',
        );
      }
      if (!ghAuthed()) {
        throw new SpycoreCliError(
          'GitHub CLI is not authenticated.',
          EXIT_USER_ERROR,
          'Run `gh auth login`.',
        );
      }

      const branch = currentBranch(cwd);
      if (!branch) {
        throw new SpycoreCliError('HEAD is detached.', EXIT_USER_ERROR);
      }
      const base = opts.base?.trim() || defaultBaseBranch(cwd);
      if (!base) {
        throw new SpycoreCliError(
          'Could not determine the base branch.',
          EXIT_USER_ERROR,
          'Pass it explicitly: `spycore pr --base main`.',
        );
      }
      if (branch === base) {
        throw new SpycoreCliError(
          `You are on the base branch (${sanitizeForDisplay(base)}).`,
          EXIT_USER_ERROR,
          'Create a feature branch first: `spycore branch`.',
        );
      }

      // Resolve a diffable base ref: the local branch, else its origin/ copy.
      let baseRef = base;
      if (!branchLog(cwd, baseRef).ok) {
        baseRef = `origin/${base}`;
        if (!branchLog(cwd, baseRef).ok) {
          throw new SpycoreCliError(
            `Cannot diff against '${sanitizeForDisplay(base)}'.`,
            EXIT_USER_ERROR,
            `Fetch it first: \`git fetch origin ${sanitizeForDisplay(base)}\`.`,
          );
        }
      }
      const log = branchLog(cwd, baseRef).stdout.trimEnd();
      if (!log.trim()) {
        throw new SpycoreCliError(
          `No commits on '${sanitizeForDisplay(branch)}' vs '${sanitizeForDisplay(base)}' — nothing to open a PR for.`,
          EXIT_USER_ERROR,
        );
      }

      // ── Branch must be pushed (push only with consent) ──
      if (!upstreamRef(cwd) || unpushedCount(cwd) > 0) {
        if (!opts.yes) {
          if (!interactive) {
            throw new SpycoreCliError(
              `Branch '${sanitizeForDisplay(branch)}' is not fully pushed.`,
              EXIT_USER_ERROR,
              'Push it first (`git push -u origin <branch>`) or re-run with --yes.',
            );
          }
          if (!(await confirm(`Push branch '${sanitizeForDisplay(branch)}' to origin?`))) {
            printCancelled('branch not pushed, no PR created');
            return;
          }
        }
        const pushed = pushCurrentBranch(cwd);
        if (!pushed.ok) {
          throw new SpycoreCliError(
            'git push failed.',
            EXIT_USER_ERROR,
            sanitizeForDisplay(pushed.stderr.trim()),
          );
        }
        if (!jsonMode) process.stderr.write(chalk.dim('✓ Pushed\n'));
      }

      // ── Generate title + body ──
      const gen: GenerateOpts = { model, apiUrlOverride: parent.apiUrl };
      const prompt = buildPrPrompt({
        base,
        branch,
        log,
        diff: branchDiff(cwd, baseRef).stdout,
      });
      const spinner = startSpinner('Generating PR title and description…', jsonMode);
      let generated;
      try {
        generated = await generateText(prompt, gen);
        spinner?.stop();
      } catch (err) {
        spinner?.fail();
        throw err;
      }

      // ── Review gate — accepting IS the create-confirmation ──
      const review = await gateOnReview({
        what: 'create a pull request',
        initial: generated.text,
        interactive,
        yes: Boolean(opts.yes),
        conversationId: generated.conversationId,
        gen,
        jsonMode,
        present: (text) => presentBlock('Pull request (first line = title)', text),
        askPrompt: 'Create this PR? [a]ccept / [e]dit / [r]egenerate / [c]ancel: ',
        readEdit: () =>
          readMultilineInput({
            prompt: 'New text — first line is the title (finish with a blank line):\n',
          }),
      });
      if (!review.accepted) {
        printCancelled('no PR created');
        return;
      }

      const { title, body } = splitTitleBody(review.text);
      if (!title) {
        throw new SpycoreCliError(
          'The PR title is empty.',
          EXIT_USER_ERROR,
          'Edit the text so the first line is the title.',
        );
      }

      // ── Create via gh, body via FILE ──
      const dir = mkdtempSync(join(tmpdir(), 'spycore-pr-'));
      const bodyFile = join(dir, 'PR_BODY.md');
      let url: string;
      try {
        writeFileSync(bodyFile, body.length > 0 ? `${body}\n` : '', 'utf8');
        url = ghPrCreate({ cwd, title, bodyFile, base, draft: Boolean(opts.draft) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new SpycoreCliError(
          'gh pr create failed.',
          EXIT_USER_ERROR,
          sanitizeForDisplay(message),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      if (jsonMode) jsonOut({ created: true, url });
      else process.stderr.write(chalk.green(`✓ PR created: ${sanitizeForDisplay(url)}\n`));
    });
}

// ─────────────────────────── spycore branch ─────────────────────────────

interface BranchOpts {
  model?: string;
  for?: string;
  yes?: boolean;
}

export function registerBranchCommand(program: Command): void {
  program
    .command('branch')
    .description(
      'Suggest a branch name from your changes (or --for "<task>"), then create and switch to it',
    )
    .addOption(new Option('--model <model>', 'Chat model for the suggestion'))
    .addOption(new Option('--for <task>', 'Describe the upcoming work instead of using the diff'))
    .addOption(
      new Option('--yes', 'Accept the suggested name and create the branch without prompting'),
    )
    .action(async (opts: BranchOpts, cmd: Command) => {
      const parent = parentOpts(cmd);
      const jsonMode = isJsonMode(cmd);
      const interactive = isInteractive(jsonMode);
      const cwd = process.cwd();

      await requireLogin();
      const model = resolveGenerationModel(opts.model);
      assertRepoReady(cwd);

      const hint = opts.for?.trim() ?? '';
      const diff = workingDiff(cwd);
      if (!hint && !diff.trim()) {
        throw new SpycoreCliError(
          'No changes to name a branch from.',
          EXIT_USER_ERROR,
          'Describe the work instead: `spycore branch --for "add rate limiting"`.',
        );
      }

      const gen: GenerateOpts = { model, apiUrlOverride: parent.apiUrl };
      const spinner = startSpinner('Suggesting a branch name…', jsonMode);
      let generated;
      try {
        generated = await generateText(buildBranchPrompt({ hint, diff }), gen);
        spinner?.stop();
      } catch (err) {
        spinner?.fail();
        throw err;
      }
      const initial = sanitizeBranchName(generated.text);
      if (!initial) {
        throw new SpycoreCliError(
          'Generation returned nothing usable.',
          EXIT_USER_ERROR,
          'Try again, or create the branch yourself.',
        );
      }

      const review = await gateOnReview({
        what: 'create a branch',
        initial,
        interactive,
        yes: Boolean(opts.yes),
        conversationId: generated.conversationId,
        gen,
        jsonMode,
        present: (text) =>
          process.stderr.write(`\nBranch name: ${chalk.bold(sanitizeForDisplay(text))}\n`),
        askPrompt: 'Create this branch? [a]ccept / [e]dit / [r]egenerate / [c]ancel: ',
        readEdit: async () => sanitizeBranchName(await readSingleLineInput('New name: ')),
      });
      if (!review.accepted) {
        printCancelled('no branch created');
        return;
      }

      const name = sanitizeBranchName(review.text);
      if (!name) {
        throw new SpycoreCliError('Branch name is empty after sanitizing.', EXIT_USER_ERROR);
      }
      if (branchExists(cwd, name)) {
        throw new SpycoreCliError(
          `A branch named '${sanitizeForDisplay(name)}' already exists.`,
          EXIT_USER_ERROR,
          'Re-run and edit the suggestion, or switch to it: `git switch <name>`.',
        );
      }
      // git validates the final ref name; surface its error verbatim if any.
      const created = createAndSwitchBranch(cwd, name);
      if (!created.ok) {
        throw new SpycoreCliError(
          'git switch -c failed.',
          EXIT_USER_ERROR,
          sanitizeForDisplay(created.stderr.trim()),
        );
      }
      if (jsonMode) jsonOut({ created: true, branch: name });
      else {
        process.stderr.write(
          chalk.green(`✓ Switched to new branch '${sanitizeForDisplay(name)}'\n`),
        );
      }
    });
}
