import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Command, Option } from 'commander';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir, isExactHost } from './helpers.js';

/**
 * Phase 5 pass 5, R2 (providers + auth + chat + ACP) regressions:
 * R2-17 (agent BYOK fallback probe leaks its 15 s timer on a throwing
 * streamChat), R2-18 (`provider list` misstates the key source of an
 * OAuth-only provider), R2-19 (chat records BYOK usage under the raw
 * --provider flag casing), and the EXTRA item (oauth.ts:235 slices a
 * server error body with a raw .slice - same truncateSafe class as
 * R3-17/R3-20).
 *
 * Each test below was written against the FIXED behaviour and fails on the
 * pre-fix tree for the reason named in its comment (verified by stashing
 * the fix - see the fix log); nothing here pins the old buggy shape.
 */

// Force the file fallback path for auth: pretend keytar is unavailable.
vi.mock('keytar', () => {
  throw new Error('not installed');
});

const undiciState = vi.hoisted(() => ({
  responder: null as null | ((url: string, init: Record<string, unknown>) => unknown),
}));

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: Record<string, unknown> = {}) => {
    if (!undiciState.responder) throw new Error(`test forgot to set undici responder (called for ${url})`);
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
    configureOutput({ json: false, color: true });
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

async function runAgent(argv: string[]) {
  const { registerAgentCommand } = await import('../src/commands/agent.js');
  return runCommand(registerAgentCommand, ['agent', ...argv]);
}

async function runProvider(argv: string[], opts: { json?: boolean } = {}) {
  const { registerProviderCommand } = await import('../src/commands/provider/index.js');
  return runCommand(registerProviderCommand, ['provider', ...argv], opts);
}

async function runChat(argv: string[]) {
  const { registerChatCommand } = await import('../src/commands/chat.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: argv.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  program.exitOverride();
  registerChatCommand(program);
  await program.parseAsync(['node', 'spycore', ...argv]);
}

let workDir: string;
let origCwd: string;

beforeEach(() => {
  freshConfigDir();
  undiciState.responder = null;
  origCwd = process.cwd();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-r2p5-')));
  process.chdir(workDir);
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
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ───────────────────────── R2-17 ─────────────────────────

describe('R2-17 agent BYOK fallback probe clears its timer when streamChat throws', () => {
  test('a throwing probe leaves no 15 s timer behind', { timeout: 90_000 }, async () => {
    const { getConfigStore, setStoredProviders } = await import('../src/lib/config.js');
    getConfigStore().set('providerFallback', true);
    setStoredProviders([
      { name: 'gbox', type: 'google', baseURL: 'https://generativelanguage.googleapis.com', model: 'a/../b', apiKey: 'k-1' },
    ]);
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    const created = new Set<ReturnType<typeof setTimeout>>();
    let cleared = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const h = origSetTimeout(...args);
      if (args[1] === 15_000) created.add(h);
      return h;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
      const id = args[0] as ReturnType<typeof setTimeout> | undefined;
      if (id !== undefined && created.has(id)) cleared += 1;
      return origClearTimeout(...args);
    }) as typeof clearTimeout;
    let r: { stdout: string; stderr: string; error: unknown };
    try {
      r = await runAgent(['do a thing', '--provider', 'gbox', '--yes']);
    } finally {
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
    // The run still fails correctly - only the timer handling changed.
    expect(String((r.error as Error)?.message)).toMatch(/Invalid model id: a\/\.\.\/b/);
    // Pre-fix: 1 x 15,000 ms timer created, 0 cleared - the clear sat after
    // the await, so the throw skipped it and the process lingered 15 s.
    expect(created.size).toBe(1);
    expect(cleared).toBe(1);
  });
});

// ───────────────────────── R2-18 ─────────────────────────

describe('R2-18 provider list names OAuth as the key source of an OAuth-only provider', () => {
  test('an OAuth-only Google entry lists oauth, not the default env var', async () => {
    const { setStoredProviders } = await import('../src/lib/config.js');
    setStoredProviders([
      {
        name: 'g-oauth',
        type: 'google',
        baseURL: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.0-flash',
        oauthRefreshToken: 'rt-1',
        oauthClientId: 'cid-1',
      },
    ]);
    const r = await runProvider(['list']);
    expect(r.error).toBeUndefined();
    // Pre-fix this listed `env:GEMINI_API_KEY (default)` - a credential
    // source the run never consults for an OAuth entry.
    expect(r.stdout).toContain('oauth');
    expect(r.stdout).not.toContain('GEMINI_API_KEY');
  });

  test('an OAuth entry that ALSO stores a key still lists oauth (the factory refreshes, never reads the key)', async () => {
    const { setStoredProviders } = await import('../src/lib/config.js');
    setStoredProviders([
      {
        name: 'g-both',
        type: 'google',
        baseURL: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.0-flash',
        apiKeyEnv: 'MY_GOOGLE_KEY',
        oauthRefreshToken: 'rt-1',
        oauthClientId: 'cid-1',
      },
    ]);
    const r = await runProvider(['list']);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain('oauth');
    expect(r.stdout).not.toContain('MY_GOOGLE_KEY');
  });

  test('a non-OAuth Google entry still lists the default env var (no regression)', async () => {
    const { setStoredProviders } = await import('../src/lib/config.js');
    setStoredProviders([
      { name: 'g-key', type: 'google', baseURL: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash' },
    ]);
    const r = await runProvider(['list']);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain('env:GEMINI_API_KEY (default)');
  });

  test('the JSON listing carries the same oauth marker', async () => {
    const { setStoredProviders } = await import('../src/lib/config.js');
    setStoredProviders([
      {
        name: 'g-oauth',
        type: 'google',
        baseURL: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.0-flash',
        oauthRefreshToken: 'rt-1',
        oauthClientId: 'cid-1',
      },
    ]);
    const r = await runProvider(['list', '--format', 'json'], { json: true });
    expect(r.error).toBeUndefined();
    const parsed = JSON.parse(r.stdout) as {
      providers: Array<{ name: string; keySource: string }>;
    };
    expect(parsed.providers).toEqual([
      expect.objectContaining({ name: 'g-oauth', keySource: 'oauth' }),
    ]);
  });
});

// ───────────────────────── R2-19 ─────────────────────────

describe('R2-19 chat records BYOK usage under the saved provider name, whatever the flag casing', () => {
  function openaiSseUsage(): unknown {
    const lines = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi ' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: Readable.from([Buffer.from(lines.join(''), 'utf8')]),
    };
  }

  test('chat --provider foo then Foo for saved provider Foo records ONE row with both calls', async () => {
    const { setStoredProviders } = await import('../src/lib/config.js');
    setStoredProviders([
      { name: 'Foo', type: 'openai', baseURL: 'http://127.0.0.1:11434/v1', model: 'm', apiKey: 'sk-test' },
    ]);
    undiciState.responder = (url: string) => {
      if (isExactHost(url, '127.0.0.1:11434')) return openaiSseUsage();
      throw new Error(`unexpected ${url}`);
    };
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await runChat(['chat', '--provider', 'foo', 'hi']);
      await runChat(['chat', '--provider', 'Foo', 'hi']);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    const { getByokUsage } = await import('../src/lib/byok-usage.js');
    const usage = getByokUsage();
    // Pre-fix the keys were ['Foo', 'foo'] - one row per casing, one call
    // each, for one saved provider.
    expect(Object.keys(usage)).toEqual(['Foo']);
    expect(usage['Foo']).toMatchObject({ calls: 2, inputTokens: 20, outputTokens: 10 });
  });
});

// ───────────────────────── EXTRA (oauth.ts:235) ─────────────────────────

describe('EXTRA oauth error-body truncation never emits a lone surrogate', () => {
  const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  test('production transport: a real Response body IS async-iterable, so the live path takes the streaming branch', async () => {
    // This pins the branch analysis, not the fix: the undici Response the
    // CLI actually receives streams its body, so readCappedErrorText's
    // Buffer.concat(...).toString('utf8') path runs (which replaces an
    // incomplete trailing multi-byte sequence with U+FFFD, never a lone
    // surrogate). The defect below lived in the documented non-streaming
    // fallback branch, which the next tests drive directly.
    const resp = new Response('hello');
    expect(typeof (resp.body as unknown as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator]).toBe(
      'function',
    );
  });

  test('a straddling astral char in a non-streaming error body is cut clean, not split', async () => {
    const { refreshAccessToken } = await import('../src/lib/oauth.js');
    const { ERROR_BODY_MAX_BYTES } = await import('../src/lib/sse.js');
    // 'a' * (MAX-1) + U+1F600 + 'tail': a raw .slice(0, MAX) keeps the high
    // surrogate and drops its low half - a lone surrogate in the error.
    const poisoned = 'a'.repeat(ERROR_BODY_MAX_BYTES - 1) + '\uD83D\uDE00' + 'tail';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        // No body property at all: not async-iterable, so readCappedErrorText
        // falls back to .text() - the site under test.
        text: async () => poisoned,
      })),
    );
    let message = '';
    try {
      await refreshAccessToken(
        { clientId: 'cid', authUrl: 'https://example.invalid/auth', tokenUrl: 'https://example.invalid/token', scopes: [], redirectPort: 0 },
        'rt-1',
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/Token refresh failed \(400\)/);
    // Pre-fix the message carried the lone high surrogate; truncateSafe
    // backs the cut off by one instead, dropping the split character.
    expect(LONE_SURROGATE.test(message)).toBe(false);
    expect(message).not.toContain('\uD83D\uDE00');
  });

  test('an astral char ending exactly at the cap survives whole', async () => {
    const { refreshAccessToken } = await import('../src/lib/oauth.js');
    const { ERROR_BODY_MAX_BYTES } = await import('../src/lib/sse.js');
    // 'a' * (MAX-2) + U+1F600: the pair ends exactly at the cut - a correct
    // truncation keeps it; this pins truncateSafe against over-trimming.
    const body = 'a'.repeat(ERROR_BODY_MAX_BYTES - 2) + '\uD83D\uDE00';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => body,
      })),
    );
    let message = '';
    try {
      await refreshAccessToken(
        { clientId: 'cid', authUrl: 'https://example.invalid/auth', tokenUrl: 'https://example.invalid/token', scopes: [], redirectPort: 0 },
        'rt-1',
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/Token refresh failed \(400\)/);
    expect(LONE_SURROGATE.test(message)).toBe(false);
    expect(message).toContain('\uD83D\uDE00');
  });
});
