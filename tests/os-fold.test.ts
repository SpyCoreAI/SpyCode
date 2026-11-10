import { describe, expect, test } from 'vitest';
import { osFold } from '../src/lib/os-fold.js';

describe('osFold', () => {
  test('folds ASCII case', () => {
    expect(osFold('ABC')).toBe('abc');
    expect(osFold('Id_RsA')).toBe('id_rsa');
    expect(osFold('already lower')).toBe('already lower');
  });

  test('folds the filesystem spellings plain toLowerCase misses', () => {
    expect(osFold('ß')).toBe('ss'); // sharp s
    expect(osFold('ẞ')).toBe('ss'); // capital sharp s
    expect(osFold('ſ')).toBe('s'); // long s
    expect(osFold('ﬀ')).toBe('ff'); // ligatures
    expect(osFold('ﬁ')).toBe('fi');
    expect(osFold('ﬂ')).toBe('fl');
    expect(osFold('ﬃ')).toBe('ffi');
    expect(osFold('ﬄ')).toBe('ffl');
    expect(osFold('ﬅ')).toBe('st');
    expect(osFold('ﬆ')).toBe('st');
    expect(osFold('K')).toBe('k'); // Kelvin sign
  });

  test('holds the dotless i out of the fold', () => {
    // U+0131 folds to itself on the filesystem; JS would map it to ASCII 'i'.
    expect(osFold('ı')).toBe('ı');
    expect(osFold('ıd_rsa')).toBe('ıd_rsa');
  });

  test('applies the fold around the dotless i holdout', () => {
    expect(osFold('AıB')).toBe('aıb');
    expect(osFold('Straße')).toBe('strasse');
  });

  test('is a pure string transform', () => {
    expect(osFold('')).toBe('');
    expect(osFold('.env.local')).toBe('.env.local');
    expect(osFold('CREDENTIALS.JSON')).toBe('credentials.json');
  });
});
