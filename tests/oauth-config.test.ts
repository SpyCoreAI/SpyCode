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

describe('refreshAccessToken validates the payload (R2 L1)', () => {
  const cfg = {
    clientId: 'id',
    authUrl: 'https://example.com/auth',
    tokenUrl: 'https://example.com/token',
    scopes: [],
    redirectPort: 0,
  };

  test('an empty success payload fails at the refresh, not as a later unauthenticated 400', async () => {
    const { vi } = await import('vitest');
    const { refreshAccessToken } = await import('../src/lib/oauth.js');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(refreshAccessToken(cfg, 'refresh-token')).rejects.toThrow(
        /no access token in response/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a missing expires_in fails at the refresh instead of producing a NaN expiry', async () => {
    const { vi } = await import('vitest');
    const { refreshAccessToken } = await import('../src/lib/oauth.js');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'new-access', token_type: 'Bearer' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(refreshAccessToken(cfg, 'refresh-token')).rejects.toThrow(
        /no expiry \(expires_in\) in response/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a complete payload still returns the tokens', async () => {
    const { vi } = await import('vitest');
    const { refreshAccessToken } = await import('../src/lib/oauth.js');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'new-access', expires_in: 3600, token_type: 'Bearer' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const tokens = await refreshAccessToken(cfg, 'refresh-token');
      expect(tokens.accessToken).toBe('new-access');
      expect(tokens.refreshToken).toBe('refresh-token');
      expect(Number.isFinite(tokens.expiresAt)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
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

describe('exchangeCodeForTokens validates the payload (R3-13 site 9)', () => {
  const cfg = {
    clientId: 'id',
    authUrl: 'https://example.com/auth',
    tokenUrl: 'https://example.com/token',
    scopes: [],
    redirectPort: 0,
  };

  test('a refresh_token without an access_token fails at the exchange instead of storing a broken token', async () => {
    const { vi } = await import('vitest');
    const { exchangeCodeForTokens } = await import('../src/lib/oauth.js');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(exchangeCodeForTokens(cfg, 'code', 'verifier', 'http://127.0.0.1:0/callback')).rejects.toThrow(
        /no access token in response/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a missing expires_in fails at the exchange instead of producing a NaN expiry', async () => {
    const { vi } = await import('vitest');
    const { exchangeCodeForTokens } = await import('../src/lib/oauth.js');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at', refresh_token: 'rt', token_type: 'Bearer' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(exchangeCodeForTokens(cfg, 'code', 'verifier', 'http://127.0.0.1:0/callback')).rejects.toThrow(
        /no expiry \(expires_in\) in response/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a complete payload still returns the tokens', async () => {
    const { vi } = await import('vitest');
    const { exchangeCodeForTokens } = await import('../src/lib/oauth.js');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const tokens = await exchangeCodeForTokens(cfg, 'code', 'verifier', 'http://127.0.0.1:0/callback');
      expect(tokens.accessToken).toBe('at');
      expect(tokens.refreshToken).toBe('rt');
      expect(Number.isFinite(tokens.expiresAt)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('token endpoint reads are capped at 1 MB (R2-3)', () => {
  const cfg = {
    clientId: 'id',
    authUrl: 'https://example.com/auth',
    tokenUrl: 'https://example.com/token',
    scopes: [],
    redirectPort: 0,
  };

  test('a multi-MB error body is truncated, not buffered in full', async () => {
    const { vi } = await import('vitest');
    const { exchangeCodeForTokens } = await import('../src/lib/oauth.js');
    let chunksYielded = 0;
    async function* huge(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 40; i += 1) {
        chunksYielded += 1;
        yield Buffer.alloc(64 * 1024, 'x');
      }
    }
    const fetchMock = vi.fn(async () => ({ ok: false, status: 400, body: huge() }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      let err: Error | undefined;
      try {
        await exchangeCodeForTokens(cfg, 'code', 'verifier', 'http://127.0.0.1:0/callback');
        expect.unreachable('should have thrown');
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).toMatch(/Token exchange failed \(400\)/);
      // The 1 MB cap binds: the message carries at most ~1 MB of body,
      // not the full 2.5 MB the endpoint sent.
      expect(err?.message.length).toBeLessThan(1_048_576 + 100);
      expect(chunksYielded).toBeLessThan(40);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test('a multi-MB success body fails cleanly instead of being parsed whole', async () => {
    const { vi } = await import('vitest');
    const { refreshAccessToken } = await import('../src/lib/oauth.js');
    async function* huge(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 40; i += 1) {
        yield Buffer.alloc(64 * 1024, 'x');
      }
    }
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: huge() }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(refreshAccessToken(cfg, 'refresh-token')).rejects.toThrow(
        /unexpected response from token endpoint/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
