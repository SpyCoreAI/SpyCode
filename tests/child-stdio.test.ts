import { describe, expect, test } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { releaseChildStdio, STDIO_DRAIN_MS } from '../src/lib/child-stdio.js';

describe('STDIO_DRAIN_MS', () => {
  test('is the documented 200ms settle window', () => {
    expect(STDIO_DRAIN_MS).toBe(200);
  });
});

describe('releaseChildStdio', () => {
  test('unrefs piped stdout/stderr/stdin handles', () => {
    const calls: string[] = [];
    const fake = {
      stdout: { unref: () => { calls.push('stdout'); } },
      stderr: { unref: () => { calls.push('stderr'); } },
      stdin: { unref: () => { calls.push('stdin'); } },
    } as unknown as ChildProcess;
    releaseChildStdio(fake);
    expect(calls).toEqual(['stdout', 'stderr', 'stdin']);
  });

  test('never throws on null stdio (ignore/inherit shapes)', () => {
    const fake = { stdout: null, stderr: null, stdin: null } as unknown as ChildProcess;
    expect(() => releaseChildStdio(fake)).not.toThrow();
  });

  test('never throws on streams without unref (test doubles, non-socket streams)', () => {
    const fake = {
      stdout: { read: () => null },
      stderr: undefined,
      stdin: null,
    } as unknown as ChildProcess;
    expect(() => releaseChildStdio(fake)).not.toThrow();
  });

  test('is safe to call more than once', () => {
    let calls = 0;
    const fake = {
      stdout: { unref: () => { calls += 1; } },
      stderr: null,
      stdin: null,
    } as unknown as ChildProcess;
    releaseChildStdio(fake);
    releaseChildStdio(fake);
    expect(calls).toBe(2);
  });

  test('works on a real spawned child with piped stdio', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: 'pipe',
    });
    try {
      expect(() => releaseChildStdio(child)).not.toThrow();
    } finally {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    }
  });

  test('a real child whose pipes were released can still be awaited', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(3);'], {
      stdio: 'pipe',
    });
    releaseChildStdio(child);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(3);
  });
});
