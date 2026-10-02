import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests } from '../src/lib/config.js';
import {
  applyRewind,
  latestSession,
  listSessions,
  loadSession,
  markSessionDone,
  planRewind,
  saveSession,
  sha256,
  type RecordedChange,
} from '../src/lib/agent/checkpoint.js';

let workDir: string;
let origCwd: string;
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  freshConfigDir();
  __resetConfigForTests();
  origCwd = process.cwd();
  // realpath so process.cwd() after chdir() matches (macOS /var → /private/var).
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-ckpt-')));
  stdoutChunks = [];
  stderrChunks = [];
  process.stdout.write = ((c: unknown) => {
    stdoutChunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    stderrChunks.push(String(c));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  try {
    process.chdir(origCwd);
  } catch {
    /* ignore */
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const fp = (name: string): string => join(workDir, name);
const seed = (task: string, changes: RecordedChange[]): string =>
  saveSession({ cwd: workDir, task, changes }) as string;

// ───────────────────────── journal round-trip ─────────────────────────

describe('checkpoint journal', () => {
  test('record → persist → load round-trips with an afterSha', () => {
    writeFileSync(fp('a.txt'), 'A1');
    const id = seed('do a thing', [{ path: fp('a.txt'), op: 'modify', before: 'A0', after: 'A1' }]);
    expect(typeof id).toBe('string');
    const s = latestSession(workDir);
    expect(s).not.toBeNull();
    expect(s?.task).toBe('do a thing');
    expect(s?.changes[0]?.afterSha).toBe(sha256('A1'));
    expect(loadSession(workDir, id)?.id).toBe(id);
    expect(listSessions(workDir)).toHaveLength(1);
  });

  test('an empty change list persists nothing', () => {
    expect(saveSession({ cwd: workDir, task: 't', changes: [] })).toBeNull();
    expect(listSessions(workDir)).toHaveLength(0);
  });

  // ── create ──
  test("rewind of a 'create' deletes the file when unchanged", () => {
    writeFileSync(fp('new.txt'), 'created');
    seed('t', [{ path: fp('new.txt'), op: 'create', before: null, after: 'created' }]);
    const steps = planRewind(latestSession(workDir)!);
    expect(steps.map((s) => s.action)).toEqual(['delete']);
    applyRewind(steps, workDir);
    expect(existsSync(fp('new.txt'))).toBe(false);
  });

  test("rewind of a 'create' SKIPS when the file was modified afterward", () => {
    writeFileSync(fp('new.txt'), 'created');
    seed('t', [{ path: fp('new.txt'), op: 'create', before: null, after: 'created' }]);
    writeFileSync(fp('new.txt'), 'user edited it'); // changed since the agent ran
    const steps = planRewind(latestSession(workDir)!);
    expect(steps[0]?.action).toBe('skip');
    expect(steps[0]?.reason).toMatch(/modified/);
    const r = applyRewind(steps, workDir);
    expect(r.restored).toBe(0);
    expect(readFileSync(fp('new.txt'), 'utf8')).toBe('user edited it'); // not deleted
  });

  // ── create: empty-parent pruning (debug-bench S3 regression) ──
  test('rewind prunes now-empty parent dirs of a created file, up to cwd', () => {
    mkdirSync(fp('data/nested'), { recursive: true });
    writeFileSync(fp('data/nested/a.txt'), 'x');
    seed('t', [{ path: fp('data/nested/a.txt'), op: 'create', before: null, after: 'x' }]);
    applyRewind(planRewind(latestSession(workDir)!), workDir);
    expect(existsSync(fp('data/nested/a.txt'))).toBe(false);
    expect(existsSync(fp('data/nested'))).toBe(false); // pruned
    expect(existsSync(fp('data'))).toBe(false); // pruned
    expect(existsSync(workDir)).toBe(true); // cwd itself never removed
  });

  test('rewind keeps a parent dir that still has other entries', () => {
    mkdirSync(fp('shared'), { recursive: true });
    writeFileSync(fp('shared/keep.txt'), 'pre-existing');
    writeFileSync(fp('shared/made.txt'), 'agent');
    seed('t', [{ path: fp('shared/made.txt'), op: 'create', before: null, after: 'agent' }]);
    applyRewind(planRewind(latestSession(workDir)!), workDir);
    expect(existsSync(fp('shared/made.txt'))).toBe(false);
    expect(existsSync(fp('shared/keep.txt'))).toBe(true);
    expect(existsSync(fp('shared'))).toBe(true); // not empty → kept
  });

  /**
   * ⭐⭐ F-2c-40 — THERE IS NO LONGER A "WITHOUT A CWD". This test used to pin
   * the opposite: `applyRewind(steps)` with no boundary at all, which meant the
   * containment check was written `if (inside && …)` and simply did not run.
   * `cwd` is now REQUIRED, so the compiler refuses a call with no boundary and
   * the class is closed by construction rather than by remembering. The pruning
   * behaviour it also covered is pinned by the two tests above it.
   *
   * What is asserted here instead is the guard the requirement exists to serve:
   * a step whose path resolves OUTSIDE the workspace is skipped by every arm.
   */
  test('a step pointing outside the workspace is SKIPPED, not applied', () => {
    const outside = join(mkdtempSync(join(tmpdir(), 'rewind-outside-')), 'victim.txt');
    seed('t', [{ path: outside, op: 'delete', before: 'RESTORED-OUTSIDE\n', after: '' }]);
    const r = applyRewind(planRewind(latestSession(workDir)!), workDir);
    expect(r.restored, 'nothing outside the workspace may be restored').toBe(0);
    expect(r.skipped).toBe(1);
    expect(existsSync(outside), 'the outside path must not have been created').toBe(false);
  });

  /**
   * ⭐ THE CONTROL FOR THE TEST ABOVE — the identical restore arm, a path INSIDE
   * the workspace, which MUST be applied. Without it the zero above is equally
   * consistent with the arm being dead.
   *
   * ⭐⭐ IT IS A SEPARATE TEST, AND THAT IS A CORRECTION. Written as a second
   * half of the same test it seeded a SECOND session, and `latestSession` orders
   * by an id whose prefix is `Date.now()` — so when both seeds land in the same
   * millisecond the tie can resolve to the FIRST session and the control reads
   * the outside step again, reporting `restored: 0`. It passed on a fast direct
   * run and failed inside the fuller `unit-tests` job. **A test whose subject
   * depends on the clock advancing is a flake, not a control**, and `beforeEach`
   * already gives each test its own workspace and config dir.
   */
  test('the same restore arm IS applied for a path inside the workspace', () => {
    const insidePath = fp('restored.txt');
    seed('t', [{ path: insidePath, op: 'delete', before: 'RESTORED-INSIDE\n', after: '' }]);
    const r = applyRewind(planRewind(latestSession(workDir)!), workDir);
    expect(r.restored).toBe(1);
    expect(r.skipped).toBe(0);
    expect(readFileSync(insidePath, 'utf8')).toBe('RESTORED-INSIDE\n');
  });

  // ── modify ──
  test("rewind of a 'modify' restores `before` when unchanged", () => {
    writeFileSync(fp('m.txt'), 'NEW');
    seed('t', [{ path: fp('m.txt'), op: 'modify', before: 'OLD', after: 'NEW' }]);
    const steps = planRewind(latestSession(workDir)!);
    expect(steps.map((s) => s.action)).toEqual(['restore']);
    applyRewind(steps, workDir);
    expect(readFileSync(fp('m.txt'), 'utf8')).toBe('OLD');
  });

  test("rewind of a 'modify' SKIPS (no clobber) when modified afterward", () => {
    writeFileSync(fp('m.txt'), 'NEW');
    seed('t', [{ path: fp('m.txt'), op: 'modify', before: 'OLD', after: 'NEW' }]);
    writeFileSync(fp('m.txt'), 'USER WROTE THIS'); // changed since
    const steps = planRewind(latestSession(workDir)!);
    expect(steps[0]?.action).toBe('skip');
    applyRewind(steps, workDir);
    expect(readFileSync(fp('m.txt'), 'utf8')).toBe('USER WROTE THIS'); // preserved
  });

  // ── reverse order + chain ──
  test('reverse-order restore handles a create→modify of the same file', () => {
    writeFileSync(fp('f.txt'), 'v2');
    seed('t', [
      { path: fp('f.txt'), op: 'create', before: null, after: 'v1' },
      { path: fp('f.txt'), op: 'modify', before: 'v1', after: 'v2' },
    ]);
    const steps = planRewind(latestSession(workDir)!);
    expect(steps.map((s) => s.action)).toEqual(['restore', 'delete']); // reverse: modify→restore v1, then create→delete
    applyRewind(steps, workDir);
    expect(existsSync(fp('f.txt'))).toBe(false); // ends fully undone
  });

  // ── prune + no-reapply ──
  test('prune keeps the newest 20 sessions per cwd', () => {
    for (let i = 0; i < 25; i += 1) {
      seed(`t${i}`, [{ path: fp('f.txt'), op: 'create', before: null, after: `v${i}` }]);
    }
    expect(listSessions(workDir)).toHaveLength(20);
  });

  test('a rewound session is not re-applied (markSessionDone)', () => {
    writeFileSync(fp('new.txt'), 'created');
    const id = seed('t', [{ path: fp('new.txt'), op: 'create', before: null, after: 'created' }]);
    markSessionDone(workDir, id);
    expect(latestSession(workDir)).toBeNull();
    expect(listSessions(workDir)).toHaveLength(0);
  });
});

// ───────────────────────── rewind command ─────────────────────────

async function runRewind(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerRewindCommand } = await import('../src/commands/rewind.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: argv.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--json').option('--no-color');
  registerRewindCommand(program);
  process.chdir(workDir);
  await program.parseAsync(['node', 'spycore', 'rewind', ...argv]);
}

describe('rewind command', () => {
  test('--yes applies the rewind (deletes a created file)', async () => {
    writeFileSync(fp('made.txt'), 'agent made this\n');
    seed('make a file', [{ path: fp('made.txt'), op: 'create', before: null, after: 'agent made this\n' }]);
    await runRewind(['--yes']);
    expect(existsSync(fp('made.txt'))).toBe(false);
    // session marked done → a second rewind finds nothing
    expect(latestSession(workDir)).toBeNull();
  });

  test('non-TTY without --yes shows a preview but does NOT change anything', async () => {
    writeFileSync(fp('made.txt'), 'agent made this\n');
    seed('make a file', [{ path: fp('made.txt'), op: 'create', before: null, after: 'agent made this\n' }]);
    await runRewind([]); // process.stdin.isTTY is false in tests
    expect(existsSync(fp('made.txt'))).toBe(true); // untouched
    expect(latestSession(workDir)).not.toBeNull(); // still active
    expect(stdoutChunks.join('')).toMatch(/delete/); // preview was shown
  });

  test('nothing to rewind in a clean directory', async () => {
    await runRewind(['--yes']);
    expect(stdoutChunks.join('')).toMatch(/[Nn]othing to rewind/);
  });
});
