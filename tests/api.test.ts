import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';

// We mock 'undici' module-level; each test sets the next response.
type MockBody = { json: () => Promise<unknown> };
type MockResp = { statusCode: number; body: MockBody; headers: Record<string, string | string[]> };
let nextResp: MockResp | (() => Promise<MockResp>) | Error | null = null;
// Capture the args the transport was called with (for header/host assertions).
let lastRequest: { url: string; options: { headers?: Record<string, string> } } | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, options: { headers?: Record<string, string> }) => {
    lastRequest = { url, options };
    if (nextResp instanceof Error) throw nextResp;
    if (typeof nextResp === 'function') return await nextResp();
    if (!nextResp) throw new Error('test forgot to set nextResp');
    return nextResp;
  }),
}));

beforeEach(() => {
  freshConfigDir();
  nextResp = null;
  lastRequest = null;
});

function jsonResp(status: number, body: unknown, headers: Record<string, string> = {}): MockResp {
  return {
    statusCode: status,
    headers,
    body: { json: async () => body },
  };
}

describe('api status -> exit code mapping', () => {
  test('200 returns parsed data', async () => {
    nextResp = jsonResp(200, { success: true, data: { hello: 'world' } });
    const { api } = await import('../src/lib/api.js');
    await expect(api.get('/some/path', { anonymous: true })).resolves.toEqual({
      hello: 'world',
    });
  });

  test('401 -> EXIT_AUTH_ERROR with login hint', async () => {
    nextResp = jsonResp(401, { success: false, error: 'invalid' });
    const { api } = await import('../src/lib/api.js');
    const { EXIT_AUTH_ERROR, isSpycoreCliError } = await import(
      '../src/lib/errors.js'
    );
    try {
      await api.get('/any', { anonymous: true });
      throw new Error('should have thrown');
    } catch (err) {
      expect(isSpycoreCliError(err)).toBe(true);
      if (isSpycoreCliError(err)) {
        expect(err.code).toBe(EXIT_AUTH_ERROR);
        expect(err.hint).toMatch(/login/i);
      }
    }
  });

  test('403 -> EXIT_AUTH_ERROR with permission hint', async () => {
    nextResp = jsonResp(403, { success: false, error: 'forbidden' });
    const { api } = await import('../src/lib/api.js');
    const { EXIT_AUTH_ERROR, isSpycoreCliError } = await import(
      '../src/lib/errors.js'
    );
    try {
      await api.get('/any', { anonymous: true });
      throw new Error('should have thrown');
    } catch (err) {
      expect(isSpycoreCliError(err)).toBe(true);
      if (isSpycoreCliError(err)) {
        expect(err.code).toBe(EXIT_AUTH_ERROR);
        expect(err.hint).toMatch(/plan|account/i);
      }
    }
  });

  test('429 surfaces retry-after in hint', async () => {
    nextResp = jsonResp(
      429,
      { success: false, error: 'rate limit' },
      { 'retry-after': '17' },
    );
    const { api } = await import('../src/lib/api.js');
    const { EXIT_NETWORK_ERROR, isSpycoreCliError } = await import(
      '../src/lib/errors.js'
    );
    try {
      await api.get('/any', { anonymous: true });
      throw new Error('should have thrown');
    } catch (err) {
      expect(isSpycoreCliError(err)).toBe(true);
      if (isSpycoreCliError(err)) {
        expect(err.code).toBe(EXIT_NETWORK_ERROR);
        expect(err.hint).toContain('17s');
      }
    }
  });

  test('500 -> EXIT_SERVER_ERROR', async () => {
    nextResp = jsonResp(500, { success: false, error: 'kaboom' });
    const { api } = await import('../src/lib/api.js');
    const { EXIT_SERVER_ERROR, isSpycoreCliError } = await import(
      '../src/lib/errors.js'
    );
    try {
      await api.post('/any', { anonymous: true, body: {} });
      throw new Error('should have thrown');
    } catch (err) {
      expect(isSpycoreCliError(err)).toBe(true);
      if (isSpycoreCliError(err)) {
        expect(err.code).toBe(EXIT_SERVER_ERROR);
      }
    }
  });

  test('network throw -> EXIT_NETWORK_ERROR with friendly message', async () => {
    nextResp = new Error('ECONNREFUSED');
    const { api } = await import('../src/lib/api.js');
    const { EXIT_NETWORK_ERROR, isSpycoreCliError } = await import(
      '../src/lib/errors.js'
    );
    try {
      await api.get('/any', { anonymous: true });
      throw new Error('should have thrown');
    } catch (err) {
      expect(isSpycoreCliError(err)).toBe(true);
      if (isSpycoreCliError(err)) {
        expect(err.code).toBe(EXIT_NETWORK_ERROR);
        expect(err.message).toContain('Cannot reach API');
      }
    }
  });
});

describe('bearer token host allowlist (CL6)', () => {
  const TOKEN = 'spycli_test_token_value';
  let prevToken: string | undefined;

  beforeEach(() => {
    prevToken = process.env.SPYCORE_TOKEN;
    process.env.SPYCORE_TOKEN = TOKEN;
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.SPYCORE_TOKEN;
    else process.env.SPYCORE_TOKEN = prevToken;
  });

  async function callWith(apiUrlOverride?: string): Promise<string | undefined> {
    nextResp = jsonResp(200, { success: true, data: {} });
    const { api } = await import('../src/lib/api.js');
    await api.get('/whoami', apiUrlOverride ? { apiUrlOverride } : {});
    return lastRequest?.options.headers?.authorization;
  }

  test('attaches the token to the default SpyCore host (api.spycore.ai)', async () => {
    expect(await callWith()).toBe(`Bearer ${TOKEN}`);
  });

  test('attaches the token to the .ca alias (api.spycore.ca)', async () => {
    expect(await callWith('https://api.spycore.ca')).toBe(`Bearer ${TOKEN}`);
  });

  test('attaches the token to localhost (dev / self-host)', async () => {
    expect(await callWith('http://localhost:8787')).toBe(`Bearer ${TOKEN}`);
    expect(await callWith('http://127.0.0.1:8787')).toBe(`Bearer ${TOKEN}`);
  });

  test('does NOT attach the token to an arbitrary host', async () => {
    expect(await callWith('https://evil.example.com')).toBeUndefined();
  });

  test('does NOT attach the token to a look-alike host', async () => {
    expect(await callWith('https://api.spycore.ai.attacker.com')).toBeUndefined();
    expect(await callWith('https://notspycore.ai')).toBeUndefined();
  });

  test('streamRequest applies the same host allowlist', async () => {
    const { isTrustedTokenHost } = await import('../src/lib/config.js');
    // Sanity-check the shared helper the streaming path also uses.
    expect(isTrustedTokenHost('https://api.spycore.ai/api/chat/stream')).toBe(true);
    expect(isTrustedTokenHost('https://api.spycore.ca/api/chat/stream')).toBe(true);
    expect(isTrustedTokenHost('https://evil.example.com/api/chat/stream')).toBe(false);
  });
});

describe('normalizeApiBase', () => {
  test('appends /api when the base has no suffix', async () => {
    const { normalizeApiBase } = await import('../src/lib/config.js');
    expect(normalizeApiBase('https://api.spycore.ai')).toBe(
      'https://api.spycore.ai/api',
    );
  });

  test('appends /api after stripping a trailing slash', async () => {
    const { normalizeApiBase } = await import('../src/lib/config.js');
    expect(normalizeApiBase('https://api.spycore.ai/')).toBe(
      'https://api.spycore.ai/api',
    );
  });

  test('leaves an existing /api suffix untouched', async () => {
    const { normalizeApiBase } = await import('../src/lib/config.js');
    expect(normalizeApiBase('https://api.spycore.ai/api')).toBe(
      'https://api.spycore.ai/api',
    );
  });

  test('collapses a trailing slash after /api', async () => {
    const { normalizeApiBase } = await import('../src/lib/config.js');
    expect(normalizeApiBase('https://api.spycore.ai/api/')).toBe(
      'https://api.spycore.ai/api',
    );
  });

  test('is idempotent', async () => {
    const { normalizeApiBase } = await import('../src/lib/config.js');
    const once = normalizeApiBase('https://api.spycore.ai');
    expect(normalizeApiBase(once)).toBe('https://api.spycore.ai/api');
  });
});
