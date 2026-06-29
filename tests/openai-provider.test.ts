import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { freshConfigDir } from './helpers.js';
import type { Provider, ProviderEvent, StreamChatParams } from '../src/lib/providers/types.js';

/**
 * The OpenAI-compatible BYOK provider speaks to a mocked undici wire — the same
 * style harness the rest of the agent tests use. We capture every request so we
 * can assert headers/body and (for the command-level test) that SpyCore's triage
 * endpoints are never touched.
 */
interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: unknown;
}

interface CapturedRequest {
  url: string;
  method?: string | undefined;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}

let requests: CapturedRequest[] = [];
let responder: ((url: string, init: { method?: string }) => MockResp) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(
    async (
      url: string,
      init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ) => {
      requests.push({ url, method: init.method, headers: init.headers, body: init.body });
      if (!responder) throw new Error('test forgot to set responder');
      return responder(url, { method: init.method ?? 'GET' });
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

/** Build an OpenAI-style streamed SSE response: deltas, optional usage, [DONE]. */
function openaiSse(
  deltas: string[],
  usage?: { prompt_tokens: number; completion_tokens: number },
): MockResp {
  const lines: string[] = [];
  for (const d of deltas) {
    lines.push(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`);
  }
  if (usage) lines.push(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
  lines.push('data: [DONE]\n\n');
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Readable.from([Buffer.from(lines.join(''), 'utf8')]),
  };
}

/** An error response whose body exposes `.text()` (what readErrorDetail prefers). */
function errResp(status: number, bodyObj: unknown): MockResp {
  return {
    statusCode: status,
    headers: {},
    body: { text: async () => JSON.stringify(bodyObj) },
  };
}

const lastBody = (): Record<string, unknown> =>
  JSON.parse(requests[requests.length - 1]?.body ?? '{}') as Record<string, unknown>;
const lastHeaders = (): Record<string, string> => requests[requests.length - 1]?.headers ?? {};

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

async function newProvider(opts: { baseURL: string; apiKey?: string | undefined }) {
  const { OpenAICompatibleProvider } = await import('../src/lib/providers/openai-compatible.js');
  return new OpenAICompatibleProvider(opts);
}

const REMOTE = 'https://api.openai.com/v1';

describe('OpenAICompatibleProvider — SSE wire', () => {
  test('yields ordered text events + a usage event + done', async () => {
    responder = () => openaiSse(['Hello', ', ', 'world'], { prompt_tokens: 12, completion_tokens: 5 });
    const p = await newProvider({ baseURL: REMOTE, apiKey: 'sk-test' });
    const id = await p.createConversation({ model: 'gpt-4o' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'gpt-4o' }));
    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ', ' },
      { type: 'text', text: 'world' },
      { type: 'usage', input: 12, output: 5 },
      { type: 'done' },
    ]);
  });

  test('POSTs to {baseURL}/chat/completions with stream + include_usage', async () => {
    responder = () => openaiSse(['x']);
    const p = await newProvider({ baseURL: 'https://api.openai.com/v1/', apiKey: 'sk' }); // trailing slash
    const id = await p.createConversation({ model: 'gpt-4o' });
    await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'gpt-4o' }));
    expect(requests[requests.length - 1]?.url).toBe('https://api.openai.com/v1/chat/completions');
    const body = lastBody();
    expect(body.model).toBe('gpt-4o');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  test('sends a Bearer header when a key is set', async () => {
    responder = () => openaiSse(['ok']);
    const p = await newProvider({ baseURL: REMOTE, apiKey: 'secret-key' });
    const id = await p.createConversation({ model: 'm' });
    await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'm' }));
    expect(lastHeaders().authorization).toBe('Bearer secret-key');
  });

  test('omits the auth header entirely when no key (local servers)', async () => {
    responder = () => openaiSse(['ok']);
    const p = await newProvider({ baseURL: 'http://localhost:11434/v1' });
    const id = await p.createConversation({ model: 'my-local-coder' });
    await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'my-local-coder' }));
    expect('authorization' in lastHeaders()).toBe(false);
  });

  test('accumulates history and replays it on the next turn (verify-continuation safe)', async () => {
    responder = () => openaiSse(['A']);
    const p = await newProvider({ baseURL: REMOTE, apiKey: 'sk' });
    const id = await p.createConversation({ model: 'm' });
    await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }));
    expect(lastBody().messages).toEqual([{ role: 'user', content: 'first' }]);

    responder = () => openaiSse(['B']);
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    expect(lastBody().messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'A' },
      { role: 'user', content: 'second' },
    ]);
  });

  test('folds a separately-passed system prompt into the first user message (wire unchanged)', async () => {
    responder = () => openaiSse(['ok']);
    const p = await newProvider({ baseURL: REMOTE, apiKey: 'sk' });
    const id = await p.createConversation({ model: 'm' });
    await collect(p.streamChat({ conversationId: id, message: 'TASK: x', system: 'SYS PROMPT', model: 'm' }));
    // Exactly the concatenation the loop used to send as one string.
    expect(lastBody().messages).toEqual([{ role: 'user', content: 'SYS PROMPT\n\nTASK: x' }]);
  });

  test('degrades gracefully when the endpoint omits usage', async () => {
    responder = () => openaiSse(['hi']); // no usage chunk
    const p = await newProvider({ baseURL: REMOTE, apiKey: 'sk' });
    const id = await p.createConversation({ model: 'm' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'm' }));
    expect(events).toEqual([{ type: 'text', text: 'hi' }, { type: 'done' }]);
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });

  test('stops consuming when shouldStop trips (time-budget cut)', async () => {
    responder = () => openaiSse(['one', 'two', 'three']);
    const p = await newProvider({ baseURL: REMOTE, apiKey: 'sk' });
    const id = await p.createConversation({ model: 'm' });
    let seen = 0;
    const events = await collect(
      p.streamChat({
        conversationId: id,
        message: 'hi',
        model: 'm',
        shouldStop: () => {
          seen += 1;
          return seen >= 1; // stop after the first text chunk
        },
      }),
    );
    expect(events).toEqual([{ type: 'text', text: 'one' }]);
  });
});

describe('OpenAICompatibleProvider — error handling', () => {
  const run = async (resp: MockResp) => {
    responder = () => resp;
    const p = await newProvider({ baseURL: REMOTE, apiKey: 'super-secret-key' });
    const id = await p.createConversation({ model: 'gpt-4o' });
    return collect(p.streamChat({ conversationId: id, message: 'hi', model: 'gpt-4o' }));
  };

  test('401 → bad/missing key message (and never leaks the key)', async () => {
    const events = await run(errResp(401, { error: { message: 'Incorrect API key provided' } }));
    expect(events).toHaveLength(1);
    const e = events[0] as { type: string; message: string };
    expect(e.type).toBe('error');
    expect(e.message).toMatch(/401/);
    expect(e.message).toMatch(/key/i);
    expect(e.message).not.toContain('super-secret-key');
  });

  test('404 → wrong base-url / model message', async () => {
    const events = await run(errResp(404, { error: { message: 'model not found' } }));
    const e = events[0] as { type: string; message: string };
    expect(e.type).toBe('error');
    expect(e.message).toMatch(/404/);
    expect(e.message).toMatch(/--base-url|--model/);
  });

  test('429 → provider rate-limit message', async () => {
    const events = await run(errResp(429, { error: { message: 'slow down' } }));
    const e = events[0] as { type: string; message: string };
    expect(e.type).toBe('error');
    expect(e.message).toMatch(/429|rate.?limit/i);
  });

  test('connection refused → local server not running', async () => {
    responder = () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:11434') as Error & { code?: string };
      err.code = 'ECONNREFUSED';
      throw err;
    };
    const p = await newProvider({ baseURL: 'http://localhost:11434/v1' });
    const id = await p.createConversation({ model: 'm' });
    const events = await collect(p.streamChat({ conversationId: id, message: 'hi', model: 'm' }));
    const e = events[0] as { type: string; message: string };
    expect(e.type).toBe('error');
    expect(e.message).toMatch(/connection refused|running/i);
  });
});

describe('BYOK config helpers', () => {
  test('parseProviderKind: defaults to spycore, accepts the built-in kinds, rejects unknown', async () => {
    const { parseProviderKind } = await import('../src/lib/providers/byok-config.js');
    expect(parseProviderKind(undefined)).toBe('spycore');
    expect(parseProviderKind('spycore')).toBe('spycore');
    expect(parseProviderKind('openai')).toBe('openai');
    expect(parseProviderKind('OpenAI')).toBe('openai');
    expect(parseProviderKind('anthropic')).toBe('anthropic');
    expect(parseProviderKind('google')).toBe('google');
    expect(() => parseProviderKind('mystery-cloud')).toThrow(/Unknown provider/);
  });

  test('resolveByokConfig requires --model', async () => {
    const { resolveByokConfig } = await import('../src/lib/providers/byok-config.js');
    expect(() => resolveByokConfig({ model: undefined, baseUrl: undefined, apiKeyEnv: undefined, env: {} })).toThrow(
      /--model.*required/,
    );
    expect(() => resolveByokConfig({ model: '  ', baseUrl: undefined, apiKeyEnv: undefined, env: {} })).toThrow(
      /--model.*required/,
    );
  });

  test('resolveByokConfig defaults base URL + key env, reads the key from env', async () => {
    const { resolveByokConfig, OPENAI_DEFAULT_BASE_URL } = await import('../src/lib/providers/byok-config.js');
    const cfg = resolveByokConfig({
      model: 'gpt-4o',
      baseUrl: undefined,
      apiKeyEnv: undefined,
      env: { OPENAI_API_KEY: 'sk-from-env' },
    });
    expect(cfg.model).toBe('gpt-4o');
    expect(cfg.baseURL).toBe(OPENAI_DEFAULT_BASE_URL);
    expect(cfg.apiKey).toBe('sk-from-env');
    expect(cfg.routingLine).toBe('Model: gpt-4o (openai)');
  });

  test('resolveByokConfig trims a trailing slash and reads a custom key env', async () => {
    const { resolveByokConfig } = await import('../src/lib/providers/byok-config.js');
    const cfg = resolveByokConfig({
      model: 'local-coder',
      baseUrl: 'http://localhost:11434/v1/',
      apiKeyEnv: 'MY_KEY',
      env: { MY_KEY: 'abc' },
    });
    expect(cfg.baseURL).toBe('http://localhost:11434/v1');
    expect(cfg.apiKey).toBe('abc');
    expect(cfg.routingLine).toBe('Model: local-coder (openai · local)');
  });

  test('resolveByokConfig yields no key when the env var is unset or empty', async () => {
    const { resolveByokConfig } = await import('../src/lib/providers/byok-config.js');
    expect(
      resolveByokConfig({ model: 'm', baseUrl: undefined, apiKeyEnv: 'NOPE', env: {} }).apiKey,
    ).toBeUndefined();
    expect(
      resolveByokConfig({ model: 'm', baseUrl: undefined, apiKeyEnv: 'EMPTY', env: { EMPTY: '   ' } }).apiKey,
    ).toBeUndefined();
  });

  test('isLocalBaseURL distinguishes local from remote endpoints', async () => {
    const { isLocalBaseURL } = await import('../src/lib/providers/byok-config.js');
    expect(isLocalBaseURL('http://localhost:11434/v1')).toBe(true);
    expect(isLocalBaseURL('http://127.0.0.1:1234/v1')).toBe(true);
    expect(isLocalBaseURL('http://my-box.local/v1')).toBe(true);
    expect(isLocalBaseURL('https://api.openai.com/v1')).toBe(false);
  });
});

/** A scripted in-memory provider — drives the loop without any network. */
class FakeProvider implements Provider {
  readonly id = 'openai' as const;
  readonly calls: StreamChatParams[] = [];
  private i = 0;
  constructor(private readonly turns: ProviderEvent[][]) {}
  createConversation(): Promise<string> {
    return Promise.resolve('fake-conv');
  }
  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    this.calls.push(params);
    const turn = this.turns[this.i] ?? [{ type: 'done' as const }];
    this.i += 1;
    for (const e of turn) yield e;
  }
}

describe('runAgent through a custom (non-spycore) provider', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-byok-'));
  });
  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('delegates to the provider, sending the system prompt + task and the wire model', async () => {
    const fake = new FakeProvider([[{ type: 'text', text: 'All done.' }, { type: 'done' }]]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const res = await runAgent({ task: 'investigate things', cwd: workDir, model: 'gpt-4o', provider: fake });
    expect(res.finalText).toBe('All done.');
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.conversationId).toBe('fake-conv');
    expect(fake.calls[0]?.model).toBe('gpt-4o');
    // The seam carries the task and the system prompt separately: turn 1's
    // message is the task; the tool protocol travels in `system`.
    expect(fake.calls[0]?.message).toContain('TASK: investigate things');
    expect(fake.calls[0]?.system).toContain('spycore:tool');
    expect(fake.calls[0]?.message).not.toContain('spycore:tool');
  });

  test('token budget records usage from the provider; degrades to 0 without it', async () => {
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const { createBudget } = await import('../src/lib/agent/budget.js');

    const withUsage = new FakeProvider([
      [{ type: 'text', text: 'done' }, { type: 'usage', input: 123, output: 45 }, { type: 'done' }],
    ]);
    const b1 = createBudget({ maxTokens: 100_000 });
    await runAgent({ task: 'x', cwd: workDir, model: 'gpt-4o', provider: withUsage, budget: b1 });
    expect(b1.snapshot().tokensUsed).toBe(168);

    const noUsage = new FakeProvider([[{ type: 'text', text: 'done' }, { type: 'done' }]]);
    const b2 = createBudget({ maxTokens: 100_000 });
    await runAgent({ task: 'y', cwd: workDir, model: 'gpt-4o', provider: noUsage, budget: b2 });
    expect(b2.snapshot().tokensUsed).toBe(0); // no usage → no token accounting, run still completes
  });

  test('an error event from the provider surfaces as a thrown run error', async () => {
    const fake = new FakeProvider([[{ type: 'error', message: 'Model endpoint returned HTTP 401' }]]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await expect(runAgent({ task: 'z', cwd: workDir, model: 'gpt-4o', provider: fake })).rejects.toThrow(/401/);
  });
});

describe('agent command — BYOK wiring (skips triage)', () => {
  test('--provider openai runs against the endpoint and never calls SpyCore triage', async () => {
    responder = (url) => {
      if (url.includes('/chat/completions')) {
        return openaiSse(['Hi there.'], { prompt_tokens: 3, completion_tokens: 2 });
      }
      throw new Error(`SpyCore endpoint must not be called for BYOK: ${url}`);
    };
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');

    const { configureOutput } = await import('../src/lib/output.js');
    const { registerAgentCommand } = await import('../src/commands/agent.js');

    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    const origExit = process.exitCode;
    (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    };

    const program = new Command();
    program.exitOverride();
    program
      .addOption(new Option('--api-url <url>'))
      .addOption(new Option('--json'))
      .addOption(new Option('--no-color'));
    configureOutput({ json: true, color: false });
    registerAgentCommand(program);

    try {
      await program.parseAsync(
        ['--json', 'agent', '--provider', 'openai', '--model', 'gpt-4o', '--yes', 'say', 'hi'],
        { from: 'user' },
      );
    } finally {
      process.stdout.write = origWrite;
      process.exitCode = origExit;
      configureOutput({ json: false, color: true });
    }

    const urls = requests.map((r) => r.url);
    // Triage was skipped: no SpyCore conversation create, no classify stream.
    expect(urls.some((u) => u.includes('/api/chat/stream'))).toBe(false);
    expect(urls.some((u) => u.includes('/conversations'))).toBe(false);
    // The BYOK endpoint WAS hit.
    expect(urls.some((u) => u.includes('/chat/completions'))).toBe(true);

    const summary = writes
      .join('')
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
    expect(summary).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o',
      routedVia: 'byok',
      executed: true,
    });
    expect(String(summary?.finalText ?? '')).toContain('Hi there.');
  });
});
