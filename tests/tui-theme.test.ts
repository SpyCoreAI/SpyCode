/**
 * Terminal theme detection: OSC 11 parsing, luminance classification, and
 * mode resolution. The probe itself is timing/terminal-dependent and is NOT
 * unit-tested here; everything around it is pure and pinned.
 */
import { describe, expect, test } from 'vitest';
import {
  detectReducedMotion,
  isLightBackground,
  parseOsc11Response,
  resolveThemeMode,
} from '../src/ui/tui/theme-detect.js';

describe('parseOsc11Response', () => {
  test('parses a standard 4-digit response', () => {
    expect(parseOsc11Response('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')).toEqual({ r: 1, g: 1, b: 1 });
    expect(parseOsc11Response('\x1b]11;rgb:0000/0000/0000\x07')).toEqual({ r: 0, g: 0, b: 0 });
  });

  test('parses 2-digit components (most significant byte wins)', () => {
    const rgb = parseOsc11Response('\x1b]11;rgb:ff/80/00\x1b\\')!;
    expect(rgb.r).toBeCloseTo(1, 5);
    expect(rgb.g).toBeCloseTo(0x80 / 255, 5);
    expect(rgb.b).toBe(0);
  });

  test('parses 1-digit components by doubling', () => {
    expect(parseOsc11Response('\x1b]11;rgb:f/f/f\x1b\\')).toEqual({ r: 1, g: 1, b: 1 });
  });

  test('rejects garbage and unrelated sequences', () => {
    expect(parseOsc11Response('')).toBeNull();
    expect(parseOsc11Response('\x1b]10;rgb:ffff/ffff/ffff\x1b\\')).toBeNull();
    expect(parseOsc11Response('\x1b]11;rgb:zz/zz/zz\x1b\\')).toBeNull();
    expect(parseOsc11Response('rgb:ffff/ffff')).toBeNull();
  });

  test('finds the response inside surrounding chatter', () => {
    expect(parseOsc11Response('noise\x1b]11;rgb:0000/0000/0000\x1b\\more')).toEqual({
      r: 0,
      g: 0,
      b: 0,
    });
  });
});

describe('isLightBackground', () => {
  test('black is dark, white is light', () => {
    expect(isLightBackground({ r: 0, g: 0, b: 0 })).toBe(false);
    expect(isLightBackground({ r: 1, g: 1, b: 1 })).toBe(true);
  });

  test('mid grays split at one half', () => {
    expect(isLightBackground({ r: 0.4, g: 0.4, b: 0.4 })).toBe(false);
    expect(isLightBackground({ r: 0.6, g: 0.6, b: 0.6 })).toBe(true);
  });
});

describe('resolveThemeMode', () => {
  test('explicit settings win over the probe', () => {
    expect(resolveThemeMode('light', 'dark')).toBe('light');
    expect(resolveThemeMode('light', null)).toBe('light');
    expect(resolveThemeMode('dark', 'light')).toBe('dark');
    expect(resolveThemeMode('dark', null)).toBe('dark');
  });

  test('auto follows the probe, defaulting to dark', () => {
    expect(resolveThemeMode('auto', 'light')).toBe('light');
    expect(resolveThemeMode('auto', 'dark')).toBe('dark');
    expect(resolveThemeMode('auto', null)).toBe('dark');
  });
});

describe('detectReducedMotion', () => {
  test('off by default', () => {
    expect(detectReducedMotion({})).toBe(false);
  });

  test('SPYCORE_REDUCED_MOTION=1 enables it', () => {
    expect(detectReducedMotion({ SPYCORE_REDUCED_MOTION: '1' })).toBe(true);
    expect(detectReducedMotion({ SPYCORE_REDUCED_MOTION: 'true' })).toBe(true);
    expect(detectReducedMotion({ SPYCORE_REDUCED_MOTION: '0' })).toBe(false);
  });
});
