/**
 * Tests for /compact's transcript serialization (compact.ts): every item
 * kind renders to a summarizable line, nothing safety-critical is dropped,
 * and the whole thing stays within the serial budget.
 */
import { describe, expect, test } from 'vitest';
import {
  buildSummaryPrompt,
  MAX_SERIAL_CHARS,
  serializeTranscriptForSummary,
  SUMMARY_SYSTEM_PROMPT,
} from '../src/ui/tui/compact.js';

describe('serializeTranscriptForSummary', () => {
  test('renders every summarizable kind', () => {
    const { text, count } = serializeTranscriptForSummary([
      { kind: 'task', task: 'short', fullTask: 'the full task text' },
      { kind: 'assistant', text: 'did the thing' },
      { kind: 'tool', tool: 'read_file', arg: 'src/a.ts', summary: '40 lines' },
      { kind: 'command', command: 'npm test', info: { statusLabel: 'exit 0' } },
      { kind: 'notice', text: '3 files changed' },
      { kind: 'diff', total: 2 },
      { kind: 'summary', text: 'earlier summary here' },
    ]);
    expect(count).toBe(7);
    expect(text).toContain('Task: the full task text');
    expect(text).toContain('Assistant: did the thing');
    expect(text).toContain('Tool read_file src/a.ts: 40 lines');
    expect(text).toContain('$ npm test -> exit 0');
    expect(text).toContain('Note: 3 files changed');
    expect(text).toContain('Diff: 2 file(s) changed');
    expect(text).toContain('Earlier summary: earlier summary here');
  });

  test('prefers fullTask over the collapsed echo', () => {
    const { text } = serializeTranscriptForSummary([
      { kind: 'task', task: '[+5 more lines - full text sent]', fullTask: 'line1\nline2\nline3' },
    ]);
    expect(text).toContain('line1\nline2\nline3');
    expect(text).not.toContain('[+5 more lines');
  });

  test('skips non-content kinds (welcome, help, peek, skills)', () => {
    const { text, count } = serializeTranscriptForSummary([
      { kind: 'welcome' },
      { kind: 'help' },
      { kind: 'peek', label: 'x', full: 'y' },
      { kind: 'banner' },
    ]);
    expect(count).toBe(0);
    expect(text).toBe('');
  });

  test('stays within the serial budget on huge transcripts', () => {
    const items = Array.from({ length: 500 }, (_, i) => ({
      kind: 'assistant',
      text: 'x'.repeat(5000),
      id: i,
    }));
    const { text } = serializeTranscriptForSummary(items);
    expect(text.length).toBeLessThanOrEqual(MAX_SERIAL_CHARS + 2000);
  });

  test('empty transcript serializes to empty', () => {
    expect(serializeTranscriptForSummary([])).toEqual({ text: '', count: 0 });
  });
});

describe('buildSummaryPrompt', () => {
  test('embeds the transcript and asks for structure', () => {
    const p = buildSummaryPrompt('Task: foo');
    expect(p).toContain('Task: foo');
    expect(p).toContain('--- transcript ---');
    expect(p.toLowerCase()).toContain('summar');
  });

  test('system prompt is output-only', () => {
    expect(SUMMARY_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(SUMMARY_SYSTEM_PROMPT.toLowerCase()).toContain('only the summary');
  });
});
