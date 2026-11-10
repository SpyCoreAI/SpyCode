/**
 * P6-6 - the grep tool had no ReDoS protection: `(a+)+$` (6 chars) against
 * a 31-char line did not finish in 10s, and the loop tests synchronously
 * per line with the abort signal checked only per file. Nested-quantifier
 * patterns are refused up front; legitimate patterns still match.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasNestedQuantifier } from '../src/lib/agent/builtin-tools.js';
import { DEFAULT_LIMITS, dispatchTool, type ToolContext } from '../src/lib/agent/tools.js';

describe('hasNestedQuantifier', () => {
  test.each([
    '(a+)+',
    '(a+)+$',
    '(a*)*',
    '((a+))+',
    'a++',
    '(a+)?',
    '(\\d+)+',
    'x(a|b+)+',
    '([a-z]+)+',
    '(?:a+)+',
    '(a+){2,3}',
  ])('rejects %s', (pattern) => {
    expect(hasNestedQuantifier(pattern)).toBe(true);
  });

  test.each([
    'error',
    '(abc)+',
    '(\\d+)-(\\d+)',
    'a+?',
    'a*?',
    'a??',
    'a{1,3}?',
    '[a+]+',
    '(a|b)+',
    '(?:abc)+',
    '(?=a+)b',
    'a{2,3}',
    'foo|bar',
    '\\(a+\\)',
    '(a+)|(b+)',
  ])('accepts %s', (pattern) => {
    expect(hasNestedQuantifier(pattern)).toBe(false);
  });
});

describe('grep refuses a catastrophic pattern instead of hanging', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-grep-redos-'));
    writeFileSync(join(workDir, 'line.txt'), `${'a'.repeat(30)}b\n`);
    writeFileSync(join(workDir, 'plain.txt'), 'error: boom\nok\n');
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({ cwd: workDir, limits: DEFAULT_LIMITS });

  test('the P6-6 repro pattern (a+)+$ is refused fast', async () => {
    const r = await dispatchTool('grep', { pattern: '(a+)+$' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/nested quantifier/);
  }, 10_000);

  test('a legitimate pattern still matches', async () => {
    const r = await dispatchTool('grep', { pattern: 'error' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/1 match in 1 file/);
  });
});
