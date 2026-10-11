import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitWithMessageFile,
  currentBranch,
  hasAnyChanges,
  hasStagedChanges,
  isDetachedHead,
  isGitRepo,
  mergeInProgress,
  recentSubjects,
  runGit,
  shortStatus,
  stageAll,
  stagedDiff,
  stagedStat,
  workingDiff,
} from '../src/lib/git.js';

const GIT_ENV = {
  'GIT_AUTHOR_NAME': 'Test',
  'GIT_AUTHOR_EMAIL': 'test@example.com',
  'GIT_COMMITTER_NAME': 'Test',
  'GIT_COMMITTER_EMAIL': 'test@example.com',
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spy-git-'));
  Object.assign(process.env, GIT_ENV);
  const r = runGit(dir, ['init', '-b', 'main']);
  expect(r.ok).toBe(true);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(GIT_ENV)) delete process.env[k];
});

function commitFile(name: string, content: string, message: string): string {
  writeFileSync(join(dir, name), content);
  expect(stageAll(dir).ok).toBe(true);
  const r = commitWithMessageFile(dir, message);
  expect(r.ok).toBe(true);
  return r.hash;
}

describe('runGit', () => {
  test('never throws - failures come back ok:false', () => {
    const r = runGit(dir, ['this-command-does-not-exist']);
    expect(r.ok).toBe(false);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test('captures stdout on success', () => {
    const r = runGit(dir, ['rev-parse', '--is-inside-work-tree']);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim()).toBe('true');
  });
});

describe('repo detection', () => {
  test('isGitRepo: false outside a repo, true inside', () => {
    expect(isGitRepo(tmpdir())).toBe(false);
    expect(isGitRepo(dir)).toBe(true);
  });
});

describe('branch / HEAD state', () => {
  test('currentBranch names the checked-out branch', () => {
    commitFile('a.txt', 'a', 'first');
    expect(currentBranch(dir)).toBe('main');
  });

  test('currentBranch is null outside a repo', () => {
    expect(currentBranch(tmpdir())).toBeNull();
  });

  test('isDetachedHead: false on a branch, true on a raw sha', () => {
    commitFile('a.txt', 'a', 'first');
    expect(isDetachedHead(dir)).toBe(false);
    const head = runGit(dir, ['rev-parse', 'HEAD']).stdout.trim();
    expect(runGit(dir, ['checkout', '--detach', head]).ok).toBe(true);
    expect(isDetachedHead(dir)).toBe(true);
    expect(currentBranch(dir)).toBeNull();
  });

  test('mergeInProgress: false normally', () => {
    commitFile('a.txt', 'a', 'first');
    expect(mergeInProgress(dir)).toBe(false);
  });
});

describe('change detection', () => {
  test('clean tree → no changes', () => {
    commitFile('a.txt', 'a', 'first');
    expect(hasAnyChanges(dir)).toBe(false);
    expect(hasStagedChanges(dir)).toBe(false);
    expect(shortStatus(dir)).toBe('');
  });

  test('untracked file → any-changes only', () => {
    commitFile('a.txt', 'a', 'first');
    writeFileSync(join(dir, 'new.txt'), 'new');
    expect(hasAnyChanges(dir)).toBe(true);
    expect(hasStagedChanges(dir)).toBe(false);
    expect(shortStatus(dir)).toContain('new.txt');
  });

  test('staged file → staged-changes, shows in stat/diff', () => {
    commitFile('a.txt', 'a', 'first');
    writeFileSync(join(dir, 'a.txt'), 'changed');
    expect(runGit(dir, ['add', 'a.txt']).ok).toBe(true);
    expect(hasStagedChanges(dir)).toBe(true);
    expect(stagedStat(dir)).toContain('a.txt');
    expect(stagedDiff(dir)).toContain('changed');
  });

  test('stageAll stages everything and workingDiff shows unstaged vs HEAD', () => {
    commitFile('a.txt', 'a', 'first');
    writeFileSync(join(dir, 'a.txt'), 'changed');
    expect(stageAll(dir).ok).toBe(true);
    expect(workingDiff(dir)).toContain('changed');
  });
});

describe('history', () => {
  test('recentSubjects lists newest-first subjects', () => {
    commitFile('a.txt', 'a', 'one');
    commitFile('b.txt', 'b', 'two');
    const out = recentSubjects(dir, 5);
    const lines = out.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('two');
    expect(lines[1]).toContain('one');
  });

  test('recentSubjects on an empty repo returns empty string', () => {
    expect(recentSubjects(dir, 5)).toBe('');
  });
});

describe('commitWithMessageFile', () => {
  test('commits and returns the short hash', () => {
    const hash = commitFile('a.txt', 'a', 'hello world');
    expect(hash).toMatch(/^[0-9a-f]{7,}$/);
    expect(runGit(dir, ['log', '--format=%s', '-1']).stdout.trim()).toBe('hello world');
  });

  test('commit of nothing staged fails cleanly', () => {
    const r = commitWithMessageFile(dir, 'empty');
    expect(r.ok).toBe(false);
    expect(r.hash).toBe('');
    // git reports "nothing to commit" on stdout, not stderr
    const combined = runGit(dir, ['status', '--porcelain']);
    expect(combined.ok).toBe(true);
    expect(r.stderr).toBe('');
  });
});
