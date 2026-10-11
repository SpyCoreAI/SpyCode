import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGit } from '../src/lib/git.js';
import {
  runCommitFlow,
  type CommitFlowIo,
  type CommitFlowResult,
} from '../src/lib/slash/commit-flow.js';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

function io(): { io: CommitFlowIo; notices: [string, string][]; answers: string[] } {
  const notices: [string, string][] = [];
  const answers: string[] = [];
  return {
    io: {
      notify: (kind, text) => {
        notices.push([kind, text]);
      },
      present: () => {},
      ask: async () => answers.shift() ?? 'n',
      readText: async () => '',
    },
    notices,
    answers,
  };
}

let dir: string;

beforeEach(() => {
  Object.assign(process.env, GIT_ENV);
  dir = mkdtempSync(join(tmpdir(), 'spy-commitflow-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of Object.keys(GIT_ENV)) delete process.env[k];
});

function initRepo(): void {
  expect(runGit(dir, ['init', '-b', 'main']).ok).toBe(true);
  writeFileSync(join(dir, 'a.txt'), 'a');
  expect(runGit(dir, ['add', '-A']).ok).toBe(true);
  expect(runGit(dir, ['commit', '-m', 'init']).ok).toBe(true);
}

describe('runCommitFlow guard rails', () => {
  test('outside a git repo: clean error, no writes', async () => {
    const { io: ioObj, notices } = io();
    const out: CommitFlowResult = await runCommitFlow({
      cwd: dir,
      model: 'styx',
      io: ioObj,
    });
    expect(out).toEqual({ committed: false });
    expect(notices).toEqual([['error', 'Not a git repository - /commit needs one.']]);
  });

  test('detached HEAD: refuses', async () => {
    initRepo();
    const head = runGit(dir, ['rev-parse', 'HEAD']).stdout.trim();
    expect(runGit(dir, ['checkout', '--detach', head]).ok).toBe(true);
    const { io: ioObj, notices } = io();
    const out = await runCommitFlow({ cwd: dir, model: 'styx', io: ioObj });
    expect(out).toEqual({ committed: false });
    expect(notices).toEqual([['error', 'HEAD is detached - check out a branch first.']]);
  });

  test('clean tree: warns and commits nothing', async () => {
    initRepo();
    const { io: ioObj, notices } = io();
    const out = await runCommitFlow({ cwd: dir, model: 'styx', io: ioObj });
    expect(out).toEqual({ committed: false });
    expect(notices).toEqual([['warning', 'Nothing to commit - working tree clean.']]);
  });

  test('unstaged changes + declined stage-all: cancels before any write', async () => {
    initRepo();
    writeFileSync(join(dir, 'a.txt'), 'changed');
    const ctx = io();
    ctx.answers.push('n');
    const out = await runCommitFlow({ cwd: dir, model: 'styx', io: ctx.io });
    expect(out).toEqual({ committed: false });
    expect(ctx.notices.some(([k, t]) => k === 'info' && t.startsWith('Nothing staged.'))).toBe(true);
    expect(ctx.notices).toContainEqual(['warning', 'Cancelled - nothing staged, nothing committed.']);
    // Nothing was staged or committed.
    expect(runGit(dir, ['diff', '--cached', '--quiet']).ok).toBe(true);
    expect(runGit(dir, ['log', '--format=%s', '-1']).stdout.trim()).toBe('init');
  });
});
