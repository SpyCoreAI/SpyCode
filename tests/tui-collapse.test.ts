/**
 * Transcript collapse budgets: tool output never hides safety-critical facts
 * (the one-line summaries always keep their names; these helpers only trim
 * VOLUME - long echoes and runaway shell output).
 */
import { describe, expect, test } from 'vitest';
import { collapseLines, echoForTranscript, capShellOutput } from '../src/ui/tui/collapse.js';

describe('collapseLines', () => {
  test('short text passes through untouched', () => {
    expect(collapseLines(['a', 'b', 'c'], 10)).toEqual({ shown: ['a', 'b', 'c'], hidden: 0 });
    expect(collapseLines([], 10)).toEqual({ shown: [], hidden: 0 });
  });

  test('long text keeps the head and reports an exact hidden count', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const out = collapseLines(lines, 10);
    expect(out.shown).toHaveLength(10);
    expect(out.shown[0]).toBe('line 0');
    expect(out.shown[9]).toBe('line 9');
    expect(out.hidden).toBe(10);
  });

  test('budget of 2 still reports the exact remainder', () => {
    const out = collapseLines(['a', 'b', 'c', 'd'], 2);
    expect(out.shown).toEqual(['a', 'b']);
    expect(out.hidden).toBe(2);
  });
});

describe('echoForTranscript', () => {
  test('short tasks echo verbatim', () => {
    expect(echoForTranscript('a\nb\nc')).toBe('a\nb\nc');
  });

  test('long pastes collapse to one line with an exact remainder count', () => {
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const out = echoForTranscript(text);
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('line 0');
    expect(out).toContain('[+19 more lines - full text sent]');
  });

  test('overlong first lines clamp with an ellipsis', () => {
    const out = echoForTranscript(`${'x'.repeat(200)}\nsecond`);
    expect(out).toContain('…');
    expect(out).toContain('[+1 more line - full text sent]');
  });

  test('empty input echoes empty', () => {
    expect(echoForTranscript('')).toBe('');
  });
});

describe('capShellOutput', () => {
  test('short output passes through with truncated=false', () => {
    expect(capShellOutput('ok\n', 10)).toEqual({ text: 'ok\n', truncated: false });
  });

  test('long output is head-truncated with an exact omission count', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const out = capShellOutput(text, 10);
    expect(out.truncated).toBe(true);
    expect(out.text.split('\n')).toContain('line 0');
    expect(out.text).toContain('… 20 more lines omitted');
  });

  test('empty output stays empty and untruncated', () => {
    expect(capShellOutput('', 10)).toEqual({ text: '', truncated: false });
  });
});
