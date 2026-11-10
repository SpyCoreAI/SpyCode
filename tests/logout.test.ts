import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
}

let responder:
  | ((url: string, init: { method: string; headers: Record<string, string> }) => MockResp)
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET', headers: init.headers ?? {} });
  }),
}));

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
let savedEnvToken: string | undefined;

function stdout(): string {
  return stdoutChunks.join('');
}
function allOut(): string {
  return stdoutChunks.join('') + stderrChunks.join('');
}

async function runCli(argv: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerLogoutCommand } = await import('../src/commands/auth/logout.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  program.exitOverride();
  registerLogoutCommand(program);
  await program.parseAsync(['node', 'spycore', ...parentArgs, 'logout', ...argv]);
}

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: { 'content-type': 'application/json' }, body: { json: async () => body } };
}

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  stdoutChunks = [];
  stderrChunks = [];
  savedEnvToken = process.env.SPYCORE_TOKEN;
  delete process.env.SPYCORE_TOKEN;
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  if (savedEnvToken === undefined) delete process.env.SPYCORE_TOKEN;
  else process.env.SPYCORE_TOKEN = savedEnvToken;
  vi.resetModules();
});

describe('spycore logout', () => {
  test('clears the local token even when the server revoke fails', async () => {
    responder = (url) => {
      if (url.includes('/auth/cli/logout')) return jsonResp(500, { success: false, error: 'boom' });
      throw new Error(`unexpected ${url}`);
    };
    await runCli([]);
    expect(allOut()).toContain('Logged out');
    expect(allOut()).toMatch(/revoke failed/i);
    const { getToken } = await import('../src/lib/auth.js');
    expect(await getToken()).toBeNull();
  });

  test('revoke success clears the token with no warning', async () => {
    responder = (url) => {
      if (url.includes('/auth/cli/logout')) return jsonResp(200, { success: true, data: {} });
      throw new Error(`unexpected ${url}`);
    };
    await runCli([]);
    expect(allOut()).toContain('Logged out');
    expect(allOut()).not.toMatch(/revoke failed/i);
    const { getToken } = await import('../src/lib/auth.js');
    expect(await getToken()).toBeNull();
  });

  test('the server revoke carries the pre-clear token (R2 M3)', async () => {
    let authHeader: string | undefined;
    responder = (url, init) => {
      if (url.includes('/auth/cli/logout')) {
        authHeader = init.headers.authorization;
        return jsonResp(200, { success: true, data: {} });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runCli([]);
    // The local copy is cleared BEFORE the revoke, so the bearer can only
    // be there if logout passes the captured token explicitly. Without
    // it the revoke goes out unauthenticated, the server 401s it, and the
    // server-side session stays live while logout warns spuriously.
    expect(authHeader).toBe('Bearer spycli_test_token');
    expect(allOut()).toContain('Logged out');
    expect(allOut()).not.toMatch(/revoke failed/i);
    const { getToken } = await import('../src/lib/auth.js');
    expect(await getToken()).toBeNull();
  });

  test('a set SPYCORE_TOKEN is reported as still active (it is not deleted)', async () => {
    process.env.SPYCORE_TOKEN = 'spycli_env_token';
    responder = (url) => {
      if (url.includes('/auth/cli/logout')) return jsonResp(200, { success: true, data: {} });
      throw new Error(`unexpected ${url}`);
    };
    await runCli([]);
    expect(allOut()).toContain('Logged out');
    expect(allOut()).toMatch(/SPYCORE_TOKEN is still set/);
    // The env var was not (and cannot be) deleted by the CLI: the session
    // is still authenticated through it, and the output says so.
    const { getToken } = await import('../src/lib/auth.js');
    expect(await getToken()).toBe('spycli_env_token');
  });

  test('--json reports the partial status and the env token', async () => {
    process.env.SPYCORE_TOKEN = 'spycli_env_token';
    responder = (url) => {
      if (url.includes('/auth/cli/logout')) return jsonResp(500, { success: false, error: 'boom' });
      throw new Error(`unexpected ${url}`);
    };
    await runCli([], ['--json']);
    const payload = JSON.parse(stdout());
    expect(payload.status).toBe('partial');
    expect(payload.envTokenActive).toBe(true);
    const { getToken } = await import('../src/lib/auth.js');
    expect(await getToken()).toBe('spycli_env_token');
  });

  test('no token reports a noop', async () => {
    const { clearToken } = await import('../src/lib/auth.js');
    await clearToken();
    responder = () => {
      throw new Error('must not call the server with no token');
    };
    await runCli([]);
    expect(allOut()).toContain('No active token');
  });
});
