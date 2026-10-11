import { describe, expect, test } from 'vitest';
import { formatDiagnostics, type Diagnostic } from '../src/lib/agent/diagnostics.js';
import { computeFileDiff } from '../src/lib/agent/diff.js';

function diag(over: Partial<Diagnostic> = {}): Diagnostic {
  return {
    file: 'src/a.ts',
    line: 3,
    column: 7,
    severity: 'error',
    message: "Cannot find name 'x'.",
    code: 2304,
    ...over,
  };
}

describe('formatDiagnostics', () => {
  test('failed check reports the reason', () => {
    expect(formatDiagnostics({ ok: false, reason: 'LSP disabled' })).toBe(
      'Diagnostic check failed: LSP disabled',
    );
  });

  test('clean tree reports no errors', () => {
    expect(formatDiagnostics({ ok: true, diagnostics: [] })).toBe('No TypeScript errors.');
  });

  test('diagnostics render as file:line:column [TScode] message', () => {
    const out = formatDiagnostics({ ok: true, diagnostics: [diag()] });
    expect(out).toBe(`src/a.ts:3:7 [TS2304] Cannot find name 'x'.`);
  });

  test('more than 50 diagnostics are capped with a remainder line', () => {
    const diags = Array.from({ length: 60 }, (_, i) => diag({ line: i + 1 }));
    const out = formatDiagnostics({ ok: true, diagnostics: diags });
    const lines = out.split('\n');
    expect(lines).toHaveLength(51);
    expect(lines[50]).toBe('... and 10 more');
    expect(lines[0]).toContain('src/a.ts:1:7');
  });

  test('exactly 50 diagnostics get no remainder line', () => {
    const diags = Array.from({ length: 50 }, (_, i) => diag({ line: i + 1 }));
    expect(formatDiagnostics({ ok: true, diagnostics: diags }).split('\n')).toHaveLength(50);
  });
});

describe('computeFileDiff', () => {
  test('identical texts produce no hunks', async () => {
    const d = await computeFileDiff('a\nb\n', 'a\nb\n');
    expect(d).toMatchObject({ added: 0, removed: 0, truncated: false, hiddenLines: 0 });
    expect(d.lines).toEqual([]);
  });

  test('added and removed lines are counted and typed', async () => {
    const d = await computeFileDiff('one\ntwo\nthree\n', 'one\nTWO\nthree\nfour\n');
    expect(d.added).toBe(2); // TWO, four
    expect(d.removed).toBe(1); // two
    expect(d.lines.some((l) => l.kind === 'hunk')).toBe(true);
    expect(d.lines.some((l) => l.kind === 'add' && l.text === 'four')).toBe(true);
    expect(d.lines.some((l) => l.kind === 'del' && l.text === 'two')).toBe(true);
    expect(d.lines.some((l) => l.kind === 'context' && l.text === 'one')).toBe(true);
  });

  test('hunk headers carry the @@ range markers', async () => {
    const d = await computeFileDiff('a\n', 'b\n');
    const hunk = d.lines.find((l) => l.kind === 'hunk')!;
    expect(hunk.text).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);
  });

  test('long diffs are capped at maxLines with a hidden count', async () => {
    const oldText = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const newText = Array.from({ length: 100 }, (_, i) => `LINE ${i}`).join('\n');
    const d = await computeFileDiff(oldText, newText, { maxLines: 10 });
    expect(d.truncated).toBe(true);
    expect(d.lines).toHaveLength(10);
    expect(d.hiddenLines).toBeGreaterThan(0);
    // counts still reflect the whole diff, not the cap
    expect(d.added).toBe(100);
    expect(d.removed).toBe(100);
  });

  test('default cap is 200 lines', async () => {
    const oldText = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    const newText = Array.from({ length: 300 }, (_, i) => `LINE ${i}`).join('\n');
    const d = await computeFileDiff(oldText, newText);
    expect(d.truncated).toBe(true);
    expect(d.lines).toHaveLength(200);
  });
});
