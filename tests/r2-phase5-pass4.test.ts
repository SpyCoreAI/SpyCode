import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { Command, Option } from 'commander';
import { freshConfigDir } from './helpers.js';
import type { ProviderEvent } from '../src/lib/providers/types.js';
import { getStoredProviders } from '../src/lib/config.js';
import { registerProviderCommand } from '../src/commands/provider/index.js';

/**
 * Phase 5 pass 4, R2 (providers + auth + chat + ACP) regressions:
 * R2-10 (empty assistant message poisons Anthropic/Google sessions),
 * R2-11 (shouldStop never polled on tool-call-only turns),
 * R2-13 (provider add health-check timer leak),
 * R2-14 (SPYCORE_TOKEN returned untrimmed),
 * R2-15 (__proto__ provider loses usage tracking).
 * R2-12 (fenced loop drops BYOK native tool_calls) lives in
 * tests/r2-phase5-pass4-loop.test.ts - it drives runAgent, not the adapters.
 *
 * Each test below was written against the FIXED behaviour and fails on the
 * pre-fix tree for the reason named in its comment (verified by stashing
 * the fix - see the fix log); nothing here pins the old buggy shape.
 */

// Force the file fallback path for auth: pretend keytar is unavailable.
vi.mock('keytar', () => {
  throw new Error('not installed');
});

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
  vi.unstubAllEnvs();
});

function sseResp(lines: string[]): { statusCode: number; headers: Record<string, string>; body: unknown } {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Readable.from([Buffer.from(lines.join(''), 'utf8')]),
  };
}

const lastBody = (): Record<string, unknown> =>
  JSON.parse(requests[requests.length - 1]?.body ?? '{}') as Record<string, unknown>;

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
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
    ev('message_delta', { type: 'message_delta', stop_reason: 'end_turn', usage: { output_tokens: usage.output } }),
    ev('message_stop', { type: 'message_stop' }),
  ]);
}

/** Anthropic: message_start + message_stop only, no text at all. */
function anthropicEmpty() {
  const ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return sseResp([
    ev('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 10, output_tokens: 1 } },
    }),
    ev('message_stop', { type: 'message_stop' }),
  ]);
}

/** Anthropic: a tool_use-only turn (no text), arguments in two fragments. */
function anthropicToolOnly() {
  const ev = (name: string, data: unknown): string => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  return sseResp([
    ev('message_start', {
      type: 'message_start',
      message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 10, output_tokens: 1 } },
    }),
    ev('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' },
    }),
    ev('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"path":' },
    }),
    ev('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"/tmp/x"}' },
    }),
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }),
    ev('message_delta', { type: 'message_delta', stop_reason: 'tool_use', usage: { output_tokens: 5 } }),
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

/** Google: one chunk with empty parts, then a clean stream end. */
function googleEmpty() {
  return sseResp([
    `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] } }] })}\n\n`,
  ]);
}

/** Google: a functionCall-only chunk (no text). */
function googleFunctionCallOnly() {
  return sseResp([
    `data: ${JSON.stringify({
      candidates: [
        {
          content: { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: '/tmp/x' } } }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    })}\n\n`,
  ]);
}

/** OpenAI-compatible: a tool_calls-only stream, arguments in two fragments. */
function openaiToolOnly() {
  const chunk = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
  return sseResp([
    chunk({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }],
          },
        },
      ],
    }),
    chunk({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"/tmp/x"}' } }] } }],
    }),
    'data: [DONE]\n\n',
  ]);
}

/** OpenAI-compatible: one text delta, then [DONE]. */
function openaiText() {
  return sseResp([
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
    'data: [DONE]\n\n',
  ]);
}

// ───────────────────────── R2-10 ─────────────────────────

describe('R2-10 no-text BYOK turn must not poison the session', () => {
  test('Anthropic: an empty stream records a non-empty assistant message, so turn 2 stays valid', async () => {
    const { AnthropicProvider } = await import('../src/lib/providers/anthropic.js');
    const p = new AnthropicProvider({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-SECRET' });
    const id = await p.createConversation({ model: 'm' });
    responder = () => anthropicEmpty();
    // Pre-fix this ended ['usage','done'] and recorded {content: ''}; the
    // next turn then replayed the empty message and the API 400s.
    expect(await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }))).toEqual([
      { type: 'usage', input: 10, output: 1 },
      { type: 'done' },
    ]);
    responder = () => anthropicSse(['B'], { input: 1, output: 1 });
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    const messages = lastBody().messages as Array<{ role: string; content: string }>;
    expect(messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: '(empty reply)' },
      { role: 'user', content: 'second' },
    ]);
    expect(messages.every((m) => m.content.length > 0)).toBe(true);
  });

  test('Anthropic: a tool-call-only turn records its calls in history', async () => {
    const { AnthropicProvider } = await import('../src/lib/providers/anthropic.js');
    const p = new AnthropicProvider({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-SECRET' });
    const id = await p.createConversation({ model: 'm' });
    responder = () => anthropicToolOnly();
    expect(await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }))).toEqual([
      { type: 'usage', input: 10, output: 5 },
      { type: 'tool_calls', calls: [{ id: 'toolu_1', name: 'read_file', arguments: '{"path":"/tmp/x"}' }] },
      { type: 'done' },
    ]);
    responder = () => anthropicSse(['B'], { input: 1, output: 1 });
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    const messages = lastBody().messages as Array<{ role: string; content: string }>;
    // Pre-fix the recorded assistant message was {content: ''} and the
    // calls were lost from history entirely.
    expect(messages).toEqual([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: '```spycore:tool\n{"tool":"read_file","args":{"path":"/tmp/x"}}\n```',
      },
      { role: 'user', content: 'second' },
    ]);
  });

  test('Anthropic: an error after a no-text first turn does not keep a poisoned entry', async () => {
    const { AnthropicProvider } = await import('../src/lib/providers/anthropic.js');
    const p = new AnthropicProvider({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-SECRET' });
    const id = await p.createConversation({ model: 'm' });
    responder = () => anthropicEmpty();
    await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }));
    // Turn 2 fails at HTTP level: the error path pops the user message but
    // must not leave an empty assistant message behind.
    responder = () => ({
      statusCode: 500,
      headers: {},
      body: { text: async () => JSON.stringify({ error: { message: 'boom' } }) },
    });
    const events = await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    expect(events[0]?.type).toBe('error');
    responder = () => anthropicSse(['C'], { input: 1, output: 1 });
    await collect(p.streamChat({ conversationId: id, message: 'third', model: 'm' }));
    const messages = lastBody().messages as Array<{ role: string; content: string }>;
    expect(messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: '(empty reply)' },
      { role: 'user', content: 'third' },
    ]);
    expect(messages.every((m) => m.content.length > 0)).toBe(true);
  });

  test('Google: an empty-parts chunk records a non-empty model message, so turn 2 stays valid', async () => {
    const { GoogleProvider } = await import('../src/lib/providers/google.js');
    const p = new GoogleProvider({ baseURL: 'https://generativelanguage.googleapis.com', apiKey: 'k' });
    const id = await p.createConversation({ model: 'g-model' });
    responder = () => googleEmpty();
    // Pre-fix this ended ['done'] and recorded parts:[{text: ''}].
    expect(await collect(p.streamChat({ conversationId: id, message: 'first', model: 'g-model' }))).toEqual([
      { type: 'done' },
    ]);
    responder = () => googleSse(['B'], { input: 1, output: 1 });
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'g-model' }));
    const contents = lastBody().contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'first' }] },
      { role: 'model', parts: [{ text: '(empty reply)' }] },
      { role: 'user', parts: [{ text: 'second' }] },
    ]);
    expect(contents.every((c) => c.parts.every((part) => part.text.length > 0))).toBe(true);
  });

  test('Google: a functionCall-only turn records its calls in history', async () => {
    const { GoogleProvider } = await import('../src/lib/providers/google.js');
    const p = new GoogleProvider({ baseURL: 'https://generativelanguage.googleapis.com', apiKey: 'k' });
    const id = await p.createConversation({ model: 'g-model' });
    responder = () => googleFunctionCallOnly();
    expect(await collect(p.streamChat({ conversationId: id, message: 'first', model: 'g-model' }))).toEqual([
      { type: 'usage', input: 10, output: 5 },
      { type: 'tool_calls', calls: [{ id: 'google-call-0', name: 'read_file', arguments: '{"path":"/tmp/x"}' }] },
      { type: 'done' },
    ]);
    responder = () => googleSse(['B'], { input: 1, output: 1 });
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'g-model' }));
    const contents = lastBody().contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    // Pre-fix the recorded model message was parts:[{text: ''}] and the
    // call was lost from history entirely.
    expect(contents).toEqual([
      { role: 'user', parts: [{ text: 'first' }] },
      {
        role: 'model',
        parts: [{ text: '```spycore:tool\n{"tool":"read_file","args":{"path":"/tmp/x"}}\n```' }],
      },
      { role: 'user', parts: [{ text: 'second' }] },
    ]);
  });
});

// ───────────────────────── R2-11 ─────────────────────────

describe('R2-11 shouldStop is polled on tool-call-only turns', () => {
  test('Anthropic: a tool_use-only turn with shouldStop tripped ends early, without done or tool_calls', async () => {
    const { AnthropicProvider } = await import('../src/lib/providers/anthropic.js');
    const p = new AnthropicProvider({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-SECRET' });
    const id = await p.createConversation({ model: 'm' });
    responder = () => anthropicToolOnly();
    // Pre-fix this ran to completion: ['usage','tool_calls','done'].
    const events = await collect(
      p.streamChat({ conversationId: id, message: 'first', model: 'm', shouldStop: () => true }),
    );
    expect(events).toEqual([]);
    // The tripped turn still settled its history validly: the calls were
    // recorded (arguments were still empty at the trip point, after
    // content_block_start), so a later turn replays a non-empty message.
    responder = () => anthropicSse(['B'], { input: 1, output: 1 });
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    const messages = lastBody().messages as Array<{ role: string; content: string }>;
    expect(messages).toEqual([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: '```spycore:tool\n{"tool":"read_file","args":{}}\n```',
      },
      { role: 'user', content: 'second' },
    ]);
  });

  test('Anthropic control: a text turn with shouldStop tripped ends after the first chunk, without done', async () => {
    const { AnthropicProvider } = await import('../src/lib/providers/anthropic.js');
    const p = new AnthropicProvider({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-SECRET' });
    const id = await p.createConversation({ model: 'm' });
    responder = () => anthropicSse(['Hello', ', ', 'world'], { input: 1, output: 1 });
    const events = await collect(
      p.streamChat({ conversationId: id, message: 'hi', model: 'm', shouldStop: () => true }),
    );
    expect(events).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  test('Google: a functionCall-only turn with shouldStop tripped ends early, without done or tool_calls', async () => {
    const { GoogleProvider } = await import('../src/lib/providers/google.js');
    const p = new GoogleProvider({ baseURL: 'https://generativelanguage.googleapis.com', apiKey: 'k' });
    const id = await p.createConversation({ model: 'g-model' });
    responder = () => googleFunctionCallOnly();
    // Pre-fix this ran to completion: ['tool_calls','done'].
    const events = await collect(
      p.streamChat({ conversationId: id, message: 'hi', model: 'g-model', shouldStop: () => true }),
    );
    expect(events).toEqual([]);
  });

  test('Google control: a text turn with shouldStop tripped ends after the first chunk, without done', async () => {
    const { GoogleProvider } = await import('../src/lib/providers/google.js');
    const p = new GoogleProvider({ baseURL: 'https://generativelanguage.googleapis.com', apiKey: 'k' });
    const id = await p.createConversation({ model: 'g-model' });
    responder = () => googleSse(['Hello', ' world'], { input: 1, output: 1 });
    const events = await collect(
      p.streamChat({ conversationId: id, message: 'hi', model: 'g-model', shouldStop: () => true }),
    );
    expect(events).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  test('OpenAI: a tool_calls-only turn with shouldStop tripped ends early, without done or tool_calls', async () => {
    const { OpenAICompatibleProvider } = await import('../src/lib/providers/openai-compatible.js');
    const p = new OpenAICompatibleProvider({ baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test' });
    const id = await p.createConversation({ model: 'gpt-4o' });
    responder = () => openaiToolOnly();
    // Pre-fix this ran to completion: ['tool_calls','done'].
    const events = await collect(
      p.streamChat({ conversationId: id, message: 'hi', model: 'gpt-4o', shouldStop: () => true }),
    );
    expect(events).toEqual([]);
  });

  test('OpenAI control: a text turn with shouldStop tripped ends after the first chunk, without done', async () => {
    const { OpenAICompatibleProvider } = await import('../src/lib/providers/openai-compatible.js');
    const p = new OpenAICompatibleProvider({ baseURL: 'https://api.openai.com/v1', apiKey: 'sk-test' });
    const id = await p.createConversation({ model: 'gpt-4o' });
    responder = () => openaiText();
    const events = await collect(
      p.streamChat({ conversationId: id, message: 'hi', model: 'gpt-4o', shouldStop: () => true }),
    );
    expect(events).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

// ───────────────────────── R2-13 ─────────────────────────

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
  (process.stdout.write as unknown) = (c: string | Uint8Array) => (
    out.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true
  );
  (process.stderr.write as unknown) = (c: string | Uint8Array) => (
    err.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true
  );
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

describe('R2-13 provider add health check clears its timer when streamChat throws', () => {
  test('a throwing health check leaves no 30 s timer behind', async () => {
    // The Google adapter throws `Invalid model id` from streamChat before
    // any network, so no responder is needed; the throw used to skip the
    // clearTimeout after the race and leave 1 x 30,000 ms timer behind.
    const origSetTimeout = globalThis.setTimeout;
    const origClearTimeout = globalThis.clearTimeout;
    const created = new Set<ReturnType<typeof setTimeout>>();
    let cleared = 0;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const h = origSetTimeout(...args);
      if (args[1] === 30_000) created.add(h);
      return h;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((...args: Parameters<typeof clearTimeout>) => {
      const id = args[0] as ReturnType<typeof setTimeout> | undefined;
      if (id !== undefined && created.has(id)) cleared += 1;
      return origClearTimeout(...args);
    }) as typeof clearTimeout;
    let r: { stdout: string; stderr: string; error: unknown };
    try {
      r = await runProvider(['add', 'g1', '--type', 'google', '--model', 'a/../b', '--api-key', 'k']);
    } finally {
      globalThis.setTimeout = origSetTimeout;
      globalThis.clearTimeout = origClearTimeout;
    }
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('Health check failed: Invalid model id: a/../b');
    expect(getStoredProviders()).toHaveLength(1);
    expect(created.size).toBe(1);
    expect(cleared).toBe(1);
  });
});

// ───────────────────────── R2-14 ─────────────────────────

describe('R2-14 SPYCORE_TOKEN is trimmed', () => {
  test('a trailing newline is trimmed', async () => {
    vi.stubEnv('SPYCORE_TOKEN', 'tok-abc\n');
    const { getToken } = await import('../src/lib/auth.js');
    // Pre-fix getToken returned 'tok-abc\n' verbatim and undici threw
    // `InvalidArgumentError: invalid authorization header` on every call.
    expect(await getToken()).toBe('tok-abc');
  });

  test('surrounding spaces are trimmed', async () => {
    vi.stubEnv('SPYCORE_TOKEN', '  tok-abc  ');
    const { getToken } = await import('../src/lib/auth.js');
    expect(await getToken()).toBe('tok-abc');
  });

  test('a whitespace-only value counts as unset', async () => {
    vi.stubEnv('SPYCORE_TOKEN', '   \n  ');
    const { getToken, isAuthenticated } = await import('../src/lib/auth.js');
    expect(await getToken()).toBeNull();
    expect(await isAuthenticated()).toBe(false);
  });
});

// ───────────────────────── R2-15 ─────────────────────────

describe('R2-15 a provider named __proto__ keeps its usage record', () => {
  test('record + read round-trips for __proto__ alongside a normal name', async () => {
    const { recordByokUsage, getByokUsage } = await import('../src/lib/byok-usage.js');
    recordByokUsage('__proto__', 10, 5);
    recordByokUsage('__proto__', 10, 5);
    recordByokUsage('normal', 10, 5);
    const usage = getByokUsage();
    // Pre-fix getByokUsage showed only ['normal']: the '__proto__' entry
    // never persisted (prototype setter) and its counts read back as NaN.
    expect(Object.keys(usage).sort()).toEqual(['__proto__', 'normal']);
    expect(usage['__proto__']).toMatchObject({ calls: 2, inputTokens: 20, outputTokens: 10 });
    expect(usage['normal']).toMatchObject({ calls: 1, inputTokens: 10, outputTokens: 5 });
  });

  test('the __proto__ entry persists in the usage file on disk', async () => {
    const { recordByokUsage } = await import('../src/lib/byok-usage.js');
    const { getConfigPath } = await import('../src/lib/config.js');
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    recordByokUsage('__proto__', 7, 3);
    // Pre-fix the entry never reached the file: JSON.stringify of the
    // plain-{} map omitted it, so the record was lost across processes.
    const stored = JSON.parse(readFileSync(join(dirname(getConfigPath()), 'byok-usage.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(stored)).toEqual(['__proto__']);
    expect(stored['__proto__']).toMatchObject({ calls: 1, inputTokens: 7, outputTokens: 3 });
  });
});
