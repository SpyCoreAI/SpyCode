import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordedChange } from '../src/lib/agent/checkpoint.js';
import {
  detectStructuralChange,
  finalizeTaskMemory,
  snapshotStructure,
  summarizeTouchedFiles,
  type StructureSnapshot,
} from '../src/lib/agent/task-memory.js';
import {
  CHANGELOG_FILE,
  generateInitialChangelog,
  parseChangelogEntries,
} from '../src/lib/codebase-changelog.js';
import { GUIDE_FILE } from '../src/lib/codebase-guide.js';

/**
 * Part 3b — write-at-end. The orchestrators call finalizeTaskMemory ONCE per
 * task at their saveSession boundary; here that hook + its helpers are tested in
 * isolation, ALL in throwaway temp dirs — NEVER this repo's root or docs/.
 */

const made: string[] = [];

function tempProject(pkg: Record<string, unknown> = { name: 'fixture' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'spycode-tm-'));
  made.push(dir);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg), 'utf8');
  return dir;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Build a RecordedChange for a path under `dir`. */
function change(dir: string, rel: string, op: 'create' | 'modify'): RecordedChange {
  return { path: join(dir, rel), op, before: op === 'create' ? null : 'old', after: 'new' };
}

function writeFile(dir: string, rel: string, body = 'x'): void {
  const abs = join(dir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

function seedChangelog(dir: string): void {
  writeFileSync(join(dir, CHANGELOG_FILE), generateInitialChangelog('2026-01-01'), 'utf8');
}

function seedGuideWithNote(dir: string): void {
  writeFileSync(
    join(dir, GUIDE_FILE),
    ['# old stale title — Codebase Guide', '', 'stale body', '', '## Notes (manual)', '', '- durable note ABC', ''].join(
      '\n',
    ),
    'utf8',
  );
}

describe('summarizeTouchedFiles', () => {
  test('groups created / modified, and detects deleted via a missing path', () => {
    const dir = tempProject();
    writeFile(dir, 'src/foo.ts');
    writeFile(dir, 'README.md');
    const changes: RecordedChange[] = [
      change(dir, 'src/foo.ts', 'create'),
      change(dir, 'README.md', 'modify'),
      change(dir, 'src/gone.ts', 'create'), // never written → missing → deleted
    ];
    const t = summarizeTouchedFiles(changes, dir);
    expect(t.created).toEqual(['src/foo.ts']);
    expect(t.modified).toEqual(['README.md']);
    expect(t.deleted).toEqual(['src/gone.ts']);
  });

  test('dedups a path; create beats a later modify', () => {
    const dir = tempProject();
    writeFile(dir, 'a.ts');
    const t = summarizeTouchedFiles([change(dir, 'a.ts', 'create'), change(dir, 'a.ts', 'modify')], dir);
    expect(t.created).toEqual(['a.ts']);
    expect(t.modified).toEqual([]);
  });
});

describe('snapshotStructure + detectStructuralChange', () => {
  test('snapshot captures top-level dirs (excluding node_modules) + dep names', () => {
    const dir = tempProject({ name: 'x', dependencies: { b: '1' }, devDependencies: { a: '2' } });
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    const snap = snapshotStructure(dir);
    expect(snap.dirs).toContain('src');
    expect(snap.dirs).not.toContain('node_modules');
    expect(snap.deps).toEqual(['a', 'b']); // sorted union
  });

  test('detects new/removed dirs and dep changes', () => {
    const base: StructureSnapshot = { dirs: ['src'], deps: ['x'] };
    expect(detectStructuralChange(base, { dirs: ['src', 'pkg'], deps: ['x'] }).newDirs).toEqual(['pkg']);
    expect(detectStructuralChange({ dirs: ['src', 'pkg'], deps: ['x'] }, base).removedDirs).toEqual(['pkg']);
    expect(detectStructuralChange(base, { dirs: ['src'], deps: ['x', 'y'] }).depsChanged).toBe(true);
    expect(detectStructuralChange(base, { dirs: ['src'], deps: ['x'] }).changed).toBe(false);
  });
});

describe('finalizeTaskMemory — append', () => {
  test('appends exactly ONE newest-first entry with grouped files + summary', async () => {
    const dir = tempProject();
    seedChangelog(dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFile(dir, 'src/foo.ts');
    writeFile(dir, 'README.md');
    const before = snapshotStructure(dir); // src already exists → no structural change

    const res = await finalizeTaskMemory({
      cwd: dir,
      task: 'Add a foo helper and update the readme',
      changes: [change(dir, 'src/foo.ts', 'create'), change(dir, 'README.md', 'modify')],
      before,
      stamp: '2026-05-05 12:00 UTC',
    });

    expect(res.appended).toBe(true);
    expect(res.structuralNote).toBeNull();
    const content = readFileSync(join(dir, CHANGELOG_FILE), 'utf8');
    const { entries } = parseChangelogEntries(content);
    expect(entries).toHaveLength(2); // exactly one new entry + the seed (idempotent)
    expect(entries[0]!.heading).toContain('Add a foo helper and update the readme');
    expect(entries[0]!.body).toContain('- `src/foo.ts`');
    expect(entries[0]!.body).toContain('- `README.md`');
    expect(entries[0]!.body).toContain('1 created, 1 modified.');
    // The seed entry is preserved, below the new one.
    expect(content.indexOf('Add a foo helper')).toBeLessThan(content.indexOf('Initialized project memory.'));
  });

  test('SKIPS appending when zero files were touched (no Q&A noise)', async () => {
    const dir = tempProject();
    seedChangelog(dir);
    const res = await finalizeTaskMemory({ cwd: dir, task: 'just a question', changes: [], before: snapshotStructure(dir) });
    expect(res.appended).toBe(false);
    expect(parseChangelogEntries(readFileSync(join(dir, CHANGELOG_FILE), 'utf8')).entries).toHaveLength(1);
  });

  test('SKIPS (and never creates the file) when CODEBASE_CHANGELOG.md is absent', async () => {
    const dir = tempProject();
    writeFile(dir, 'a.ts');
    const res = await finalizeTaskMemory({
      cwd: dir,
      task: 'touch a file',
      changes: [change(dir, 'a.ts', 'create')],
      before: snapshotStructure(dir),
    });
    expect(res.appended).toBe(false);
    expect(existsSync(join(dir, CHANGELOG_FILE))).toBe(false);
  });

  test('respects autoChangelog=false', async () => {
    const dir = tempProject();
    seedChangelog(dir);
    writeFile(dir, 'a.ts');
    const res = await finalizeTaskMemory({
      cwd: dir,
      task: 'touch a file',
      changes: [change(dir, 'a.ts', 'create')],
      before: snapshotStructure(dir),
      autoChangelog: false,
    });
    expect(res.appended).toBe(false);
    expect(parseChangelogEntries(readFileSync(join(dir, CHANGELOG_FILE), 'utf8')).entries).toHaveLength(1);
  });

  test('each call is independent — two tasks produce two newest-first entries', async () => {
    const dir = tempProject();
    seedChangelog(dir);
    writeFile(dir, 'a.ts');
    writeFile(dir, 'b.ts');
    await finalizeTaskMemory({ cwd: dir, task: 'task ALPHA', changes: [change(dir, 'a.ts', 'create')], before: snapshotStructure(dir), stamp: '2026-05-05 10:00 UTC' });
    await finalizeTaskMemory({ cwd: dir, task: 'task BETA', changes: [change(dir, 'b.ts', 'create')], before: snapshotStructure(dir), stamp: '2026-05-05 11:00 UTC' });
    const content = readFileSync(join(dir, CHANGELOG_FILE), 'utf8');
    expect(parseChangelogEntries(content).entries).toHaveLength(3); // seed + 2
    expect(content.indexOf('task BETA')).toBeLessThan(content.indexOf('task ALPHA')); // newest first
  });
});

describe('finalizeTaskMemory — structural change + guide refresh', () => {
  test('new top-level dir adds a note AND refreshes the guide, preserving manual notes', async () => {
    const dir = tempProject();
    seedChangelog(dir);
    seedGuideWithNote(dir);
    const before = snapshotStructure(dir); // no subdirs yet
    mkdirSync(join(dir, 'newpkg'), { recursive: true });
    writeFile(dir, 'newpkg/index.ts');

    const res = await finalizeTaskMemory({
      cwd: dir,
      task: 'scaffold newpkg',
      changes: [change(dir, 'newpkg/index.ts', 'create')],
      before,
      stamp: '2026-05-05 12:00 UTC',
      autoRefreshGuide: true,
    });

    expect(res.appended).toBe(true);
    expect(res.guideRefreshed).toBe(true);
    expect(res.structuralNote).toContain('new dir `newpkg/`');

    const entry = parseChangelogEntries(readFileSync(join(dir, CHANGELOG_FILE), 'utf8')).entries[0]!;
    expect(entry.body).toContain('new dir `newpkg/`');
    expect(entry.body).toContain('Refreshed CODEBASE_GUIDE.md');

    const guide = readFileSync(join(dir, GUIDE_FILE), 'utf8');
    expect(guide).toContain('Generated by SpyCore'); // regenerated…
    expect(guide).not.toContain('old stale title'); // …old body gone…
    expect(guide).toContain('- durable note ABC'); // …manual notes survive
  });

  test('autoRefreshGuide=false is note-only — the guide is left untouched', async () => {
    const dir = tempProject();
    seedChangelog(dir);
    seedGuideWithNote(dir);
    const before = snapshotStructure(dir);
    mkdirSync(join(dir, 'newpkg'), { recursive: true });
    writeFile(dir, 'newpkg/index.ts');

    const res = await finalizeTaskMemory({
      cwd: dir,
      task: 'scaffold newpkg',
      changes: [change(dir, 'newpkg/index.ts', 'create')],
      before,
      stamp: '2026-05-05 12:00 UTC',
      autoRefreshGuide: false,
    });

    expect(res.appended).toBe(true);
    expect(res.guideRefreshed).toBe(false);
    const entry = parseChangelogEntries(readFileSync(join(dir, CHANGELOG_FILE), 'utf8')).entries[0]!;
    expect(entry.body).toContain('new dir `newpkg/`'); // structural note still recorded
    expect(entry.body).not.toContain('Refreshed CODEBASE_GUIDE.md');
    // Guide untouched.
    expect(readFileSync(join(dir, GUIDE_FILE), 'utf8')).toContain('old stale title');
  });

  test('a package.json dependency change is noted', async () => {
    const dir = tempProject({ name: 'x', dependencies: { a: '1' } });
    seedChangelog(dir);
    const before = snapshotStructure(dir); // deps: ['a']
    // Simulate the agent adding a dependency (e.g. via run_command) + editing pkg.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dependencies: { a: '1', b: '2' } }), 'utf8');

    const res = await finalizeTaskMemory({
      cwd: dir,
      task: 'add dep b',
      changes: [change(dir, 'package.json', 'modify')],
      before,
      stamp: '2026-05-05 12:00 UTC',
      autoRefreshGuide: false,
    });
    expect(res.structuralNote).toContain('package.json dependencies changed');
  });
});

describe('finalizeTaskMemory — failure isolation', () => {
  test('a write error never propagates (CODEBASE_CHANGELOG.md is a directory)', async () => {
    const dir = tempProject();
    mkdirSync(join(dir, CHANGELOG_FILE), { recursive: true }); // not a file → read/write fails
    writeFile(dir, 'a.ts');
    // Must resolve, not throw.
    const res = await finalizeTaskMemory({
      cwd: dir,
      task: 'touch a file',
      changes: [change(dir, 'a.ts', 'create')],
      before: snapshotStructure(dir),
    });
    expect(res.appended).toBe(false);
  });
});
