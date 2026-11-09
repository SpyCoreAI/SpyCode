import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Command, Option } from 'commander';
import { freshConfigDir } from './helpers.js';
import type { ProviderEvent } from '../src/lib/providers/types.js';

/**
 * Native Anthropic + Google BYOK adapters: request shape (URL, auth header,
 * system placement, role mapping), SSE parsing from realistic fixtures, usage
 * mapping, error handling, history replay - plus the resolution/validation
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

describe('resolveAnthropicMaxTokens', () => {
  test('Claude 3 family caps at 4096; newer models get 8192', async () => {
    const { resolveAnthropicMaxTokens } = await import('../src/lib/providers/anthropic.js');
    expect(resolveAnthropicMaxTokens('claude-3-haiku-20240307')).toBe(4096);
    expect(resolveAnthropicMaxTokens('claude-3-opus-20240229')).toBe(4096);
    expect(resolveAnthropicMaxTokens('claude-instant-1.2')).toBe(4096);
    // 3.5 Sonnet genuinely supports 8192 output tokens - only the 3.0
    // family caps at 4096.
    expect(resolveAnthropicMaxTokens('claude-3-5-sonnet-20241022')).toBe(8192);
    expect(resolveAnthropicMaxTokens('claude-sonnet-4-20250514')).toBe(8192);
    expect(resolveAnthropicMaxTokens('claude-opus-4-1')).toBe(8192);
    expect(resolveAnthropicMaxTokens('claude-x')).toBe(8192);
  });

  test('the cap is purely the model-name heuristic - there is no override (R2 L12)', async () => {
    // The provider's maxTokens option was dead in production (the factory
    // never passed it, no flag or stored field set it), so the option and
    // the resolver's override branch were removed rather than wired.
    // resolveAnthropicMaxTokens now takes only the model.
    const { resolveAnthropicMaxTokens } = await import('../src/lib/providers/anthropic.js');
    expect(resolveAnthropicMaxTokens.length).toBe(1);
    expect(resolveAnthropicMaxTokens('claude-3-haiku-20240307')).toBe(4096);
    expect(resolveAnthropicMaxTokens('claude-sonnet-4-20250514')).toBe(8192);
  });

  test('the provider sends the derived cap in the request body', async () => {
    const { AnthropicProvider } = await import('../src/lib/providers/anthropic.js');
    responder = () => anthropicSse(['hi'], { input: 1, output: 1 });
    const p = new AnthropicProvider({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-SECRET' });
    const id = await p.createConversation({ model: 'claude-3-haiku-20240307' });
    await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'claude-3-haiku-20240307' }));
    expect(lastBody().max_tokens).toBe(4096);
  });
});

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

  test('a 401 refreshes the OAuth token once and replays the request with the fresh token', async () => {
    const { GoogleProvider } = await import('../src/lib/providers/google.js');
    let refreshes = 0;
    const p = new GoogleProvider({
      baseURL: 'https://generativelanguage.googleapis.com',
      oauthAccessToken: 'expired-token',
      refreshOAuthToken: async () => {
        refreshes += 1;
        return 'fresh-token';
      },
    });
    let calls = 0;
    responder = () => {
      calls += 1;
      if (calls === 1) return errResp(401, { error: { code: 401, message: 'invalid token', status: 'UNAUTHENTICATED' } });
      return googleSse(['refreshed'], { input: 1, output: 1 });
    };
    const id = await p.createConversation({ model: 'g-model' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'g-model' }));
    expect(events[0]).toEqual({ type: 'text', text: 'refreshed' });
    expect(events[events.length - 1]).toEqual({ type: 'done' });
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
    // The replay carried the fresh token, not the expired one.
    expect(requests[0]?.headers?.['authorization']).toBe('Bearer expired-token');
    expect(requests[1]?.headers?.['authorization']).toBe('Bearer fresh-token');
  });

  test('a 401 with no refresher configured surfaces as an error (no retry)', async () => {
    const { GoogleProvider } = await import('../src/lib/providers/google.js');
    const p = new GoogleProvider({
      baseURL: 'https://generativelanguage.googleapis.com',
      oauthAccessToken: 'expired-token',
    });
    responder = () => errResp(401, { error: { code: 401, message: 'invalid token', status: 'UNAUTHENTICATED' } });
    const id = await p.createConversation({ model: 'g-model' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'g-model' }));
    expect(events[0]?.type).toBe('error');
    expect(requests).toHaveLength(1);
  });

  test('a safety-blocked prompt surfaces as an error, not a silent empty turn (R2 M4)', async () => {
    const p = await make();
    // promptFeedback with a block reason, no candidates, no text.
    responder = () =>
      sseResp([`data: ${JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })}\n\n`]);
    const id = await p.createConversation({ model: 'g-model' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'g-model' }));
    expect(events).toEqual([
      { type: 'error', message: expect.stringContaining('SAFETY') },
    ]);
  });

  test('a candidate finishing SAFETY / RECITATION surfaces as an error, not an empty done (R2 M4)', async () => {
    const p = await make();
    for (const reason of ['SAFETY', 'RECITATION', 'BLOCKLIST', 'OTHER']) {
      responder = () =>
        sseResp([
          `data: ${JSON.stringify({ candidates: [{ finishReason: reason }] })}\n\n`,
        ]);
      const id = await p.createConversation({ model: 'g-model' });
      const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'g-model' }));
      expect(events).toEqual([
        { type: 'error', message: expect.stringContaining(reason) },
      ]);
    }
    // Control: a normal finish still ends done, and MAX_TOKENS still warns.
    responder = () =>
      sseResp([
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\n\n`,
      ]);
    const id = await p.createConversation({ model: 'g-model' });
    expect(await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'g-model' }))).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'done' },
    ]);
  });

  test('a model id with .. segments is rejected before any request (R2 L6)', async () => {
    const p = await make();
    const id = await p.createConversation({ model: 'a/../../b' });
    await expect(
      collect(p.streamChat({ conversationId: id, message: 'hi', model: 'a/../../b' })),
    ).rejects.toThrow(/Invalid model id/);
    expect(requests).toHaveLength(0);
    const id2 = await p.createConversation({ model: 'models/../../v1beta/models/evil' });
    await expect(
      collect(p.streamChat({ conversationId: id2, message: 'hi', model: 'models/../../v1beta/models/evil' })),
    ).rejects.toThrow(/Invalid model id/);
    expect(requests).toHaveLength(0);
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

describe('provider command - native types', () => {
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

  test('a hand-edited stored entry with an unknown type fails cleanly on list, not with a TypeError (R2 L9)', async () => {
    const { setStoredProviders } = await import('../src/lib/config.js');
    setStoredProviders([
      {
        name: 'tampered',
        type: 'mystery' as 'openai',
        baseURL: 'https://example.com/v1',
        model: 'm',
      },
    ]);
    const list = await runProvider(['list']);
    expect(String((list.error as Error)?.message)).toMatch(/Unknown BYOK provider type/);
    expect(String((list.error as Error)?.message)).not.toMatch(/Cannot read properties of undefined/);
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

describe('SpyCore wire - system+task concatenation preserved', () => {
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

// ───────────────────────── R2 pass 3: tool-use-only replies + stream cap ─────────────────────────

/** One typed Anthropic SSE frame (`event:` + `data:`), same shape as anthropicSse's local helper. */
const r2ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

describe('R2 pass 3 - tool-use-only replies surface tool_calls (R2-1)', () => {
  test('Anthropic: a tool_use-only reply yields tool_calls, not a silent done', async () => {
    responder = () =>
      sseResp([
        r2ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
        r2ev('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
        }),
        r2ev('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":' },
        }),
        r2ev('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"/etc/passwd"}' },
        }),
        r2ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
        r2ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }),
        r2ev('message_stop', { type: 'message_stop' }),
      ]);
    const { AnthropicProvider } = await import('../src/lib/providers/anthropic.js');
    const p = new AnthropicProvider({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-SECRET' });
    const id = await p.createConversation({ model: 'claude-x' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'claude-x' }));
    expect(events.map((e) => e.type)).toEqual(['usage', 'tool_calls', 'done']);
    const calls = events.find((e) => e.type === 'tool_calls') as {
      type: string;
      calls: Array<{ id: string; name: string; arguments: string }>;
    };
    expect(calls.calls).toEqual([
      { id: 'toolu_1', name: 'read_file', arguments: '{"path":"/etc/passwd"}' },
    ]);
  });

  test('Google: a functionCall-only reply yields tool_calls, not a silent done', async () => {
    responder = () =>
      sseResp([
        `data: ${JSON.stringify({
          candidates: [
            {
              content: { parts: [{ functionCall: { name: 'read_file', args: { path: '/etc/passwd' } } }] },
              finishReason: 'STOP',
            },
          ],
        })}\n\n`,
      ]);
    const { GoogleProvider } = await import('../src/lib/providers/google.js');
    const p = new GoogleProvider({ baseURL: 'https://generativelanguage.googleapis.com', apiKey: 'AIza-SECRET' });
    const id = await p.createConversation({ model: 'gemini-2.0-flash' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'gemini-2.0-flash' }));
    expect(events.map((e) => e.type)).toEqual(['tool_calls', 'done']);
    const calls = events.find((e) => e.type === 'tool_calls') as {
      type: string;
      calls: Array<{ id: string; name: string; arguments: string }>;
    };
    expect(calls.calls).toHaveLength(1);
    expect(calls.calls[0]?.name).toBe('read_file');
    expect(calls.calls[0]?.arguments).toBe('{"path":"/etc/passwd"}');
    expect(calls.calls[0]?.id.length).toBeGreaterThan(0);
  });
});

describe('R2 pass 3 - streamed turns are capped at 1 MB (R2-2)', () => {
  test('OpenAI: 2 MB of text deltas ends in a cap error, never a 2 MB reply', async () => {
    const big = 'x'.repeat(10_240);
    const lines: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: big } }] })}\n\n`);
    }
    lines.push('data: [DONE]\n\n');
    responder = () => sseResp(lines);
    const { OpenAICompatibleProvider } = await import('../src/lib/providers/openai-compatible.js');
    const p = new OpenAICompatibleProvider({ baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'k' });
    const id = await p.createConversation({ model: 'm' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'm' }));
    const total = events
      .filter((e) => e.type === 'text')
      .reduce((n, e) => n + (e as { text: string }).text.length, 0);
    expect(total).toBeLessThanOrEqual(1_048_576);
    const err = events.find((e) => e.type === 'error') as { type: string; message: string } | undefined;
    expect(err?.message).toMatch(/1,048,576 byte stream cap/);
    expect(events.some((e) => e.type === 'done')).toBe(false);
  });

  test('Anthropic: text deltas past the cap end in a cap error', async () => {
    const big = 'y'.repeat(600_000);
    responder = () =>
      sseResp([
        r2ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }),
        r2ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        r2ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: big } }),
        r2ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: big } }),
        r2ev('message_stop', { type: 'message_stop' }),
      ]);
    const { AnthropicProvider } = await import('../src/lib/providers/anthropic.js');
    const p = new AnthropicProvider({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-SECRET' });
    const id = await p.createConversation({ model: 'claude-x' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'claude-x' }));
    expect(events.map((e) => e.type)).toEqual(['text', 'error']);
    expect((events[1] as { message: string }).message).toMatch(/1,048,576 byte stream cap/);
  });

  test('Google: text parts past the cap end in a cap error', async () => {
    const big = 'z'.repeat(600_000);
    responder = () =>
      sseResp([
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: big }] } }] })}\n\n`,
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: big }] } }] })}\n\n`,
      ]);
    const { GoogleProvider } = await import('../src/lib/providers/google.js');
    const p = new GoogleProvider({ baseURL: 'https://generativelanguage.googleapis.com', apiKey: 'AIza-SECRET' });
    const id = await p.createConversation({ model: 'gemini-2.0-flash' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'gemini-2.0-flash' }));
    expect(events.map((e) => e.type)).toEqual(['text', 'error']);
    expect((events[1] as { message: string }).message).toMatch(/1,048,576 byte stream cap/);
  });
});
