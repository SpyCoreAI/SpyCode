import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { freshConfigDir } from './helpers.js';
import { configureOutput } from '../src/lib/output.js';
import { registerInitCommand } from '../src/commands/init.js';

/**
 * H10 - `spycore init --force` deleted the original file BEFORE
 * regenerating it, and a generator failure only logged a warning: the
 * user's file was already gone. The original is now held in memory and
 * restored byte-for-byte when generation throws.
 *
 * The failure is injected by mocking the SPYCODE.md generator to throw;
 * the other two generators run for real, so the test also proves one
 * failing file still does not block the others.
 */
vi.mock('../src/lib/memory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/memory.js')>()),
  initMemoryFile: vi.fn(async () => {
    throw new Error('simulated generator failure');
  }),
}));

const FILES = ['SPYCODE.md', 'CODEBASE_GUIDE.md', 'CODEBASE_CHANGELOG.md'];

let projectDir: string;
let origCwd: string;
let stdout: string[];
let stderr: string[];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

async function runInit(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerInitCommand(program);
  await program.parseAsync(['node', 'spycore', 'init', ...args], { from: 'node' });
}

beforeEach(() => {
  freshConfigDir();
  configureOutput({ json: false, color: false });
  origCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'spycode-init-restore-'));
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'initfix', scripts: { build: 'x' } }),
  );
  process.chdir(projectDir);
  stdout = [];
  stderr = [];
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.chdir(origCwd);
  rmSync(projectDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('spycore init --force restores the original on generator failure', () => {
  test('a failing generator leaves the original file byte-identical', async () => {
    const original = '# My hand-written project memory\n\nDo not lose this.\n';
    writeFileSync(join(projectDir, 'SPYCODE.md'), original, 'utf8');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runInit(['--force', '--yes']);
    // The run fails overall (one file errored) ...
    expect(exit).toHaveBeenCalledWith(1);
    // ... but the original SPYCODE.md survived byte-for-byte.
    expect(readFileSync(join(projectDir, 'SPYCODE.md'), 'utf8')).toBe(original);
    expect(stderr.join('')).toContain('Failed to generate SPYCODE.md');
    // ... and the other two files were still (over)written, not blocked.
    for (const f of ['CODEBASE_GUIDE.md', 'CODEBASE_CHANGELOG.md']) {
      expect(existsSync(join(projectDir, f))).toBe(true);
    }
  });
});
