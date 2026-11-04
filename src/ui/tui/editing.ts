/**
 * Pure composer-editing primitives for the TUI's multiline input.
 *
 * The composer is a plain `{ value, cursor }` over a flat string; newlines
 * are real `\n` characters (Ctrl+J inserts one, Enter submits). All helpers
 * here are total and unit-tested - the React side only calls them.
 */

export interface ComposerState {
  value: string;
  cursor: number;
}

/**
 * Hard cap on the composer value. Pasted blobs collapse to `[Pasted ~N
 * lines]` placeholders, so the value itself must never grow unboundedly
 * (a 500-line paste used to become one unbounded line).
 */
export const COMPOSER_MAX_CHARS = 20_000;

/** A single input event at/above this size is a paste, not typing. */
export const PASTE_CHAR_THRESHOLD = 200;
/** ... or this many newline-separated lines. */
export const PASTE_LINE_THRESHOLD = 3;

export function clampComposerState(s: ComposerState): ComposerState {
  if (s.value.length <= COMPOSER_MAX_CHARS) return s;
  const value = s.value.slice(0, COMPOSER_MAX_CHARS);
  return { value, cursor: Math.min(s.cursor, value.length) };
}

/**
 * Chain a composer mutation with synchronous ref sync.
 *
 * Live-test finding (2026-10-05): two input events landing in the same tick
 * both read a render-synced ref, so the second insert overwrote the first
 * (`!echo hello` ran as `cho hello`). Applying the transform to the ref's
 * value AND writing the ref back immediately makes back-to-back events
 * chain on the latest value even before React re-renders. The TUI routes
 * every composer mutation through this; the test pins the chaining.
 */
export function updateComposerState(
  ref: { current: ComposerState },
  setState: (next: ComposerState) => void,
  fn: (prev: ComposerState) => ComposerState,
): void {
  const next = fn(ref.current);
  ref.current = next;
  setState(next);
}

/** Insert text at the cursor. */
export function insertText(state: ComposerState, text: string): ComposerState {
  if (text.length === 0) return state;
  return clampComposerState({
    value: state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor),
    cursor: state.cursor + text.length,
  });
}

/** Ctrl+J: a newline at the cursor. */
export function insertNewline(state: ComposerState): ComposerState {
  return insertText(state, '\n');
}

/** Backspace: delete the char before the cursor (joins lines across `\n`). */
export function deleteBackward(state: ComposerState): ComposerState {
  if (state.cursor <= 0) return state;
  // Don't split surrogate pairs: if the char before the cursor is a low
  // surrogate, delete the full pair.
  let deleteCount = 1;
  const prevCode = state.value.charCodeAt(state.cursor - 1);
  if (prevCode >= 0xdc00 && prevCode <= 0xdfff && state.cursor >= 2) {
    deleteCount = 2;
  }
  return {
    value: state.value.slice(0, state.cursor - deleteCount) + state.value.slice(state.cursor),
    cursor: state.cursor - deleteCount,
  };
}

export function stepCursor(state: ComposerState, delta: -1 | 1): ComposerState {
  let cursor = state.cursor + delta;
  // Don't land between surrogates: skip over the pair.
  if (delta === 1 && cursor < state.value.length) {
    const code = state.value.charCodeAt(cursor);
    if (code >= 0xdc00 && code <= 0xdfff) cursor += 1;
  } else if (delta === -1 && cursor > 0) {
    const code = state.value.charCodeAt(cursor - 1);
    if (code >= 0xd800 && code <= 0xdbff) cursor -= 1;
  }
  cursor = Math.max(0, Math.min(state.value.length, cursor));
  return { value: state.value, cursor };
}

/** Split the value into logical (`\n`-delimited) lines. */
export function composerLines(value: string): string[] {
  return value.split('\n');
}

/**
 * Word-wise cursor movement (Alt+Left / Ctrl+Left = backward word,
 * Alt+Right / Ctrl+Right = forward word) with readline (Alt+b / Alt+f)
 * semantics: moving left lands on the START of the previous word, moving
 * right on the END of the next word. Word characters are Unicode letters,
 * numbers and `_`; everything else (spaces, punctuation, emoji) separates
 * words. The cursor never lands inside a surrogate pair.
 */
export function moveCursorWord(state: ComposerState, dir: -1 | 1): ComposerState {
  const isWordChar = (cp: string): boolean => /[\p{L}\p{N}_]/u.test(cp);
  const cps = [...state.value];
  // UTF-16 cursor offset -> code-point index (never splits a pair).
  let idx = [...state.value.slice(0, state.cursor)].length;
  if (dir === -1) {
    while (idx > 0 && !isWordChar(cps[idx - 1]!)) idx -= 1;
    while (idx > 0 && isWordChar(cps[idx - 1]!)) idx -= 1;
  } else {
    while (idx < cps.length && !isWordChar(cps[idx]!)) idx += 1;
    while (idx < cps.length && isWordChar(cps[idx]!)) idx += 1;
  }
  // Code-point index -> UTF-16 offset.
  const cursor = cps.slice(0, idx).join('').length;
  return { value: state.value, cursor };
}

/**
 * Locate the cursor: logical line index + column. Pure helper so the
 * renderer and the up/down handler agree on where the cursor is.
 */
export function locateCursor(value: string, cursor: number): { line: number; col: number } {
  const lines = composerLines(value);
  let rest = Math.max(0, Math.min(value.length, cursor));
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i]!.length;
    if (rest <= len) return { line: i, col: rest };
    rest -= len + 1;
  }
  const last = lines.length - 1;
  return { line: last, col: lines[last]!.length };
}

/** Move the cursor one logical line up/down, keeping the column when possible. */
export function moveCursorLine(state: ComposerState, dir: -1 | 1): ComposerState {
  const lines = composerLines(state.value);
  const { line, col } = locateCursor(state.value, state.cursor);
  const next = line + dir;
  if (next < 0 || next >= lines.length) return state;
  const ncol = Math.min(col, lines[next]!.length);
  let cursor = 0;
  for (let i = 0; i < next; i++) cursor += lines[i]!.length + 1;
  return { value: state.value, cursor: cursor + ncol };
}

/** Soft-history edges (OpenCode-style): history only at the buffer edges. */
export function cursorOnFirstLine(state: ComposerState): boolean {
  return !state.value.slice(0, state.cursor).includes('\n');
}

export function cursorOnLastLine(state: ComposerState): boolean {
  return !state.value.slice(state.cursor).includes('\n');
}

/**
 * Is this input event a paste rather than typing? Ink delivers a paste as ONE
 * input event holding the whole blob; a lone `\n` (Ctrl+J) has length 1 and
 * is never a paste.
 */
export function isPasteChunk(chunk: string): boolean {
  if (chunk.length <= 1) return false;
  return chunk.includes('\n') || chunk.length >= PASTE_CHAR_THRESHOLD;
}

/** The collapsed placeholder for a big paste. The `#id` keys the full text
 * in the session's paste store; on submit it is expanded back. */
export function pastePlaceholder(lines: number, id: number): string {
  return `[Pasted ~${lines} line${lines === 1 ? '' : 's'} #${id}]`;
}

const PASTE_PLACEHOLDER_RE = /\[Pasted ~\d+ lines? #(\d+)\]/g;

/**
 * Expand paste placeholders back to their full text for submit. Unknown ids
 * (user-typed lookalikes) are left untouched - the paste is then simply not
 * there, which is the forgiving behavior.
 */
export function expandPlaceholders(value: string, store: ReadonlyMap<number, string>): string {
  return value.replace(PASTE_PLACEHOLDER_RE, (m, id: string) => store.get(Number(id)) ?? m);
}

/**
 * Strip paste placeholders from a draft (used on /clear, where the store is
 * dropped — leaving the literal token would send garbage to the agent).
 */
export function stripPlaceholders(value: string): string {
  return value.replace(PASTE_PLACEHOLDER_RE, '').replace(/  +/g, ' ');
}

/**
 * Split an `$EDITOR`-style spec (`code --wait`, `vim`) into argv, respecting
 * single/double quotes. `spawnSync` runs with `shell: false`, so this split
 * is what makes multi-word editors work.
 */
export function parseEditorSpec(spec: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of spec) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur.length > 0) {
        parts.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) parts.push(cur);
  return parts;
}
