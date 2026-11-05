import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Command, Option } from 'commander';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import { registerRewindCommand } from '../src/commands/rewind.js';
import { saveSession, sha256 } from '../src/lib/agent/checkpoint.js';
import { getConfigPath } from '../src/lib/config.js';

async function runRewind(
  argv: string[],
  parentArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; error: unknown }> {
  const { configureOutput } = await import('../src/lib/output.js');
  const program = new Command();
  program.exitOverride();
  program.addOption(new Option('--api-url <url>')).addOption(new Option('--json')).addOption(new Option('--no-color'));
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  registerRewindCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exitCode;
  (process.stdout.write as unknown) = (c: string | Uint8Array) => (out.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
  (process.stderr.write as unknown) = (c: string | Uint8Array) => (err.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
  let error: unknown;
  try {
    await program.parseAsync(['node', 'spycore', ...parentArgs, 'rewind', ...argv]);
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = origExit;
    configureOutput({ json: false, color: true });
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

let workDir: string;
let prevCwd: string;
const origStdin = process.stdin;

function fp(name: string): string {
  return join(workDir, name);
}
function ckptDir(): string {
  return join(dirname(getConfigPath()), 'checkpoints', sha256(workDir));
}
function seed(task: string, changes: Array<Record<string, unknown>>): string {
  const id = saveSession({ cwd: workDir, task, changes: changes as never });
  expect(id).not.toBeNull();
  return id as string;
}
function allOut(r: { stdout: string; stderr: string }): string {
  return r.stdout + r.stderr;
}

beforeEach(() => {
  freshConfigDir();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-rewind-edge-')));
  prevCwd = process.cwd();
  process.chdir(workDir);
});

afterEach(async () => {
  process.chdir(prevCwd);
  Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('rewind --list', () => {
  test('an empty directory reports no sessions', async () => {
    const r = await runRewind(['--list']);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('No agent sessions recorded for this directory.');
  });

  test('a fresh session lists as just now', async () => {
    seed('do a thing', [{ path: fp('a.txt'), op: 'create', before: null, after: 'A\n' }]);
    const r = await runRewind(['--list']);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('just now');
  });

  test('a long task is truncated in the list', async () => {
    const task = 'x'.repeat(100);
    seed(task, [{ path: fp('a.txt'), op: 'create', before: null, after: 'A\n' }]);
    const r = await runRewind(['--list']);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain(`${'x'.repeat(55)}…`);
    expect(allOut(r)).not.toContain(task);
  });

  test('a session with an unparseable start time still lists', async () => {
    const id = seed('do a thing', [{ path: fp('a.txt'), op: 'create', before: null, after: 'A\n' }]);
    const file = join(ckptDir(), `${id}.json`);
    const session = JSON.parse(readFileSync(file, 'utf8'));
    session.startedAt = 'not-a-date';
    writeFileSync(file, JSON.stringify(session));
    const r = await runRewind(['--list']);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain(id);
    expect(allOut(r)).not.toContain('NaN');
  });

  test('an older session lists with a seconds-ago time', async () => {
    const id = seed('old session', [{ path: fp('a.txt'), op: 'create', before: null, after: 'A\n' }]);
    const file = join(ckptDir(), `${id}.json`);
    const session = JSON.parse(readFileSync(file, 'utf8'));
    session.startedAt = new Date(Date.now() - 30_000).toISOString();
    writeFileSync(file, JSON.stringify(session));
    const r = await runRewind(['--list']);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('30s ago');
  });

  test('an hours-old session lists with an hours-ago time', async () => {
    const id = seed('hours old', [{ path: fp('a.txt'), op: 'create', before: null, after: 'A\n' }]);
    const file = join(ckptDir(), `${id}.json`);
    const session = JSON.parse(readFileSync(file, 'utf8'));
    session.startedAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    writeFileSync(file, JSON.stringify(session));
    const r = await runRewind(['--list']);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('2h ago');
  });

  test('--json lists sessions structurally', async () => {
    const id = seed('do a thing', [{ path: fp('a.txt'), op: 'create', before: null, after: 'A\n' }]);
    const r = await runRewind(['--list'], ['--json']);
    expect(r.error).toBeUndefined();
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.sessions[0]).toMatchObject({ id, files: 1, task: 'do a thing' });
  });
});

describe('rewind apply paths', () => {
  test('--json with no session reports nothing to rewind structurally', async () => {
    const r = await runRewind([], ['--json']);
    expect(r.error).toBeUndefined();
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed).toMatchObject({ applied: false, restored: 0, skipped: 0, message: 'nothing to rewind' });
  });

  test('a two-change apply reports the plural', async () => {
    writeFileSync(fp('a.txt'), 'A\n');
    writeFileSync(fp('b.txt'), 'B\n');
    seed('two creates', [
      { path: fp('a.txt'), op: 'create', before: null, after: 'A\n' },
      { path: fp('b.txt'), op: 'create', before: null, after: 'B\n' },
    ]);
    const r = await runRewind(['--yes']);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('Rewound 2 changes.');
    expect(existsSync(fp('a.txt'))).toBe(false);
    expect(existsSync(fp('b.txt'))).toBe(false);
  });

  test('a two-change prompt asks in the plural', async () => {
    writeFileSync(fp('a.txt'), 'A\n');
    writeFileSync(fp('b.txt'), 'B\n');
    seed('two prompt', [
      { path: fp('a.txt'), op: 'create', before: null, after: 'A\n' },
      { path: fp('b.txt'), op: 'create', before: null, after: 'B\n' },
    ]);
    const yesStdin = Readable.from(['y\n']);
    (yesStdin as unknown as { isTTY: boolean }).isTTY = true;
    Object.defineProperty(process, 'stdin', { value: yesStdin, configurable: true });
    const r = await runRewind([]);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('Restore 2 changes?');
    expect(allOut(r)).toContain('Rewound 2 changes.');
  });
  test('a one-change session previews in the singular and applies', async () => {
    writeFileSync(fp('a.txt'), 'A\n');
    seed('make a file', [{ path: fp('a.txt'), op: 'create', before: null, after: 'A\n' }]);
    const r = await runRewind(['--yes']);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('1 change:');
    expect(allOut(r)).toContain('delete');
    expect(allOut(r)).toContain('Rewound 1 change.');
    expect(existsSync(fp('a.txt'))).toBe(false);
  });

  test('a two-change session previews in the plural with restore rows', async () => {
    writeFileSync(fp('a.txt'), 'A\n');
    writeFileSync(fp('m.txt'), 'new\n');
    seed('two changes', [
      { path: fp('a.txt'), op: 'create', before: null, after: 'A\n' },
      { path: fp('m.txt'), op: 'modify', before: 'old\n', after: 'new\n' },
    ]);
    const r = await runRewind([]);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('2 changes:');
    expect(allOut(r)).toContain('restore');
    expect(allOut(r)).toContain('Non-interactive - re-run with --yes to apply the rewind.');
    expect(existsSync(fp('a.txt'))).toBe(true);
  });

  test('an explicit --session id rewinds that session', async () => {
    writeFileSync(fp('a.txt'), 'A\n');
    const id = seed('explicit', [{ path: fp('a.txt'), op: 'create', before: null, after: 'A\n' }]);
    const r = await runRewind(['--session', id, '--yes']);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('Rewound 1 change.');
    expect(existsSync(fp('a.txt'))).toBe(false);
  });

  test('an unknown --session id errors', async () => {
    const r = await runRewind(['--session', 'no-such-session']);
    expect((r.error as Error)?.message).toMatch(/No session "no-such-session"/);
  });

  test('a change outside the workspace previews by absolute path', async () => {
    const outside = join(tmpdir(), 'spycli-rewind-outside-f.txt');
    seed('outside', [{ path: outside, op: 'create', before: null, after: 'X\n' }]);
    const r = await runRewind([]);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain(outside);
  });

  test('one restored plus one skipped reports both counts', async () => {
    writeFileSync(fp('a.txt'), 'A\n');
    writeFileSync(fp('b.txt'), 'CHANGED\n');
    seed('mixed', [
      { path: fp('a.txt'), op: 'create', before: null, after: 'A\n' },
      { path: fp('b.txt'), op: 'create', before: null, after: 'B\n' },
    ]);
    const r = await runRewind(['--yes']);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('Rewound 1 change, skipped 1.');
    expect(existsSync(fp('a.txt'))).toBe(false);
    expect(existsSync(fp('b.txt'))).toBe(true);
  });

  test('an all-skipped session reports nothing to restore', async () => {
    writeFileSync(fp('b.txt'), 'CHANGED\n');
    seed('stale', [{ path: fp('b.txt'), op: 'create', before: null, after: 'B\n' }]);
    const r = await runRewind(['--yes']);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('Nothing to restore');
    expect(existsSync(fp('b.txt'))).toBe(true);
  });

  test('--json apply reports the structured result', async () => {
    writeFileSync(fp('a.txt'), 'A\n');
    const id = seed('json apply', [{ path: fp('a.txt'), op: 'create', before: null, after: 'A\n' }]);
    const r = await runRewind(['--yes'], ['--json']);
    expect(r.error).toBeUndefined();
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed).toMatchObject({ session: id, applied: true, restored: 1, skipped: 0 });
  });

  test('answering yes at the prompt applies, answering no cancels', async () => {
    writeFileSync(fp('a.txt'), 'A\n');
    seed('prompt yes', [{ path: fp('a.txt'), op: 'create', before: null, after: 'A\n' }]);
    const yesStdin = Readable.from(['y\n']);
    (yesStdin as unknown as { isTTY: boolean }).isTTY = true;
    Object.defineProperty(process, 'stdin', { value: yesStdin, configurable: true });
    let r = await runRewind([]);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('Rewound 1 change.');
    expect(existsSync(fp('a.txt'))).toBe(false);

    writeFileSync(fp('a.txt'), 'A\n');
    seed('prompt no', [{ path: fp('a.txt'), op: 'create', before: null, after: 'A\n' }]);
    const noStdin = Readable.from(['n\n']);
    (noStdin as unknown as { isTTY: boolean }).isTTY = true;
    Object.defineProperty(process, 'stdin', { value: noStdin, configurable: true });
    r = await runRewind([]);
    expect(r.error).toBeUndefined();
    expect(allOut(r)).toContain('Rewind cancelled - nothing changed.');
    expect(existsSync(fp('a.txt'))).toBe(true);
  });
});
