/**
 * H-7 - durable two-file memory: the cap throws (never silently deletes),
 * writes are atomic at 0600, free text is redaction-scrubbed, the session
 * snapshot is byte-identical when the files are empty, and the memory tool
 * blocks leaf-role writes.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  DURABLE_MEMORY_CAP_CHARS,
  appendDurableMemory,
  appendDurableMemoryRaw,
  durableMemoryDir,
  loadDurableMemorySnapshot,
  readDurableFile,
  removeDurableMemoryLines,
  renderDurableMemoryBlock,
} from '../src/lib/agent/durable-memory.js';

let dir = '';

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = '';
  }
});

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'spycode-dmem-'));
  return dir;
}

describe('readDurableFile', () => {
  test('missing files read as empty (no throw)', () => {
    expect(readDurableFile('memory', freshDir())).toBe('');
    expect(readDurableFile('user', dir)).toBe('');
  });
});

describe('appendDurableMemory', () => {
  test('appends bulleted, redaction-scrubbed lines at 0600', () => {
    const d = freshDir();
    appendDurableMemory('memory', ['user prefers tabs', 'token Bearer abcdefghijklmnop1234'], d);
    const raw = readFileSync(join(durableMemoryDir(d), 'MEMORY.md'), 'utf8');
    expect(raw).toContain('- user prefers tabs');
    expect(raw).not.toContain('abcdefghijklmnop1234');
    expect(raw).toContain('redacted');
    expect(statSync(join(durableMemoryDir(d), 'MEMORY.md')).mode & 0o777).toBe(0o600);
  });

  test('the cap throws - never silent deletion', () => {
    const d = freshDir();
    mkdirSync(durableMemoryDir(d), { recursive: true });
    const big = 'x'.repeat(DURABLE_MEMORY_CAP_CHARS - 10);
    writeFileSync(join(durableMemoryDir(d), 'MEMORY.md'), big, 'utf8');
    expect(() => appendDurableMemory('memory', ['one more line'], d)).toThrow(/full/);
    // The file is untouched.
    expect(readFileSync(join(durableMemoryDir(d), 'MEMORY.md'), 'utf8')).toBe(big);
  });

  test('over-long single entries truncate to the entry cap', () => {
    const d = freshDir();
    appendDurableMemory('memory', ['x'.repeat(50_000)], d);
    const raw = readDurableFile('memory', d);
    expect(raw.length).toBeLessThan(50_000);
    expect(raw.length).toBeGreaterThan(3_900);
  });
});

describe('appendDurableMemoryRaw', () => {
  test('appends structured text without bullets', () => {
    const d = freshDir();
    appendDurableMemoryRaw('memory', '<!-- marker -->\n## Section\n\nbody', d);
    const raw = readDurableFile('memory', d);
    expect(raw).toContain('## Section');
    expect(raw).not.toContain('- ## Section');
  });

  test('the cap throws on raw appends too', () => {
    const d = freshDir();
    expect(() => appendDurableMemoryRaw('memory', 'x'.repeat(DURABLE_MEMORY_CAP_CHARS + 1), d)).toThrow();
    expect(readDurableFile('memory', d)).toBe('');
  });
});

describe('removeDurableMemoryLines', () => {
  test('removes matching lines case-insensitively', () => {
    const d = freshDir();
    appendDurableMemory('memory', ['keep this', 'drop THAT line', 'keep too'], d);
    expect(removeDurableMemoryLines('memory', 'that', d).removed).toBe(1);
    const raw = readDurableFile('memory', d);
    expect(raw).not.toContain('drop');
    expect(raw).toContain('keep this');
  });
});

describe('loadDurableMemorySnapshot / renderDurableMemoryBlock', () => {
  test('empty files render byte-identically (frozen snapshot)', () => {
    const d = freshDir();
    const snap = loadDurableMemorySnapshot(d);
    expect(renderDurableMemoryBlock(snap)).toBe('');
    expect(snap.memory).toBe('');
    expect(snap.user).toBe('');
  });

  test('populated files render both sections', () => {
    const d = freshDir();
    appendDurableMemory('memory', ['the project is x'], d);
    appendDurableMemory('user', ['named reza'], d);
    const block = renderDurableMemoryBlock(loadDurableMemorySnapshot(d));
    expect(block).toContain('the project is x');
    expect(block).toContain('named reza');
  });
});
