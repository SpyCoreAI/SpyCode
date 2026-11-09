import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import { SpycoreCliError } from '../src/lib/errors.js';
import {
  isLocalBaseURL,
  resolveByokConfig,
  resolveProviderSelection,
  type StoredProviderConfig,
} from '../src/lib/providers/byok-config.js';
import { GoogleProvider } from '../src/lib/providers/google.js';
import { OpenAICompatibleProvider } from '../src/lib/providers/openai-compatible.js';
import { AnthropicProvider } from '../src/lib/providers/anthropic.js';
import type { ProviderEvent } from '../src/lib/providers/types.js';

/**
 * Phase 4b1 (Low, providers + agent/acp commands) regression tests.
 * Each test FAILS on the pre-fix code and PASSES on the fix.
 */

// ───────────────────── mocked undici ─────────────────────

const undiciState = vi.hoisted(() => ({
  requests: [] as Array<{ url: string; init: Record<string, unknown> }>,
  responder: null as null | ((url: string, init: Record<string, unknown>) => unknown),
}));

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: Record<string, unknown> = {}) => {
    undiciState.requests.push({ url, init });
    if (!undiciState.responder) throw new Error('test forgot to set undici responder');
    return undiciState.responder(url, init);
  }),
}));

// ───────────────────── mocked api (SpyCore provider only) ─────────────────────

const apiState = vi.hoisted(() => ({
  post: null as null | ((...args: unknown[]) => Promise<unknown>),
  stream: null as null | ((...args: unknown[]) => AsyncIterable<unknown>),
}));

vi.mock('../src/lib/api.js', () => ({
  api: {
    post: (...args: unknown[]) => apiState.post!(...args),
  },
  streamRequest: (...args: unknown[]) => apiState.stream!(...args),
}));

beforeEach(() => {
  freshConfigDir();
  undiciState.requests = [];
  undiciState.responder = null;
  apiState.post = null;
  apiState.stream = null;
  delete process.env.SPYCORE_GOOGLE_CLIENT_ID;
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  delete process.env.SPYCORE_GOOGLE_CLIENT_ID;
});

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

function sseResponder(chunks: string[]): (url: string) => unknown {
  return () => ({
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Readable.from([Buffer.from(chunks.join(''), 'utf8')]),
  });
}

const storedOpenai = (over: Partial<StoredProviderConfig> = {}): StoredProviderConfig => ({
  name: 'Foo',
  type: 'openai',
  baseURL: 'http://127.0.0.1:9/v1',
  model: 'm',
  ...over,
});

describe('4b1 item 3 - stored provider names match case-insensitively', () => {
  test('`--provider foo` resolves a provider saved as `Foo`', () => {
    const sel = resolveProviderSelection({
      providerFlag: 'foo',
      model: undefined,
      baseUrl: undefined,
      apiKeyEnv: undefined,
      env: {},
      stored: [storedOpenai()],
      defaultProvider: undefined,
    });
    expect(sel.kind).toBe('byok');
    if (sel.kind === 'byok') expect(sel.sourceName).toBe('Foo');
  });

  test('`--provider FOO` and a default of `Foo` resolve the same way', () => {
    for (const opts of [
      { providerFlag: 'FOO', defaultProvider: undefined },
      { providerFlag: undefined, defaultProvider: 'Foo' },
    ]) {
      const sel = resolveProviderSelection({
        ...opts,
        model: undefined,
        baseUrl: undefined,
        apiKeyEnv: undefined,
        env: {},
        stored: [storedOpenai()],
      });
      expect(sel.kind).toBe('byok');
    }
  });
});

describe('4b1 item 4 - OAuth config without a client id errors clearly', () => {
  const storedGoogle: StoredProviderConfig = {
    name: 'g',
    type: 'google',
    baseURL: 'https://generativelanguage.googleapis.com',
    model: 'gemini-2.0-flash',
    oauthRefreshToken: 'rt-1',
  };

  test('a stored OAuth entry without oauthClientId (and no env var) names OAuth, not the API key', () => {
    expect(() =>
      resolveProviderSelection({
        providerFlag: 'g',
        model: undefined,
        baseUrl: undefined,
        apiKeyEnv: undefined,
        env: {},
        stored: [storedGoogle],
        defaultProvider: undefined,
      }),
    ).toThrow(/no OAuth client ID stored/);
  });

  test('the env var satisfies the same entry', () => {
    const sel = resolveProviderSelection({
      providerFlag: 'g',
      model: undefined,
      baseUrl: undefined,
      apiKeyEnv: undefined,
      env: { SPYCORE_GOOGLE_CLIENT_ID: 'cid.apps.googleusercontent.com' },
      stored: [storedGoogle],
      defaultProvider: undefined,
    });
    expect(sel.kind).toBe('byok');
  });

  test('the factory wraps the missing-id error as a SpycoreCliError, not a plain Error', async () => {
    const { createByokProvider } = await import('../src/lib/providers/factory.js');
    const { EXIT_USER_ERROR } = await import('../src/lib/errors.js');
    let caught: unknown;
    try {
      await createByokProvider({
        type: 'google',
        model: 'gemini-2.0-flash',
        baseURL: 'https://generativelanguage.googleapis.com',
        apiKey: undefined,
        routingLine: 'Model: gemini-2.0-flash (google)',
        oauthRefreshToken: 'rt-1',
      });
    } catch (err) {
      caught = err;
    }
    // No instanceof check: the dynamically-imported factory carries its own
    // errors.js identity after resetModules, so instanceof is meaningless
    // here - the name + user-error code + message are the contract.
    expect((caught as Error).name).toBe('SpycoreCliError');
    expect((caught as { code?: unknown }).code).toBe(EXIT_USER_ERROR);
    expect(String((caught as Error).message)).toMatch(/Google OAuth client ID not configured/);
  });
});

describe('4b1 item 5 - API keys are trimmed', () => {
  test('an env var with surrounding whitespace/newline is trimmed', () => {
    const cfg = resolveByokConfig({
      type: 'anthropic',
      model: 'claude-x',
      baseUrl: undefined,
      apiKeyEnv: undefined,
      env: { ANTHROPIC_API_KEY: '  sk-ant-x \n' },
    });
    expect(cfg.apiKey).toBe('sk-ant-x');
  });

  test('a stored env-var key is trimmed too', () => {
    const sel = resolveProviderSelection({
      providerFlag: 'Foo',
      model: undefined,
      baseUrl: undefined,
      apiKeyEnv: undefined,
      env: { MY_KEY: '\t k2 ' },
      stored: [storedOpenai({ type: 'anthropic', apiKeyEnv: 'MY_KEY' })],
      defaultProvider: undefined,
    });
    expect(sel.kind).toBe('byok');
    if (sel.kind === 'byok') expect(sel.config.apiKey).toBe('k2');
  });
});

describe('4b1 item 6 - the rest of loopback is local', () => {
  test('127.0.0.2 and the rest of 127/8 count as local', () => {
    expect(isLocalBaseURL('http://127.0.0.2:8080/v1')).toBe(true);
    expect(isLocalBaseURL('http://127.1.2.3:8080/v1')).toBe(true);
    expect(isLocalBaseURL('http://127.255.255.255:8080/v1')).toBe(true);
  });
});

describe('4b1 item 7 - GoogleProvider constructor throws a SpycoreCliError', () => {
  test('no key and no OAuth token is a user error with a hint', () => {
    let caught: unknown;
    try {
      new GoogleProvider({ baseURL: 'https://generativelanguage.googleapis.com' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SpycoreCliError);
  });
});

describe('4b1 items 8 + 12 - Google model path segments and request timeouts', () => {
  test('`models/gemini-2.0-flash` does not become `models%2F…`', async () => {
    undiciState.responder = sseResponder([]);
    const provider = new GoogleProvider({
      baseURL: 'https://generativelanguage.googleapis.com',
      apiKey: 'g-key',
    });
    const convo = await provider.createConversation({ model: 'gemini-2.0-flash' });
    const events = await collect(
      provider.streamChat({ conversationId: convo, model: 'models/gemini-2.0-flash', message: 'hi' }),
    );
    expect(events[events.length - 1]).toEqual({ type: 'done' });
    expect(undiciState.requests).toHaveLength(1);
    expect(undiciState.requests[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse',
    );
    expect(undiciState.requests[0]!.init.headersTimeout).toBe(30_000);
    expect(undiciState.requests[0]!.init.bodyTimeout).toBe(300_000);
  });

  test('a multi-segment model id encodes per segment', async () => {
    undiciState.responder = sseResponder([]);
    const provider = new GoogleProvider({
      baseURL: 'https://generativelanguage.googleapis.com',
      apiKey: 'g-key',
    });
    const convo = await provider.createConversation({ model: 'x' });
    await collect(provider.streamChat({ conversationId: convo, model: 'a/b c/d', message: 'hi' }));
    expect(undiciState.requests[0]!.url).toContain('/v1beta/models/a/b%20c/d:streamGenerateContent');
  });
});

describe('4b1 item 9 - BYOK adapters surface finish_reason and tool calls', () => {
  test('openai-compatible: streamed delta.tool_calls assemble into one tool_calls event', async () => {
    const chunk = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`;
    undiciState.responder = sseResponder([
      chunk({ choices: [{ delta: { content: 'hi' }, finish_reason: null }] }),
      chunk({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '"/x"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      'data: [DONE]\n\n',
    ]);
    const provider = new OpenAICompatibleProvider({ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k' });
    const convo = await provider.createConversation({ model: 'gpt-x' });
    const events = await collect(provider.streamChat({ conversationId: convo, model: 'gpt-x', message: 'hi' }));
    expect(events).toContainEqual({ type: 'text', text: 'hi' });
    expect(events).toContainEqual({
      type: 'tool_calls',
      calls: [{ id: 'call_1', name: 'read_file', arguments: '{"path":"/x"}' }],
    });
    expect(events[events.length - 1]).toEqual({ type: 'done' });
    expect(undiciState.requests[0]!.init.headersTimeout).toBe(30_000);
    expect(undiciState.requests[0]!.init.bodyTimeout).toBe(300_000);
  });

  test('openai-compatible: finish_reason length yields a truncation warning, not a silent empty turn', async () => {
    undiciState.responder = sseResponder([
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
      'data: [DONE]\n\n',
    ]);
    const provider = new OpenAICompatibleProvider({ baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k' });
    const convo = await provider.createConversation({ model: 'gpt-x' });
    const events = await collect(provider.streamChat({ conversationId: convo, model: 'gpt-x', message: 'hi' }));
    expect(events).toContainEqual({
      type: 'warning',
      message: 'Response truncated (max tokens hit) - the reply may be incomplete.',
    });
  });

  test('anthropic: stop_reason max_tokens yields a truncation warning', async () => {
    undiciState.responder = sseResponder([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":9},"stop_reason":"max_tokens"}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    const provider = new AnthropicProvider({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-x' });
    const convo = await provider.createConversation({ model: 'claude-x' });
    const events = await collect(provider.streamChat({ conversationId: convo, model: 'claude-x', message: 'hi' }));
    expect(events).toContainEqual({
      type: 'warning',
      message: 'Response truncated (max tokens hit) - the reply may be incomplete.',
    });
    expect(undiciState.requests[0]!.init.headersTimeout).toBe(30_000);
  });

  test('google: finishReason MAX_TOKENS yields a truncation warning', async () => {
    undiciState.responder = sseResponder([
      'data: {"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"MAX_TOKENS"}]}\n\n',
    ]);
    const provider = new GoogleProvider({
      baseURL: 'https://generativelanguage.googleapis.com',
      apiKey: 'g-key',
    });
    const convo = await provider.createConversation({ model: 'gemini-2.0-flash' });
    const events = await collect(
      provider.streamChat({ conversationId: convo, model: 'gemini-2.0-flash', message: 'hi' }),
    );
    expect(events).toContainEqual({
      type: 'warning',
      message: 'Response truncated (max tokens hit) - the reply may be incomplete.',
    });
  });
});

describe('4b1 item 10 - SpyCore createConversation validates the id', () => {
  test('a server response without an id fails instead of publishing undefined', async () => {
    const { SpyCoreProvider } = await import('../src/lib/providers/spycore.js');
    apiState.post = async () => ({});
    const provider = new SpyCoreProvider();
    await expect(provider.createConversation({ model: 'styx' })).rejects.toThrow(/without an id/);
    apiState.post = async () => ({ id: 'cnv_9' });
    await expect(provider.createConversation({ model: 'styx' })).resolves.toBe('cnv_9');
  });
});

describe('4b1 item 19 - SpyCore polls the time budget after tool calls too', () => {
  test('a turn streaming only tool calls stops when shouldStop trips', async () => {
    const { SpyCoreProvider } = await import('../src/lib/providers/spycore.js');
    const provider = new SpyCoreProvider();
    async function* toolCallThenDone(): AsyncIterable<unknown> {
      yield { data: { type: 'tool_calls', calls: [{ id: '1', name: 'read_file', arguments: '{}' }] } };
      yield { data: { type: 'done' } };
    }
    apiState.stream = toolCallThenDone;
    const stopped = await collect(
      provider.streamChat({
        conversationId: 'cnv_1',
        model: 'styx',
        message: 'hi',
        shouldStop: () => true,
      }),
    );
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.type).toBe('tool_calls');
    const finished = await collect(
      provider.streamChat({
        conversationId: 'cnv_1',
        model: 'styx',
        message: 'hi',
        shouldStop: () => false,
      }),
    );
    expect(finished.map((e) => e.type)).toEqual(['tool_calls', 'done']);
  });
});

describe('4b1 item 13 - Google OAuth refresh is bounded at the call site', () => {
  test('a hung token endpoint fails the refresh after 30s instead of hanging forever', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(() => new Promise(() => {})),
      );
      const { createByokProvider } = await import('../src/lib/providers/factory.js');
      const pending = createByokProvider({
        type: 'google',
        model: 'gemini-2.0-flash',
        baseURL: 'https://generativelanguage.googleapis.com',
        apiKey: undefined,
        routingLine: 'Model: gemini-2.0-flash (google)',
        oauthRefreshToken: 'rt-1',
        oauthClientId: 'stored-client-id.apps.googleusercontent.com',
      });
      const assertion = expect(pending).rejects.toThrow(/Google OAuth token refresh failed: .*timed out after 30s/);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  }, 15_000);
});
