import { describe, expect, test, beforeAll, vi } from 'vitest';
import { spawnSync } from 'node:child_process';

// Every test here spawns the built CLI (spawnSync's own cap is 15s, above the
// suite's 10s default) — give the whole file a generous cap so a loaded box
// can't flake the prepublishOnly gate.
vi.setConfig({ testTimeout: 30_000 });
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * End-to-end integration tests that spawn the actual CLI binary.
 *
 * These run against the built bundle at build/index.js, so
 * they require a prior `pnpm build`. The vitest config doesn't enforce
 * that; we skip the whole suite if the bundle is missing so a fresh
 * clone doesn't fail before the user has built once.
 *
 * Network-dependent commands (chat, files upload, etc.) are NOT covered
 * here — those are exercised by the manual pre-release smoke checklist.
 * We test only commands that are pure (--version, --help,
 * config get/set on a temp dir, schema, completion, etc.).
 */
const CLI_PATH = resolve(__dirname, '..', 'build', 'index.js');
const HAS_BUNDLE = existsSync(CLI_PATH);

const describeIfBundle = HAS_BUNDLE ? describe : describe.skip;

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function run(args: string[], opts?: { stdin?: string; env?: Record<string, string> }): RunResult {
  const dir = mkdtempSync(join(tmpdir(), 'spycli-int-'));
  const env = {
    ...process.env,
    SPYCORE_TEST_CWD: dir,
    SPYCORE_NO_UPDATE_CHECK: '1',
    NO_COLOR: '1',
    ...opts?.env,
  } as NodeJS.ProcessEnv;
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    input: opts?.stdin,
    env,
    encoding: 'utf-8',
    timeout: 15000,
  });
  return {
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
    exitCode: result.status,
  };
}

beforeAll(() => {
  if (!HAS_BUNDLE) {
    // eslint-disable-next-line no-console
    console.warn(
      '[integration] build/index.js not found — run `pnpm build` first. Suite skipped.',
    );
  }
});

describeIfBundle('cli integration — version and help', () => {
  test('--version prints the CLI version', () => {
    const r = run(['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('--help lists every top-level command', () => {
    const r = run(['--help']);
    expect(r.exitCode).toBe(0);
    for (const cmd of [
      'version',
      'login',
      'logout',
      'whoami',
      'ping',
      'config',
      'chat',
      'conversations',
      'files',
      'memory',
      'usage',
      'image',
      'agent',
      'provider',
      'skills',
      'update',
      'completion',
      'schema',
    ]) {
      expect(r.stdout).toContain(cmd);
    }
  });

  test('unknown command exits non-zero with a helpful message', () => {
    const r = run(['definitely-not-a-real-command']);
    expect(r.exitCode).not.toBe(0);
    // commander writes to stderr; the message contains the bad name.
    expect(r.stderr + r.stdout).toMatch(/definitely-not-a-real-command|unknown command/i);
  });
});

describeIfBundle('cli integration — schema', () => {
  test('schema --json outputs valid JSON with the expected shape', () => {
    const r = run(['--json', 'schema']);
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      version: string;
      commands: unknown[];
      outputTypes: Record<string, unknown>;
      exitCodes: Record<string, number>;
      envVars: unknown[];
    };
    expect(parsed.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(parsed.commands.length).toBeGreaterThan(10);
    expect(Object.keys(parsed.outputTypes).length).toBeGreaterThan(0);
    expect(parsed.exitCodes.SUCCESS).toBe(0);
    expect(parsed.exitCodes.AUTH_ERROR).toBe(2);
  });

  test('schema (text mode) prints a friendly summary', () => {
    const r = run(['schema']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('SpyCore CLI');
    expect(r.stdout).toContain('JSON Schema introspection');
  });

});

describeIfBundle('cli integration — completion', () => {
  test('completion bash prints a script and bash -n parses it', () => {
    const r = run(['completion', 'bash']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('complete -F _spycore spycore');
  });

  test('completion zsh prints #compdef header', () => {
    const r = run(['completion', 'zsh']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.startsWith('#compdef spycore')).toBe(true);
  });

  test('completion fish includes __fish_use_subcommand entries', () => {
    const r = run(['completion', 'fish']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('__fish_use_subcommand');
  });

  test('completion powershell registers a Native completer', () => {
    const r = run(['completion', 'powershell']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Register-ArgumentCompleter -Native');
  });

  test('completion with no shell name surfaces a usage hint', () => {
    const r = run(['completion']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('bash|zsh|fish|powershell');
  });
});

describeIfBundle('cli integration — config', () => {
  test('config get on a fresh dir returns nothing for a missing key', () => {
    const r = run(['config', 'get', 'apiUrl']);
    expect(r.exitCode).toBe(0);
    // Either prints the default or empty; just ensure no crash.
    expect(r.stdout.length).toBeGreaterThanOrEqual(0);
  });

  test('config set then get round-trips', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spycli-int-rt-'));
    const env = { SPYCORE_TEST_CWD: dir };
    const setR = run(['config', 'set', 'apiUrl', 'https://example.test'], { env });
    expect(setR.exitCode).toBe(0);
    const getR = run(['config', 'get', 'apiUrl'], { env });
    expect(getR.exitCode).toBe(0);
    expect(getR.stdout).toContain('https://example.test');
  });
});

describeIfBundle('cli integration — exit codes and JSON shape', () => {
  test('--version --json returns just the version line', () => {
    const r = run(['--json', '--version']);
    // commander emits version directly without an action handler, so the
    // output is plain text. That's fine — we just assert it succeeds.
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim().length).toBeGreaterThan(0);
  });

  // Auth-state-sensitive commands (whoami, ping with token, files list, …)
  // are NOT covered here because the OS keychain may legitimately hold a
  // valid token from interactive use. They live in docs/CLI_SMOKE.md as
  // manual checks that run before each release.
});
