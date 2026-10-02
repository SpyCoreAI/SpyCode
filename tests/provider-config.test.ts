import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { statSync } from 'node:fs';
import { Command, Option } from 'commander';
import { freshConfigDir } from './helpers.js';

/**
 * Stored provider configs + the `provider` command + run-time resolution +
 * login decoupling. The undici wire is mocked (provider `test` + a BYOK agent
 * run); `isAuthenticated` is mocked so we can drive the login-gate decoupling.
 */
interface CapturedRequest {
  url: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}
let requests: CapturedRequest[] = [];
let responder: ((url: string) => { statusCode: number; headers: Record<string, string>; body: unknown }) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url);
  }),
}));

const hoisted = vi.hoisted(() => ({ authed: true }));
vi.mock('../src/lib/auth.js', async (orig) => {
  const actual = await orig<typeof import('../src/lib/auth.js')>();
  return { ...actual, isAuthenticated: () => Promise.resolve(hoisted.authed) };
});

beforeEach(() => {
  freshConfigDir();
  requests = [];
  responder = null;
  hoisted.authed = true;
});
afterEach(() => {
  vi.resetModules();
});

function openaiSse(deltas: string[], usage?: { prompt_tokens: number; completion_tokens: number }) {
  const lines: string[] = [];
  for (const d of deltas) lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`);
  if (usage) lines.push(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  lines.push('data: [DONE]\n\n');
  return { statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(lines.join(''), 'utf8')]) };
}
function errResp(status: number, msg: string) {
  return { statusCode: status, headers: {}, body: { text: async () => JSON.stringify({ error: { message: msg } }) } };
}

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
  (process.stdout.write as unknown) = (c: string | Uint8Array) => (out.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
  (process.stderr.write as unknown) = (c: string | Uint8Array) => (err.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
  let error: unknown;
  try {
    await program.parseAsync(argv, { from: 'user' });
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

const runProvider = (argv: string[], opts?: { json?: boolean }) =>
  import('../src/commands/provider/index.js').then(({ registerProviderCommand }) =>
    runCommand(registerProviderCommand, ['provider', ...argv], opts),
  );
const runAgentCmd = (argv: string[], opts?: { json?: boolean }) =>
  import('../src/commands/agent.js').then(({ registerAgentCommand }) =>
    runCommand(registerAgentCommand, ['--json', 'agent', ...argv], { json: true, ...opts }),
  );

// ───────────────────────── pure resolution ─────────────────────────

describe('resolveProviderSelection', () => {
  const base = {
    baseUrl: undefined,
    model: undefined,
    apiKeyEnv: undefined,
    env: {} as NodeJS.ProcessEnv,
    stored: [] as Array<{ name: string; type: 'openai'; baseURL: string; model?: string; apiKeyEnv?: string; apiKey?: string }>,
    defaultProvider: undefined as string | undefined,
  };

  test('no flag + no default → spycore', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    expect(resolveProviderSelection({ ...base, providerFlag: undefined })).toEqual({ kind: 'spycore' });
  });

  test('no flag + a saved default → that saved provider', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    const stored = [{ name: 'mybox', type: 'openai' as const, baseURL: 'https://h.example/v1', model: 'm1', apiKeyEnv: 'K' }];
    const sel = resolveProviderSelection({ ...base, providerFlag: undefined, defaultProvider: 'mybox', stored, env: { K: 'sk-1' } });
    expect(sel).toMatchObject({ kind: 'byok', sourceName: 'mybox' });
    if (sel.kind === 'byok') {
      expect(sel.config.model).toBe('m1');
      expect(sel.config.baseURL).toBe('https://h.example/v1');
      expect(sel.config.apiKey).toBe('sk-1');
      expect(sel.config.routingLine).toBe('Model: m1 (openai)');
    }
  });

  test('a stored NAME beats the built-in type; flags override stored fields', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    const stored = [{ name: 'mybox', type: 'openai' as const, baseURL: 'https://h.example/v1', model: 'm1', apiKeyEnv: 'K' }];
    const sel = resolveProviderSelection({
      ...base,
      providerFlag: 'mybox',
      model: 'override-model',
      baseUrl: 'https://other.example/v2/',
      apiKeyEnv: 'OTHER',
      stored,
      env: { K: 'sk-1', OTHER: 'sk-override' },
    });
    expect(sel).toMatchObject({ kind: 'byok', sourceName: 'mybox' });
    if (sel.kind === 'byok') {
      expect(sel.config.model).toBe('override-model'); // --model overrides stored
      expect(sel.config.baseURL).toBe('https://other.example/v2'); // --base-url overrides + trims slash
      expect(sel.config.apiKey).toBe('sk-override'); // --api-key-env overrides
    }
  });

  test('built-in openai type → ad-hoc path (sourceName null)', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    const sel = resolveProviderSelection({ ...base, providerFlag: 'openai', model: 'gpt-4o', env: { OPENAI_API_KEY: 'sk-x' } });
    expect(sel).toMatchObject({ kind: 'byok', sourceName: null });
    if (sel.kind === 'byok') expect(sel.config.model).toBe('gpt-4o');
  });

  test('unknown provider name → clear error', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    expect(() => resolveProviderSelection({ ...base, providerFlag: 'nope' })).toThrow(/Unknown provider/);
  });

  test('saved provider with no model and no --model → clear error', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    const stored = [{ name: 'mybox', type: 'openai' as const, baseURL: 'https://h.example/v1' }];
    expect(() => resolveProviderSelection({ ...base, providerFlag: 'mybox', stored })).toThrow(/no model.*--model/);
  });

  test('saved inline key is used when no env var is set', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    const stored = [{ name: 'mybox', type: 'openai' as const, baseURL: 'https://h.example/v1', model: 'm', apiKey: 'inline-secret' }];
    const sel = resolveProviderSelection({ ...base, providerFlag: 'mybox', stored });
    if (sel.kind === 'byok') expect(sel.config.apiKey).toBe('inline-secret');
  });
});

// ───────────────────────── provider command round-trip ─────────────────────────

describe('provider command — round-trip + persistence', () => {
  test('add → list → use → remove persists correctly', async () => {
    const { getStoredProviders, getDefaultProviderName } = await import('../src/lib/config.js');

    await runProvider(['add', 'mybox', '--base-url', 'https://h.example/v1', '--model', 'm1', '--api-key-env', 'MYBOX_KEY']);
    let stored = getStoredProviders();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'mybox', type: 'openai', baseURL: 'https://h.example/v1', model: 'm1', apiKeyEnv: 'MYBOX_KEY' });
    expect(stored[0]?.apiKey).toBeUndefined();

    const list = await runProvider(['list'], { json: true });
    const parsed = JSON.parse(list.stdout) as { defaultProvider: string; providers: Array<Record<string, unknown>> };
    expect(parsed.defaultProvider).toBe('spycore');
    expect(parsed.providers[0]).toMatchObject({ name: 'mybox', keySource: 'env:MYBOX_KEY' });

    await runProvider(['use', 'mybox']);
    expect(getDefaultProviderName()).toBe('mybox');

    await runProvider(['use', 'spycore']);
    expect(getDefaultProviderName()).toBe('spycore');

    await runProvider(['remove', 'mybox']);
    expect(getStoredProviders()).toHaveLength(0);
  });

  test('removing the default provider resets the default to spycore', async () => {
    const { getDefaultProviderName } = await import('../src/lib/config.js');
    await runProvider(['add', 'mybox', '--base-url', 'https://h.example/v1', '--model', 'm']);
    await runProvider(['use', 'mybox']);
    expect(getDefaultProviderName()).toBe('mybox');
    await runProvider(['remove', 'mybox']);
    expect(getDefaultProviderName()).toBeUndefined(); // → resolves to spycore
  });

  test('list masks an inline stored key (stored:••••last4), never the full key', async () => {
    await runProvider(['add', 'secretbox', '--base-url', 'https://h.example/v1', '--model', 'm', '--api-key', 'sk-supersecret-WXYZ']);
    const list = await runProvider(['list'], { json: true });
    expect(list.stdout).toContain('stored:••••WXYZ');
    expect(list.stdout).not.toContain('sk-supersecret-WXYZ');
    // text mode too
    const text = await runProvider(['list']);
    expect(text.stdout).toContain('stored:••••WXYZ');
    expect(text.stdout).not.toContain('sk-supersecret-WXYZ');
  });
});

describe('provider command — validation', () => {
  test('rejects a reserved name', async () => {
    const r = await runProvider(['add', 'spycore', '--base-url', 'https://h.example/v1']);
    expect(String((r.error as Error)?.message)).toMatch(/reserved/);
  });
  test('rejects a duplicate name', async () => {
    await runProvider(['add', 'dup', '--base-url', 'https://h.example/v1', '--model', 'm']);
    const r = await runProvider(['add', 'dup', '--base-url', 'https://h.example/v1', '--model', 'm']);
    expect(String((r.error as Error)?.message)).toMatch(/already exists/);
  });
  test('rejects a bad base URL', async () => {
    const r = await runProvider(['add', 'badurl', '--base-url', 'not-a-url']);
    expect(String((r.error as Error)?.message)).toMatch(/Invalid --base-url/);
  });
  test('rejects passing both --api-key-env and --api-key', async () => {
    const r = await runProvider(['add', 'both', '--base-url', 'https://h.example/v1', '--model', 'm', '--api-key-env', 'K', '--api-key', 'x']);
    expect(String((r.error as Error)?.message)).toMatch(/either --api-key-env or --api-key/);
  });
  test('use rejects an unknown name', async () => {
    const r = await runProvider(['use', 'ghost']);
    expect(String((r.error as Error)?.message)).toMatch(/No saved provider/);
  });
});

describe('config file permissions', () => {
  test.skipIf(process.platform === 'win32')('the config file is written 0600 after a provider write', async () => {
    const { getConfigPath } = await import('../src/lib/config.js');
    await runProvider(['add', 'mybox', '--base-url', 'https://h.example/v1', '--model', 'm']);
    const mode = statSync(getConfigPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// ───────────────────────── provider test command ─────────────────────────

describe('provider test command', () => {
  test('reports success when the endpoint responds', async () => {
    responder = () => openaiSse(['OK'], { prompt_tokens: 2, completion_tokens: 1 });
    await runProvider(['add', 'mybox', '--base-url', 'http://localhost:1234/v1', '--model', 'm']);
    const r = await runProvider(['test', 'mybox']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toMatch(/reachable/);
    expect(requests.some((q) => q.url.includes('/chat/completions'))).toBe(true);
  });

  test('reports a clear failure on 401 (key redacted)', async () => {
    responder = () => errResp(401, 'Incorrect API key');
    await runProvider(['add', 'mybox', '--base-url', 'https://h.example/v1', '--model', 'm', '--api-key', 'sk-zzzz-SECRET']);
    const r = await runProvider(['test', 'mybox']);
    const msg = String((r.error as Error)?.message ?? '');
    expect(msg).toMatch(/401/);
    expect(msg).not.toContain('sk-zzzz-SECRET');
  });
});

// ───────────────────────── login decoupling ─────────────────────────

describe('agent — login decoupling', () => {
  test('a BYOK default provider runs with NO SpyCore login (isAuthenticated false)', async () => {
    hoisted.authed = false; // not logged in
    responder = (url) => {
      if (url.includes('/chat/completions')) return openaiSse(['Hello from BYOK.'], { prompt_tokens: 3, completion_tokens: 2 });
      throw new Error(`SpyCore endpoint must not be called: ${url}`);
    };
    // Save a BYOK provider and make it the default.
    const { setStoredProviders, setDefaultProviderName } = await import('../src/lib/config.js');
    setStoredProviders([{ name: 'mybox', type: 'openai', baseURL: 'http://localhost:9999/v1', model: 'demo-model' }]);
    setDefaultProviderName('mybox');

    const r = await runAgentCmd(['--yes', 'say', 'hi']); // no --provider → uses the default
    expect(r.error).toBeUndefined(); // NO "Not logged in" error
    expect(requests.some((q) => q.url.includes('/chat/completions'))).toBe(true);
    expect(requests.some((q) => q.url.includes('/api/chat/stream'))).toBe(false);

    const summary = r.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find((o) => o && o.executed === true);
    expect(summary).toMatchObject({ provider: 'mybox', model: 'demo-model', routedVia: 'byok', executed: true });
    // Evidence anchor (debug-bench post-mortems): the run summary must carry
    // the conversation handle so a captured run correlates with server logs.
    expect(typeof summary?.conversationId).toBe('string');
    expect((summary?.conversationId as string).length).toBeGreaterThan(0);
  });

  test('the spycore provider still requires login (isAuthenticated false → error)', async () => {
    hoisted.authed = false;
    responder = () => {
      throw new Error('no network expected — should fail at the login gate');
    };
    const r = await runAgentCmd(['say', 'hi']); // no provider, no default → spycore
    expect(String((r.error as Error)?.message)).toMatch(/Not logged in/);
  });
});
