import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createByokProvider } from '../src/lib/providers/factory.js';
import type { ByokConfig } from '../src/lib/providers/byok-config.js';
import { getStoredProviders, setStoredProviders, __resetConfigForTests } from '../src/lib/config.js';
import { freshConfigDir } from './helpers.js';

/** undici request impl, set per test (same pattern as the responder mocks). */
type RequestImpl = (url: string, init?: unknown) => Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}>;
let requestImpl: RequestImpl | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init?: unknown) => {
    if (!requestImpl) throw new Error('test forgot to set requestImpl');
    return requestImpl(url, init);
  }),
}));

/**
 * H7 - a stored Google OAuth provider was unusable without
 * SPYCORE_GOOGLE_CLIENT_ID: the factory called `googleOAuthConfig(0)`
 * BEFORE overriding the client id with the stored value, and the config
 * builder throws when the env var is unset. A provider saved with
 * `spycore provider add --type google --oauth` (which stores oauthClientId
 * precisely so the env var is not needed again) died on every later run.
 */
describe('stored Google OAuth provider works without the env var', () => {
  const ENV_KEY = 'SPYCORE_GOOGLE_CLIENT_ID';
  const origFetch = globalThis.fetch;

  const config: ByokConfig = {
    type: 'google',
    model: 'gemini-2.0-flash',
    baseURL: 'https://generativelanguage.googleapis.com',
    apiKey: undefined,
    routingLine: 'Model: gemini-2.0-flash (google)',
    oauthRefreshToken: 'stored-refresh-token',
    oauthClientId: 'stored-client-id.apps.googleusercontent.com',
  };

  beforeEach(() => {
    freshConfigDir();
    requestImpl = null;
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
    globalThis.fetch = origFetch;
    requestImpl = null;
    __resetConfigForTests();
    vi.restoreAllMocks();
  });

  test('refreshes with the stored client id and no env var set', async () => {
    const seen: Array<Record<string, string>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      seen.push(Object.fromEntries(body.entries()));
      return {
        ok: true,
        json: async () => ({
          access_token: 'fresh-access-token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      } as Response;
    }) as typeof fetch;

    const provider = await createByokProvider(config);
    expect(provider.id).toBe('google');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.client_id).toBe('stored-client-id.apps.googleusercontent.com');
    expect(seen[0]?.refresh_token).toBe('stored-refresh-token');
    expect(seen[0]?.grant_type).toBe('refresh_token');
  });

  test('without a stored client id and without the env var it still errors helpfully', async () => {
    await expect(
      createByokProvider({ ...config, oauthClientId: undefined }),
    ).rejects.toThrow('Google OAuth client ID not configured');
  });

  test('refreshAccessToken keeps a rotated refresh token (and the old one when none is returned)', async () => {
    const { refreshAccessToken, googleOAuthConfig } = await import('../src/lib/oauth.js');
    const cfg = googleOAuthConfig(0, 'cid.apps.googleusercontent.com');
    let next: Record<string, unknown> = {
      access_token: 'a1',
      refresh_token: 'rt-new',
      expires_in: 3600,
      token_type: 'Bearer',
    };
    globalThis.fetch = vi.fn(async () => ({ ok: true, json: async () => next })) as unknown as typeof fetch;
    const rotated = await refreshAccessToken(cfg, 'rt-old');
    expect(rotated.accessToken).toBe('a1');
    expect(rotated.refreshToken).toBe('rt-new');
    // No refresh_token in the response: the old token is still the live one.
    next = { access_token: 'a2', expires_in: 3600, token_type: 'Bearer' };
    const kept = await refreshAccessToken(cfg, 'rt-new');
    expect(kept.refreshToken).toBe('rt-new');
  });

  test('a rotated refresh token is reused on the next refresh and persisted to the stored entry', async () => {
    setStoredProviders([
      {
        name: 'g',
        type: 'google',
        baseURL: 'https://generativelanguage.googleapis.com',
        model: 'gemini-2.0-flash',
        oauthRefreshToken: 'rt-old',
        oauthClientId: 'stored-client-id.apps.googleusercontent.com',
      },
    ]);
    const { resolveProviderSelection } = await import('../src/lib/providers/byok-config.js');
    const sel = resolveProviderSelection({
      providerFlag: 'g',
      model: undefined,
      baseUrl: undefined,
      apiKeyEnv: undefined,
      env: process.env,
      stored: getStoredProviders(),
      defaultProvider: undefined,
    });
    expect(sel.kind).toBe('byok');
    if (sel.kind !== 'byok') return;

    // Rotation chain: rt-old -> rt-new -> rt-new2. A provider that rotates
    // revokes the old token, so the second refresh MUST send rt-new.
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      const sent = body.get('refresh_token') ?? '';
      seen.push(sent);
      const rotated = sent === 'rt-old' ? 'rt-new' : 'rt-new2';
      return {
        ok: true,
        json: async () => ({
          access_token: `at-for-${sent}`,
          refresh_token: rotated,
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      } as Response;
    }) as typeof fetch;

    // First stream attempt 401s (expired access token), the retry succeeds.
    let calls = 0;
    requestImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return { statusCode: 401, headers: {} as Record<string, string>, body: { text: async () => 'unauthorized' } };
      }
      return {
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: Readable.from([
          Buffer.from('data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}\n\n'),
        ]),
      };
    };

    const provider = await createByokProvider(sel.config);
    // The construction refresh already persisted its rotation.
    expect(getStoredProviders()[0]?.oauthRefreshToken).toBe('rt-new');
    const conv = await provider.createConversation({ model: 'gemini-2.0-flash' });
    const events: Array<{ type: string }> = [];
    for await (const ev of provider.streamChat({ conversationId: conv, message: 'hi', model: 'gemini-2.0-flash' })) {
      events.push(ev as { type: string });
    }
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(seen).toEqual(['rt-old', 'rt-new']);
    expect(getStoredProviders()[0]?.oauthRefreshToken).toBe('rt-new2');
  });
});
