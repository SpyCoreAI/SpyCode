import { describe, expect, test } from 'vitest';
import type { CheckpointSession } from '../src/lib/agent/checkpoint.js';
import { sessionPickerRows } from '../src/ui/tui/session-picker.js';

function session(over: Partial<CheckpointSession>): CheckpointSession {
  return {
    id: 'session-1',
    cwd: '/tmp',
    startedAt: new Date().toISOString(),
    task: 'do a thing',
    changes: [],
    ...over,
  };
}

describe('sessionPickerRows', () => {
  test('previews the task, file count, and non-resumable status', () => {
    const rows = sessionPickerRows([
      session({ id: 'a', task: 'line one\nline two' }),
      session({ id: 'b', task: '   ' }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(['a', 'b']);
    expect(rows[0]!.text).toContain('line one line two');
    expect(rows[0]!.text).toContain('0 files');
    expect(rows[0]!.text).toContain('[• recorded]');
    expect(rows[1]!.text).toContain('(untitled)');
  });

  test('truncates long task previews', () => {
    const rows = sessionPickerRows([session({ task: 'x'.repeat(80) })]);
    expect(rows[0]!.text).toContain('…');
  });
});
