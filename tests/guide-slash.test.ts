import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';

/**
 * Wiring check for the CODEBASE_GUIDE.md slash surfaces (Part 2). The deep
 * generator behaviour is covered by codebase-guide.test.ts (pure lib); here we
 * confirm chat.ts's `handleSlashCommand` routes /init (BOTH files) and /guide at
 * the real working directory. We chdir into a throwaway project — never the repo
 * root — and restore cwd + stderr afterwards.
 */

const baseCtx = {
  json: false,
  color: false,
  currentConvo: 'cnv_test',
  apiUrl: undefined,
  model: 'charon' as const,
};

let projectDir: string;
let origCwd: string;
let stderr: string[];
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  freshConfigDir();
  origCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'spycode-guide-slash-'));
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'guidefix', scripts: { build: 'x', test: 'y' } }),
  );
  process.chdir(projectDir);
  stderr = [];
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origStderrWrite;
  process.chdir(origCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

describe('handleSlashCommand — CODEBASE_GUIDE.md', () => {
  test('/guide reports no guide in a fresh project', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/guide', baseCtx);
    expect(r.consumed).toBe(true);
    expect(stderr.join('')).toContain('No CODEBASE_GUIDE.md');
  });

  test('/init generates BOTH SPYCODE.md and CODEBASE_GUIDE.md', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/init', baseCtx);
    expect(r.consumed).toBe(true);
    expect(existsSync(join(projectDir, 'SPYCODE.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'CODEBASE_GUIDE.md'))).toBe(true);
    const out = stderr.join('');
    expect(out).toContain('SPYCODE.md');
    expect(out).toContain('CODEBASE_GUIDE.md');
  });

  test('/init handles the two files INDEPENDENTLY (one existing does not block the other)', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    // Pre-create only CODEBASE_GUIDE.md.
    writeFileSync(join(projectDir, 'CODEBASE_GUIDE.md'), 'PRE-EXISTING GUIDE', 'utf8');

    const r = await handleSlashCommand('/init', baseCtx);
    expect(r.consumed).toBe(true);
    // SPYCODE.md still gets created…
    expect(existsSync(join(projectDir, 'SPYCODE.md'))).toBe(true);
    // …and the pre-existing guide is left untouched, with a refresh hint.
    expect(readFileSync(join(projectDir, 'CODEBASE_GUIDE.md'), 'utf8')).toBe('PRE-EXISTING GUIDE');
    const out = stderr.join('');
    expect(out).toMatch(/CODEBASE_GUIDE\.md already exists/);
    expect(out).toContain('/guide refresh');
  });

  test('/init a second time reports both files already exist', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    await handleSlashCommand('/init', baseCtx);
    stderr = [];
    const r = await handleSlashCommand('/init', baseCtx);
    expect(r.consumed).toBe(true);
    const out = stderr.join('');
    expect(out).toMatch(/SPYCODE\.md already exists/);
    expect(out).toMatch(/CODEBASE_GUIDE\.md already exists/);
  });

  test('/guide refresh regenerates + overwrites the file', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    writeFileSync(join(projectDir, 'CODEBASE_GUIDE.md'), '# stale\n\nstale body\n', 'utf8');
    const r = await handleSlashCommand('/guide refresh', baseCtx);
    expect(r.consumed).toBe(true);
    expect(stderr.join('')).toContain('Regenerated CODEBASE_GUIDE.md');
    const content = readFileSync(join(projectDir, 'CODEBASE_GUIDE.md'), 'utf8');
    expect(content).toContain('Codebase Guide');
    expect(content).not.toContain('stale body');
  });

  test('/guide refresh preserves a hand-written "## Notes (manual)" section', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    writeFileSync(
      join(projectDir, 'CODEBASE_GUIDE.md'),
      '# x\n\n## Notes (manual)\n\n- keep me\n',
      'utf8',
    );
    const r = await handleSlashCommand('/guide refresh', baseCtx);
    expect(r.consumed).toBe(true);
    const out = stderr.join('');
    expect(out).toContain('Notes (manual)');
    expect(readFileSync(join(projectDir, 'CODEBASE_GUIDE.md'), 'utf8')).toContain('- keep me');
  });

  test('/guide (no arg) reports presence + line count after generation', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    await handleSlashCommand('/init', baseCtx);
    stderr = [];
    const r = await handleSlashCommand('/guide', baseCtx);
    expect(r.consumed).toBe(true);
    const out = stderr.join('');
    expect(out).toContain('CODEBASE_GUIDE.md');
    expect(out).toMatch(/\d+ lines/);
  });

  test('/guide with an unknown subcommand explains itself', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/guide bogus', baseCtx);
    expect(r.consumed).toBe(true);
    expect(stderr.join('')).toContain('Unknown /guide subcommand');
  });
});
