import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LIMITS,
  dispatchTool,
  type ToolContext,
  type ToolLimits,
} from '../src/lib/agent/tools.js';
import { snapshotStructure } from '../src/lib/agent/task-memory.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';

/** Approve everything: the tools under test are the file tools, not the gate. */
const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });

describe('R1-4 write_file / edit_file enforce the read_file size cap', () => {
  let workDir: string;
  // An 11-byte file against a 4-byte cap - the same shape the loop tests
  // pin for read_file.
  const tiny: ToolLimits = { ...DEFAULT_LIMITS, maxFileBytes: 4 };
  const ctx = (limits: ToolLimits = DEFAULT_LIMITS): ToolContext => ({
    cwd: workDir,
    limits,
    requestApproval: ACCEPT,
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-r1-sizecap-'));
    writeFileSync(join(workDir, 'big.txt'), '0123456789\n');
    writeFileSync(join(workDir, 'small.txt'), 'abc\n');
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test('write_file refuses an existing file over the cap, like read_file', async () => {
    const r = await dispatchTool('write_file', { path: 'big.txt', content: 'new\n' }, ctx(tiny));
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/file too large to write \(11 B\)/);
  });

  test('edit_file refuses an existing file over the cap, like read_file', async () => {
    const r = await dispatchTool(
      'edit_file',
      { path: 'big.txt', old_str: '0123', new_str: 'XXXX' },
      ctx(tiny),
    );
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/file too large to edit \(11 B\)/);
  });

  test('the cap does not touch files that fit, or files being created', async () => {
    const edited = await dispatchTool(
      'edit_file',
      { path: 'small.txt', old_str: 'abc', new_str: 'xyz' },
      ctx(tiny),
    );
    expect(edited.ok).toBe(true);
    const created = await dispatchTool(
      'write_file',
      { path: 'new.txt', content: 'brand new\n' },
      ctx(tiny),
    );
    expect(created.ok).toBe(true);
  });
});

describe('R1-7 traversal ignore lists are case-insensitive', () => {
  let workDir: string;
  const ctx = (): ToolContext => ({ cwd: workDir, limits: DEFAULT_LIMITS, requestApproval: ACCEPT });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-r1-ignore-'));
    for (const d of ['Node_Modules', 'BUILD', 'Dist', '.GIT']) {
      mkdirSync(join(workDir, d, 'pkg'), { recursive: true });
      writeFileSync(join(workDir, d, 'pkg', 'index.js'), 'marker\n');
    }
    writeFileSync(join(workDir, 'ok.js'), 'ok\n');
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  test('list_dir hides differently-cased ignored directories', async () => {
    const r = await dispatchTool('list_dir', { path: '.' }, ctx());
    expect(r.ok).toBe(true);
    for (const d of ['Node_Modules/', 'BUILD/', 'Dist/', '.GIT/']) {
      expect(r.content, d).not.toContain(d);
    }
    expect(r.content).toContain('ok.js');
  });

  test('glob does not enumerate differently-cased ignored trees', async () => {
    const r = await dispatchTool('glob', { pattern: '**/*.js' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('ok.js');
    expect(r.content).not.toContain('Node_Modules');
    expect(r.content).not.toContain('BUILD');
    expect(r.content).not.toContain('Dist');
    expect(r.content).not.toContain('.GIT');
  });

  test('read_file refuses a file inside a differently-cased ignored directory', async () => {
    const r = await dispatchTool('read_file', { path: 'Node_Modules/pkg/index.js' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/excluded directory/);
  });

  test('task-memory snapshot excludes differently-cased ignored directories', () => {
    const snap = snapshotStructure(workDir);
    expect(snap.dirs).not.toContain('Node_Modules');
    expect(snap.dirs).not.toContain('BUILD');
    expect(snap.dirs).not.toContain('Dist');
    expect(snap.dirs).not.toContain('.GIT');
  });
});
