import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendMemoryNote,
  buildContextInjection,
  formatContextInjection,
  formatLoadedMemory,
  loadMemory,
} from '../src/lib/memory.js';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'spycli-memory-'));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const fp = (name: string): string => join(workDir, name);

describe('loadMemory edges', () => {
  test('the budget drops the largest section first', () => {
    writeFileSync(fp('SPYCODE.md'), `Project.\n${'p'.repeat(20000)}\n`);
    writeFileSync(fp('SPYCODE.local.md'), `Local.\n${'l'.repeat(40000)}\n`);
    const mem = loadMemory({ cwd: workDir });
    expect(mem.files).toHaveLength(1);
    expect(mem.files[0]!.scope).toBe('project');
    expect(mem.notices.some((n) => n.includes('Dropped'))).toBe(true);
  });

  test('a duplicate candidate path is loaded once, and a blank file is skipped', () => {
    // resolve() is lexical, so a symlink does NOT dedupe; the dedupe arm
    // fires when two candidates share one lexical path: cwd inside the
    // global dir makes the global and project candidates identical.
    const home = mkdtempSync(join(tmpdir(), 'spycli-home-'));
    const globalDir = join(home, '.spycore');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'SPYCODE.md'), 'Shared notes.\n');
    const mem = loadMemory({ cwd: globalDir, home });
    expect(mem.files).toHaveLength(1);
    expect(mem.files[0]!.scope).toBe('global');
    rmSync(home, { recursive: true, force: true });

    writeFileSync(fp('SPYCODE.md'), '   \n  \n');
    const blank = loadMemory({ cwd: workDir });
    expect(blank.files).toHaveLength(0);
  });

  test('a single one-line file renders singular counts', () => {
    writeFileSync(fp('SPYCODE.md'), 'Only line.\n');
    const mem = loadMemory({ cwd: workDir });
    const text = formatLoadedMemory(mem);
    expect(text).toContain('(1 file,');
    expect(text).toContain('1 line,');
  });

  test('two files render the plural count', () => {
    writeFileSync(fp('SPYCODE.md'), 'Project notes.\n');
    writeFileSync(fp('SPYCODE.local.md'), 'Personal notes.\n');
    const mem = loadMemory({ cwd: workDir });
    expect(mem.files).toHaveLength(2);
    expect(formatLoadedMemory(mem)).toContain('(2 files,');
  });
});

describe('buildContextInjection edges', () => {
  test('memory is kept whole even over a tiny combined budget', () => {
    writeFileSync(fp('SPYCODE.md'), `MARKER-KEEP\n${'m'.repeat(500)}\n`);
    writeFileSync(fp('CODEBASE_GUIDE.md'), `# Guide\n\n${'g'.repeat(1000)}\n`);
    const inj = buildContextInjection({ cwd: workDir, contextBudgetChars: 50 });
    expect(inj.block).toContain('MARKER-KEEP');
    expect(inj.block).toContain('m'.repeat(500));
    expect(inj.parts.find((p) => p.kind === 'memory')?.status).toBe('full');
  });

  test('a guide over its part budget is truncated with a notice', () => {
    writeFileSync(fp('CODEBASE_GUIDE.md'), `# Guide\n\n${'g'.repeat(5000)}\n`);
    const inj = buildContextInjection({ cwd: workDir, guideBudgetChars: 100 });
    const guide = inj.parts.find((p) => p.kind === 'guide');
    expect(guide?.status).toBe('truncated');
    expect(inj.notices.some((n) => n.includes('Trimmed CODEBASE_GUIDE.md'))).toBe(true);
    expect(formatContextInjection(inj)).toContain('[truncated]');
  });

  test('a changelog over its part budget is truncated with a notice', () => {
    writeFileSync(fp('CODEBASE_CHANGELOG.md'), `## 2026-01-01\n\n${'c'.repeat(5000)}\n`);
    const inj = buildContextInjection({ cwd: workDir, changelogBudgetChars: 100 });
    const log = inj.parts.find((p) => p.kind === 'changelog');
    expect(log?.status).toBe('truncated');
    expect(inj.notices.some((n) => n.includes('Trimmed CODEBASE_CHANGELOG.md'))).toBe(true);
  });

  test('a part too small to truncate usefully is dropped', () => {
    // A dropped part only renders when another part stays active.
    writeFileSync(fp('SPYCODE.md'), 'Small memory.\n');
    writeFileSync(fp('CODEBASE_GUIDE.md'), `# Guide\n\n${'g'.repeat(1000)}\n`);
    const inj = buildContextInjection({
      cwd: workDir,
      contextBudgetChars: 50,
      injectChangelog: false,
    });
    const guide = inj.parts.find((p) => p.kind === 'guide');
    expect(guide?.status).toBe('dropped');
    expect(formatContextInjection(inj)).toContain('[dropped - over budget]');
  });

  test('disabled parts produce the off note when nothing is active', () => {
    writeFileSync(fp('CODEBASE_GUIDE.md'), '# Guide\n\nBody.\n');
    writeFileSync(fp('CODEBASE_CHANGELOG.md'), '## 2026-01-01\n\nBody.\n');
    const inj = buildContextInjection({
      cwd: workDir,
      injectGuide: false,
      injectChangelog: false,
    });
    expect(formatContextInjection(inj)).toContain('some parts are disabled');
  });
});

describe('appendMemoryNote edges', () => {
  test('a body without a trailing newline gains one before the bullet', () => {
    writeFileSync(fp('SPYCODE.md'), 'Existing line');
    const r = appendMemoryNote(workDir, 'new note');
    expect(r.created).toBe(false);
    const body = readFileSync(fp('SPYCODE.md'), 'utf8');
    expect(body).toBe('Existing line\n- new note\n');
  });
});
