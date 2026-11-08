import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LIMITS,
  dispatchTool,
  type ToolContext,
} from '../src/lib/agent/tools.js';

/**
 * H3 - `grep` with a `/g` regex skipped every second match: `compileRegex`
 * accepted the `g` flag and the scan reused one regex across lines with
 * `re.test(line)`, so `lastIndex` advanced and matches alternated
 * true/false. A file with N matching lines reported ~N/2.
 */
describe('grep with a /g (or /y) pattern reports every matching line', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-grep-g-'));
    writeFileSync(
      join(workDir, 'app.log'),
      [
        'error: first failure',
        'ok: nothing here',
        'error: second failure',
        'error: third failure',
        'ok: fine',
        'error: fourth failure',
        'error: fifth failure',
      ].join('\n'),
    );
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const ctx = (): ToolContext => ({ cwd: workDir, limits: DEFAULT_LIMITS });

  test('/error/g reports all five matching lines, in order', async () => {
    const r = await dispatchTool('grep', { pattern: '/error/g' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/5 matches in 1 file/);
    for (const n of [1, 3, 4, 6, 7]) {
      expect(r.content).toContain(`app.log:${n}:`);
    }
    expect(r.content).not.toContain('app.log:2:');
    expect(r.content).not.toContain('app.log:5:');
  });

  test('/error/gy reports all five matching lines too', async () => {
    const r = await dispatchTool('grep', { pattern: '/error/gy' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/5 matches in 1 file/);
  });

  test('a bare pattern still reports every matching line (no regression)', async () => {
    const r = await dispatchTool('grep', { pattern: 'error' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/5 matches in 1 file/);
  });

  test('the /i flag still works alongside the stripped flags', async () => {
    const r = await dispatchTool('grep', { pattern: '/ERROR/gi' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/5 matches in 1 file/);
  });
});
