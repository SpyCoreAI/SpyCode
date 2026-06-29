import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';

/**
 * Wiring check for the in-session slash commands that drive SPYCODE.md memory.
 * The deep behaviour is covered by memory.test.ts (pure lib); here we only
 * confirm chat.ts's `handleSlashCommand` consumes /init, /memory and /remember
 * and routes them at the real working directory. We chdir into a throwaway
 * project and restore cwd afterwards.
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
  projectDir = mkdtempSync(join(tmpdir(), 'spycode-slash-'));
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'slashfix', scripts: { build: 'x', test: 'y' } }));
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

describe('handleSlashCommand — SPYCODE.md memory', () => {
  test('/memory reports nothing loaded in a fresh project', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/memory', baseCtx);
    expect(r.consumed).toBe(true);
    // /memory now reports the combined project context (Part 3a).
    expect(stderr.join('')).toContain('No project context is loaded');
  });

  test('/remember creates SPYCODE.md and /memory then lists it', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r1 = await handleSlashCommand('/remember prefer the repo_map tool first', baseCtx);
    expect(r1.consumed).toBe(true);
    expect(existsSync(join(projectDir, 'SPYCODE.md'))).toBe(true);
    expect(stderr.join('')).toMatch(/Created|Updated/);

    stderr = [];
    const r2 = await handleSlashCommand('/memory', baseCtx);
    expect(r2.consumed).toBe(true);
    const out = stderr.join('');
    expect(out).toContain('SPYCODE.md');
    expect(out).toContain('Project context injected');
  });

  test('/remember with no note prints usage', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/remember', baseCtx);
    expect(r.consumed).toBe(true);
    expect(stderr.join('')).toContain('Usage: /remember');
    expect(existsSync(join(projectDir, 'SPYCODE.md'))).toBe(false);
  });

  test('/init generates SPYCODE.md, and refuses to overwrite on a second call', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r1 = await handleSlashCommand('/init', baseCtx);
    expect(r1.consumed).toBe(true);
    expect(existsSync(join(projectDir, 'SPYCODE.md'))).toBe(true);
    expect(stderr.join('')).toContain('Created');

    stderr = [];
    const r2 = await handleSlashCommand('/init', baseCtx);
    expect(r2.consumed).toBe(true);
    expect(stderr.join('')).toMatch(/already exists/);
  });
});
