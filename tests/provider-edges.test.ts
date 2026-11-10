import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import { registerProviderCommand } from '../src/commands/provider/index.js';
import { getStoredProviders, setStoredProviders } from '../src/lib/config.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
}

let responder: ((url: string, init: { method: string; body?: unknown }) => MockResp | Promise<never>) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET', body: init.body });
  }),
}));

async function runProvider(argv: string[]): Promise<{ stdout: string; stderr: string; error: unknown }> {
  const { configureOutput } = await import('../src/lib/output.js');
  const program = new Command();
  program.exitOverride();
  program.addOption(new Option('--api-url <url>')).addOption(new Option('--json')).addOption(new Option('--no-color'));
  configureOutput({ json: false, color: false });
  registerProviderCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exitCode;
  (process.stdout.write as unknown) = (c: string | Uint8Array) => (out.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
  (process.stderr.write as unknown) = (c: string | Uint8Array) => (err.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
  let error: unknown;
  try {
    await program.parseAsync(['provider', ...argv], { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = origExit;
    configureOutput({ json: false, color: true });
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

let cwd: string;
let prevCwd: string;
const origStdin = process.stdin;

beforeEach(() => {
  freshConfigDir();
  responder = null;
  cwd = mkdtempSync(join(tmpdir(), 'spycli-prov-edge-'));
  prevCwd = process.cwd();
  process.chdir(cwd);
});

afterEach(async () => {
  process.chdir(prevCwd);
  Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('provider add edges', () => {
  test('a blank name errors', async () => {
    const { error } = await runProvider(['add', '   ', '--skip-test']);
    expect((error as Error)?.message).toMatch(/A provider name is required/);
  });

  test('a non-http(s) base URL errors', async () => {
    const { error } = await runProvider(['add', 'x', '--base-url', 'ftp://example.com/v1', '--skip-test']);
    expect((error as Error)?.message).toMatch(/must use http or https/);
  });

  test('a plain-http non-local base URL warns', async () => {
    const r = await runProvider(['add', 'x', '--base-url', 'http://example.com/v1', '--skip-test']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('plain http://');
  });

  test('a non-vendor host warns for a vendor type', async () => {
    const r = await runProvider(['add', 'a', '--type', 'anthropic', '--base-url', 'https://evil.example.com', '--skip-test']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('is not the vendor default');
  });

  test('--oauth is refused for non-Google and with a key', async () => {
    let r = await runProvider(['add', 'x', '--oauth', '--skip-test']);
    expect((r.error as Error)?.message).toMatch(/only supported for Google/);
    r = await runProvider(['add', 'g', '--type', 'google', '--oauth', '--api-key-env', 'GEMINI_API_KEY', '--skip-test']);
    expect((r.error as Error)?.message).toMatch(/either --oauth or an API key/);
  });

  test('a --model is stored on the entry', async () => {
    const r = await runProvider(['add', 'x', '--model', 'gpt-x', '--skip-test']);
    expect(r.error).toBeUndefined();
    expect(getStoredProviders()[0]).toMatchObject({ name: 'x', model: 'gpt-x' });
  });

  test('without --skip-test and without a model the health check is skipped', async () => {
    const r = await runProvider(['add', 'x']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('Skipped health check (no --model specified)');
  });

  test('a non-Error health-check failure is stringified into the warning', async () => {
    responder = () => {
      throw 'boom-string';
    };
    const r = await runProvider(['add', 'x', '--model', 'm', '--api-key', 'k']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('Health check failed:');
    expect(r.stdout + r.stderr).toContain('boom-string');
    expect(getStoredProviders()).toHaveLength(1);
  });

  test('a stalled health-check stream times out (default 30s, exercised at 1s)', async () => {
    // The 30s default is pinned by the healthCheckTimeoutMs unit test
    // below; here the timeout PATH is exercised via the hook at 1s, so
    // the test takes ~1s instead of the full 30s.
    const prev = process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS;
    process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS = '1000';
    try {
      responder = () => new Promise<never>(() => {});
      const r = await runProvider(['add', 'x', '--model', 'm', '--api-key', 'k']);
      expect(r.error).toBeUndefined();
      expect(r.stdout + r.stderr).toContain('Health check timed out after 1s.');
    } finally {
      if (prev === undefined) delete process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS;
      else process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS = prev;
    }
  }, 10_000);

  test('healthCheckTimeoutMs defaults to 30s and ignores bad overrides', async () => {
    const { healthCheckTimeoutMs } = await import('../src/commands/provider/index.js');
    const prev = process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS;
    try {
      delete process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS;
      expect(healthCheckTimeoutMs()).toBe(30_000);
      process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS = '1000';
      expect(healthCheckTimeoutMs()).toBe(1000);
      process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS = 'not-a-number';
      expect(healthCheckTimeoutMs()).toBe(30_000);
      process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS = '0';
      expect(healthCheckTimeoutMs()).toBe(30_000);
    } finally {
      if (prev === undefined) delete process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS;
      else process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS = prev;
    }
  });
});

describe('provider list edges', () => {
  test('a fresh store lists the built-in default and no providers', async () => {
    const r = await runProvider(['list']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('Default: spycore (built-in)');
    expect(r.stdout + r.stderr).toContain('No saved providers.');
  });

  test('keyless entries show none for key-optional types and the default env for key-required types', async () => {
    setStoredProviders([
      { name: 'local', type: 'openai', baseURL: 'http://127.0.0.1:8080/v1' },
      { name: 'a', type: 'anthropic', baseURL: 'https://api.anthropic.com' },
    ]);
    const r = await runProvider(['list']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('none');
    expect(r.stdout + r.stderr).toContain('env:ANTHROPIC_API_KEY (default)');
  });

  test('the default provider row is starred', async () => {
    await runProvider(['add', 'x', '--skip-test']);
    await runProvider(['use', 'x']);
    const r = await runProvider(['list']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toMatch(/^\* x /m);
  });
});

describe('provider remove, use, test edges', () => {
  test('removing an unknown provider errors', async () => {
    const { error } = await runProvider(['remove', 'ghost', '--yes']);
    expect((error as Error)?.message).toMatch(/No saved provider named "ghost"/);
  });

  test('declining the remove prompt keeps the provider', async () => {
    await runProvider(['add', 'x', '--skip-test']);
    const fakeStdin = Readable.from(['n\n']);
    (fakeStdin as unknown as { isTTY: boolean }).isTTY = true;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const r = await runProvider(['remove', 'x']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('Cancelled - nothing deleted.');
    expect(getStoredProviders()).toHaveLength(1);
  });

  test('using an unknown provider errors', async () => {
    const { error } = await runProvider(['use', 'ghost']);
    expect((error as Error)?.message).toMatch(/No saved provider named "ghost"/);
  });

  test('testing a built-in-kind stored entry reports not testable', async () => {
    setStoredProviders([{ name: 'spycore', type: 'openai', baseURL: 'https://api.openai.com/v1' }]);
    const { error } = await runProvider(['test', 'spycore']);
    expect((error as Error)?.message).toMatch(/is not testable/);
  });
});
