import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';

/**
 * Wiring check for the Part 3a slash surfaces: /init now creates THREE files
 * independently, /changelog views the newest entries, and /memory reflects the
 * combined context. The deep behaviour lives in the pure-lib tests; here we just
 * confirm chat.ts's handleSlashCommand routes them at the real cwd. We chdir into
 * a throwaway project — never the repo root — and restore cwd + stderr after.
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
  projectDir = mkdtempSync(join(tmpdir(), 'spycode-cl-slash-'));
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'clfix', scripts: { build: 'x', test: 'y' } }),
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

describe('handleSlashCommand — /init creates all three files', () => {
  test('/init generates SPYCODE.md + CODEBASE_GUIDE.md + CODEBASE_CHANGELOG.md', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/init', baseCtx);
    expect(r.consumed).toBe(true);
    expect(existsSync(join(projectDir, 'SPYCODE.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'CODEBASE_GUIDE.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'CODEBASE_CHANGELOG.md'))).toBe(true);
    expect(stderr.join('')).toContain('CODEBASE_CHANGELOG.md');
  });

  test('the changelog is created INDEPENDENTLY (a pre-existing one does not block the others)', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    writeFileSync(join(projectDir, 'CODEBASE_CHANGELOG.md'), 'PRE-EXISTING LOG', 'utf8');

    const r = await handleSlashCommand('/init', baseCtx);
    expect(r.consumed).toBe(true);
    // The other two are still created…
    expect(existsSync(join(projectDir, 'SPYCODE.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'CODEBASE_GUIDE.md'))).toBe(true);
    // …and the pre-existing changelog is left untouched.
    expect(readFileSync(join(projectDir, 'CODEBASE_CHANGELOG.md'), 'utf8')).toBe('PRE-EXISTING LOG');
    expect(stderr.join('')).toMatch(/CODEBASE_CHANGELOG\.md already exists/);
  });

  test('/init a second time reports all three already exist', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    await handleSlashCommand('/init', baseCtx);
    stderr = [];
    const r = await handleSlashCommand('/init', baseCtx);
    expect(r.consumed).toBe(true);
    const out = stderr.join('');
    expect(out).toMatch(/SPYCODE\.md already exists/);
    expect(out).toMatch(/CODEBASE_GUIDE\.md already exists/);
    expect(out).toMatch(/CODEBASE_CHANGELOG\.md already exists/);
  });
});

describe('handleSlashCommand — /changelog', () => {
  test('absent file prints the /init hint', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/changelog', baseCtx);
    expect(r.consumed).toBe(true);
    const out = stderr.join('');
    expect(out).toContain('No CODEBASE_CHANGELOG.md');
    expect(out).toContain('/init');
  });

  test('after /init, /changelog lists the seeded entry', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    await handleSlashCommand('/init', baseCtx);
    stderr = [];
    const r = await handleSlashCommand('/changelog', baseCtx);
    expect(r.consumed).toBe(true);
    const out = stderr.join('');
    expect(out).toContain('CODEBASE_CHANGELOG.md');
    expect(out).toContain('Initialized project memory.');
  });
});

describe('handleSlashCommand — /memory after /init reflects all context', () => {
  test('/memory shows the guide + changelog parts once generated', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    await handleSlashCommand('/init', baseCtx);
    stderr = [];
    const r = await handleSlashCommand('/memory', baseCtx);
    expect(r.consumed).toBe(true);
    const out = stderr.join('');
    expect(out).toContain('Project context injected');
    expect(out).toContain('CODEBASE_GUIDE.md');
    expect(out).toContain('CODEBASE_CHANGELOG.md');
  });

  test('injectChangelog=false hides the changelog from /memory', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const { getConfigStore } = await import('../src/lib/config.js');
    await handleSlashCommand('/init', baseCtx);
    getConfigStore().set('injectChangelog', false);
    stderr = [];
    await handleSlashCommand('/memory', baseCtx);
    const out = stderr.join('');
    // The changelog row shows as disabled rather than an injected part.
    expect(out).toContain('disabled');
  });
});
