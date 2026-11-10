/**
 * P6-2 - displayCwd truncates code-point aware: a raw `slice(-39)` cut
 * code units and split a surrogate pair when an astral character sat in a
 * >40-char cwd path.
 */
import { homedir } from 'node:os';
import { describe, expect, test } from 'vitest';
import { displayCwd } from '../src/ui/tui/app-views.js';

/** True when the string holds no lone surrogate (every code point is whole). */
function hasNoLoneSurrogate(s: string): boolean {
  return [...s].every((cp) => cp.length !== 1 || cp.charCodeAt(0) < 0xd800 || cp.charCodeAt(0) > 0xdfff);
}

describe('displayCwd', () => {
  test('a long path with an emoji keeps the pair whole', () => {
    // 50 code points under ~: the old slice(-39) started on the emoji's
    // low surrogate and rendered a lone surrogate.
    const cwd = `${homedir()}/${'a'.repeat(9)}😀${'b'.repeat(38)}`;
    const out = displayCwd(cwd);
    expect(out.startsWith('…')).toBe(true);
    expect(out).toContain('😀');
    expect(hasNoLoneSurrogate(out)).toBe(true);
  });

  test('a long path outside $HOME keeps astral chars whole too', () => {
    const cwd = `/tmp/${'a'.repeat(9)}😀${'b'.repeat(38)}`;
    const out = displayCwd(cwd);
    expect(out.startsWith('…')).toBe(true);
    expect(out).toContain('😀');
    expect(hasNoLoneSurrogate(out)).toBe(true);
  });

  test('a short path is unchanged', () => {
    expect(displayCwd(`${homedir()}/projects/spycode`)).toBe('~/projects/spycode');
    expect(displayCwd('/tmp/w')).toBe('/tmp/w');
  });

  test('a path of exactly 40 code points is unchanged', () => {
    const cwd = `${homedir()}/${'a'.repeat(38)}`; // '~/'+38 = 40 code points
    expect(displayCwd(cwd)).toBe(`~/${'a'.repeat(38)}`);
  });
});
