import { describe, expect, test } from 'vitest';
import { Readable } from 'node:stream';
import { readMultilineInput } from '../src/lib/prompt.js';

/**
 * readMultilineInput (4c): the doc comment promises "two empty lines in
 * a row = send", but the code used to finish on the FIRST empty line
 * after content. stdin is swapped for a scripted stream per test.
 */
function feedStdin(lines: string[]): { restore: () => void } {
  const mockStdin = Readable.from(lines.map((l) => `${l}\n`));
  const origStdin = process.stdin;
  Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });
  return {
    restore: () => {
      Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
    },
  };
}

describe('readMultilineInput two-blank-lines rule', () => {
  test('a single blank line is a paragraph break, not "send"', async () => {
    const { restore } = feedStdin(['first', '', 'second', '', '']);
    try {
      const text = await readMultilineInput({ prompt: '> ' });
      expect(text).toBe('first\n\nsecond');
    } finally {
      restore();
    }
  });

  test('two blank lines in a row finish, even with no content after', async () => {
    const { restore } = feedStdin(['only line', '', '']);
    try {
      const text = await readMultilineInput({ prompt: '> ' });
      expect(text).toBe('only line');
    } finally {
      restore();
    }
  });

  test('EOF finishes without trailing blanks', async () => {
    const { restore } = feedStdin(['a', '', 'b']);
    try {
      const text = await readMultilineInput({ prompt: '> ' });
      expect(text).toBe('a\n\nb');
    } finally {
      restore();
    }
  });
});
