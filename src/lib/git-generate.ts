/**
 * AI text generation for the git commands (`spycore commit` / `pr` /
 * `branch`) - PHASE-1 1.5.
 *
 * Generation rides the EXISTING charged chat contract and nothing else:
 * a fresh conversation via POST /conversations, then the one-shot
 * `/api/chat/stream` call (the exact channel `spycore chat` and the 1.3
 * image-edit flow use), consumed silently. No new server surface, no
 * charging change; plan/quota/waitlist errors surface through the same
 * mappings as chat.
 *
 * Prompt budget mirrors the 1.2 attachment contract: the diff block is
 * capped at 24,000 chars with an EXPLICIT truncation marker, and the
 * assembled message is guaranteed to fit the server's 32,000-char cap -
 * the scaffold is measured first and the diff gets what remains.
 *
 * Generated output passes a post-check net that strips any attribution
 * trailer (Co-Authored-By / Generated-with / robot-emoji lines) even if a
 * model emits one against instructions. This is non-configurable.
 */
import { api, streamRequest, type StreamEvent } from './api.js';
import { WIRE_MESSAGE_MAX_CHARS } from './attachments.js';
import { EXIT_USER_ERROR, SpycoreCliError } from './errors.js';
import type { ModelSlug } from './models.js';

/** Per-block diff budget - mirrors TEXT_ATTACH_MAX_CHARS from the 1.2 contract. */
export const GIT_DIFF_MAX_CHARS = 24_000;

/** File-list / log blocks are context, not the payload - keep them small. */
const STAT_MAX_CHARS = 4_000;
const LOG_MAX_CHARS = 1_000;

/** Marker appended when a block is cut - the model must know it saw a prefix. */
export const TRUNCATION_MARKER = '[... truncated: diff exceeds the prompt budget ...]';

/** Cut `text` to `max` chars with the explicit marker (no silent trims). */
export function truncateWithMarker(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(0, max - TRUNCATION_MARKER.length - 2);
  return `${text.slice(0, keep)}\n${TRUNCATION_MARKER}`;
}

/**
 * The pinned output rules shared by commit + PR generation. The "no trailer"
 * instruction is load-bearing (tested); the post-check net below is the
 * safety layer for a model that ignores it.
 */
const NO_TRAILER_RULES =
  'Output ONLY the requested text - no surrounding prose, no code fences, no explanations. ' +
  'Never add a trailer of any kind: no Co-Authored-By line, no "Generated with" line, ' +
  'no attribution, no signature, no emoji footer.';

export interface CommitPromptInput {
  stat: string;
  diff: string;
  recentLog: string;
}

/** Assemble the commit-message prompt; guaranteed ≤ WIRE_MESSAGE_MAX_CHARS. */
export function buildCommitPrompt(input: CommitPromptInput): string {
  const head =
    'Write a git commit message for the staged changes below.\n' +
    'Rules:\n' +
    '- Conventional Commits format: type(scope): subject\n' +
    '- Subject line at most 72 characters, imperative mood\n' +
    '- Optionally a blank line and a concise body explaining WHY\n' +
    `- ${NO_TRAILER_RULES}\n`;
  const log = input.recentLog.trim()
    ? `\nRecent commit subjects (match their style):\n${truncateWithMarker(input.recentLog, LOG_MAX_CHARS)}\n`
    : '';
  const stat = input.stat.trim()
    ? `\nChanged files:\n${truncateWithMarker(input.stat, STAT_MAX_CHARS)}\n`
    : '';
  const scaffold = `${head}${log}${stat}\nStaged diff:\n`;
  const diffBudget = Math.min(
    GIT_DIFF_MAX_CHARS,
    Math.max(0, WIRE_MESSAGE_MAX_CHARS - scaffold.length - 64),
  );
  return `${scaffold}${truncateWithMarker(input.diff, diffBudget)}`;
}

export interface PrPromptInput {
  base: string;
  branch: string;
  log: string;
  diff: string;
}

/** Assemble the PR title+body prompt; guaranteed ≤ WIRE_MESSAGE_MAX_CHARS. */
export function buildPrPrompt(input: PrPromptInput): string {
  const head =
    `Write a pull request title and description for branch "${input.branch}" targeting "${input.base}".\n` +
    'Rules:\n' +
    '- First line: the PR title only (at most 72 characters)\n' +
    '- Then a blank line, then a concise markdown description: what changed and why\n' +
    `- ${NO_TRAILER_RULES}\n`;
  const log = input.log.trim()
    ? `\nCommits on this branch:\n${truncateWithMarker(input.log, LOG_MAX_CHARS)}\n`
    : '';
  const scaffold = `${head}${log}\nBranch diff vs ${input.base}:\n`;
  const diffBudget = Math.min(
    GIT_DIFF_MAX_CHARS,
    Math.max(0, WIRE_MESSAGE_MAX_CHARS - scaffold.length - 64),
  );
  return `${scaffold}${truncateWithMarker(input.diff, diffBudget)}`;
}

export interface BranchPromptInput {
  hint: string;
  diff: string;
}

/** Assemble the branch-name prompt; guaranteed ≤ WIRE_MESSAGE_MAX_CHARS. */
export function buildBranchPrompt(input: BranchPromptInput): string {
  const head =
    'Suggest ONE git branch name for the work described below.\n' +
    'Rules:\n' +
    '- kebab-case, prefixed with a change type: feat/, fix/, chore/, docs/, refactor/, perf/ or test/\n' +
    '- at most 60 characters, lowercase letters, digits and hyphens only after the prefix\n' +
    `- ${NO_TRAILER_RULES}\n`;
  const hint = input.hint.trim() ? `\nTask: ${input.hint.trim()}\n` : '';
  const scaffold = `${head}${hint}\nWorking-tree diff:\n`;
  const diffBudget = Math.min(
    GIT_DIFF_MAX_CHARS,
    Math.max(0, WIRE_MESSAGE_MAX_CHARS - scaffold.length - 64),
  );
  const diff = input.diff.trim()
    ? truncateWithMarker(input.diff, diffBudget)
    : '(no diff - name from the task alone)';
  return `${scaffold}${diff}`;
}

/**
 * Attribution-trailer patterns the net removes from GENERATED output. The
 * generation instruction already forbids these; this is the belt-and-braces
 * layer and it is not configurable.
 */
const TRAILER_LINE_RE =
  /^\s*(co-authored-by\s*:|generated\s+with\b|generated\s+by\b|🤖)/i;

/**
 * Normalize a generated message: unwrap a single surrounding code fence,
 * drop attribution-trailer lines, strip C0 control chars (except \n \t),
 * collapse trailing blank lines.
 */
export function stripGenerationArtifacts(text: string): string {
  let out = text.replace(/\r\n/g, '\n').trim();
  // Unwrap one full-message fence (```...``` possibly with a language tag).
  const fence = out.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fence && typeof fence[1] === 'string') out = fence[1];
  const lines = out
    .split('\n')
    .filter((line) => !TRAILER_LINE_RE.test(line))
    // eslint-disable-next-line no-control-regex
    .map((line) => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''));
  return lines.join('\n').replace(/\n{3,}$/g, '\n').trim();
}

/** First line = title, rest (past the first blank line) = body. */
export function splitTitleBody(text: string): { title: string; body: string } {
  const lines = text.split('\n');
  const title = (lines[0] ?? '').trim();
  const body = lines.slice(1).join('\n').trim();
  return { title, body };
}

/**
 * Enforce the branch-name shape locally: lowercase, kebab, ≤60 chars,
 * slashes only as the type separator. Model output is never trusted to be
 * ref-safe on its own.
 */
export function sanitizeBranchName(raw: string): string {
  const first = raw.split('\n').find((l) => l.trim().length > 0) ?? '';
  let name = first.trim().toLowerCase();
  name = name.replace(/`/g, '');
  name = name.replace(/[^a-z0-9/-]+/g, '-');
  name = name.replace(/\/{2,}/g, '/').replace(/-{2,}/g, '-');
  name = name.replace(/^[-/]+|[-/]+$/g, '');
  // Keep at most one slash (the type prefix separator).
  const parts = name.split('/');
  if (parts.length > 2) name = `${parts[0]}/${parts.slice(1).join('-')}`;
  if (name.length > 60) name = name.slice(0, 60).replace(/[-/]+$/g, '');
  return name;
}

export interface GenerateOpts {
  model: ModelSlug;
  apiUrlOverride?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface GenerateResult {
  text: string;
  conversationId: string;
}

/**
 * Consume one `/api/chat/stream` turn silently, collecting assistant text.
 * Stream `error` events map exactly like the chat command's (plan/quota
 * hints); pre-stream HTTP failures already arrive as SpycoreCliError via
 * the shared mapHttpFailure.
 */
async function collectTurn(
  conversationId: string,
  message: string,
  opts: GenerateOpts,
): Promise<string> {
  let text = '';
  for await (const event of streamRequest(
    '/api/chat/stream',
    {
      conversationId,
      message,
      model: opts.model.toUpperCase(),
    },
    { apiUrlOverride: opts.apiUrlOverride, signal: opts.signal },
  )) {
    const data = (event as StreamEvent).data as
      | (Record<string, unknown> & { type?: string })
      | undefined;
    if (!data || typeof data !== 'object') continue;
    if (data.type === 'text') {
      text += String(data.content ?? '');
    } else if (data.type === 'error') {
      const message_ = String(data.message ?? 'Generation failed');
      const lower = message_.toLowerCase();
      if (lower.includes('plan') || lower.includes('upgrade')) {
        throw new SpycoreCliError(
          `Generation failed: ${message_}`,
          EXIT_USER_ERROR,
          'Upgrade at https://spycore.ai/pricing.',
        );
      }
      if (lower.includes('quota') || lower.includes('limit')) {
        throw new SpycoreCliError(
          `Generation failed: ${message_}`,
          EXIT_USER_ERROR,
          'See your usage at https://spycore.ai/usage.',
        );
      }
      throw new SpycoreCliError(`Generation failed: ${message_}`);
    }
  }
  return text;
}

/** Fresh conversation + first generation turn. */
export async function generateText(
  prompt: string,
  opts: GenerateOpts,
): Promise<GenerateResult> {
  const created = await api.post<{ id: string }>('/conversations', {
    apiUrlOverride: opts.apiUrlOverride,
    body: { model: opts.model.toUpperCase() },
  });
  const raw = await collectTurn(created.id, prompt, opts);
  const text = stripGenerationArtifacts(raw);
  if (!text) {
    throw new SpycoreCliError(
      'Generation returned nothing usable.',
      EXIT_USER_ERROR,
      'Try again, or write the text yourself.',
    );
  }
  return { text, conversationId: created.id };
}

/** Regenerate on the SAME conversation - no diff re-send, still charged normally. */
export async function regenerateText(
  conversationId: string,
  opts: GenerateOpts,
): Promise<string> {
  const raw = await collectTurn(
    conversationId,
    `Produce a DIFFERENT version for the same changes. Same rules. ${NO_TRAILER_RULES}`,
    opts,
  );
  const text = stripGenerationArtifacts(raw);
  if (!text) {
    throw new SpycoreCliError(
      'Generation returned nothing usable.',
      EXIT_USER_ERROR,
      'Try again, or write the text yourself.',
    );
  }
  return text;
}

// ─────────────────────────── review loop ────────────────────────────────

export type ReviewAction = 'accept' | 'cancel';

export interface ReviewLoopIo {
  /** Show the current candidate to the user (already display-sanitized by the caller). */
  present: (text: string) => void;
  /** Ask "[a]ccept / [e]dit / [r]egenerate / [c]ancel" - returns the raw answer. */
  ask: () => Promise<string>;
  /** Read a full replacement text from the user. */
  readEdit: () => Promise<string>;
  /** Produce a fresh candidate. */
  regenerate: () => Promise<string>;
}

export interface ReviewResult {
  action: ReviewAction;
  text: string;
}

/**
 * The accept / edit / regenerate / cancel state machine. Pure control flow
 * over injected IO so it is unit-testable; the commands wire the real
 * prompts. An edit is ALSO passed through the trailer net - user-typed
 * trailers are their own business, but a pasted generated message must not
 * smuggle one past the net.
 */
export async function reviewLoop(
  initial: string,
  io: ReviewLoopIo,
): Promise<ReviewResult> {
  let current = initial;
  // Bounded only by the user's patience - every iteration re-prompts.
  for (;;) {
    io.present(current);
    const answer = (await io.ask()).trim().toLowerCase();
    if (answer === 'a' || answer === 'accept' || answer === 'y' || answer === 'yes') {
      return { action: 'accept', text: current };
    }
    if (answer === 'c' || answer === 'cancel' || answer === 'n' || answer === 'no' || answer === 'q') {
      return { action: 'cancel', text: current };
    }
    if (answer === 'e' || answer === 'edit') {
      const edited = stripGenerationArtifacts(await io.readEdit());
      if (edited) current = edited;
      continue;
    }
    if (answer === 'r' || answer === 'regenerate') {
      current = await io.regenerate();
      continue;
    }
    // Unrecognized input → re-present and re-ask.
  }
}
