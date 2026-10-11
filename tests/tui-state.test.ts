/**
 * TUI draft/state persistence: round-trips through a configurable config dir,
 * never crashes on garbage, never destroys history when clearing the draft,
 * and never leaks machine specifics.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, beforeEach } from 'vitest';
import { loadTuiState, saveTuiState, clearTuiDraft } from '../src/ui/tui/state.js';

beforeEach(() => {
  // Each suite gets its own config dir so tests never touch the real one.
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'spycore-tui-test-'));
});

function writeRawState(contents: string): void {
  const dir = process.env.XDG_CONFIG_HOME!;
  mkdirSync(join(dir, 'spycore'), { recursive: true });
  writeFileSync(join(dir, 'spycore', 'tui-state.json'), contents);
}

describe('tui state', () => {
  test('starts null when nothing is stored', () => {
    expect(loadTuiState()).toBeNull();
  });

  test('draft round-trips', () => {
    saveTuiState({ draft: 'half-typed thought', updatedAt: 't' });
    expect(loadTuiState()?.draft).toBe('half-typed thought');
  });

  test('history round-trips', () => {
    saveTuiState({ draft: '', updatedAt: 't', history: ['first', 'second'] });
    expect(loadTuiState()?.history).toEqual(['first', 'second']);
  });

  test('clearTuiDraft clears the draft but keeps history', () => {
    saveTuiState({ draft: 'abc', updatedAt: 't', history: ['x'] });
    clearTuiDraft();
    const s = loadTuiState();
    expect(s?.draft).toBe('');
    expect(s?.history).toEqual(['x']);
  });

  test('garbage on disk degrades to null', () => {
    writeRawState('{not json');
    expect(loadTuiState()).toBeNull();
  });

  test('non-string draft is treated as missing', () => {
    writeRawState(JSON.stringify({ draft: 42 }));
    expect(loadTuiState()).toBeNull();
  });

  test('non-string history entries are dropped', () => {
    writeRawState(JSON.stringify({ draft: 'd', history: ['ok', 7] }));
    expect(loadTuiState()?.history).toEqual([]);
  });

  test('the stored file carries no machine specifics beyond the config dir', () => {
    saveTuiState({ draft: 'd', updatedAt: 't', history: ['h'] });
    const s = loadTuiState();
    expect(JSON.stringify(s)).not.toContain(process.env.HOME ?? '__never__');
  });
});
