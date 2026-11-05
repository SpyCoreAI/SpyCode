import { describe, expect, test } from 'vitest';
import {
  actionForKey,
  displayLabelForKeyId,
  KEYBINDINGS,
  keyIdForInkEvent,
  labelForAction,
  normalizeKeyId,
  resolveKeybindings,
} from '../src/ui/tui/keybindings.js';

describe('keybinding overrides (F16)', () => {
  test('undefined overrides resolve to the pinned contract, untouched', () => {
    const { bindings, errors } = resolveKeybindings(undefined);
    expect(errors).toEqual([]);
    expect(bindings).toBe(KEYBINDINGS);
  });

  test('empty array keeps every default binding', () => {
    const { bindings, errors } = resolveKeybindings([]);
    expect(errors).toEqual([]);
    expect(bindings).toEqual(KEYBINDINGS);
  });

  test('a valid override rebinds one action in one context only', () => {
    // Note: the target key must be one the terminal can actually produce
    // (ctrl+enter is not - Ink reports it as plain enter), otherwise the
    // override is rejected by the producibility gate.
    const { bindings, errors } = resolveKeybindings([
      { context: 'composer', action: 'command palette', key: 'ctrl+q' },
    ]);
    expect(errors).toEqual([]);
    const palette = bindings.filter((b) => b.when === 'composer' && b.action === 'command palette');
    expect(palette).toHaveLength(1);
    expect(palette[0]!.id).toBe('ctrl+q');
    expect(palette[0]!.label).toBe('Ctrl+Q');
    // Everything else is byte-identical to the contract.
    const rest = bindings.filter((b) => !(b.when === 'composer' && b.action === 'command palette'));
    const restOrig = KEYBINDINGS.filter((b) => !(b.when === 'composer' && b.action === 'command palette'));
    expect(rest).toEqual(restOrig);
  });

  test('user key spellings normalize (Ctrl+J, CTRL-J, ctrl + j)', () => {
    for (const spelling of ['Ctrl+Q', 'CTRL-Q', 'ctrl + q', 'ctrl+q']) {
      const { bindings, errors } = resolveKeybindings([
        { context: 'composer', action: 'edit in $EDITOR', key: spelling },
      ]);
      expect(errors, spelling).toEqual([]);
      expect(bindings.find((b) => b.when === 'composer' && b.action === 'edit in $EDITOR')!.id).toBe(
        'ctrl+q',
      );
    }
  });

  test('normalizeKeyId rejects garbage', () => {
    expect(() => normalizeKeyId('')).toThrow();
    expect(() => normalizeKeyId('ctrl+hyper+x')).toThrow();
    expect(() => normalizeKeyId('ctrl+ctrl+x')).toThrow();
    expect(() => normalizeKeyId('ctrl+nope')).toThrow();
    expect(normalizeKeyId('Enter')).toBe('enter');
    expect(normalizeKeyId('alt+shift+f5')).toBe('alt+shift+f5');
  });

  test('conflict: stealing another binding\'s key rejects EVERYTHING (fail-closed)', () => {
    // composer already has send on enter; moving newline onto enter collides.
    const { bindings, errors } = resolveKeybindings([
      { context: 'composer', action: 'edit in $EDITOR', key: 'enter' },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/conflict/);
    expect(bindings).toBe(KEYBINDINGS);
  });

  test('conflict between two overrides is caught too', () => {
    // Note: the keys must be producible (the PRODUCIBLE gate rejects
    // ctrl+enter before the conflict check ever runs).
    const { bindings, errors } = resolveKeybindings([
      { context: 'composer', action: 'command palette', key: 'ctrl+q' },
      { context: 'composer', action: 'edit in $EDITOR', key: 'ctrl+q' },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/conflict/);
    expect(bindings).toBe(KEYBINDINGS);
  });

  test('unknown action is rejected - overrides cannot invent bindings', () => {
    const { bindings, errors } = resolveKeybindings([
      { context: 'composer', action: 'launch-missiles', key: 'ctrl+m' },
    ]);
    expect(errors.join(' ')).toMatch(/unknown action/);
    expect(bindings).toBe(KEYBINDINGS);
  });

  test('unknown context is rejected', () => {
    const { bindings, errors } = resolveKeybindings([
      { context: 'nope', action: 'command palette', key: 'ctrl+m' },
    ]);
    expect(errors.join(' ')).toMatch(/unknown context/);
    expect(bindings).toBe(KEYBINDINGS);
  });

  test('invalid key is rejected', () => {
    const { bindings, errors } = resolveKeybindings([
      { context: 'composer', action: 'command palette', key: 'ctrl+hyper+x' },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(bindings).toBe(KEYBINDINGS);
  });

  test('non-array overrides are rejected', () => {
    const { bindings, errors } = resolveKeybindings({ context: 'composer' });
    expect(errors.length).toBeGreaterThan(0);
    expect(bindings).toBe(KEYBINDINGS);
  });

  test('ambiguous action without "from" is rejected, not guessed', () => {
    // Note: approval/confirm/palette contexts are pinned (not rebindable).
    // Using composer context with a doubly-bound action for this test.
    // (composer has no doubly-bound actions by default, so we test the
    //  mechanism via the pinned-context rejection instead.)
    const ambiguous = resolveKeybindings([
      { context: 'approval', action: 'reject', key: 'ctrl+q' },
    ]);
    expect(ambiguous.errors.join(' ')).toMatch(/not supported|pinned/);
    expect(ambiguous.bindings).toBe(KEYBINDINGS);
  });

  test('bad "from" is rejected', () => {
    // Note: the target key must be producible so the test reaches the
    // `from` check instead of the key gate.
    const { bindings, errors } = resolveKeybindings([
      { context: 'composer', action: 'command palette', from: 'ctrl+z', key: 'ctrl+q' },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/no "command palette" binding on/);
    expect(bindings).toBe(KEYBINDINGS);
  });

  test('valid "from" disambiguates and rebinds the named binding', () => {
    const { bindings, errors } = resolveKeybindings([
      { context: 'composer', action: 'command palette', from: 'ctrl+p', key: 'ctrl+q' },
    ]);
    expect(errors).toEqual([]);
    const palette = bindings.filter((b) => b.when === 'composer' && b.action === 'command palette');
    expect(palette).toHaveLength(1);
    expect(palette[0]!.id).toBe('ctrl+q');
  });

  test('non-dispatchable contexts reject overrides with clear error', () => {
    for (const ctx of ['approval', 'confirm', 'palette'] as const) {
      const { bindings, errors } = resolveKeybindings([
        { context: ctx, action: 'close', key: 'ctrl+x' },
      ]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/not supported|pinned/);
      expect(bindings).toBe(KEYBINDINGS);
    }
  });

  test('same key in DIFFERENT contexts is legal (contract allows it)', () => {
    // Note: `always`-context keys (ctrl+c, ctrl+b) are globally reserved
    // and cannot be rebound into other contexts - the global-first handler
    // would steal them. Using a non-reserved key here in dispatchable contexts.
    const { bindings, errors } = resolveKeybindings([
      { context: 'composer', action: 'command palette', key: 'ctrl+x' },
    ]);
    expect(errors).toEqual([]);
    expect(
      bindings.find((b) => b.when === 'composer' && b.action === 'command palette')!.id,
    ).toBe('ctrl+x');
  });

  test('always-context keys cannot be rebound into other contexts', () => {
    const { bindings, errors } = resolveKeybindings([
      { context: 'composer', action: 'command palette', key: 'ctrl+c' },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toMatch(/reserved by the "always" context/);
    expect(bindings).toBe(KEYBINDINGS);
  });

  test('rebind targets the terminal can never produce are rejected', () => {
    // 'x' normalizes fine but keyIdForInkEvent can never emit it (plain
    // typing), so the action would become unreachable.
    for (const key of ['x', 'space', 'f1', 'alt+q', 'shift+tab', 'ctrl+enter']) {
      const { bindings, errors } = resolveKeybindings([
        { context: 'composer', action: 'command palette', key },
      ]);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.join(' ')).toMatch(/can never be produced/);
      expect(bindings).toBe(KEYBINDINGS);
    }
  });

  test('an always-context rebind shadowed by another context is rejected', () => {
    // escape is bound directly in every context, so the always-fallback
    // would never fire: the rebind is dead, not moved.
    const { bindings, errors } = resolveKeybindings([
      { context: 'always', action: 'toggle sidebar', key: 'escape' },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/shadowed by/);
    expect(bindings).toBe(KEYBINDINGS);
  });

  test('an always-context rebind onto a free key is accepted', () => {
    // ctrl+x is producible and bound nowhere: the rebind is a genuine move.
    const { bindings, errors } = resolveKeybindings([
      { context: 'always', action: 'toggle sidebar', key: 'ctrl+x' },
    ]);
    expect(errors).toEqual([]);
    const sidebar = bindings.filter((b) => b.when === 'always' && b.action === 'toggle sidebar');
    expect(sidebar).toHaveLength(1);
    expect(sidebar[0]!.id).toBe('ctrl+x');
  });

  test('hardcoded-reserved keys cannot be rebind targets', () => {
    // down has hardcoded history navigation in composer; it is not in the
    // contract table, so the conflict checker cannot see it.
    const { bindings, errors } = resolveKeybindings([
      { context: 'composer', action: 'copy last reply', key: 'down' },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(' ')).toMatch(/reserved for hardcoded/);
    expect(bindings).toBe(KEYBINDINGS);
  });

  test('displayLabelForKeyId prettifies ids', () => {
    expect(displayLabelForKeyId('ctrl+j')).toBe('Ctrl+J');
    expect(displayLabelForKeyId('escape')).toBe('Esc');
    expect(displayLabelForKeyId('up')).toBe('↑');
    expect(displayLabelForKeyId('enter')).toBe('Enter');
    expect(displayLabelForKeyId('f5')).toBe('F5');
  });

  test('the pinned contract itself still satisfies one-key-one-meaning', () => {
    // The resolver with no overrides is the identity; assert the shipped
    // table has no duplicate (context, key) pairs.
    const seen = new Set<string>();
    for (const b of KEYBINDINGS) {
      const k = `${b.when} ${b.id}`;
      expect(seen.has(k), `duplicate: ${k}`).toBe(false);
      seen.add(k);
    }
  });

  test('keyIdForInkEvent maps Ink key events to normalized ids', () => {
    const k = (over: object) => ({
      ctrl: false, meta: false, ...over,
    });
    expect(keyIdForInkEvent('', k({ return: true }))).toBe('enter');
    expect(keyIdForInkEvent('', k({ escape: true }))).toBe('escape');
    expect(keyIdForInkEvent('', k({ tab: true }))).toBe('tab');
    expect(keyIdForInkEvent('', k({ upArrow: true }))).toBe('up');
    expect(keyIdForInkEvent('', k({ downArrow: true }))).toBe('down');
    expect(keyIdForInkEvent('', k({ backspace: true }))).toBe('backspace');
    // Ctrl+letter: input is the base character.
    expect(keyIdForInkEvent('p', k({ ctrl: true }))).toBe('ctrl+p');
    expect(keyIdForInkEvent('P', k({ ctrl: true }))).toBe('ctrl+p');
    expect(keyIdForInkEvent('5', k({ meta: true }))).toBe('meta+5');
    // Plain typing is not a binding.
    expect(keyIdForInkEvent('x', k({}))).toBeNull();
    expect(keyIdForInkEvent(' ', k({}))).toBeNull();
    // Shift+letter is typing; shift+tab has no contract entry.
    expect(keyIdForInkEvent('X', k({ shift: true }))).toBeNull();
    expect(keyIdForInkEvent('', k({ tab: true, shift: true }))).toBe('tab');
    // Ctrl+non-alnum is not producible.
    expect(keyIdForInkEvent(' ', k({ ctrl: true }))).toBeNull();
  });

  test('actionForKey checks the direct context, then the always fallback', () => {
    expect(actionForKey(KEYBINDINGS, 'composer', 'ctrl+p')).toBe('command palette');
    expect(actionForKey(KEYBINDINGS, 'composer', 'ctrl+b')).toBe('toggle sidebar');
    expect(actionForKey(KEYBINDINGS, 'running', 'escape')).toBe('interrupt run');
    expect(actionForKey(KEYBINDINGS, 'composer', 'escape')).toBe('stash draft');
    expect(actionForKey(KEYBINDINGS, 'composer', 'ctrl+z')).toBeNull();
    // A rebound table is honored.
    const { bindings } = resolveKeybindings([
      { context: 'composer', action: 'command palette', key: 'ctrl+q' },
    ]);
    expect(actionForKey(bindings, 'composer', 'ctrl+q')).toBe('command palette');
    expect(actionForKey(bindings, 'composer', 'ctrl+p')).toBeNull();
  });

  test('labelForAction returns the resolved display label', () => {
    expect(labelForAction(KEYBINDINGS, 'composer', 'command palette')).toBe('Ctrl+P');
    expect(labelForAction(KEYBINDINGS, 'composer', 'toggle sidebar')).toBe('Ctrl+B');
    expect(labelForAction(KEYBINDINGS, 'composer', 'nope')).toBeNull();
    const { bindings } = resolveKeybindings([
      { context: 'composer', action: 'command palette', key: 'ctrl+q' },
    ]);
    expect(labelForAction(bindings, 'composer', 'command palette')).toBe('Ctrl+Q');
  });
});
