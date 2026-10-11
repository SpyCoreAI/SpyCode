import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { freshConfigDir } from './helpers.js';
import { configureOutput } from '../src/lib/output.js';
import { registerInitCommand } from '../src/commands/init.js';

/**
 * `spycore init` (F19) - the non-interactive twin of `/init`.
 *
 * Pinned here:
 * - creates all three living-memory files in an empty project, via the SAME
 *   generators the slash command uses (byte-identical content);
 * - idempotent: a second run touches nothing and reports every file skipped;
 * - --dry-run previews the plan and writes nothing;
 * - --force overwrites existing files, but only with --yes in non-TTY -
 *   without it the command refuses (exit 1) and leaves every file intact;
 * - --json emits a structured payload instead of human text.
 *
 * We chdir into a throwaway project - never the repo root - and restore
 * cwd + stdio after each test.
 */

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
  projectDir = mkdtempSync(join(tmpdir(), 'spycode-init-cmd-'));
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

describe('spycore init', () => {
  test('creates all three files in an empty project', async () => {
    await runInit([]);
    for (const f of FILES) {
      expect(existsSync(join(projectDir, f))).toBe(true);
    }
    expect(readFileSync(join(projectDir, 'SPYCODE.md'), 'utf8')).toContain('SpyCode Project Memory');
    expect(readFileSync(join(projectDir, 'CODEBASE_GUIDE.md'), 'utf8')).toContain('Codebase Guide');
    expect(readFileSync(join(projectDir, 'CODEBASE_CHANGELOG.md'), 'utf8')).toContain(
      'Initialized project memory.',
    );
    const out = stdout.join('');
    expect(out).toContain('Created SPYCODE.md');
    expect(out).toContain('Created CODEBASE_GUIDE.md');
    expect(out).toContain('Created CODEBASE_CHANGELOG.md');
  });

  test('second run is idempotent - existing files untouched, reported skipped', async () => {
    await runInit([]);
    const before = FILES.map((f) => readFileSync(join(projectDir, f), 'utf8'));
    stdout = [];
    await runInit([]);
    FILES.forEach((f, i) => {
      expect(readFileSync(join(projectDir, f), 'utf8')).toBe(before[i]);
    });
    const out = stdout.join('');
    for (const f of FILES) {
      expect(out).toContain(`${f} already exists - skipped`);
    }
  });

  test('--dry-run previews without writing anything', async () => {
    await runInit(['--dry-run']);
    for (const f of FILES) {
      expect(existsSync(join(projectDir, f))).toBe(false);
    }
    const out = stdout.join('');
    for (const f of FILES) {
      expect(out).toContain(`[dry-run] would create ${f}`);
    }
  });

  test('--dry-run --force previews overwrites and writes nothing', async () => {
    await runInit([]);
    const before = readFileSync(join(projectDir, 'SPYCODE.md'), 'utf8');
    stdout = [];
    await runInit(['--dry-run', '--force']);
    expect(readFileSync(join(projectDir, 'SPYCODE.md'), 'utf8')).toBe(before);
    const out = stdout.join('');
    for (const f of FILES) {
      expect(out).toContain(`[dry-run] would overwrite ${f}`);
    }
  });

  test('--force --yes overwrites existing files', async () => {
    await runInit([]);
    writeFileSync(join(projectDir, 'SPYCODE.md'), 'HAND-EDITED', 'utf8');
    stdout = [];
    await runInit(['--force', '--yes']);
    const content = readFileSync(join(projectDir, 'SPYCODE.md'), 'utf8');
    expect(content).not.toBe('HAND-EDITED');
    expect(content).toContain('SpyCode Project Memory');
    expect(stdout.join('')).toContain('Overwrote SPYCODE.md');
  });

  test('--force without --yes refuses in non-TTY and leaves files intact', async () => {
    await runInit([]);
    const before = FILES.map((f) => readFileSync(join(projectDir, f), 'utf8'));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    await runInit(['--force']);
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr.join('')).toContain('Refusing to overwrite');
    FILES.forEach((f, i) => {
      expect(readFileSync(join(projectDir, f), 'utf8')).toBe(before[i]);
    });
  });

  test('--json emits a structured payload', async () => {
    // The --json flag itself is global plumbing owned by src/index.ts; here we
    // exercise the command's JSON code path via the output config directly.
    configureOutput({ json: true, color: false });
    await runInit([]);
    const payload = JSON.parse(stdout.join('')) as {
      dryRun: boolean;
      force: boolean;
      files: Array<{ file: string; path: string; existed: boolean; action: string }>;
    };
    expect(payload.dryRun).toBe(false);
    expect(payload.force).toBe(false);
    expect(payload.files.map((f) => f.file).sort()).toEqual([...FILES].sort());
    expect(payload.files.every((f) => f.action === 'created' && f.existed === false)).toBe(true);
    expect(payload.files.every((f) => f.path.endsWith(`/${f.file}`))).toBe(true);
  });
});
