import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';

// `config` commands read the local conf store only — no network, so no undici
// mock is needed. We DO reset modules between tests so the config-store
// singleton is rebuilt against each test's fresh SPYCORE_TEST_CWD.

let stdoutChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  freshConfigDir();
  stdoutChunks = [];
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  vi.resetModules();
});

function stdout(): string {
  return stdoutChunks.join('');
}

const FAKE_TOKEN = 'spycli_FAKE_TOKEN_DO_NOT_LEAK_0123456789';

async function seedStore(): Promise<void> {
  const { setStoredTokenInFile, getConfigStore } = await import(
    '../src/lib/config.js'
  );
  getConfigStore().set('apiUrl', 'https://api.spycore.ai/api');
  setStoredTokenInFile(FAKE_TOKEN);
}

async function runConfig(argv: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerConfigCommand } = await import(
    '../src/commands/config/index.js'
  );
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });

  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerConfigCommand(program);
  await program.parseAsync(['node', 'spycore', ...parentArgs, 'config', ...argv]);
}

describe('config secret redaction', () => {
  test('config list --json never prints the raw token', async () => {
    await seedStore();
    await runConfig(['list'], ['--json']);
    const out = stdout();
    expect(out).not.toContain(FAKE_TOKEN);
    const parsed = JSON.parse(out.trim());
    expect(parsed.__token__).toBe('***redacted***');
    expect(parsed.apiUrl).toBe('https://api.spycore.ai/api');
  });

  test('config list --format yaml redacts the token', async () => {
    await seedStore();
    await runConfig(['list', '--format', 'yaml']);
    const out = stdout();
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain('***redacted***');
  });

  test('config list --format markdown redacts the token', async () => {
    await seedStore();
    await runConfig(['list', '--format', 'markdown']);
    const out = stdout();
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain('***redacted***');
  });

  test('config list (text) does not print the token', async () => {
    await seedStore();
    await runConfig(['list']);
    expect(stdout()).not.toContain(FAKE_TOKEN);
  });

  test('config get (no key) --json redacts the token', async () => {
    await seedStore();
    await runConfig(['get'], ['--json']);
    const out = stdout();
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain('***redacted***');
  });

  test('config get __token__ is redacted by default', async () => {
    await seedStore();
    await runConfig(['get', '__token__']);
    const out = stdout();
    expect(out).not.toContain(FAKE_TOKEN);
    expect(out).toContain('***redacted***');
  });

  test('config get __token__ --reveal shows the raw token', async () => {
    await seedStore();
    await runConfig(['get', '__token__', '--reveal']);
    expect(stdout()).toContain(FAKE_TOKEN);
  });

  test('config get apiUrl (non-secret) is unaffected', async () => {
    await seedStore();
    await runConfig(['get', 'apiUrl']);
    const out = stdout();
    expect(out).toContain('https://api.spycore.ai/api');
    expect(out).not.toContain('***redacted***');
  });
});
