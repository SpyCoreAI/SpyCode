import { afterEach, describe, expect, test } from 'vitest';
import { googleOAuthConfig } from '../src/lib/oauth.js';

const ENV_KEY = 'SPYCORE_GOOGLE_CLIENT_ID';

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe('googleOAuthConfig', () => {
  test('throws a helpful error when the client id is not configured', () => {
    expect(() => googleOAuthConfig(8080)).toThrow('Google OAuth client ID not configured');
  });

  test('blank client ids count as missing', () => {
    process.env[ENV_KEY] = '   ';
    expect(() => googleOAuthConfig(8080)).toThrow('Google OAuth client ID not configured');
  });

  test('builds the OAuth config from the env client id', () => {
    process.env[ENV_KEY] = '  my-client-id  ';
    const cfg = googleOAuthConfig(9182);
    expect(cfg.clientId).toBe('my-client-id'); // trimmed
    expect(cfg.redirectPort).toBe(9182);
    expect(cfg.authUrl).toContain('accounts.google.com');
    expect(cfg.tokenUrl.length).toBeGreaterThan(0);
    expect(cfg.scopes.length).toBeGreaterThan(0);
  });

  test('an explicitly passed client id works with no env var (H7)', () => {
    const cfg = googleOAuthConfig(0, '  stored-client-id  ');
    expect(cfg.clientId).toBe('stored-client-id'); // trimmed
    expect(cfg.redirectPort).toBe(0);
  });

  test('an explicitly passed client id wins over the env var (H7)', () => {
    process.env[ENV_KEY] = 'env-client-id';
    expect(googleOAuthConfig(0, 'stored-client-id').clientId).toBe('stored-client-id');
  });
});

describe('refreshAccessToken timeout (4c)', () => {
  test('a hung token endpoint fails after the timeout instead of hanging forever', async () => {
    const { vi } = await import('vitest');
    const { refreshAccessToken, OAUTH_FETCH_TIMEOUT_MS } = await import(
      '../src/lib/oauth.js'
    );
    expect(OAUTH_FETCH_TIMEOUT_MS).toBe(30_000);
    // The fetch mock never settles on its own - it rejects only when its
    // signal aborts, exactly like a real fetch under AbortSignal.timeout.
    // (Node's AbortSignal.timeout does not run on vitest fake timers, so
    // the timeout is injected short here with real timers instead.)
    const fetchMock = vi.fn((_url: string, opts: { signal?: AbortSignal }) => {
      return new Promise<never>((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          const err = new Error('aborted') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(
        refreshAccessToken(
          {
            clientId: 'id',
            authUrl: 'https://example.com/auth',
            tokenUrl: 'https://example.com/token',
            scopes: [],
            redirectPort: 0,
          },
          'refresh-token',
          { timeoutMs: 50 },
        ),
      ).rejects.toThrow(/timed out after 0.05s/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
