import { describe, expect, test } from 'vitest';
import { clip, clipOneLine, isObject, shortId } from '../src/lib/text.js';

describe('isObject', () => {
  test('plain objects are objects', () => {
    expect(isObject({})).toBe(true);
    expect(isObject({ a: 1 })).toBe(true);
    expect(isObject(Object.create(null))).toBe(true);
  });

  test('arrays are not objects', () => {
    expect(isObject([])).toBe(false);
    expect(isObject([1, 2])).toBe(false);
  });

  test('null and primitives are not objects', () => {
    expect(isObject(null)).toBe(false);
    expect(isObject(undefined)).toBe(false);
    expect(isObject('x')).toBe(false);
    expect(isObject(42)).toBe(false);
    expect(isObject(true)).toBe(false);
  });

  test('narrows the type for property access', () => {
    const v: unknown = { a: 1 };
    if (isObject(v)) {
      expect(v.a).toBe(1);
    } else {
      throw new Error('should have narrowed');
    }
  });
});

describe('shortId', () => {
  test('short ids pass through unchanged', () => {
    expect(shortId('abc')).toBe('abc');
    expect(shortId('')).toBe('');
    expect(shortId('12345678901234')).toBe('12345678901234'); // exactly 14
  });

  test('long ids are shortened to 12 chars + ellipsis', () => {
    expect(shortId('123456789012345')).toBe('123456789012…');
    expect(shortId('session-9f8e7d6c5b4a')).toBe('session-9f8e…');
  });
});

describe('clip', () => {
  test('strings at or under the max pass through untouched', () => {
    expect(clip('hello', 5)).toBe('hello');
    expect(clip('hello', 10)).toBe('hello');
    expect(clip('', 3)).toBe('');
  });

  test('long strings are cut to max-1 chars plus an ellipsis', () => {
    expect(clip('hello world', 6)).toBe('hello…');
    expect(clip('abcdef', 1)).toBe('…');
    expect(clip('abcdef', 2)).toBe('a…');
  });

  test('whitespace is NOT collapsed or trimmed', () => {
    expect(clip('  a\nb  ', 20)).toBe('  a\nb  ');
    expect(clip('a  b', 3)).toBe('a …');
  });

  test('max of 0 yields only the ellipsis for non-empty input', () => {
    expect(clip('x', 0)).toBe('…');
    expect(clip('', 0)).toBe('');
  });
});

describe('clipOneLine', () => {
  test('collapses all whitespace runs to single spaces and trims', () => {
    expect(clipOneLine('  a\n\tb   c  ', 50)).toBe('a b c');
    expect(clipOneLine('line1\nline2\r\nline3', 50)).toBe('line1 line2 line3');
  });

  test('short input passes through flattened', () => {
    expect(clipOneLine('hello', 10)).toBe('hello');
    expect(clipOneLine('', 5)).toBe('');
  });

  test('long input is flattened first, then clipped like clip()', () => {
    expect(clipOneLine('a b c d e', 7)).toBe('a b c …');
    expect(clipOneLine('word1\nword2', 9)).toBe('word1 wo…');
  });
});
