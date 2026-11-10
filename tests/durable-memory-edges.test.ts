import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests, getConfigPath } from '../src/lib/config.js';
import {
  appendDurableMemory,
  appendDurableMemoryRaw,
  DURABLE_MEMORY_CAP_CHARS,
  readDurableFile,
  removeDurableMemoryLines,
  renderDurableMemoryBlock,
  loadDurableMemorySnapshot,
} from '../src/lib/agent/durable-memory.js';
import { DEFAULT_LIMITS, dispatchTool, type ToolContext } from '../src/lib/agent/tools.js';
import { headlessApproval } from '../src/lib/agent/approval.js';

let cfgDir: string;

beforeEach(() => {
  freshConfigDir();
  __resetConfigForTests();
  cfgDir = dirname(getConfigPath());
});

afterEach(() => {
  // Config dirs are fresh per test via freshConfigDir; nothing to clean here.
});

const memDir = (): string => join(cfgDir, 'memories');
const memPath = (): string => join(memDir(), 'MEMORY.md');
const userPath = (): string => join(memDir(), 'USER.md');

describe('durable-memory readers and writers', () => {
  test('NUL bytes are stripped; unreadable files read as empty', () => {
    mkdirSync(memDir(), { recursive: true });
    writeFileSync(memPath(), 'has\0nul');
    expect(readDurableFile('memory', cfgDir)).toBe('hasnul');
    rmSync(memPath());
    mkdirSync(memPath());
    expect(readDurableFile('memory', cfgDir)).toBe('');
  });

  test('append rejects empty input and over-cap writes', () => {
    expect(() => appendDurableMemory('memory', ['   '], cfgDir)).toThrow(/nothing to remember/);
    mkdirSync(memDir(), { recursive: true });
    writeFileSync(memPath(), 'x'.repeat(DURABLE_MEMORY_CAP_CHARS - 10));
    expect(() => appendDurableMemory('memory', ['one more line'], cfgDir)).toThrow(/is full/);
  });

  test('raw append: empty rejection, second-append join, over-cap', () => {
    expect(() => appendDurableMemoryRaw('memory', '   ', cfgDir)).toThrow(/nothing to import/);
    appendDurableMemoryRaw('memory', 'first section', cfgDir);
    const res = appendDurableMemoryRaw('memory', 'second section', cfgDir);
    expect(res.chars).toBeGreaterThan(0);
    const text = readFileSync(memPath(), 'utf8');
    expect(text).toContain('first section');
    expect(text).toContain('second section');
    writeFileSync(memPath(), 'x'.repeat(DURABLE_MEMORY_CAP_CHARS - 5));
    expect(() => appendDurableMemoryRaw('memory', 'one more', cfgDir)).toThrow(/is full/);
  });

  test('remove rejects an empty match and reports zero on a missing file', () => {
    expect(() => removeDurableMemoryLines('memory', '   ', cfgDir)).toThrow(/match must not be empty/);
    expect(removeDurableMemoryLines('memory', 'zzz', cfgDir)).toEqual({ removed: 0, chars: 0 });
  });

  test('render block covers user-only, memory-only, and empty snapshots', () => {
    expect(renderDurableMemoryBlock(loadDurableMemorySnapshot(cfgDir))).toBe('');
    appendDurableMemory('user', ['likes tea'], cfgDir);
    const userOnly = renderDurableMemoryBlock(loadDurableMemorySnapshot(cfgDir));
    expect(userOnly).toContain('User profile');
    expect(userOnly).not.toContain('Durable memory');
    appendDurableMemory('memory', ['a lesson'], cfgDir);
    const both = renderDurableMemoryBlock(loadDurableMemorySnapshot(cfgDir));
    expect(both).toContain('User profile');
    expect(both).toContain('Durable memory');
    expect(existsSync(userPath())).toBe(true);
  });
});

describe('memory tool dispatch arms', () => {
  // Memory writes are approval-gated (mutating tool): approve them here so
  // the add/remove arms exercise the write path, not the approval gate.
  const run = (args: unknown, extra: Partial<ToolContext> = {}) =>
    dispatchTool('memory', args, {
      cwd: tmpdir(),
      limits: DEFAULT_LIMITS,
      requestApproval: headlessApproval(true),
      ...extra,
    });
  const runUnapproved = (args: unknown) =>
    dispatchTool('memory', args, { cwd: tmpdir(), limits: DEFAULT_LIMITS });

  test('no action defaults to view, invalid file and action throw', async () => {
    const viewed = await run({});
    expect(viewed.ok).toBe(true);
    expect(viewed.summary).toBe('durable memory shown');
    const badFile = await run({ action: 'view', file: 'bogus' });
    expect(badFile.ok).toBe(false);
    expect(badFile.content).toContain('file must be "memory" or "user"');
    const badAction = await run({ action: 'bogus' });
    expect(badAction.ok).toBe(false);
    expect(badAction.content).toContain('action must be "view", "add", or "remove"');
  });

  test('the user file also refuses over-cap appends', async () => {
    mkdirSync(memDir(), { recursive: true });
    writeFileSync(userPath(), 'x'.repeat(DURABLE_MEMORY_CAP_CHARS - 10));
    expect(() => appendDurableMemory('user', ['one more line'], cfgDir)).toThrow(/is full/);
    writeFileSync(userPath(), 'x'.repeat(DURABLE_MEMORY_CAP_CHARS - 5));
    expect(() => appendDurableMemoryRaw('user', 'one more', cfgDir)).toThrow(/is full/);
  });

  test('view shows real content instead of (empty) when files exist', async () => {
    appendDurableMemory('memory', ['a memory line'], cfgDir);
    appendDurableMemory('user', ['a user line'], cfgDir);
    const viewed = await run({ action: 'view' });
    expect(viewed.content).toContain('a memory line');
    expect(viewed.content).toContain('a user line');
    expect(viewed.content).not.toContain('(empty)');
  });

  test('add with no file defaults to the memory file', async () => {
    const added = await run({ action: 'add', text: 'a default memory' });
    expect(added.ok).toBe(true);
    expect(added.summary).toBe('remembered in MEMORY.md');
    expect(added.content).toContain('Appended to MEMORY.md');
  });

  test('remove drops matching lines from the memory file', async () => {
    appendDurableMemory('memory', ['remove me please', 'keep me'], cfgDir);
    const removed = await run({ action: 'remove', match: 'remove me' });
    expect(removed.ok).toBe(true);
    expect(removed.summary).toBe('1 line removed');
    expect(readDurableFile('memory', cfgDir)).not.toContain('remove me please');
    expect(readDurableFile('memory', cfgDir)).toContain('keep me');
  });

  test('the landed write is exactly the approved diff, even if the file changed during approval', async () => {
    // TOCTOU: the approved diff was computed from the pre-approval read,
    // but the write used to RE-READ the file - so for `remove`, a line
    // added during the (unbounded) approval pause that matched the needle
    // was deleted without ever appearing in the approved diff. The write
    // now reuses the approved snapshot, so exactly the approved diff lands.
    // Trade-off, pinned here: a concurrent edit made during the pause is
    // overwritten by the approved snapshot (same last-writer-wins as an
    // approved write_file), rather than silently changing what lands.
    appendDurableMemory('memory', ['keep me'], cfgDir);
    const mutatingApproval = async (): Promise<{ approved: boolean }> => {
      appendDurableMemory('memory', ['concurrent line, added during approval'], cfgDir);
      return { approved: true };
    };
    const added = await dispatchTool(
      'memory',
      { action: 'add', text: 'a new entry' },
      { cwd: tmpdir(), limits: DEFAULT_LIMITS, requestApproval: mutatingApproval },
    );
    expect(added.ok).toBe(true);
    expect(readDurableFile('memory', cfgDir)).toBe('- keep me\n- a new entry\n');
  });

  test('remove of two lines reports the plural', async () => {
    appendDurableMemory('memory', ['drop one', 'drop two', 'keep me'], cfgDir);
    const removed = await run({ action: 'remove', match: 'drop' });
    expect(removed.ok).toBe(true);
    expect(removed.summary).toBe('2 lines removed');
    expect(removed.content).toContain('Removed 2 lines containing "drop"');
    expect(readDurableFile('memory', cfgDir)).toContain('keep me');
  });

  test('remove from the user file names USER.md', async () => {
    appendDurableMemory('user', ['drop this', 'keep this'], cfgDir);
    const removed = await run({ action: 'remove', file: 'user', match: 'drop' });
    expect(removed.ok).toBe(true);
    expect(removed.summary).toBe('1 line removed');
    expect(removed.content).toContain('from USER.md');
    expect(readDurableFile('user', cfgDir)).toContain('keep this');
  });

  test('add to the user file names USER.md', async () => {
    const added = await run({ action: 'add', file: 'user', text: 'prefers tea' });
    expect(added.ok).toBe(true);
    expect(added.summary).toBe('remembered in USER.md');
    expect(added.content).toContain('Appended to USER.md');
  });

  test('a rejected approval blocks the write - nothing lands on disk', async () => {
    const rejected = await runUnapproved({ action: 'add', text: 'never written' });
    expect(rejected.ok).toBe(false);
    expect(rejected.content).toMatch(/not approved|approval/i);
    expect(readDurableFile('memory', cfgDir)).not.toContain('never written');
    appendDurableMemory('memory', ['drop me'], cfgDir);
    const rejectedRemove = await runUnapproved({ action: 'remove', match: 'drop me' });
    expect(rejectedRemove.ok).toBe(false);
    expect(readDurableFile('memory', cfgDir)).toContain('drop me');
  });

  test('plan mode blocks memory writes (and view - the snapshot is already frozen in the prompt)', async () => {
    const blocked = await run({ action: 'add', text: 'plan write' }, { planMode: true });
    expect(blocked.ok).toBe(false);
    expect(blocked.content).toContain('disabled in planning mode');
    expect(readDurableFile('memory', cfgDir)).not.toContain('plan write');
    const blockedView = await run({ action: 'view' }, { planMode: true });
    expect(blockedView.ok).toBe(false);
    expect(blockedView.content).toContain('disabled in planning mode');
  });
});
