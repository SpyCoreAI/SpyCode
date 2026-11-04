import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closePause,
  diffWorkspace,
  openPause,
  snapshotWorkspace,
  type WorkspaceSnapshot,
} from '../src/lib/agent/workspace-delta.js';

let workDir: string;

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-delta-')));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const fp = (name: string): string => join(workDir, name);
const snap = async (): Promise<WorkspaceSnapshot> => {
  const s = await snapshotWorkspace(workDir);
  expect(s).not.toBeNull();
  return s!;
};

describe('snapshotWorkspace capture rules', () => {
  test('a control-byte-heavy file is hash-only, and an oversize file is hash-only', async () => {
    const binary = Buffer.concat([Buffer.alloc(50, 0x01), Buffer.alloc(50, 0x61)]);
    writeFileSync(fp('bin.dat'), binary);
    writeFileSync(fp('big.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const s = await snap();
    expect(s.entries.get('bin.dat')?.content).toBeNull();
    expect(s.entries.get('big.txt')?.content).toBeNull();
    expect(s.entries.get('bin.dat')?.sha).toHaveLength(64);
  });

  test('the retained-bytes cap fails the snapshot closed', async () => {
    for (let i = 0; i < 33; i += 1) {
      writeFileSync(fp(`f${i}.txt`), Buffer.alloc(2 * 1024 * 1024, 0x61));
    }
    expect(await snapshotWorkspace(workDir)).toBeNull();
  });

  test('the file-count cap fails the snapshot and the diff closed', { timeout: 60_000 }, async () => {
    for (let i = 0; i < 20001; i += 1) {
      writeFileSync(fp(`f${i}.txt`), '');
    }
    expect(await snapshotWorkspace(workDir)).toBeNull();
    const hand: WorkspaceSnapshot = { root: workDir, entries: new Map(), present: null };
    expect(await diffWorkspace(hand, new Set())).toEqual({ changes: [], uncaptured: [] });
  });
});

describe('openPause and closePause', () => {
  test('a file deleted before the pause is left out of the census', async () => {
    writeFileSync(fp('gone.txt'), 'x');
    const s = await snap();
    rmSync(fp('gone.txt'));
    const census = await openPause(s);
    expect(census.stats.has('gone.txt')).toBe(false);
  });

  test('a file grown past the per-file cap during the pause is re-captured hash-only', async () => {
    writeFileSync(fp('grown.txt'), 'small');
    const s = await snap();
    const census = await openPause(s);
    writeFileSync(fp('grown.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x62));
    const rebased = await closePause(s, census);
    expect(rebased).toContain('grown.txt');
    expect(s.entries.get('grown.txt')?.content).toBeNull();
  });

  test('a file turned binary during the pause is re-captured hash-only', async () => {
    writeFileSync(fp('turned.txt'), 'plain text here');
    const s = await snap();
    const census = await openPause(s);
    writeFileSync(
      fp('turned.txt'),
      Buffer.concat([Buffer.alloc(50, 0x01), Buffer.alloc(50, 0x61)]),
    );
    await closePause(s, census);
    expect(s.entries.get('turned.txt')?.content).toBeNull();
  });

  test('a file replaced by a directory during the pause drops out of the baseline', async () => {
    writeFileSync(fp('dirnow.txt'), 'was a file');
    const s = await snap();
    const census = await openPause(s);
    rmSync(fp('dirnow.txt'));
    mkdirSync(fp('dirnow.txt'));
    const rebased = await closePause(s, census);
    expect(rebased).toContain('dirnow.txt');
    expect(s.entries.has('dirnow.txt')).toBe(false);
  });

  test('a null baseline present set stays null while arrivals still join', async () => {
    writeFileSync(fp('a.txt'), 'a');
    const hand: WorkspaceSnapshot = {
      root: workDir,
      entries: new Map([['a.txt', { sha: 'x', content: 'a' }]]),
      present: null,
    };
    const census = await openPause(hand);
    expect(census.present).not.toBeNull();
    writeFileSync(fp('b.txt'), 'b');
    await closePause(hand, census);
    expect(hand.entries.has('b.txt')).toBe(true);
    expect(hand.present).toBeNull();
  });

  test('a file deleted before the pause and recreated during it keeps its old entry', async () => {
    writeFileSync(fp('back.txt'), 'original');
    const s = await snap();
    rmSync(fp('back.txt'));
    const census = await openPause(s);
    writeFileSync(fp('back.txt'), 'recreated');
    const rebased = await closePause(s, census);
    expect(s.entries.get('back.txt')?.content).toBe('original');
    expect(rebased).not.toContain('back.txt');
  });

  test('a baseline that exactly fills the byte budget cannot retain a changed file', async () => {
    for (let i = 0; i < 32; i += 1) {
      writeFileSync(fp(`f${i}.txt`), Buffer.alloc(2 * 1024 * 1024, 0x61));
    }
    const s = await snap();
    const census = await openPause(s);
    writeFileSync(fp('f0.txt'), Buffer.alloc(2 * 1024 * 1024, 0x62));
    const rebased = await closePause(s, census);
    expect(rebased).toContain('f0.txt');
    expect(s.entries.has('f0.txt')).toBe(false);
  });
});

describe('diffWorkspace deletion guards', () => {
  test('an already-journaled deletion is skipped', async () => {
    writeFileSync(fp('del.txt'), 'x');
    const s = await snap();
    rmSync(fp('del.txt'));
    const d = await diffWorkspace(s, new Set([fp('del.txt')]));
    expect(d.changes).toHaveLength(0);
    expect(d.uncaptured).toHaveLength(0);
  });

  test('a deleted hash-only file is reported uncaptured, not as a delete', async () => {
    const binary = Buffer.concat([Buffer.alloc(50, 0x01), Buffer.alloc(50, 0x61)]);
    writeFileSync(fp('bin.dat'), binary);
    const s = await snap();
    rmSync(fp('bin.dat'));
    const d = await diffWorkspace(s, new Set());
    expect(d.changes).toHaveLength(0);
    expect(d.uncaptured).toContain('bin.dat');
  });
});
