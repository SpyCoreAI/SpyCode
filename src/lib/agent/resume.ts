/**
 * Agent-session RESUME (`spycore agent --resume [session|latest]`).
 *
 * An interrupted run's state is journaled incrementally by the RunRecorder
 * (checkpoint.ts) at every completed step boundary. This module resolves which
 * session to resume, guards against workspace drift since the interrupt, and
 * builds the (identity-clean) resume banner + the continuation message that
 * re-enters the loop through the EXISTING conversationId/continueMessage
 * contract — the transcript itself lives server-side in the conversation, so
 * nothing is replayed client-side.
 *
 * Restore policy: budgets are CUMULATIVE (consumption carries over — a resume
 * never resets spend); safety config (web tools, approvals, MCP trust) is
 * re-resolved from the CURRENT invocation, never inherited; only the tool
 * protocol is pinned by the session, because the conversation's system prompt
 * taught exactly one wire protocol on turn 1.
 */
import { execFileSync } from 'node:child_process';
import type { AgentRunState } from './loop.js';
import type { Budget } from './budget.js';
import {
  currentFileSha,
  getResumeState,
  listSessions,
  loadSession,
  type CheckpointSession,
  type ResumeBudgetState,
  type ResumeState,
  type RunRecorder,
} from './checkpoint.js';
import { sanitizeForDisplay } from '../sanitize-display.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';

export interface ResumeTarget {
  session: CheckpointSession;
  state: ResumeState;
}

/** `git rev-parse HEAD` for the drift fingerprint; null outside a repo / on error. */
export function currentGitHead(cwd: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
      .toString()
      .trim();
    return /^[0-9a-f]{40}$/i.test(out) ? out : null;
  } catch {
    return null;
  }
}

const LIST_HINT = 'List sessions with `spycore rewind --list`.';

/** True when a session can be continued: interrupted, SpyCore-backed, and bound to a conversation. */
export function isResumable(session: CheckpointSession): boolean {
  const state = getResumeState(session);
  return (
    state !== null &&
    state.status !== 'completed' &&
    state.providerKind === 'spycore' &&
    state.conversationId !== null
  );
}

/**
 * Resolve `--resume [ref]` to a session. `true` (bare flag) and 'latest' pick
 * the newest resumable session; anything else is a session id. Every failure
 * is a clean, actionable error — old-format files never crash.
 */
export function resolveResumeTarget(cwd: string, ref: string | true): ResumeTarget {
  const wantLatest = ref === true || ref === 'latest';
  if (wantLatest) {
    const found = listSessions(cwd).find((s) => isResumable(s));
    if (!found) {
      throw new SpycoreCliError(
        'No resumable agent session in this directory.',
        EXIT_USER_ERROR,
        `Interrupted runs recorded by this CLI version appear in \`spycore rewind --list\` marked "resumable".`,
      );
    }
    return { session: found, state: getResumeState(found)! };
  }

  const session = loadSession(cwd, ref);
  if (!session) {
    throw new SpycoreCliError(`No session "${ref}" for this directory.`, EXIT_USER_ERROR, LIST_HINT);
  }
  const state = getResumeState(session);
  if (!state) {
    throw new SpycoreCliError(
      `Session ${session.id} is not resumable — it was recorded before resume support.`,
      EXIT_USER_ERROR,
      'You can still undo its journaled workspace changes with `spycore rewind --session ' + session.id + '`.',
    );
  }
  if (state.status === 'completed') {
    throw new SpycoreCliError(
      `Session ${session.id} already completed — there is nothing to resume.`,
      EXIT_USER_ERROR,
      'Undo its journaled workspace changes with `spycore rewind`, or start a new run.',
    );
  }
  if (state.providerKind !== 'spycore') {
    throw new SpycoreCliError(
      `Session ${session.id} is not resumable — runs on a custom provider keep their conversation in-process only.`,
      EXIT_USER_ERROR,
      'Re-run the task instead.',
    );
  }
  if (state.conversationId === null) {
    throw new SpycoreCliError(
      `Session ${session.id} was interrupted before execution began — there is no progress to resume.`,
      EXIT_USER_ERROR,
      'Re-run the task.',
    );
  }
  return { session, state };
}

/** Workspace changes since the last recorded step boundary. */
export interface WorkspaceDrift {
  /** git HEAD moved since the interrupt (both fingerprints known). */
  headMoved: boolean;
  fromHead: string | null;
  toHead: string | null;
  /** Journaled files whose on-disk content no longer matches the agent's last write. */
  modifiedFiles: string[];
}

/**
 * Detect drift: git HEAD movement plus a sha re-check of every journaled file
 * (last write per path wins). Returns null when the workspace is unchanged.
 */
export function detectWorkspaceDrift(target: ResumeTarget): WorkspaceDrift | null {
  const { session, state } = target;
  const lastByPath = new Map<string, string>();
  for (const c of session.changes) lastByPath.set(c.path, c.afterSha);
  const modifiedFiles: string[] = [];
  for (const [path, afterSha] of lastByPath) {
    if (currentFileSha(path) !== afterSha) modifiedFiles.push(path);
  }
  const toHead = currentGitHead(session.cwd);
  const headMoved = state.gitHead !== null && toHead !== null && toHead !== state.gitHead;
  if (!headMoved && modifiedFiles.length === 0) return null;
  return { headMoved, fromHead: state.gitHead, toHead, modifiedFiles };
}

function ago(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return 'unknown time';
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export interface ResumeBannerInput {
  target: ResumeTarget;
  drift: WorkspaceDrift | null;
  /** Display label of the model this resumed run uses (identity-safe). */
  modelLabel: string;
  /** Where the model came from: the session record or an explicit --model. */
  modelFromFlag: boolean;
  /** Current (re-resolved) web-tools setting. */
  webTools: boolean;
  observeWorkspace: boolean;
  /** Budget as restored (consumption + effective caps). */
  budget: ResumeBudgetState;
}

/**
 * The resume banner: what is being restored, how config was re-resolved, and
 * the drift status. Plain lines — the caller styles them; every session-file
 * string is sanitized at this boundary.
 */
export function buildResumeBanner(input: ResumeBannerInput): string[] {
  const { target, drift, budget } = input;
  const { session, state } = target;
  const files = session.changes.length;
  const lines: string[] = [
    `Resuming agent session ${session.id} (started ${ago(session.startedAt)})`,
    `Task: ${sanitizeForDisplay(truncate(session.task, 120))}`,
    `Progress: ${state.turnsCompleted} completed turn${state.turnsCompleted === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'} changed${state.approvedPlan ? ' · approved plan restored' : ''}`,
  ];
  const caps: string[] = [];
  if (budget.caps.maxTokens) caps.push(`${budget.tokensUsed}/${budget.caps.maxTokens} tokens`);
  else if (budget.tokensUsed > 0) caps.push(`${budget.tokensUsed} tokens used`);
  if (budget.caps.maxTimeMs) caps.push(`${Math.round(budget.elapsedMs / 1000)}s/${Math.round(budget.caps.maxTimeMs / 1000)}s`);
  if (budget.caps.maxTurns) caps.push(`${budget.turnsUsed}/${budget.caps.maxTurns} turns`);
  if (caps.length > 0) lines.push(`Budget (cumulative — consumption carried over): ${caps.join(' · ')}`);
  lines.push(
    `Config: model ${input.modelLabel} (${input.modelFromFlag ? '--model override' : 'from session'}) · web tools ${input.webTools ? 'on' : 'off'} (current setting) · workspace observation ${input.observeWorkspace ? 'on' : 'off'} (current setting) · ${state.nativeTools ? 'native' : 'fenced'} tool protocol (pinned by session) · approvals prompt fresh`,
  );
  if (drift) {
    const what: string[] = [];
    if (drift.headMoved) what.push('git HEAD moved since the interrupt');
    if (drift.modifiedFiles.length > 0) {
      what.push(
        `${drift.modifiedFiles.length} journaled file${drift.modifiedFiles.length === 1 ? '' : 's'} modified outside the run`,
      );
    }
    lines.push(`Workspace drift detected: ${what.join(' · ')}. Consider \`spycore rewind\` first.`);
  }
  return lines;
}

/**
 * The message that re-enters the loop on the existing conversation. The server
 * defensively completes any half-open tool round, so a plain user message is
 * wire-safe in every interrupt scenario — nothing is ever replayed.
 */
export function buildResumeContinueMessage(input: {
  state: ResumeState;
  driftAccepted: boolean;
  /** loop.ts CONTINUE_HINT for fenced-protocol conversations; '' for native. */
  protocolHint: string;
}): string {
  const { state } = input;
  const parts = [
    `This TASK was interrupted after ${state.turnsCompleted} completed tool-calling turn${state.turnsCompleted === 1 ? '' : 's'} and is now RESUMING.`,
    'Everything above is your prior progress on it; file changes you already applied are still in the workspace.',
    'Do NOT redo completed work — if you were mid-way through a step, re-check the current state of the files involved before continuing, then carry the task through to completion.',
  ];
  if (state.approvedPlan) parts.push('The previously approved plan still applies.');
  if (input.driftAccepted) {
    parts.push(
      'NOTE: the workspace was modified outside this session since the interruption — verify current file contents instead of relying on earlier reads.',
    );
  }
  if (input.protocolHint.length > 0) parts.push(input.protocolHint);
  return parts.join(' ');
}

/**
 * Per-phase `onRunState` hook: mirrors each completed step boundary into the
 * recorder (conversation binding, cumulative turn count, budget consumption,
 * loaded skills, git fingerprint). Build a fresh hook per runAgent call — it
 * captures the turn base so verify fix-ups keep accumulating.
 */
export function makeRunStateHook(input: {
  recorder: RunRecorder;
  budget: Budget;
  cwd: string;
  loadedSkills: ReadonlySet<string>;
}): (s: AgentRunState) => void {
  const base = input.recorder.state().turnsCompleted;
  return (s) => {
    const snap = input.budget.snapshot();
    input.recorder.update({
      conversationId: s.conversationId,
      nativeTools: s.nativeTools,
      turnsCompleted: base + s.turnsCompleted,
      budget: { ...snap, caps: input.budget.caps },
      loadedSkills: [...input.loadedSkills],
      gitHead: currentGitHead(input.cwd),
    });
  };
}
