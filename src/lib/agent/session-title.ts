/**
 * Auto titles for local agent sessions (F29).
 *
 * Server conversations get their titles from the backend (an SSE `title`
 * event during the first turn). A local session has no server author, so
 * this mirrors that behavior client-side: one cheap call to the
 * smallest/fastest model (minos) turns the first task's raw text into a
 * short title. Everything here is fail-soft - a null return means "keep the
 * fallback title", never a user-visible error.
 */
import type { Provider } from '../providers/types.js';

/** Smallest/fastest model on the fleet - dedicated to title generation. */
export const SESSION_TITLE_MODEL = 'minos';

/** Hard word cap on generated titles (feature spec: max ~10 words). */
export const SESSION_TITLE_MAX_WORDS = 10;

/** Defensive character cap so a runaway model can't blow up the sidebar. */
export const SESSION_TITLE_MAX_CHARS = 120;

/** The prompt the server-side title generator is mirrored from: short,
 * plain-words, no decoration. */
export function buildSessionTitlePrompt(task: string): {
  system: string;
  message: string;
} {
  return {
    system: `You write ultra-short titles for agent work sessions. Reply with ONLY the title: at most ${SESSION_TITLE_MAX_WORDS} words, plain words, no quotation marks, no trailing punctuation, no markdown, no emoji.`,
    message: `Write a title for this session:\n\n${task.trim().slice(0, 2000)}`,
  };
}

/**
 * Normalize raw model output into a display-safe title. Returns null when
 * there is nothing usable (empty, whitespace-only) so callers keep their
 * fallback. Pure - pinned by tests.
 */
export function cleanSessionTitle(raw: string): string | null {
  // First line only - a chatty model may append explanations.
  let line = (raw.split('\n')[0] ?? '').trim();
  // Strip wrapping quotes/backticks the model likes to add.
  if (line.length >= 2) {
    const first = line[0];
    const last = line[line.length - 1];
    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === '`' && last === '`')
    ) {
      line = line.slice(1, -1).trim();
    }
  }
  // Trailing sentence punctuation is noise in a sidebar.
  line = line.replace(/[.:;!?…]+$/u, '').trim();
  const words = line.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return null;
  const clipped = words.slice(0, SESSION_TITLE_MAX_WORDS).join(' ');
  return clipped.length > SESSION_TITLE_MAX_CHARS
    ? `${clipped.slice(0, SESSION_TITLE_MAX_CHARS - 1)}…`
    : clipped;
}

/**
 * One cheap model turn that produces a session title for `task`. Resolves
 * null on any failure (network, auth, empty output) - callers keep their
 * fallback title.
 */
export async function generateSessionTitle(opts: {
  provider: Provider;
  /** SESSION_TITLE_MODEL for SpyCore; the user's BYOK model id otherwise. */
  model: string;
  apiUrlOverride?: string;
  task: string;
  signal?: AbortSignal;
}): Promise<string | null> {
  const task = opts.task.trim();
  if (task.length === 0) return null;
  try {
    const { system, message } = buildSessionTitlePrompt(task);
    const conversationId = await opts.provider.createConversation({
      model: opts.model,
      apiUrlOverride: opts.apiUrlOverride,
    });
    let text = '';
    for await (const event of opts.provider.streamChat({
      conversationId,
      message,
      system,
      model: opts.model,
      apiUrlOverride: opts.apiUrlOverride,
      signal: opts.signal,
    })) {
      if (opts.signal?.aborted) return null;
      if (event.type === 'text') text += event.text;
      else if (event.type === 'error') return null;
      // tool_calls can never happen: no tools were offered this turn.
    }
    return cleanSessionTitle(text);
  } catch {
    return null;
  }
}
