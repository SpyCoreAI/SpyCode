import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Command, Option } from 'commander';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

/**
 * Phase 4b1 (Low) CLI-level regression tests: strict numeric flags
 * (agent + acp), ACP budget-flag validation, case-insensitive provider
 * names, the provider-test timeout, schema env vars, resume without a
 * conversation id, and the BYOK-fallback recorder label.
 */

// ───────────────────── mocked undici (fallback + provider-test tests) ─────────────────────

const undiciState = vi.hoisted(() => ({
  responder: null as null | ((url: string, init: Record<string, unknown>) => unknown),
}));

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: Record<string, unknown> = {}) => {
    if (!undiciState.responder) throw new Error('test forgot to set undici responder');
    return undiciState.responder(url, init);
  }),
}));

/** Invoke a registered command in-process and capture stdout/stderr + any thrown error. */
async function runCommand(
  register: (p: Command) => void,
  argv: string[],
  opts: { json?: boolean } = {},
): Promise<{ stdout: string; stderr: string; error: unknown }> {
  const { configureOutput } = await import('../src/lib/output.js');
  const program = new Command();
  program.exitOverride();
  program.addOption(new Option('--api-url <url>')).addOption(new Option('--json')).addOption(new Option('--no-color'));
  configureOutput({ json: Boolean(opts.json), color: false });
  register(program);
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exitCode;
  (process.stdout.write as unknown) = (c: string | Uint8Array) => (
    out.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true
  );
  (process.stderr.write as unknown) = (c: string | Uint8Array) => (
    err.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true
  );
  let error: unknown;
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = origOut as typeof process.stdout.write;
    process.stderr.write = origErr as typeof process.stderr.write;
    process.exitCode = origExit;
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

async function runAgent(argv: string[]): Promise<{ stdout: string; stderr: string; error: unknown }> {
  const { registerAgentCommand } = await import('../src/commands/agent.js');
  return runCommand(registerAgentCommand, ['agent', ...argv]);
}

async function runAcp(argv: string[]): Promise<{ stdout: string; stderr: string; error: unknown }> {
  const { registerAcpCommand } = await import('../src/commands/acp.js');
  return runCommand(registerAcpCommand, ['acp', ...argv]);
}

async function runProvider(argv: string[], opts: { json?: boolean } = {}) {
  const { registerProviderCommand } = await import('../src/commands/provider/index.js');
  return runCommand(registerProviderCommand, ['provider', ...argv], opts);
}

let workDir: string;
let origCwd: string;
const origHealthTimeout = process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS;

beforeEach(() => {
  freshConfigDir();
  undiciState.responder = null;
  origCwd = process.cwd();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-4b1-')));
  delete process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS;
});

afterEach(() => {
  try {
    process.chdir(origCwd);
  } catch {
    /* ignore */
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  if (origHealthTimeout === undefined) delete process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS;
  else process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS = origHealthTimeout;
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe('4b1 item 1 - agent numeric flags error instead of silently defaulting', () => {
  // Explicit deadline (repo ruling §F3): the first agent.js import in a
  // fresh worker costs ~18-25 s of transform on this VM, while the run
  // itself is ~1 s - the cost is the import, and the timeout must cover
  // it. The assertions themselves are instant once the module is loaded.
  test.each([
    [['do a thing', '--max-turns', 'abc'], /Invalid --max-turns/],
    [['do a thing', '--max-turns', '0'], /Invalid --max-turns/],
    [['do a thing', '--max-turns', '201'], /Invalid --max-turns/],
    [['do a thing', '--cmd-timeout', 'abc'], /Invalid --cmd-timeout/],
    [['do a thing', '--cmd-timeout', '0'], /Invalid --cmd-timeout/],
    [['do a thing', '--max-tool-calls-per-turn', 'abc'], /Invalid --max-tool-calls-per-turn/],
    [['do a thing', '--max-tool-calls-per-turn', '0'], /Invalid --max-tool-calls-per-turn/],
  ])('%s errors', { timeout: 60_000 }, async (argv, pattern) => {
    const r = await runAgent(argv as string[]);
    expect(String((r.error as Error)?.message)).toMatch(pattern);
  });

  test('a valid --max-turns still works (dry-run preview)', { timeout: 60_000 }, async () => {
    const r = await runAgent(['do a thing', '--max-turns', '5', '--dry-run']);
    expect(r.error).toBeUndefined();
  });
});

describe('4b1 items 1 + 17 - acp numeric and budget flags error on invalid input', () => {
  test.each([
    [['--max-turns', 'abc'], /Invalid --max-turns/],
    [['--max-turns', '0'], /Invalid --max-turns/],
    [['--cmd-timeout', 'abc'], /Invalid --cmd-timeout/],
    [['--cmd-timeout', '99999'], /Invalid --cmd-timeout/],
    [['--max-tokens', 'abc'], /Invalid --max-tokens/],
    [['--max-tokens', '0'], /Invalid --max-tokens/],
    [['--max-time', '0'], /Invalid --max-time/],
    [['--max-time', 'abc'], /Invalid --max-time/],
  ])('%s errors', async (argv, pattern) => {
    const r = await runAcp(argv as string[]);
    expect(String((r.error as Error)?.message)).toMatch(pattern);
  });
});

describe('4b1 item 3 - provider names match case-insensitively', () => {
  test('`provider use foo` sets the default to the saved `Foo`', async () => {
    const { getDefaultProviderName } = await import('../src/lib/config.js');
    await runProvider(['add', 'Foo', '--base-url', 'https://h.example/v1', '--model', 'm', '--skip-test']);
    const r = await runProvider(['use', 'foo']);
    expect(r.error).toBeUndefined();
    expect(getDefaultProviderName()).toBe('Foo');
  });

  test('`provider add FOO` conflicts with a saved `Foo`', async () => {
    await runProvider(['add', 'Foo', '--base-url', 'https://h.example/v1', '--model', 'm', '--skip-test']);
    const r = await runProvider(['add', 'FOO', '--base-url', 'https://h.example/v1', '--model', 'm', '--skip-test']);
    expect(String((r.error as Error)?.message)).toMatch(/already exists/);
  });

  test('`provider test foo` resolves the saved `Foo`', async () => {
    // The endpoint never answers: the point here is the name resolves
    // (a resolution failure would say "No saved provider", a timeout
    // says the lookup succeeded and the request stalled).
    process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS = '50';
    undiciState.responder = (_url: string, init: Record<string, unknown>) =>
      new Promise((_resolve, reject) => {
        (init.signal as AbortSignal | undefined)?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    const { setStoredProviders } = await import('../src/lib/config.js');
    setStoredProviders([
      { name: 'Foo', type: 'openai', baseURL: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k-1' },
    ]);
    const r = await runProvider(['test', 'foo']);
    expect(String((r.error as Error)?.message)).toMatch(/timed out after 0\.05s/);
  });
});

describe('4b1 item 12 - provider test aborts on a stalled endpoint', () => {
  test('a hung endpoint fails after the health-check timeout, with progress output', async () => {
    process.env.SPYCORE_HEALTH_CHECK_TIMEOUT_MS = '50';
    undiciState.responder = (_url: string, init: Record<string, unknown>) =>
      new Promise((_resolve, reject) => {
        (init.signal as AbortSignal | undefined)?.addEventListener(
          'abort',
          () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          { once: true },
        );
      });
    const { setStoredProviders } = await import('../src/lib/config.js');
    setStoredProviders([
      { name: 'slowbox', type: 'openai', baseURL: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k-1' },
    ]);
    const r = await runProvider(['test', 'slowbox']);
    expect(String((r.error as Error)?.message)).toMatch(/timed out after 0\.05s/);
    expect(r.stderr + r.stdout).toMatch(/Waiting for a reply \(up to 0\.05s\)/);
  });
});

describe('4b1 item 18 - schema lists every env var the CLI reads', () => {
  test('SPYCODE_GUARDIAN_THRESHOLD, SPYCORE_GOOGLE_CLIENT_ID and SPYCORE_NO_NOTIFY are listed', async () => {
    const { registerSchemaCommand } = await import('../src/commands/schema.js');
    const r = await runCommand((p) => registerSchemaCommand(p, '0.9.10'), ['schema', '--json'], { json: true });
    expect(r.error).toBeUndefined();
    const schema = JSON.parse(r.stdout) as { envVars: Array<{ name: string }> };
    const names = schema.envVars.map((v) => v.name);
    expect(names).toContain('SPYCODE_GUARDIAN_THRESHOLD');
    expect(names).toContain('SPYCORE_GOOGLE_CLIENT_ID');
    expect(names).toContain('SPYCORE_NO_NOTIFY');
  });
});

describe('4b1 item 15 - agent --resume with no recorded conversation id', () => {
  // resolveResumeTarget already fails cleanly for this record (the
  // non-null assertion in agent.ts is unreachable through it); the
  // test pins the clean error on both spellings instead of a crash.
  // Explicit deadline (repo ruling §F3): first agent.js import cost.
  test('a record that never reached its first model turn fails cleanly', { timeout: 60_000 }, async () => {
    process.chdir(workDir);
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    const { createRunRecorder } = await import('../src/lib/agent/checkpoint.js');
    const rec = createRunRecorder({
      cwd: workDir,
      task: 'never started',
      initial: {
        providerKind: 'spycore',
        model: 'styx',
        planMode: false,
        maxTurns: 25,
        budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} },
        gitHead: null,
      },
    });
    // A change persists the journal even though no conversation ever bound,
    // so the record exists on disk with conversationId null.
    const a = join(workDir, 'a.txt');
    writeFileSync(a, 'A');
    rec.recordChange({ path: a, op: 'create', before: null, after: 'A' });
    rec.finalize('interrupted');
    const bare = await runAgent(['--resume']);
    expect(String((bare.error as Error)?.message)).toMatch(/No resumable agent session/);
    const named = await runAgent(['--resume', rec.id]);
    expect(String((named.error as Error)?.message)).toMatch(/interrupted before execution began/);
  });
});

describe('4b1 item 2 - a BYOK→SpyCore fallback run is journaled as spycore', () => {
  function jsonResp(status: number, body: unknown) {
    return { statusCode: status, headers: {}, body: { json: async () => body } };
  }
  function sseResp(events: Array<Record<string, unknown>>) {
    const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: {
        json: async () => ({}),
        [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator](),
      },
    };
  }
  const toolBlock = (tool: string, args: unknown): string =>
    '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

  test('fallback run records providerKind spycore, not byok', { timeout: 60_000 }, async () => {
    process.chdir(workDir);
    const { setStoredTokenInFile, getConfigStore, setStoredProviders } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    getConfigStore().set('providerFallback', true);
    setStoredProviders([
      { name: 'mybox', type: 'openai', baseURL: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'k-1' },
    ]);
    let streamCalls = 0;
    undiciState.responder = (url: string, init: Record<string, unknown>) => {
      const method = (init.method as string | undefined) ?? 'GET';
      if (url.startsWith('http://127.0.0.1:9/v1/chat/completions')) {
        return {
          statusCode: 401,
          headers: {},
          body: { text: async () => JSON.stringify({ error: { message: 'Incorrect API key provided' } }) },
        };
      }
      if (method === 'GET' && url.endsWith('/auth/cli/whoami')) {
        return jsonResp(200, { success: true, data: { plan: 'pro' } });
      }
      if (method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'cnv_fallback' } });
      }
      if (method === 'POST' && url.includes('/api/chat/stream')) {
        streamCalls += 1;
        if (streamCalls === 1) {
          // Triage: STANDARD.
          return sseResp([{ type: 'text', content: 'STANDARD' }, { type: 'done' }]);
        }
        if (streamCalls === 2) {
          // Run turn 1: write a marker file, then answer.
          return sseResp([
            { type: 'text', content: toolBlock('write_file', { path: 'marker.txt', content: 'v1\n' }) },
            { type: 'done' },
          ]);
        }
        return sseResp([{ type: 'text', content: 'Done.' }, { type: 'done' }]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const r = await runAgent(['make a marker file', '--provider', 'mybox', '--model', 'styx', '--yes']);
    expect(r.error).toBeUndefined();
    expect(r.stderr).toMatch(/Falling back to SpyCore/);
    expect(readFileSync(join(workDir, 'marker.txt'), 'utf8')).toBe('v1\n');
    const { listSessions, getResumeState } = await import('../src/lib/agent/checkpoint.js');
    const sessions = listSessions(workDir);
    expect(sessions).toHaveLength(1);
    expect(getResumeState(sessions[0]!)?.providerKind).toBe('spycore');
  });

  test('a Google OAuth refresh failure falls back to SpyCore instead of hard-failing (R2 M2 + L8)', { timeout: 60_000 }, async () => {
    process.chdir(workDir);
    const { setStoredTokenInFile, getConfigStore, setStoredProviders } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    getConfigStore().set('providerFallback', true);
    setStoredProviders([
      {
        name: 'gbox',
        type: 'google',
        baseURL: 'https://generativelanguage.googleapis.com',
        model: 'g-model',
        oauthRefreshToken: 'rt-revoked',
        oauthClientId: 'cid-1',
      },
    ]);
    // The token endpoint rejects the revoked refresh token. Before the
    // fix this threw out of createByokProvider - before the fallback try
    // was ever entered - so the run hard-failed despite providerFallback.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
      })),
    );
    let streamCalls = 0;
    undiciState.responder = (url: string, init: Record<string, unknown>) => {
      const method = (init.method as string | undefined) ?? 'GET';
      if (method === 'GET' && url.endsWith('/auth/cli/whoami')) {
        return jsonResp(200, { success: true, data: { plan: 'pro' } });
      }
      if (method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'cnv_fallback' } });
      }
      if (method === 'POST' && url.includes('/api/chat/stream')) {
        streamCalls += 1;
        if (streamCalls === 1) {
          return sseResp([{ type: 'text', content: 'STANDARD' }, { type: 'done' }]);
        }
        if (streamCalls === 2) {
          return sseResp([
            { type: 'text', content: toolBlock('write_file', { path: 'marker.txt', content: 'v1\n' }) },
            { type: 'done' },
          ]);
        }
        return sseResp([{ type: 'text', content: 'Done.' }, { type: 'done' }]);
      }
      throw new Error(`unexpected ${method} ${url}`);
    };
    const r = await runAgent(['make a marker file', '--provider', 'gbox', '--model', 'styx', '--yes']);
    expect(r.error).toBeUndefined();
    expect(r.stderr).toMatch(/Falling back to SpyCore/);
    expect(readFileSync(join(workDir, 'marker.txt'), 'utf8')).toBe('v1\n');
    // L8: the probe never ran (construction failed first), and a probe
    // must never be recorded as a real call anyway - no phantom usage.
    const { getByokUsage } = await import('../src/lib/byok-usage.js');
    expect(getByokUsage()['gbox']).toBeUndefined();
  });

  test('the same refresh failure is still a hard error with fallback off (R2 M2)', { timeout: 60_000 }, async () => {
    process.chdir(workDir);
    const { setStoredTokenInFile, setStoredProviders } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    setStoredProviders([
      {
        name: 'gbox',
        type: 'google',
        baseURL: 'https://generativelanguage.googleapis.com',
        model: 'g-model',
        oauthRefreshToken: 'rt-revoked',
        oauthClientId: 'cid-1',
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
      })),
    );
    undiciState.responder = () => {
      throw new Error('must not reach any endpoint - construction fails first');
    };
    const r = await runAgent(['make a marker file', '--provider', 'gbox', '--model', 'styx', '--yes']);
    expect(String((r.error as Error)?.message)).toMatch(/Google OAuth token refresh failed/);
  });
});
