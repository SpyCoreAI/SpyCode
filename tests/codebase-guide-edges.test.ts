import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  generateCodebaseGuide,
  guideStatus,
  readGuideForContext,
  refreshCodebaseGuide,
} from '../src/lib/codebase-guide.js';
import type { RepoScan } from '../src/lib/repo-scan.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'spycli-guide-'));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const fp = (name: string): string => join(workDir, name);
const baseScan = (over: Partial<RepoScan> = {}): RepoScan => ({
  cwd: workDir,
  topDirs: [],
  topFiles: [],
  languages: [],
  fileCount: 0,
  sampled: false,
  keyFiles: [],
  ...over,
});

describe('generateCodebaseGuide rows', () => {
  test('script tail, runtime none, entryFiles absent, sampled suffix', () => {
    const scripts: Record<string, string> = {};
    for (let i = 0; i < 14; i += 1) scripts[`custom${i}`] = `echo ${i}`;
    const guide = generateCodebaseGuide(
      baseScan({
        pkg: {
          name: 'demo',
          scripts: Object.keys(scripts),
          dependencies: [],
          devDependencies: ['vitest'],
        },
        sampled: true,
      }),
    );
    expect(guide).toContain(', +2 more');
    expect(guide).toContain('**Runtime (0):** _none_');
    expect(guide).toContain('**Dev (1):** `vitest`');
    expect(guide).toContain('(language detection sampled the first portion)');
    expect(guide).toContain('_No entry points found');
  });

  test('data-flow observations per directory shape', () => {
    const guide = generateCodebaseGuide(
      baseScan({
        topDirs: ['server/', 'client/', 'api/', 'services/', 'prisma/'],
      }),
    );
    expect(guide).toContain('Split client/server');
    expect(guide).toContain('An API/route layer is present');
    expect(guide).toContain('A `services/` layer suggests');
    expect(guide).toContain('A data layer is present');

    const serverOnly = generateCodebaseGuide(baseScan({ topDirs: ['server/'] }));
    expect(serverOnly).toContain('A `server/` directory holds the backend');
    const clientOnly = generateCodebaseGuide(baseScan({ topDirs: ['client/'] }));
    expect(clientOnly).toContain('A `client/` directory holds the frontend.');
  });
});

describe('guide file helpers', () => {
  test('guideStatus counts zero for an empty file and tolerates a directory', () => {
    writeFileSync(fp('CODEBASE_GUIDE.md'), '');
    expect(guideStatus(workDir)).toMatchObject({ exists: true, lines: 0 });
    rmSync(fp('CODEBASE_GUIDE.md'));
    mkdirSync(fp('CODEBASE_GUIDE.md'));
    expect(guideStatus(workDir)).toMatchObject({ exists: true, lines: 0 });
  });

  test('readGuideForContext tolerates a directory and truncates on maxChars', () => {
    mkdirSync(fp('CODEBASE_GUIDE.md'));
    const unreadable = readGuideForContext(workDir);
    expect(unreadable).toMatchObject({ exists: true, text: '', truncated: false });
    rmSync(fp('CODEBASE_GUIDE.md'), { recursive: true });
    writeFileSync(fp('CODEBASE_GUIDE.md'), `# Guide\n\n${'x'.repeat(500)}\n`);
    const capped = readGuideForContext(workDir, { maxChars: 100 });
    expect(capped.truncated).toBe(true);
    expect(capped.text).toContain('truncated to fit');
    expect(capped.text.length).toBeLessThanOrEqual(100 + 40);
  });

  test('refresh with an unreadable old guide regenerates (and then fails the write)', async () => {
    mkdirSync(fp('CODEBASE_GUIDE.md'));
    await expect(refreshCodebaseGuide(workDir)).rejects.toThrow();
  });
});
