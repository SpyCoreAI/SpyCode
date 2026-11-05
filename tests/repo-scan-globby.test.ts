import { describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Fault injection: globby's exports throw when called, so both the ignore
// setup and the file walk fail and scanRepo takes its fail-closed paths.
vi.mock('globby', () => ({
  isGitIgnoredSync: () => {
    throw new Error('globby unavailable');
  },
  globby: () => {
    throw new Error('globby unavailable');
  },
}));

import { scanRepo } from '../src/lib/repo-scan.js';

describe('repo-scan without globby', () => {
  test('the scan degrades to an empty result instead of throwing', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'spycli-reposcan-mock-'));
    try {
      writeFileSync(join(workDir, 'a.txt'), 'a');
      const scan = await scanRepo(workDir);
      // The top-level listing is a readdir walk (unaffected); the globby
      // walk that feeds the sample, languages, and count degrades to empty.
      expect(scan.topFiles).toEqual(['a.txt']);
      expect(scan.fileCount).toBe(0);
      expect(scan.languages).toEqual([]);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
