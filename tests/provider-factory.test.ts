import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import type { ByokConfig } from '../src/lib/providers/byok-config.js';
import type { ProviderEvent } from '../src/lib/providers/types.js';

/**
 * H14 - direct tests for `createByokProvider` (the dispatch that maps a
 * provider type to its adapter class). Provider tests previously
 * instantiated the adapter classes directly, so a factory regression -
 * wrong class, dropped option, bad default - was invisible.
 *
 * The dispatched provider is proven on the wire: a mocked undici `request`
 * captures the URL and auth headers of the provider the factory built.
 * Google OAuth refresh goes through global `fetch` and is stubbed per test.
 */
interface CapturedRequest {
  url: string;
  headers?: Record<string, string>;
  body?: string;
}
let requests: CapturedRequest[] = [];

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { headers?: Record<string, string>; body?: string } = {}) => {
    requests.push({ url, headers: init.headers, body: init.body });
    return {
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: Readable.from([
        Buffer.from(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
          'utf8',
        ),
      ]),
    };
  }),
}));

const origGoogleClientId = process.env.SPYCORE_GOOGLE_CLIENT_ID;
const origFetch = globalThis.fetch;

beforeEach(() => {
  freshConfigDir();
  requests = [];
  delete process.env.SPYCORE_GOOGLE_CLIENT_ID;
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  if (origGoogleClientId === undefined) delete process.env.SPYCORE_GOOGLE_CLIENT_ID;
  else process.env.SPYCORE_GOOGLE_CLIENT_ID = origGoogleClientId;
  globalThis.fetch = origFetch;
});

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

function baseConfig(overrides: Partial<ByokConfig>): ByokConfig {
  return {
    type: 'openai',
    model: 'gpt-x',
    baseURL: 'https://api.example/v1',
    apiKey: 'k-123',
    routingLine: 'Model: gpt-x (openai)',
    ...overrides,
  };
}

describe('createByokProvider dispatch', () => {
  test('openai maps to the OpenAI-compatible adapter with the configured endpoint and key', async () => {
    const { createByokProvider } = await import('../src/lib/providers/factory.js');
    const provider = await createByokProvider(
      baseConfig({ type: 'openai', baseURL: 'http://localhost:9/v1', apiKey: 'k-123' }),
    );
    expect(provider.id).toBe('openai');
    const convo = await provider.createConversation({ model: 'gpt-x' });
    const events = await collect(provider.streamChat({ conversationId: convo, model: 'gpt-x', message: 'hi' }));
    expect(events.some((e) => e.type === 'text' && e.text === 'hi')).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://localhost:9/v1/chat/completions');
    expect(requests[0]!.headers?.authorization).toBe('Bearer k-123');
    expect(JSON.parse(requests[0]!.body ?? '{}').model).toBe('gpt-x');
  });

  test('openai without a key sends no Authorization header (local servers)', async () => {
    const { createByokProvider } = await import('../src/lib/providers/factory.js');
    const provider = await createByokProvider(
      baseConfig({ type: 'openai', baseURL: 'http://localhost:9/v1', apiKey: undefined }),
    );
    expect(provider.id).toBe('openai');
    const convo = await provider.createConversation({ model: 'gpt-x' });
    await collect(provider.streamChat({ conversationId: convo, model: 'gpt-x', message: 'hi' }));
    expect(requests[0]!.headers?.authorization).toBeUndefined();
  });

  test('anthropic maps to the Anthropic adapter', async () => {
    const { createByokProvider } = await import('../src/lib/providers/factory.js');
    const provider = await createByokProvider(
      baseConfig({ type: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-x' }),
    );
    expect(provider.id).toBe('anthropic');
  });

  test('anthropic without a key fails closed with the missing-key error', async () => {
    const { createByokProvider } = await import('../src/lib/providers/factory.js');
    await expect(
      createByokProvider(baseConfig({ type: 'anthropic', apiKey: undefined })),
    ).rejects.toThrow(/An API key is required for the anthropic provider/);
  });

  test('google with an API key maps to the Google adapter', async () => {
    const { createByokProvider } = await import('../src/lib/providers/factory.js');
    const provider = await createByokProvider(
      baseConfig({ type: 'google', baseURL: 'https://generativelanguage.googleapis.com', apiKey: 'g-key' }),
    );
    expect(provider.id).toBe('google');
  });

  test('google without a key fails closed with the missing-key error', async () => {
    const { createByokProvider } = await import('../src/lib/providers/factory.js');
    await expect(
      createByokProvider(baseConfig({ type: 'google', apiKey: undefined })),
    ).rejects.toThrow(/An API key is required for the google provider/);
  });

  test('google OAuth refresh uses the STORED client id first, no env var needed', async () => {
    const { createByokProvider } = await import('../src/lib/providers/factory.js');
    const seenBodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string } = {}) => {
        seenBodies.push(init.body ?? '');
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'ya29-fresh', expires_in: 3600, token_type: 'Bearer' }),
        };
      }),
    );
    const provider = await createByokProvider(
      baseConfig({
        type: 'google',
        apiKey: undefined,
        oauthRefreshToken: 'refresh-token',
        oauthClientId: 'stored-client-id.apps.googleusercontent.com',
      }),
    );
    expect(provider.id).toBe('google');
    expect(seenBodies).toHaveLength(1);
    expect(seenBodies[0]).toContain('client_id=stored-client-id.apps.googleusercontent.com');
    expect(seenBodies[0]).toContain('refresh_token=refresh-token');
  });

  test('google OAuth without a stored id and without the env var throws the setup hint', async () => {
    const { createByokProvider } = await import('../src/lib/providers/factory.js');
    await expect(
      createByokProvider(baseConfig({ type: 'google', apiKey: undefined, oauthRefreshToken: 'rt' })),
    ).rejects.toThrow(/Google OAuth client ID not configured/);
  });

  test('google OAuth refresh failure is wrapped as a user error with the re-auth hint', async () => {
    const { createByokProvider } = await import('../src/lib/providers/factory.js');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => 'invalid_grant',
      })),
    );
    await expect(
      createByokProvider(
        baseConfig({
          type: 'google',
          apiKey: undefined,
          oauthRefreshToken: 'stale-refresh-token',
          oauthClientId: 'stored-client-id.apps.googleusercontent.com',
        }),
      ),
    ).rejects.toThrow(/Google OAuth token refresh failed/);
  });

  test('an unknown type throws instead of returning no provider', async () => {
    const { createByokProvider } = await import('../src/lib/providers/factory.js');
    await expect(
      createByokProvider(baseConfig({ type: 'bogus' as unknown as ByokConfig['type'] })),
    ).rejects.toThrow(/Unknown BYOK provider type: bogus/);
  });
});
