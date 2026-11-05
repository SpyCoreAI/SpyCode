/**
 * Tests for the multiline composer editing primitives (editing.ts):
 * insertion, deletion, line movement, soft-history edges, paste
 * classification/collapse/expansion, and the composer length cap.
 */
import { describe, expect, test } from 'vitest';
import {
  clampComposerState,
  COMPOSER_MAX_CHARS,
  composerLines,
  cursorOnFirstLine,
  cursorOnLastLine,
  deleteBackward,
  expandPlaceholders,
  insertNewline,
  insertText,
  isPasteChunk,
  locateCursor,
  stepCursor,
  moveCursorLine,
  parseEditorSpec,
  pastePlaceholder,
  stripPlaceholders,
  moveCursorWord,
  updateComposerState,
} from '../src/ui/tui/editing.js';

describe('insertText / insertNewline / deleteBackward', () => {
  test('inserts at the cursor', () => {
    const s = insertText({ value: 'ab', cursor: 1 }, 'X');
    expect(s).toEqual({ value: 'aXb', cursor: 2 });
  });

  test('newline splits the line', () => {
    const s = insertNewline({ value: 'ab', cursor: 1 });
    expect(s).toEqual({ value: 'a\nb', cursor: 2 });
  });

  test('backspace joins lines across newlines', () => {
    const s = deleteBackward({ value: 'a\nb', cursor: 2 });
    expect(s).toEqual({ value: 'ab', cursor: 1 });
  });

  test('backspace at 0 is a no-op', () => {
    const s = { value: 'ab', cursor: 0 };
    expect(deleteBackward(s)).toBe(s);
  });

  test('value never exceeds the cap', () => {
    const s = insertText({ value: '', cursor: 0 }, 'x'.repeat(COMPOSER_MAX_CHARS + 100));
    expect(s.value.length).toBe(COMPOSER_MAX_CHARS);
    expect(s.cursor).toBe(COMPOSER_MAX_CHARS);
  });
});

describe('locateCursor / moveCursorLine', () => {
  test('locates line and column', () => {
    expect(locateCursor('ab\ncde', 4)).toEqual({ line: 1, col: 1 });
    expect(locateCursor('ab\ncde', 0)).toEqual({ line: 0, col: 0 });
    expect(locateCursor('ab\ncde', 6)).toEqual({ line: 1, col: 3 });
  });

  test('moves up keeping the column when possible', () => {
    const s = moveCursorLine({ value: 'ab\ncdef', cursor: 6 }, -1);
    expect(s.cursor).toBe(2); // 'ab', col 2
  });

  test('moves down clamping to the shorter line', () => {
    const s = moveCursorLine({ value: 'abcdef\nxy', cursor: 4 }, 1);
    expect(locateCursor(s.value, s.cursor)).toEqual({ line: 1, col: 2 });
  });

  test('stays put past the buffer edges', () => {
    const top = { value: 'ab\ncd', cursor: 1 };
    expect(moveCursorLine(top, -1)).toBe(top);
    const bottom = { value: 'ab\ncd', cursor: 5 };
    expect(moveCursorLine(bottom, 1)).toBe(bottom);
  });

  test('composerLines splits on newlines', () => {
    expect(composerLines('a\nb\nc')).toEqual(['a', 'b', 'c']);
  });
});

describe('soft-history edges', () => {
  test('first line: no newline before the cursor', () => {
    expect(cursorOnFirstLine({ value: 'ab\ncd', cursor: 2 })).toBe(true);
    expect(cursorOnFirstLine({ value: 'ab\ncd', cursor: 3 })).toBe(false);
  });

  test('last line: no newline at/after the cursor', () => {
    expect(cursorOnLastLine({ value: 'ab\ncd', cursor: 4 })).toBe(true);
    expect(cursorOnLastLine({ value: 'ab\ncd', cursor: 2 })).toBe(false);
  });

  test('single-line draft is both edges', () => {
    const s = { value: 'hello', cursor: 3 };
    expect(cursorOnFirstLine(s)).toBe(true);
    expect(cursorOnLastLine(s)).toBe(true);
  });
});

describe('isPasteChunk', () => {
  test('a lone LF (Ctrl+J) is not a paste', () => {
    expect(isPasteChunk('\n')).toBe(false);
  });

  test('multiline blobs are pastes', () => {
    expect(isPasteChunk('a\nb\nc')).toBe(true);
  });

  test('very long single-line input is a paste', () => {
    expect(isPasteChunk('x'.repeat(200))).toBe(true);
  });

  test('normal typing is not a paste', () => {
    expect(isPasteChunk('hello')).toBe(false);
    expect(isPasteChunk('a')).toBe(false);
  });
});

describe('paste placeholders', () => {
  test('placeholder names the line count and id', () => {
    expect(pastePlaceholder(12, 3)).toBe('[Pasted ~12 lines #3]');
    expect(pastePlaceholder(1, 0)).toBe('[Pasted ~1 line #0]');
  });

  test('expandPlaceholders restores full text by id', () => {
    const store = new Map([
      [3, 'line1\nline2\nline3'],
      [7, 'other'],
    ]);
    expect(expandPlaceholders('do [Pasted ~3 lines #3] now', store)).toBe('do line1\nline2\nline3 now');
    expect(expandPlaceholders('[Pasted ~1 line #7]', store)).toBe('other');
  });

  test('unknown ids (user-typed lookalikes) are left untouched', () => {
    const store = new Map<number, string>();
    expect(expandPlaceholders('[Pasted ~3 lines #99]', store)).toBe('[Pasted ~3 lines #99]');
  });

  test('text without placeholders passes through', () => {
    expect(expandPlaceholders('plain task', new Map())).toBe('plain task');
  });
});

describe('stepCursor', () => {
  test('clamps to the buffer bounds', () => {
    expect(stepCursor({ value: 'ab', cursor: 0 }, -1).cursor).toBe(0);
    expect(stepCursor({ value: 'ab', cursor: 2 }, 1).cursor).toBe(2);
    expect(stepCursor({ value: 'a\nb', cursor: 1 }, 1).cursor).toBe(2);
  });
});

describe('parseEditorSpec', () => {
  test('splits on whitespace', () => {
    expect(parseEditorSpec('code --wait')).toEqual(['code', '--wait']);
    expect(parseEditorSpec('vi')).toEqual(['vi']);
  });

  test('respects quotes', () => {
    expect(parseEditorSpec('"my editor" --wait')).toEqual(['my editor', '--wait']);
    expect(parseEditorSpec("'my editor'")).toEqual(['my editor']);
  });

  test('empty spec yields no argv', () => {
    expect(parseEditorSpec('   ')).toEqual([]);
  });
});

describe('updateComposerState', () => {
  test('back-to-back updates in one tick chain without losing characters', () => {
    // Regression (live test 2026-10-05): two input events in the same tick
    // both read a render-synced ref, so `!echo hello` ran as `cho hello`.
    // The ref must sync immediately so the second update chains on the first.
    const ref = { current: { value: '', cursor: 0 } };
    let state = ref.current;
    const setState = (next: { value: string; cursor: number }): void => {
      state = next;
    };
    // No render happens between these - exactly the racy interleaving.
    updateComposerState(ref, setState, (p) => insertText(p, '!'));
    updateComposerState(ref, setState, (p) => insertText(p, 'e'));
    updateComposerState(ref, setState, (p) => insertText(p, 'cho hello'));
    expect(ref.current.value).toBe('!echo hello');
    expect(state.value).toBe('!echo hello');
    expect(ref.current.cursor).toBe('!echo hello'.length);
  });

  test('mixed edits chain: type, newline, backspace', () => {
    const ref = { current: { value: '', cursor: 0 } };
    const setState = (_n: { value: string; cursor: number }): void => {};
    updateComposerState(ref, setState, (p) => insertText(p, 'ab'));
    updateComposerState(ref, setState, insertNewline);
    updateComposerState(ref, setState, (p) => insertText(p, 'c'));
    updateComposerState(ref, setState, deleteBackward);
    expect(ref.current.value).toBe('ab\n');
  });
});

describe('stripPlaceholders', () => {
  test('removes placeholder tokens', () => {
    expect(stripPlaceholders('hello [Pasted ~10 lines #3] world')).toBe('hello world');
  });
  test('leaves normal text untouched', () => {
    expect(stripPlaceholders('just some text')).toBe('just some text');
  });
  test('removes multiple placeholders', () => {
    expect(stripPlaceholders('[Pasted ~3 lines #1] and [Pasted ~5 lines #2]')).toBe(' and ');
  });
});

describe('surrogate pairs (emoji)', () => {
  test('deleteBackward removes the full pair, not half', () => {
    const s = { value: 'a😀', cursor: 3 }; // 'a' + surrogate pair (2 units)
    const out = deleteBackward(s);
    expect(out.value).toBe('a');
    expect(out.cursor).toBe(1);
  });
  test('stepCursor does not land between surrogates', () => {
    const s = { value: 'a😀b', cursor: 1 };
    const fwd = stepCursor(s, 1);
    expect(fwd.cursor).toBe(3); // skips the pair
    const back = stepCursor({ value: 'a😀b', cursor: 3 }, -1);
    expect(back.cursor).toBe(1); // skips back over the pair
  });
});

describe('moveCursorWord', () => {
  test('left jumps to the start of the previous word', () => {
    const s = { value: 'hello world', cursor: 11 };
    expect(moveCursorWord(s, -1).cursor).toBe(6);
    expect(moveCursorWord({ value: 'hello world', cursor: 6 }, -1).cursor).toBe(0);
  });

  test('right jumps to the end of the next word', () => {
    const s = { value: 'hello world', cursor: 0 };
    expect(moveCursorWord(s, 1).cursor).toBe(5);
    expect(moveCursorWord({ value: 'hello world', cursor: 5 }, 1).cursor).toBe(11);
  });

  test('underscores and digits count as word characters', () => {
    const s = { value: 'foo_bar2 baz', cursor: 12 };
    expect(moveCursorWord(s, -1).cursor).toBe(9);
    expect(moveCursorWord({ value: 'foo_bar2 baz', cursor: 0 }, 1).cursor).toBe(8);
  });

  test('punctuation and emoji are separators', () => {
    const s = { value: 'hi,😀there', cursor: 9 };
    // 'hi,'(3 units) + '😀'(2 units): "there" starts at UTF-16 offset 5.
    expect(moveCursorWord(s, -1).cursor).toBe(5);
    expect(moveCursorWord({ value: 'hi,😀there', cursor: 0 }, 1).cursor).toBe(2);
  });

  test('stops at the string edges', () => {
    expect(moveCursorWord({ value: 'abc', cursor: 0 }, -1).cursor).toBe(0);
    expect(moveCursorWord({ value: 'abc', cursor: 3 }, 1).cursor).toBe(3);
    expect(moveCursorWord({ value: '', cursor: 0 }, 1).cursor).toBe(0);
  });

  test('never lands inside a surrogate pair', () => {
    // 'a😀b c': the pair occupies UTF-16 offsets 1..3.
    const s = { value: 'a😀b c', cursor: 5 };
    // Start of "b" is UTF-16 offset 3 (the pair is a separator).
    expect(moveCursorWord(s, -1).cursor).toBe(3);
    const back = moveCursorWord({ value: 'a😀b c', cursor: 3 }, -1);
    expect(back.cursor).toBe(0); // separator run + "a" consumed: start of "a"
    const fwd = moveCursorWord({ value: 'a😀b', cursor: 0 }, 1);
    expect(fwd.cursor).toBe(1); // end of "a", before the pair
  });

  test('runs of separators are skipped in one jump', () => {
    const s = { value: 'a   b', cursor: 5 };
    // One word back: start of "b".
    expect(moveCursorWord(s, -1).cursor).toBe(4);
    // Again: the separator run and "a" are consumed together.
    expect(moveCursorWord({ value: 'a   b', cursor: 4 }, -1).cursor).toBe(0);
  });
});
