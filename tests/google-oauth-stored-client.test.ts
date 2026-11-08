import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createByokProvider } from '../src/lib/providers/factory.js';
import type { ByokConfig } from '../src/lib/providers/byok-config.js';

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
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    delete process.env[ENV_KEY];
    globalThis.fetch = origFetch;
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
});
