import { describe, expect, test } from 'vitest';
import { gradient, hexToRgb, lerp, lerpHex, rgbToHex } from '../src/ui/lib/gradient.js';

describe('hexToRgb', () => {
  test('parses 6-digit hex', () => {
    expect(hexToRgb('#ff0000')).toEqual([255, 0, 0]);
    expect(hexToRgb('#00ff00')).toEqual([0, 255, 0]);
    expect(hexToRgb('#0000ff')).toEqual([0, 0, 255]);
    expect(hexToRgb('#1a2b3c')).toEqual([0x1a, 0x2b, 0x3c]);
  });

  test('parses 3-digit shorthand', () => {
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(hexToRgb('#000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#abc')).toEqual([0xaa, 0xbb, 0xcc]);
  });
});

describe('rgbToHex', () => {
  test('round-trips through hexToRgb', () => {
    expect(rgbToHex(hexToRgb('#1a2b3c'))).toBe('#1a2b3c');
  });

  test('clamps and rounds out-of-range components', () => {
    expect(rgbToHex([255.6, -1, 128])).toBe('#ff0080');
    expect(rgbToHex([300, 0, 0])).toBe('#ff0000');
  });
});

describe('lerp', () => {
  test('endpoints and midpoint', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
    expect(lerp(10, 0, 0.25)).toBe(7.5);
  });
});

describe('lerpHex', () => {
  test('endpoints and midpoint', () => {
    expect(lerpHex('#000000', '#ffffff', 0)).toBe('#000000');
    expect(lerpHex('#000000', '#ffffff', 1)).toBe('#ffffff');
    expect(lerpHex('#000000', '#ffffff', 0.5)).toBe('#808080');
  });

  test('t is clamped to [0, 1]', () => {
    expect(lerpHex('#123456', '#abcdef', -2)).toBe('#123456');
    expect(lerpHex('#123456', '#abcdef', 99)).toBe('#abcdef');
  });
});

describe('gradient', () => {
  test('two stops, three steps', () => {
    expect(gradient(['#000000', '#ffffff'], 3)).toEqual(['#000000', '#808080', '#ffffff']);
  });

  test('n <= 0 yields an empty array', () => {
    expect(gradient(['#000', '#fff'], 0)).toEqual([]);
    expect(gradient(['#000', '#fff'], -3)).toEqual([]);
  });

  test('n == 1 yields just the first stop', () => {
    expect(gradient(['#123456', '#ffffff'], 1)).toEqual(['#123456']);
  });

  test('a single stop repeats it', () => {
    expect(gradient(['#abc'], 4)).toEqual(['#abc', '#abc', '#abc', '#abc']);
  });

  test('three stops interpolate piecewise', () => {
    const out = gradient(['#000000', '#ff0000', '#ffffff'], 5);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('#000000');
    expect(out[2]).toBe('#ff0000'); // exact middle lands on the middle stop
    expect(out[4]).toBe('#ffffff');
  });

  test('first and last are always the stops', () => {
    const out = gradient(['#102030', '#405060', '#708090'], 9);
    expect(out[0]).toBe('#102030');
    expect(out[out.length - 1]).toBe('#708090');
  });
});
