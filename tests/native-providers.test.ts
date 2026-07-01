import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Command, Option } from 'commander';
import { freshConfigDir } from './helpers.js';
import type { ProviderEvent } from '../src/lib/providers/types.js';

/**
 * Native Anthropic + Google BYOK adapters: request shape (URL, auth header,
 * system placement, role mapping), SSE parsing from realistic fixtures, usage
 * mapping, error handling, history replay — plus the resolution/validation
 * surface for the new types and a byte-identity guard on the SpyCore wire.
 */
interface CapturedRequest {
  url: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}
let requests: CapturedRequest[] = [];
let responder:
  | ((url: string) => { statusCode: number; headers: Record<string, string | string[]>; body: unknown })
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(
    async (
      url: string,
      init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ) => {
      requests.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (!responder) throw new Error('test forgot to set responder');
      return responder(url);
    },
  ),
}));

beforeEach(() => {
  freshConfigDir();
  requests = [];
  responder = null;
});
afterEach(() => {
  vi.resetModules();
});

function sseResp(lines: string[]): { statusCode: number; headers: Record<string, string>; body: unknown } {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Readable.from([Buffer.from(lines.join(''), 'utf8')]),
  };
}
function errResp(status: number, bodyObj: unknown) {
  return { statusCode: status, headers: {}, body: { text: async () => JSON.stringify(bodyObj) } };
}

/** A realistic Anthropic Messages SSE stream (event: + data: framing). */
function anthropicSse(deltas: string[], usage: { input: number; output: number }) {
  const ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return sseResp([
    ev('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: usage.input, output_tokens: 1 } },
    }),
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...deltas.map((t) =>
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } }),
    ),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output } }),
    ev('message_stop', { type: 'message_stop' }),
  ]);
}

/** A realistic Google alt=sse stream (data-only lines, no terminator). */
function googleSse(deltas: string[], usage: { input: number; output: number }) {
  const chunk = (text: string, withUsage: boolean): string =>
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] } }],
      ...(withUsage ? { usageMetadata: { promptTokenCount: usage.input, candidatesTokenCount: usage.output } } : {}),
    })}\n\n`;
  return sseResp(deltas.map((t, i) => chunk(t, i === deltas.length - 1)));
}

const lastBody = (): Record<string, unknown> =>
  JSON.parse(requests[requests.length - 1]?.body ?? '{}') as Record<string, unknown>;
const lastHeaders = (): Record<string, string> => requests[requests.length - 1]?.headers ?? {};

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

// ───────────────────────── Anthropic adapter ─────────────────────────

describe('AnthropicProvider', () => {
  const make = async () => {
    const { AnthropicProvider } = await import('../src/lib/providers/anthropic.js');
    return new AnthropicProvider({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-SECRET' });
  };

  test('request: /v1/messages with x-api-key + anthropic-version, system top-level, max_tokens, stream', async () => {
    responder = () => anthropicSse(['hi'], { input: 10, output: 2 });
    const p = await make();
    const id = await p.createConversation({ model: 'claude-x' });
    await collect(p.streamChat({ conversationId: id, message: 'TASK: x', system: 'SYS', model: 'claude-x' }));
    const req = requests[requests.length - 1];
    expect(req?.url).toBe('https://api.anthropic.com/v1/messages');
    const h = lastHeaders();
    expect(h['x-api-key']).toBe('sk-ant-SECRET');
    expect(h['anthropic-version']).toBeTruthy();
    expect('authorization' in h).toBe(false); // not a Bearer API
    const body = lastBody();
    expect(body.model).toBe('claude-x');
    expect(body.system).toBe('SYS'); // top-level, NOT a message
    expect(body.max_tokens).toBe(8192);
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([{ role: 'user', content: 'TASK: x' }]);
  });

  test('yields ordered text events + mapped usage + done from the typed SSE stream', async () => {
    responder = () => anthropicSse(['Hello', ', ', 'world'], { input: 42, output: 17 });
    const p = await make();
    const id = await p.createConversation({ model: 'm' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'm' }));
    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ', ' },
      { type: 'text', text: 'world' },
      { type: 'usage', input: 42, output: 17 }, // input from message_start, output from message_delta
      { type: 'done' },
    ]);
  });

  test('replays history and resends the remembered system on turn 2', async () => {
    responder = () => anthropicSse(['A'], { input: 1, output: 1 });
    const p = await make();
    const id = await p.createConversation({ model: 'm' });
    await collect(p.streamChat({ conversationId: id, message: 'first', system: 'SYS', model: 'm' }));

    responder = () => anthropicSse(['B'], { input: 1, output: 1 });
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' })); // no system this turn
    const body = lastBody();
    expect(body.system).toBe('SYS'); // remembered from turn 1 (stateless API)
    expect(body.messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'A' },
      { role: 'user', content: 'second' },
    ]);
  });

  test('HTTP 401/404/429 → clear messages; the key never appears', async () => {
    const p = await make();
    const run = async (status: number, msg: string) => {
      responder = () => errResp(status, { type: 'error', error: { type: 'x', message: msg } });
      const id = await p.createConversation({ model: 'claude-x' });
      return collect(p.streamChat({ conversationId: id, message: 'hi', model: 'claude-x' }));
    };
    const e401 = (await run(401, 'invalid x-api-key'))[0] as { type: string; message: string };
    expect(e401.type).toBe('error');
    expect(e401.message).toMatch(/401/);
    expect(e401.message).toMatch(/key/i);
    expect(e401.message).not.toContain('sk-ant-SECRET');
    const e404 = (await run(404, 'model not found'))[0] as { message: string };
    expect(e404.message).toMatch(/404/);
    expect(e404.message).toMatch(/--model|--base-url/);
    const e429 = (await run(429, 'overloaded'))[0] as { message: string };
    expect(e429.message).toMatch(/429|rate/i);
  });

  test('an SSE error event surfaces as an error event', async () => {
    responder = () =>
      sseResp([
        `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
      ]);
    const p = await make();
    const id = await p.createConversation({ model: 'm' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'm' }));
    expect(events).toEqual([{ type: 'error', message: expect.stringContaining('Overloaded') }]);
  });
});

// ───────────────────────── Google adapter ─────────────────────────

describe('GoogleProvider', () => {
  const make = async () => {
    const { GoogleProvider } = await import('../src/lib/providers/google.js');
    return new GoogleProvider({ baseURL: 'https://generativelanguage.googleapis.com', apiKey: 'AIza-SECRET' });
  };

  test('request: streamGenerateContent?alt=sse with x-goog-api-key, systemInstruction, role mapping', async () => {
    responder = () => googleSse(['hi'], { input: 5, output: 2 });
    const p = await make();
    const id = await p.createConversation({ model: 'g-model' });
    await collect(p.streamChat({ conversationId: id, message: 'TASK: x', system: 'SYS', model: 'g-model' }));
    const req = requests[requests.length - 1];
    expect(req?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/g-model:streamGenerateContent?alt=sse',
    );
    const h = lastHeaders();
    expect(h['x-goog-api-key']).toBe('AIza-SECRET');
    expect('authorization' in h).toBe(false);
    const body = lastBody();
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'TASK: x' }] }]);
  });

  test('yields ordered text + usageMetadata mapping + done (stream end, no terminator)', async () => {
    responder = () => googleSse(['One', 'Two'], { input: 33, output: 9 });
    const p = await make();
    const id = await p.createConversation({ model: 'm' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'm' }));
    expect(events).toEqual([
      { type: 'text', text: 'One' },
      { type: 'text', text: 'Two' },
      { type: 'usage', input: 33, output: 9 },
      { type: 'done' },
    ]);
  });

  test('maps assistant → model role in the next turn and keeps systemInstruction', async () => {
    responder = () => googleSse(['A'], { input: 1, output: 1 });
    const p = await make();
    const id = await p.createConversation({ model: 'm' });
    await collect(p.streamChat({ conversationId: id, message: 'first', system: 'SYS', model: 'm' }));

    responder = () => googleSse(['B'], { input: 1, output: 1 });
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    const body = lastBody();
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'SYS' }] });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ text: 'A' }] }, // assistant → 'model'
      { role: 'user', parts: [{ text: 'second' }] },
    ]);
  });

  test('HTTP 400/403/404/429 → clear messages; the key never appears', async () => {
    const p = await make();
    const run = async (status: number, msg: string) => {
      responder = () => errResp(status, { error: { code: status, message: msg, status: 'X' } });
      const id = await p.createConversation({ model: 'g' });
      return collect(p.streamChat({ conversationId: id, message: 'hi', model: 'g' }));
    };
    const e400 = (await run(400, 'API key not valid'))[0] as { type: string; message: string };
    expect(e400.type).toBe('error');
    expect(e400.message).toMatch(/400/);
    expect(e400.message).toMatch(/key/i);
    expect(e400.message).not.toContain('AIza-SECRET');
    const e403 = (await run(403, 'permission denied'))[0] as { message: string };
    expect(e403.message).toMatch(/403/);
    const e404 = (await run(404, 'model not found'))[0] as { message: string };
    expect(e404.message).toMatch(/--model|--base-url/);
    const e429 = (await run(429, 'quota exceeded'))[0] as { message: string };
    expect(e429.message).toMatch(/429|rate/i);
  });
});

// ───────────────────────── resolution + validation for the new types ─────────────────────────

describe('resolution for native types', () => {
  const base = {
    baseUrl: undefined,
    model: undefined,
    apiKeyEnv: undefined,
    env: {} as NodeJS.ProcessEnv,
    stored: [] as Array<{
      name: string;
      type: 'openai' | 'anthropic' | 'google';
      baseURL: string;
      model?: string;
      apiKeyEnv?: string;
      apiKey?: string;
    }>,
    defaultProvider: undefined as string | undefined,
  };

  test('--provider anthropic ad-hoc: default base URL + env key + label', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    const sel = resolveProviderSelection({
      ...base,
      providerFlag: 'anthropic',
      model: 'claude-x',
      env: { ANTHROPIC_API_KEY: 'sk-a' },
    });
    expect(sel).toMatchObject({ kind: 'byok', sourceName: null });
    if (sel.kind === 'byok') {
      expect(sel.config.type).toBe('anthropic');
      expect(sel.config.baseURL).toBe('https://api.anthropic.com');
      expect(sel.config.apiKey).toBe('sk-a');
      expect(sel.config.routingLine).toBe('Model: claude-x (anthropic)');
    }
  });

  test('--provider google ad-hoc: default base URL + env key + label', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    const sel = resolveProviderSelection({
      ...base,
      providerFlag: 'google',
      model: 'g-model',
      env: { GEMINI_API_KEY: 'AIza-g' },
    });
    if (sel.kind === 'byok') {
      expect(sel.config.type).toBe('google');
      expect(sel.config.baseURL).toBe('https://generativelanguage.googleapis.com');
      expect(sel.config.apiKey).toBe('AIza-g');
      expect(sel.config.routingLine).toBe('Model: g-model (google)');
    } else {
      throw new Error('expected byok');
    }
  });

  test('missing key for a native type → clear error BEFORE any request', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    expect(() =>
      resolveProviderSelection({ ...base, providerFlag: 'anthropic', model: 'claude-x', env: {} }),
    ).toThrow(/API key is required.*anthropic/);
    expect(() =>
      resolveProviderSelection({ ...base, providerFlag: 'google', model: 'g', env: {} }),
    ).toThrow(/API key is required.*google/);
    expect(requests).toHaveLength(0); // nothing was sent
  });

  test('openai stays keyless-capable (no default-env fallback for stored configs)', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    const stored = [{ name: 'local', type: 'openai' as const, baseURL: 'http://localhost:1/v1', model: 'm' }];
    const sel = resolveProviderSelection({
      ...base,
      providerFlag: 'local',
      stored,
      env: { OPENAI_API_KEY: 'should-NOT-be-picked-up' },
    });
    if (sel.kind === 'byok') expect(sel.config.apiKey).toBeUndefined();
    else throw new Error('expected byok');
  });

  test('a stored anthropic config with no key source falls back to the default env var', async () => {
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    const stored = [
      { name: 'claudebox', type: 'anthropic' as const, baseURL: 'https://api.anthropic.com', model: 'claude-x' },
    ];
    const sel = resolveProviderSelection({
      ...base,
      providerFlag: 'claudebox',
      stored,
      env: { ANTHROPIC_API_KEY: 'sk-fallback' },
    });
    if (sel.kind === 'byok') expect(sel.config.apiKey).toBe('sk-fallback');
    else throw new Error('expected byok');
    // …and errors when even the fallback is absent.
    expect(() => resolveProviderSelection({ ...base, providerFlag: 'claudebox', stored, env: {} })).toThrow(
      /API key is required/,
    );
  });
});

// ───────────────────────── provider command accepts the new types ─────────────────────────

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
    configureOutput({ json: false, color: true });
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

const runProvider = (argv: string[], opts?: { json?: boolean }) =>
  import('../src/commands/provider/index.js').then(({ registerProviderCommand }) =>
    runCommand(registerProviderCommand, ['provider', ...argv], opts),
  );

describe('provider command — native types', () => {
  test('add --type anthropic with no --base-url persists the default base URL', async () => {
    const { getStoredProviders } = await import('../src/lib/config.js');
    const r = await runProvider(['add', 'claudebox', '--type', 'anthropic', '--model', 'claude-x', '--api-key-env', 'MY_ANT_KEY']);
    expect(r.error).toBeUndefined();
    expect(getStoredProviders()[0]).toMatchObject({
      name: 'claudebox',
      type: 'anthropic',
      baseURL: 'https://api.anthropic.com',
      model: 'claude-x',
      apiKeyEnv: 'MY_ANT_KEY',
    });
  });

  test('add --type google persists; list shows the default-env key source for keyless natives', async () => {
    await runProvider(['add', 'gbox', '--type', 'google', '--model', 'g-model']);
    const list = await runProvider(['list'], { json: true });
    const parsed = JSON.parse(list.stdout) as { providers: Array<Record<string, unknown>> };
    expect(parsed.providers[0]).toMatchObject({
      name: 'gbox',
      type: 'google',
      baseURL: 'https://generativelanguage.googleapis.com',
      keySource: 'env:GEMINI_API_KEY (default)',
    });
  });

  test('add rejects an unsupported type and the new reserved names', async () => {
    const bad = await runProvider(['add', 'x', '--type', 'mystery']);
    expect(String((bad.error as Error)?.message)).toMatch(/Unsupported provider type/);
    for (const reserved of ['anthropic', 'google']) {
      const r = await runProvider(['add', reserved, '--type', 'openai', '--model', 'm']);
      expect(String((r.error as Error)?.message)).toMatch(/reserved/);
    }
  });

  test('provider test works through the anthropic adapter', async () => {
    responder = () => anthropicSse(['OK'], { input: 1, output: 1 });
    await runProvider(['add', 'claudebox', '--type', 'anthropic', '--model', 'claude-x', '--api-key-env', 'ANT_KEY']);
    process.env.ANT_KEY = 'sk-test-ant';
    try {
      const r = await runProvider(['test', 'claudebox']);
      expect(r.error).toBeUndefined();
      expect(r.stdout + r.stderr).toMatch(/reachable/);
      const req = requests.find((q) => q.url.includes('/v1/messages'));
      expect(req).toBeTruthy();
      expect(req?.headers?.['x-api-key']).toBe('sk-test-ant');
    } finally {
      delete process.env.ANT_KEY;
    }
  });
});

// ───────────────────────── SpyCore wire byte-identity guard ─────────────────────────

describe('SpyCore wire — system+task concatenation preserved', () => {
  test('turn 1 body.message is exactly `${system}\\n\\nTASK: …` (one string, as before the seam split)', async () => {
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    responder = (url) => {
      if (url.endsWith('/conversations')) {
        return { statusCode: 200, headers: {}, body: { json: async () => ({ success: true, data: { id: 'cnv_1' } }) } };
      }
      if (url.includes('/api/chat/stream')) {
        return sseResp([`data: ${JSON.stringify({ type: 'text', content: 'Done.' })}\n\n`, `data: {"type":"done"}\n\n`]);
      }
      throw new Error(`unexpected ${url}`);
    };
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({ task: 'read it', cwd: '/tmp', maxTurns: 2 });
    const chat = requests.find((q) => q.url.includes('/api/chat/stream'));
    const body = JSON.parse(chat?.body ?? '{}') as { message?: string };
    // One concatenated string: system prompt first, the \n\nTASK: join, no separate field.
    expect(body.message?.startsWith('You are SpyCode')).toBe(true);
    expect(body.message).toContain('spycore:tool');
    expect(body.message).toContain('\n\nTASK: read it');
    expect('system' in (JSON.parse(chat?.body ?? '{}') as Record<string, unknown>)).toBe(false);
  });
});
