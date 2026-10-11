import { describe, expect, test } from 'vitest';
import { join } from 'node:path';
import {
  DELTA_MAX_BYTES,
  DELTA_MAX_FILE_BYTES,
  DELTA_MAX_FILES,
  pauseNotice,
  relDisplay,
  uncapturedNotice,
} from '../src/lib/agent/workspace-delta.js';

describe('delta budgets', () => {
  test('the caps are the documented values', () => {
    expect(DELTA_MAX_FILES).toBe(20_000);
    expect(DELTA_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(DELTA_MAX_FILE_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('pauseNotice', () => {
  test('no rebased files → null', () => {
    expect(pauseNotice([])).toBeNull();
  });

  test('singular grammar', () => {
    expect(pauseNotice(['a.txt'])).toBe(
      "1 file changed while this call was waiting for approval and was left out of the run's journal: a.txt",
    );
  });

  test('plural grammar with a +N more suffix past three files', () => {
    const notice = pauseNotice(['a', 'b', 'c', 'd', 'e'])!;
    expect(notice).toContain('5 files changed');
    expect(notice).toContain('were left out');
    expect(notice).toContain('a, b, c (+2 more)');
  });

  test('three or fewer files are all named', () => {
    expect(pauseNotice(['a', 'b', 'c'])!).toContain('a, b, c');
    expect(pauseNotice(['a', 'b', 'c'])!).not.toContain('more');
  });
});

describe('uncapturedNotice', () => {
  test('no uncaptured files → null', () => {
    expect(uncapturedNotice([])).toBeNull();
  });

  test('singular grammar', () => {
    expect(uncapturedNotice(['.env'])!).toContain(
      '1 changed file could not be journaled and `spycore rewind` will not restore it: .env',
    );
  });

  test('plural with +N more', () => {
    const notice = uncapturedNotice(['a', 'b', 'c', 'd'])!;
    expect(notice).toContain('4 changed files could not be journaled');
    expect(notice).toContain('will not restore them: a, b, c (+1 more)');
  });
});

describe('relDisplay', () => {
  test('paths inside the root render relative', () => {
    expect(relDisplay('/ws', join('/ws', 'a', 'b.txt'))).toBe(join('a', 'b.txt'));
  });

  test('paths at or outside the root render absolute', () => {
    expect(relDisplay('/ws', '/ws')).toBe('/ws');
    expect(relDisplay('/ws', '/elsewhere/x.txt')).toBe('/elsewhere/x.txt');
  });
});
