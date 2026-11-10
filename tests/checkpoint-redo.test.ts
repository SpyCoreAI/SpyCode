import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests, getConfigPath } from '../src/lib/config.js';
import {
  applyRedo,
  checkpointDirFor,
  createRunRecorder,
  listSessions,
  loadSession,
  markSessionDone,
  planRedo,
  planRewind,
  reopenRunRecorder,
  saveSession,
  sha256,
  type CheckpointSession,
  type FileChange,
} from '../src/lib/agent/checkpoint.js';

let workDir: string;

beforeEach(() => {
  freshConfigDir();
  __resetConfigForTests();
  workDir = mkdtempSync(join(tmpdir(), 'spycli-ckpt-redo-'));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const fp = (name: string): string => join(workDir, name);
const ckptDir = (): string => checkpointDirFor(workDir);
const ch = (path: string, op: 'create' | 'modify' | 'delete', before: string | null, after: string): FileChange => ({
  path,
  op,
  before,
  after,
  afterSha: sha256(after),
});
const validResume = () => ({
  version: 1 as const,
  status: 'interrupted' as const,
  conversationId: null,
  nativeTools: false,
  providerKind: 'spycore' as const,
  model: 'hermes',
  planMode: false,
  approvedPlan: null,
  turnsCompleted: 0,
  maxTurns: 25,
  budget: { caps: {}, tokensUsed: 0, turnsUsed: 0, elapsedMs: 0 },
  loadedSkills: [],
  gitHead: null,
  updatedAt: new Date().toISOString(),
});
const session = (changes: FileChange[]): CheckpointSession => ({
  id: '1-test',
  cwd: workDir,
  startedAt: new Date().toISOString(),
  task: 'test task',
  changes,
  resume: validResume(),
});

describe('planRewind sim and null-before arms', () => {
  test('delete then create of one file threads null through the sim', () => {
    writeFileSync(fp('f.txt'), 'NEW');
    const steps = planRewind(
      session([ch(fp('f.txt'), 'delete', null, ''), ch(fp('f.txt'), 'create', null, 'NEW')]),
    );
    expect(steps.map((s) => s.action)).toEqual(['delete', 'restore']);
  });

  test('modify with null before restores and hashes the empty string', () => {
    writeFileSync(fp('f.txt'), 'NEW');
    const steps = planRewind(session([ch(fp('f.txt'), 'modify', null, 'NEW')]));
    expect(steps).toHaveLength(1);
    expect(steps[0]?.action).toBe('restore');
  });
});

describe('planRedo and applyRedo', () => {
  test('create, delete, and modify redo and apply', () => {
    const created = planRedo(session([ch(fp('c.txt'), 'create', null, 'NEW')]));
    expect(created.map((s) => s.action)).toEqual(['restore']);
    const appliedCreate = applyRedo(created, workDir);
    expect(appliedCreate).toEqual({ restored: 1, skipped: 0 });
    expect(readFileSync(fp('c.txt'), 'utf8')).toBe('NEW');

    writeFileSync(fp('d.txt'), 'OLD');
    const deleted = planRedo(session([ch(fp('d.txt'), 'delete', 'OLD', '')]));
    expect(deleted.map((s) => s.action)).toEqual(['delete']);
    const appliedDelete = applyRedo(deleted, workDir);
    expect(appliedDelete).toEqual({ restored: 1, skipped: 0 });
    expect(existsSync(fp('d.txt'))).toBe(false);

    writeFileSync(fp('m.txt'), 'OLD');
    const modified = planRedo(session([ch(fp('m.txt'), 'modify', 'OLD', 'NEW')]));
    expect(modified.map((s) => s.action)).toEqual(['restore']);
    applyRedo(modified, workDir);
    expect(readFileSync(fp('m.txt'), 'utf8')).toBe('NEW');
  });

  test('redo guards: modified, recreated, and deleted since undo', () => {
    writeFileSync(fp('m.txt'), 'OTHER');
    const modified = planRedo(session([ch(fp('m.txt'), 'modify', 'OLD', 'NEW')]));
    expect(modified[0]?.action).toBe('skip');
    expect(modified[0]?.reason).toBe('modified since undo');

    writeFileSync(fp('c.txt'), 'X');
    const recreated = planRedo(session([ch(fp('c.txt'), 'create', 'X', 'NEW')]));
    expect(recreated[0]?.action).toBe('skip');
    expect(recreated[0]?.reason).toBe('recreated since undo');

    const deleted = planRedo(session([ch(fp('d.txt'), 'delete', null, '')]));
    expect(deleted[0]?.action).toBe('skip');
    expect(deleted[0]?.reason).toBe('deleted since undo');
  });

  test('a really recreated file (create with null before) says recreated, not modified', () => {
    // In a real journal a create always has before null, so the old code -
    // sha guard first, existence checks below it - reported a recreated
    // file "modified since undo": the inner checks could never fire. The
    // existence checks now run first, so the reason names what happened.
    writeFileSync(fp('c.txt'), 'USER RECREATED');
    const recreated = planRedo(session([ch(fp('c.txt'), 'create', null, 'NEW')]));
    expect(recreated[0]?.action).toBe('skip');
    expect(recreated[0]?.reason).toBe('recreated since undo');
    // And a really re-deleted file says deleted, not modified.
    const deleted = planRedo(session([ch(fp('d.txt'), 'delete', 'OLD', '')]));
    expect(deleted[0]?.action).toBe('skip');
    expect(deleted[0]?.reason).toBe('deleted since undo');
  });

  test('delete then create chain threads null through the sim', () => {
    writeFileSync(fp('f.txt'), 'OLD');
    const steps = planRedo(
      session([ch(fp('f.txt'), 'delete', 'OLD', ''), ch(fp('f.txt'), 'create', null, 'NEW')]),
    );
    expect(steps.map((s) => s.action)).toEqual(['delete', 'restore']);
    const applied = applyRedo(steps, workDir);
    expect(applied).toEqual({ restored: 2, skipped: 0 });
    expect(readFileSync(fp('f.txt'), 'utf8')).toBe('NEW');
  });

  test('applyRedo guards: skip, outside-cwd, symlink leaf, write failure', () => {
    writeFileSync(fp('keep.txt'), 'OLD');
    writeFileSync(fp('real.txt'), 'OLD');
    symlinkSync(fp('real.txt'), fp('link.txt'));
    writeFileSync(fp('blocker'), 'not a directory');
    const steps = planRedo(session([ch(fp('keep.txt'), 'modify', 'OLD', 'NEW')]));
    const skipped = applyRedo(
      [
        { change: steps[0]!.change, action: 'skip', reason: 'test' },
        { change: ch('/etc/passwd', 'modify', 'OLD', 'NEW'), action: 'restore' },
        { change: ch(fp('link.txt'), 'create', null, 'NEW'), action: 'restore' },
        { change: ch(fp('blocker/inner.txt'), 'create', null, 'NEW'), action: 'restore' },
        ...steps,
      ],
      workDir,
    );
    expect(skipped.restored).toBe(1);
    expect(skipped.skipped).toBe(4);
    expect(readFileSync(fp('keep.txt'), 'utf8')).toBe('NEW');
  });

  test('applyRedo create makes parent directories', () => {
    const steps = planRedo(session([ch(fp('newdir/sub/f.txt'), 'create', null, 'NEW')]));
    const applied = applyRedo(steps, workDir);
    expect(applied).toEqual({ restored: 1, skipped: 0 });
    expect(readFileSync(fp('newdir/sub/f.txt'), 'utf8')).toBe('NEW');
  });
});

describe('checkpoint best-effort catches', () => {
  test('session directory as a file: saveSession returns null, listSessions is empty', () => {
    mkdirSync(join(dirname(getConfigPath()), 'checkpoints'), { recursive: true });
    writeFileSync(ckptDir(), 'not a directory');
    const id = saveSession({
      cwd: workDir,
      task: 't',
      changes: [{ path: fp('f.txt'), op: 'create', before: null, after: 'x' }],
    });
    expect(id).toBe(null);
    expect(listSessions(workDir)).toEqual([]);
  });

  test('markSessionDone tolerates a directory in place of the session file', () => {
    mkdirSync(join(ckptDir(), '9-test.json'), { recursive: true });
    // Renaming an empty directory would SUCCEED, so the target must already
    // exist as a non-empty directory for the rename to fail.
    mkdirSync(join(ckptDir(), '9-test.json.done', 'child'), { recursive: true });
    expect(() => markSessionDone(workDir, '9-test')).not.toThrow();
    expect(existsSync(join(ckptDir(), '9-test.json'))).toBe(true);
  });

  test('recorder persist swallows a session-directory failure', () => {
    mkdirSync(join(dirname(getConfigPath()), 'checkpoints'), { recursive: true });
    writeFileSync(ckptDir(), 'not a directory');
    const rec = createRunRecorder({
      cwd: workDir,
      task: 't',
      initial: {
        providerKind: 'spycore',
        model: 'hermes',
        planMode: false,
        maxTurns: 25,
        budget: { caps: {}, tokensUsed: 0, turnsUsed: 0, elapsedMs: 0 },
        gitHead: null,
      },
    });
    expect(() =>
      rec.recordChange({ path: fp('f.txt'), op: 'create', before: null, after: 'x' }),
    ).not.toThrow();
    expect(rec.changeCount()).toBe(1);
  });

  test('planRedo treats an unreadable path as absent', () => {
    mkdirSync(fp('adir'));
    const steps = planRedo(session([ch(fp('adir'), 'modify', null, 'NEW')]));
    expect(steps[0]?.action).toBe('restore');
  });

  test('prune tolerates an unlinkable overflow entry', () => {
    mkdirSync(ckptDir(), { recursive: true });
    mkdirSync(join(ckptDir(), '1.json'));
    for (let i = 2; i <= 21; i += 1) writeFileSync(join(ckptDir(), `${i}.json`), '{}');
    const id = saveSession({
      cwd: workDir,
      task: 't',
      changes: [{ path: fp('f.txt'), op: 'create', before: null, after: 'x' }],
    });
    expect(id).not.toBe(null);
    expect(existsSync(join(ckptDir(), '1.json'))).toBe(true);
    expect(existsSync(join(ckptDir(), '2.json'))).toBe(false);
  });

  test('finalize tolerates a directory in place of the session file', () => {
    mkdirSync(ckptDir(), { recursive: true });
    const data = { ...session([]), id: '5-test' };
    writeFileSync(join(ckptDir(), '5-test.json'), JSON.stringify(data));
    const loaded = loadSession(workDir, '5-test');
    expect(loaded).not.toBe(null);
    const recorder = reopenRunRecorder(loaded!);
    expect(recorder).not.toBe(null);
    unlinkSync(join(ckptDir(), '5-test.json'));
    mkdirSync(join(ckptDir(), '5-test.json'));
    expect(() => recorder!.finalize('completed')).not.toThrow();
    expect(existsSync(join(ckptDir(), '5-test.json'))).toBe(true);
  });

  test('symlink leaf is refused by applyRedo', () => {
    writeFileSync(fp('real.txt'), 'OLD');
    symlinkSync(fp('real.txt'), fp('link.txt'));
    const steps = planRedo(session([ch(fp('link.txt'), 'modify', 'OLD', 'NEW')]));
    // planRedo reads through the link, so the step is a restore; applyRedo
    // must still refuse the symlinked leaf.
    expect(steps[0]?.action).toBe('restore');
    const applied = applyRedo(steps, workDir);
    expect(applied).toEqual({ restored: 0, skipped: 1 });
    expect(readFileSync(fp('real.txt'), 'utf8')).toBe('OLD');
  });
});
