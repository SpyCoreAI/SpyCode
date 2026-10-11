/**
 * Tests for the transcript-search helpers (transcript-search.ts): per-kind
 * text extraction, hit finding, highlight splitting, and index clamping.
 */
import { describe, expect, test } from 'vitest';
import {
  clampHitIndex,
  findTranscriptHits,
  itemSearchText,
  matchExcerpt,
  splitHighlight,
  type SearchableItem,
} from '../src/ui/tui/transcript-search.js';

const item = (over: Partial<SearchableItem> & { kind: string }): SearchableItem => ({
  id: 1,
  ...over,
});

describe('itemSearchText', () => {
  test('extracts prose kinds verbatim', () => {
    expect(itemSearchText(item({ kind: 'assistant', id: 1, text: 'hello world' }))).toBe('hello world');
    expect(itemSearchText(item({ kind: 'notice', id: 2, text: 'watch out' }))).toBe('watch out');
    expect(itemSearchText(item({ kind: 'task', id: 3, task: 'do the thing' }))).toContain('do the thing');
  });

  test('tool items contribute tool, arg and summary', () => {
    const t = itemSearchText(item({ kind: 'tool', id: 4, tool: 'read_file', arg: 'src/a.ts', summary: '12 lines' }));
    expect(t).toContain('read_file');
    expect(t).toContain('src/a.ts');
    expect(t).toContain('12 lines');
  });

  test('command items contribute the command and its tail', () => {
    const t = itemSearchText(
      item({ kind: 'command', id: 5, command: 'npm test', info: { tail: '3 failed', statusLabel: 'exit 1' } }),
    );
    expect(t).toContain('npm test');
    expect(t).toContain('3 failed');
  });

  test('diff items contribute file paths and hunk text', () => {
    const t = itemSearchText(
      item({
        kind: 'diff',
        id: 6,
        files: [{ path: 'src/b.ts', hunks: [{ text: 'added line' }] }],
      }),
    );
    expect(t).toContain('src/b.ts');
    expect(t).toContain('added line');
  });

  test('unknown kinds and non-strings are safe', () => {
    expect(itemSearchText(item({ kind: 'banner', id: 7 }))).toBe('');
    expect(itemSearchText(item({ kind: 'whatever', id: 8 }))).toBe('');
    expect(itemSearchText(item({ kind: 'assistant', id: 9, text: 42 }))).toBe('');
  });
});

describe('findTranscriptHits', () => {
  const items: SearchableItem[] = [
    item({ kind: 'assistant', id: 1, text: 'The Quick brown fox' }),
    item({ kind: 'tool', id: 2, tool: 'grep', arg: 'fox', summary: '1 match' }),
    item({ kind: 'notice', id: 3, text: 'nothing relevant' }),
  ];

  test('matches case-insensitively in transcript order', () => {
    expect(findTranscriptHits(items, 'FOX')).toEqual([1, 2]);
    expect(findTranscriptHits(items, 'quick')).toEqual([1]);
  });

  test('blank query matches nothing', () => {
    expect(findTranscriptHits(items, '')).toEqual([]);
    expect(findTranscriptHits(items, '   ')).toEqual([]);
  });
});

describe('splitHighlight', () => {
  test('splits around every non-overlapping occurrence', () => {
    expect(splitHighlight('foo bar foo', 'foo')).toEqual([
      { text: 'foo', match: true },
      { text: ' bar ', match: false },
      { text: 'foo', match: true },
    ]);
  });

  test('is case-insensitive but preserves original casing', () => {
    expect(splitHighlight('Foo BAR', 'foo')).toEqual([
      { text: 'Foo', match: true },
      { text: ' BAR', match: false },
    ]);
  });

  test('no match returns the whole text as one plain segment', () => {
    expect(splitHighlight('hello', 'zzz')).toEqual([{ text: 'hello', match: false }]);
  });

  test('empty query or text is a single plain segment', () => {
    expect(splitHighlight('hello', '')).toEqual([{ text: 'hello', match: false }]);
    expect(splitHighlight('', 'x')).toEqual([{ text: '', match: false }]);
  });
});

describe('matchExcerpt', () => {
  test('returns context around the first match', () => {
    const e = matchExcerpt('0123456789 MATCH 0123456789', 'match', 4);
    expect(e).not.toBeNull();
    expect(e!.match).toBe('MATCH');
    expect(e!.before).toContain('789 ');
    expect(e!.after).toBe(' 012…');
  });

  test('adds ellipses when truncated', () => {
    const e = matchExcerpt(`x${'a'.repeat(200)}needle${'b'.repeat(200)}y`, 'needle', 4);
    expect(e!.before.startsWith('…')).toBe(true);
    expect(e!.after.endsWith('…')).toBe(true);
  });

  test('returns null without a match or with a blank query', () => {
    expect(matchExcerpt('hello', 'zzz')).toBeNull();
    expect(matchExcerpt('hello', '  ')).toBeNull();
  });
});

describe('clampHitIndex', () => {
  test('clamps to the valid range, -1 when empty', () => {
    expect(clampHitIndex(0, [])).toBe(-1);
    expect(clampHitIndex(-1, [1, 2])).toBe(0);
    expect(clampHitIndex(5, [1, 2])).toBe(1);
    expect(clampHitIndex(1, [1, 2])).toBe(1);
  });
});
