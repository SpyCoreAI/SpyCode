/**
 * The TUI keybinding contract: one key, one meaning per context, and /help
 * that always fits an 80x24 terminal. The approval key map is pinned here so
 * the a/A/r/Esc semantics are tested, not just rendered.
 */
import { describe, expect, test } from 'vitest';
import {
  KEYBINDINGS,
  approvalKeyFor,
} from '../src/ui/tui/keybindings.js';
import { layoutHelpColumns, type HelpEntry } from '../src/ui/tui/help.js';

describe('KEYBINDINGS uniqueness (hard rule #1)', () => {
  test('no two bindings share a key in the same context', () => {
    const seen = new Map<string, string>();
    for (const b of KEYBINDINGS) {
      const k = `${b.when}:${b.id}`;
      expect(seen.has(k), `duplicate binding ${k} (${seen.get(k)} vs ${b.action})`).toBe(false);
      seen.set(k, b.action);
    }
  });

  test('every binding has a label and a plain-words action', () => {
    for (const b of KEYBINDINGS) {
      expect(b.label.length).toBeGreaterThan(0);
      expect(b.action.length).toBeGreaterThan(0);
    }
  });

  test('Ctrl+C never quits outright - only double-press does', () => {
    const quit = KEYBINDINGS.filter((b) => b.action.includes('quit'));
    expect(quit.length).toBe(1);
    expect(quit[0]!.label).toBe('Ctrl+C');
    expect(quit[0]!.action).toContain('double-press');
  });

  test('Esc in the approval context is reject (default-deny)', () => {
    const esc = KEYBINDINGS.find((b) => b.when === 'approval' && b.id === 'escape');
    expect(esc?.action).toBe('reject');
  });
});

describe('layoutHelpColumns (live /help surface)', () => {
  const cells: HelpEntry[] = [
    { key: 'Enter', desc: 'send' },
    { key: 'Ctrl+P', desc: 'command palette' },
    { key: 'Ctrl+G', desc: 'edit in $EDITOR' },
    { key: 'Esc', desc: 'stash draft' },
  ];
  test('columns fit the inner width and preserve every cell', () => {
    for (const w of [76, 60, 40]) {
      const cols = layoutHelpColumns(cells, w);
      const flat = cols.flat();
      expect(flat).toHaveLength(cells.length);
      let total = 0;
      for (const col of cols) {
        total += Math.max(...col.map((c) => c.key.length + 2 + c.desc.length));
      }
      total += 2 * (cols.length - 1);
      expect(total).toBeLessThanOrEqual(w);
    }
  });

  test('falls back to a single column on narrow screens', () => {
    expect(layoutHelpColumns(cells, 10)).toHaveLength(1);
    expect(layoutHelpColumns([], 80)).toEqual([]);
  });
});

describe('approvalKeyFor', () => {
  test('a / A / r map to their decisions (session scope only)', () => {
    expect(approvalKeyFor('a', false)).toBe('accept');
    expect(approvalKeyFor('A', false)).toBe('accept_all');
    expect(approvalKeyFor('r', false)).toBe('reject');
  });

  test('the permanent-allow w key is gone from the TUI', () => {
    expect(approvalKeyFor('w', false)).toBeNull();
    const approval = KEYBINDINGS.filter((b) => b.when === 'approval');
    expect(approval.some((b) => b.id === 'w')).toBe(false);
  });

  test('Esc is reject regardless of input', () => {
    expect(approvalKeyFor('', true)).toBe('reject');
    expect(approvalKeyFor('a', true)).toBe('reject');
  });

  test('anything else is ignored', () => {
    for (const k of ['x', 'q', 'y', 'w', 'Enter', ' ']) {
      expect(approvalKeyFor(k, false)).toBeNull();
    }
  });

  test('Ctrl+O is the universal expand gesture, Ctrl+Y copies', () => {
    const peek = KEYBINDINGS.find((b) => b.id === 'ctrl+o');
    expect(peek?.when).toBe('composer');
    expect(peek?.action).toBe('expand elided output');
    const copy = KEYBINDINGS.find((b) => b.id === 'ctrl+y');
    expect(copy?.when).toBe('composer');
    expect(copy?.action).toBe('copy last reply');
  });

  test('Ctrl+J is newline in the composer', () => {
    const nl = KEYBINDINGS.find((b) => b.id === 'ctrl+j');
    expect(nl?.when).toBe('composer');
    expect(nl?.action).toBe('newline');
  });
});
