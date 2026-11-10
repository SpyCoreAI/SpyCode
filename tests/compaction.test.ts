/**
 * H-9 - stage-1 transcript pruning: old tool/command items collapse to
 * stubs, old notices drop, long assistant messages cap - all without any
 * model call. Pure - the matrix is pinned here.
 */
import { describe, expect, test } from 'vitest';
import {
  COMPACT_ASSISTANT_CAP,
  pruneTranscriptItems,
  type PrunableItem,
} from '../src/lib/agent/compaction.js';

const tool = (i: number, summary = 'ok'): PrunableItem => ({
  kind: 'tool',
  tool: 'read_file',
  arg: `file${i}.ts`,
  summary,
});
const notice = (text: string): PrunableItem => ({ kind: 'notice', text });
const assistant = (text: string, final = false): PrunableItem => ({ kind: 'assistant', text, final });
const task = (t: string): PrunableItem => ({ kind: 'task', task: t });

describe('pruneTranscriptItems', () => {
  test('small transcripts pass through untouched', () => {
    const items = [task('do it'), tool(1), assistant('working', true)];
    const { items: out, pruned } = pruneTranscriptItems(items);
    expect(pruned).toBe(0);
    expect(out).toEqual(items);
  });

  test('old tool items collapse to stubs, recent ones stay whole', () => {
    const items = Array.from({ length: 12 }, (_, i) => tool(i));
    const { items: out, pruned } = pruneTranscriptItems(items, { keepRecentTools: 3 });
    expect(pruned).toBe(9);
    expect(out).toHaveLength(12);
    // Recent three keep their args; the rest are stubs (no arg).
    for (let i = 0; i < 9; i += 1) {
      expect(out[i]!.arg).toBeUndefined();
      expect(out[i]!.summary).toBe('ok');
    }
    expect(out[11]!.arg).toBe('file11.ts');
  });

  test('old notices drop, recent ones stay', () => {
    const items = [notice('n1'), notice('n2'), notice('n3'), notice('n4'), notice('n5')];
    const { items: out, pruned } = pruneTranscriptItems(items, { keepRecentNotices: 2 });
    expect(pruned).toBe(3);
    expect(out.map((i) => i.text)).toEqual(['n4', 'n5']);
  });

  test('long non-final assistant messages cap', () => {
    const items = [assistant('x'.repeat(COMPACT_ASSISTANT_CAP + 100))];
    const { items: out, pruned } = pruneTranscriptItems(items);
    expect(pruned).toBe(1);
    expect(out[0]!.text!.length).toBeLessThan(COMPACT_ASSISTANT_CAP + 20);
    expect(out[0]!.text).toContain('[pruned]');
  });

  test('final assistant messages are never capped', () => {
    const items = [assistant('x'.repeat(COMPACT_ASSISTANT_CAP + 100), true)];
    const { items: out, pruned } = pruneTranscriptItems(items);
    expect(pruned).toBe(0);
    expect(out[0]!.text!.length).toBe(COMPACT_ASSISTANT_CAP + 100);
  });

  test('command items collapse like tool items', () => {
    const items = Array.from({ length: 4 }, (_, i) => ({
      kind: 'command',
      command: `cmd${i}`,
      info: { statusLabel: 'ok' },
    }) as PrunableItem);
    const { items: out, pruned } = pruneTranscriptItems(items, { keepRecentTools: 1 });
    expect(pruned).toBe(3);
    expect(out[0]).toMatchObject({ kind: 'command', command: 'cmd0', info: { statusLabel: 'ok' } });
  });

  test('task items always pass through', () => {
    const items = [task('a'), task('b')];
    const { pruned } = pruneTranscriptItems(items);
    expect(pruned).toBe(0);
  });
});
