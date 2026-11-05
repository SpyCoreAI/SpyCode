import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanRepo } from '../src/lib/repo-scan.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'spycli-reposcan-'));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const fp = (name: string): string => join(workDir, name);
const pkg = (obj: unknown): void => writeFileSync(fp('package.json'), JSON.stringify(obj));

describe('repo-scan package.json facts', () => {
  test('non-string name, bin forms, exports forms, main, malformed', async () => {
    pkg({ name: 123, main: './index.js', bin: './cli.js', exports: './index.js' });
    let scan = await scanRepo(workDir);
    expect(scan.pkg).toMatchObject({ name: undefined, main: './index.js', bin: ['(default)'], exports: ['.'] });

    pkg({ name: 'demo', bin: { a: './a.js', b: './b.js' }, exports: { '.': './i.js', './x': './x.js' } });
    scan = await scanRepo(workDir);
    expect(scan.pkg).toMatchObject({ name: 'demo', bin: ['a', 'b'], exports: ['.', './x'] });

    writeFileSync(fp('package.json'), '{not json');
    scan = await scanRepo(workDir);
    expect(scan.pkg).toBeUndefined();
  });
});

describe('repo-scan README summary', () => {
  test('badges, HTML wrappers, paragraph breaks, empty, and the cap', async () => {
    writeFileSync(fp('README.md'), '# Title\n\n![badge](https://x.example/b.svg)\n\n<div>\n</div>\n\nFirst para line one.\nSecond line.\n\nSecond paragraph here.\n');
    let scan = await scanRepo(workDir);
    expect(scan.readmeSummary).toBe('First para line one. Second line.');

    writeFileSync(fp('README.md'), '# Only a title\n\n## Section\n');
    scan = await scanRepo(workDir);
    expect(scan.readmeSummary).toBeUndefined();

    writeFileSync(fp('README.md'), `Intro.\n\n${'y'.repeat(600)}\n`);
    scan = await scanRepo(workDir);
    expect(scan.readmeSummary).toBe('Intro.');

    writeFileSync(fp('README.md'), `${'z'.repeat(600)}\n`);
    scan = await scanRepo(workDir);
    expect(scan.readmeSummary!.length).toBeLessThanOrEqual(501);
    expect(scan.readmeSummary!.endsWith('…')).toBe(true);
  });

  test('an unreadable README degrades to undefined', async () => {
    mkdirSync(fp('README.md'));
    const scan = await scanRepo(workDir);
    expect(scan.readmeSummary).toBeUndefined();
  });
});

describe('repo-scan directory walk', () => {
  test('gitignored top-level files are skipped', async () => {
    // NOTE: isGitIgnoredSync only matches a directory path WITH a trailing
    // slash, and scanRepo checks bare dir names, so gitignored DIRECTORIES
    // still appear in topDirs (their files are skipped from the walk). The
    // ignore arm itself is covered here via a gitignored file.
    writeFileSync(fp('.gitignore'), 'ignored.txt\n');
    writeFileSync(fp('ignored.txt'), 'x');
    writeFileSync(fp('kept.txt'), 'y');
    const scan = await scanRepo(workDir);
    expect(scan.topFiles).toContain('kept.txt');
    expect(scan.topFiles).not.toContain('ignored.txt');
  });

  test('a fully unreadable directory degrades to an empty scan', async () => {
    const scan = await scanRepo(join(workDir, 'does-not-exist'));
    expect(scan.topDirs).toEqual([]);
    expect(scan.topFiles).toEqual([]);
    expect(scan.fileCount).toBe(0);
  });
});
