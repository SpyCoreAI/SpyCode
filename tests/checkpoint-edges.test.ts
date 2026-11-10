import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests, getConfigPath } from '../src/lib/config.js';
import {
  applyRewind,
  branchSession,
  checkpointDirFor,
  createRunRecorder,
  getResumeState,
  listSessions,
  loadSession,
  planRewind,
  reopenRunRecorder,
  saveSession,
  sha256,
  type CheckpointSession,
  type FileChange,
  type RecordedChange,
  type ResumeState,
} from '../src/lib/agent/checkpoint.js';

let workDir: string;

beforeEach(() => {
  freshConfigDir();
  __resetConfigForTests();
  workDir = mkdtempSync(join(tmpdir(), 'spycli-ckpt-edge-'));
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
const writeSessionFile = (name: string, data: unknown): void => {
  mkdirSync(ckptDir(), { recursive: true });
  writeFileSync(join(ckptDir(), name), typeof data === 'string' ? data : JSON.stringify(data));
};
const validResume = (): ResumeState => ({
  version: 1,
  status: 'running',
  conversationId: null,
  nativeTools: false,
  providerKind: 'spycore',
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
const validSession = (changes: FileChange[]): CheckpointSession => ({
  id: '1-test',
  cwd: workDir,
  startedAt: new Date().toISOString(),
  task: 'test task',
  changes,
});
const ch = (path: string, op: 'create' | 'modify' | 'delete', before: string | null, after: string): FileChange => ({
  path,
  op,
  before,
  after,
  afterSha: sha256(after),
});

// ───────────────────────── getResumeState validation ─────────────────────────

describe('getResumeState rejects malformed resume data', () => {
  test('an invalid status is rejected', () => {
    const r = validResume();
    (r as unknown as Record<string, unknown>).status = 'bogus';
    expect(getResumeState({ ...validSession([]), resume: r })).toBeNull();
  });

  test('a non-string conversationId is rejected', () => {
    const r = validResume();
    (r as unknown as Record<string, unknown>).conversationId = 123;
    expect(getResumeState({ ...validSession([]), resume: r })).toBeNull();
  });

  test('an unknown providerKind is rejected', () => {
    const r = validResume();
    (r as unknown as Record<string, unknown>).providerKind = 'other';
    expect(getResumeState({ ...validSession([]), resume: r })).toBeNull();
  });

  test('a non-string model is rejected', () => {
    const r = validResume();
    (r as unknown as Record<string, unknown>).model = 42;
    expect(getResumeState({ ...validSession([]), resume: r })).toBeNull();
  });

  test('a non-boolean nativeTools is rejected', () => {
    const r = validResume();
    (r as unknown as Record<string, unknown>).nativeTools = 'yes';
    expect(getResumeState({ ...validSession([]), resume: r })).toBeNull();
  });

  test('a missing budget is rejected', () => {
    const r = validResume();
    (r as unknown as Record<string, unknown>).budget = null;
    expect(getResumeState({ ...validSession([]), resume: r })).toBeNull();
  });

  test('a non-object budget is rejected', () => {
    const r = validResume();
    (r as unknown as Record<string, unknown>).budget = 'x';
    expect(getResumeState({ ...validSession([]), resume: r })).toBeNull();
  });

  test('a well-formed resume passes through', () => {
    expect(getResumeState({ ...validSession([]), resume: validResume() })).not.toBeNull();
  });
});

// ───────────────────────── session id validation ─────────────────────────

describe('session id validation', () => {
  test('loadSession rejects a traversal id', () => {
    expect(loadSession(workDir, '../evil')).toBeNull();
    expect(loadSession(workDir, 'bad id!')).toBeNull();
  });

  test('branchSession rejects a traversal source id', () => {
    expect(branchSession(workDir, '../evil')).toBeNull();
  });

  test('branchSession returns null when the source cannot be read', () => {
    mkdirSync(ckptDir(), { recursive: true });
    mkdirSync(join(ckptDir(), 'badid.json'));
    expect(branchSession(workDir, 'badid')).toBeNull();
  });
});

// ───────────────────────── parseSession robustness ─────────────────────────

describe('parseSession robustness via listSessions', () => {
  test('a corrupt JSON file is excluded', () => {
    writeSessionFile('1-bad.json', '{not json');
    expect(listSessions(workDir)).toHaveLength(0);
  });

  test('a JSON null file is excluded', () => {
    writeSessionFile('1-null.json', 'null');
    expect(listSessions(workDir)).toHaveLength(0);
  });

  test('a file whose changes are not an array is excluded', () => {
    writeSessionFile('1-shape.json', { id: '1-shape', cwd: workDir, task: 't', changes: 'nope' });
    expect(listSessions(workDir)).toHaveLength(0);
  });

  test('a non-numeric id prefix sorts as zero', () => {
    writeSessionFile('abc-1.json', { id: 'abc-1', cwd: workDir, task: 't', changes: [] });
    writeSessionFile('999-z.json', { id: '999-z', cwd: workDir, task: 't', changes: [] });
    expect(listSessions(workDir).map((s) => s.id)).toEqual(['999-z', 'abc-1']);
  });
});

// ───────────────────────── saveSession failure ─────────────────────────

describe('saveSession failure', () => {
  test('a checkpoints path blocked by a file persists nothing', () => {
    // No permission trick: as root, chmod cannot fail a write. A FILE sitting
    // where the `checkpoints/` directory belongs makes mkdirSync throw
    // ENOTDIR instead, which saveSession's catch turns into null.
    const configDir = dirname(getConfigPath());
    const blocker = join(configDir, 'checkpoints');
    writeFileSync(blocker, 'not a directory');
    try {
      expect(saveSession({ cwd: workDir, task: 't', changes: [{ path: fp('a.txt'), op: 'create', before: null, after: 'A' }] })).toBeNull();
    } finally {
      rmSync(blocker, { force: true });
    }
  });
});

// ───────────────────────── recorder edges ─────────────────────────

describe('recorder edges', () => {
  const initial = (): Parameters<typeof createRunRecorder>[0]['initial'] => ({
    providerKind: 'spycore',
    model: 'hermes',
    planMode: false,
    maxTurns: 25,
    budget: { caps: {}, tokensUsed: 0, turnsUsed: 0, elapsedMs: 0 },
    gitHead: null,
  });

  test('recordChanges with an empty list is a no-op', () => {
    const rec = createRunRecorder({ cwd: workDir, task: 't', initial: initial() });
    rec.recordChanges([]);
    expect(rec.changeCount()).toBe(0);
  });

  test('a second finalize is a no-op', () => {
    const rec = createRunRecorder({ cwd: workDir, task: 't', initial: initial() });
    rec.finalize('completed');
    rec.finalize('completed');
    expect(rec.changeCount()).toBe(0);
  });

  test('reopen rejects a session without a valid resume record', () => {
    expect(reopenRunRecorder(validSession([]))).toBeNull();
  });

  test('reopen re-hashes a change that carries no afterSha', () => {
    const change = { path: fp('a.txt'), op: 'modify', before: 'A0', after: 'A1' } as unknown as FileChange;
    const rec = reopenRunRecorder({ ...validSession([change]), resume: validResume() });
    expect(rec).not.toBeNull();
    expect(rec!.changes()[0]).toMatchObject({ afterSha: sha256('A1') });
  });
});

// ───────────────────────── planRewind edges ─────────────────────────

describe('planRewind edges', () => {
  test('a created file that is already gone is skipped, not deleted', () => {
    const steps = planRewind(validSession([ch(fp('gone.txt'), 'create', null, 'X')]));
    expect(steps).toEqual([{ change: expect.anything(), action: 'skip', reason: 'already deleted' }]);
  });

  test('a deleted file that is still absent is restored', () => {
    const steps = planRewind(validSession([ch(fp('back.txt'), 'delete', 'X', '')]));
    expect(steps).toEqual([{ change: expect.anything(), action: 'restore' }]);
  });

  test('a deleted file that reappeared is skipped', () => {
    writeFileSync(fp('back.txt'), 'someone restored it');
    const steps = planRewind(validSession([ch(fp('back.txt'), 'delete', 'X', '')]));
    expect(steps).toEqual([{ change: expect.anything(), action: 'skip', reason: 'recreated since the agent ran' }]);
  });

  test('a modified file that is missing is skipped', () => {
    const steps = planRewind(validSession([ch(fp('gone.txt'), 'modify', 'X', 'Y')]));
    expect(steps).toEqual([{ change: expect.anything(), action: 'skip', reason: 'file is missing' }]);
  });

  test('an inconsistent chain skips via the simulated state, not the disk', () => {
    writeFileSync(fp('f.txt'), 'Z');
    const steps = planRewind(
      validSession([
        ch(fp('f.txt'), 'modify', 'X', 'Y'),
        ch(fp('f.txt'), 'modify', 'W', 'Z'),
      ]),
    );
    expect(steps.map((s) => s.action)).toEqual(['restore', 'skip']);
    expect(steps[1]?.reason).toBe('modified since the agent ran');
  });
});

// ───────────────────────── applyRewind edges ─────────────────────────

describe('applyRewind edges', () => {
  test('a delete-restore with a null before writes an empty file', () => {
    const out = applyRewind(
      [{ change: ch(fp('back.txt'), 'delete', null, 'X'), action: 'restore' }],
      workDir,
    );
    expect(out).toEqual({ restored: 1, skipped: 0 });
    expect(readFileSync(fp('back.txt'), 'utf8')).toBe('');
  });

  test('a modify-restore with a null before writes an empty file', () => {
    writeFileSync(fp('f.txt'), 'old');
    const out = applyRewind(
      [{ change: ch(fp('f.txt'), 'modify', null, 'X'), action: 'restore' }],
      workDir,
    );
    expect(out).toEqual({ restored: 1, skipped: 0 });
    expect(readFileSync(fp('f.txt'), 'utf8')).toBe('');
  });

  test('a restore blocked by a file in the path is skipped, not thrown', () => {
    // No permission trick: as root, chmod cannot fail a write. A FILE sitting
    // where a parent directory belongs makes writeFileSync throw ENOTDIR,
    // which applyRewind's catch turns into a skip. The containment guard
    // still passes: canonicalize resolves the file parent lexically inside.
    writeFileSync(fp('blocker'), 'I am a file');
    const out = applyRewind(
      [{ change: ch(fp('blocker/f.txt'), 'modify', 'X', 'Y'), action: 'restore' }],
      workDir,
    );
    expect(out).toEqual({ restored: 0, skipped: 1 });
    expect(existsSync(fp('blocker/f.txt'))).toBe(false);
  });

  test('prune stops when a parent still holds another file', () => {
    mkdirSync(fp('sub'));
    writeFileSync(fp('sub/keep.txt'), 'keep');
    writeFileSync(fp('sub/gone.txt'), 'X');
    const out = applyRewind(
      [{ change: ch(fp('sub/gone.txt'), 'create', null, 'X'), action: 'delete' }],
      workDir,
    );
    expect(out).toEqual({ restored: 1, skipped: 0 });
    expect(existsSync(fp('sub/gone.txt'))).toBe(false);
    expect(existsSync(fp('sub'))).toBe(true);
    expect(readFileSync(fp('sub/keep.txt'), 'utf8')).toBe('keep');
  });

  test('a delete under a symlinked-out parent is skipped at the guard, never pruned', () => {
    // This is why pruneEmptyDirs' own containment re-check never fires
    // through the public API: the identical predicate already rejects the
    // file path in applyRewind, before prune is reached. The outside
    // directory and its file must survive untouched.
    const ext = mkdtempSync(join(tmpdir(), 'spycli-ckpt-ext-'));
    try {
      writeFileSync(join(ext, 'f.txt'), 'X');
      symlinkSync(ext, fp('link'));
      const out = applyRewind(
        [{ change: ch(fp('link/f.txt'), 'create', null, 'X'), action: 'delete' }],
        workDir,
      );
      expect(out).toEqual({ restored: 0, skipped: 1 });
      expect(readFileSync(join(ext, 'f.txt'), 'utf8')).toBe('X');
    } finally {
      rmSync(ext, { recursive: true, force: true });
    }
  });

  test('prune bails out when a parent cannot be listed', () => {
    // No permission trick: as root, chmod cannot fail a readdir. A parent
    // that is a SYMLINK TO A FILE makes readdirSync throw ENOTDIR, which
    // pruneEmptyDirs' catch turns into a stop. The delete arm reaches prune
    // because the file path itself passes containment (it resolves lexically
    // inside via the link target) and existsSync on it is false, so no
    // unlink is attempted first.
    writeFileSync(fp('target.txt'), 'target');
    symlinkSync(fp('target.txt'), fp('link'));
    const out = applyRewind(
      [{ change: ch(fp('link/f.txt'), 'create', null, 'X'), action: 'delete' }],
      workDir,
    );
    expect(out).toEqual({ restored: 1, skipped: 0 });
    expect(existsSync(fp('link'))).toBe(true);
    expect(readFileSync(fp('target.txt'), 'utf8')).toBe('target');
  });
});
