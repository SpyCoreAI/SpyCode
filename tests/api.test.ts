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

  /**
   * THE GATE IS SCHEME-AWARE, AND THAT IS THE PROPERTY - not the host set.
   *
   * The predicate consulted `hostname` alone, so the SCHEME was never part of
   * the decision. Driven through the real transport with a sentinel token,
   * `http://api.spycore.ai/api/user/me` received `Bearer <token>` - a SpyCore
   * credential in cleartext - and 27 of 48 probed scheme×host combinations
   * attached the token to a non-https URL. `--api-url` / `SPYCORE_API_URL` are
   * attacker- and prompt-reachable and neither `resolveApiUrl` nor
   * `normalizeApiBase` validates a scheme, so the base URL is the whole input.
   *
   * The assertion is written as a MATRIX rather than as example URLs, so a
   * later widening has to delete a row rather than slip past a spot check.
   *
   * WHAT THIS CANNOT SEE: whether a caller consults the predicate at all. That
   * is the four attach sites' property, asserted by the sibling tests above and
   * by attachments/upload's own suites.
   */
  test('non-https NEVER carries the token to a remote host; loopback keeps http for dev', async () => {
    const { isTrustedTokenHost } = await import('../src/lib/config.js');
    const REMOTE = ['api.spycore.ai', 'api.spycore.ca'];
    const LOOPBACK = ['localhost', '127.0.0.1'];
    const NON_HTTPS = ['http:', 'ftp:', 'file:', 'ws:', 'wss:', 'gopher:'];

    // Controls first: the matrix below is only meaningful if the predicate can
    // say yes and no at all.
    expect(isTrustedTokenHost('https://api.spycore.ai/api/x'), 'predicate never says yes').toBe(true);
    expect(isTrustedTokenHost('https://evil.example.com/api/x'), 'predicate never says no').toBe(false);

    for (const host of REMOTE) {
      expect(isTrustedTokenHost(`https://${host}/api/x`), `https://${host} must carry the token`).toBe(true);
      for (const scheme of NON_HTTPS) {
        expect(
          isTrustedTokenHost(`${scheme}//${host}/api/x`),
          `${scheme}//${host} received the bearer token - the gate is scheme-blind again`,
        ).toBe(false);
      }
    }
    for (const host of LOOPBACK) {
      // Loopback is the documented dev / self-hosting case and a local server
      // serves plain http; the token never leaves the machine.
      expect(isTrustedTokenHost(`http://${host}:3001/api/x`), `http://${host} is the dev case`).toBe(true);
      expect(isTrustedTokenHost(`https://${host}:3001/api/x`)).toBe(true);
      for (const scheme of NON_HTTPS.filter((s) => s !== 'http:')) {
        expect(
          isTrustedTokenHost(`${scheme}//${host}/api/x`),
          `${scheme}//${host} received the bearer token`,
        ).toBe(false);
      }
    }
  });

  /**
   * IPv6 LOOPBACK NOW RECEIVES THE TOKEN - AND THE WIDENING IS PINNED BY
   * ITS BOUNDARY, NOT BY ITS EXAMPLES.
   *
   * F-2c-26 measured that `new URL('https://[::1]/x').hostname` keeps the
   * brackets, so the `'::1'` entry never matched and a developer on IPv6
   * loopback got no token. It left the behaviour alone because widening a
   * credential allowlist is a decision. The decision was taken (F-2c-27) and
   * the change is bracket-stripping on the LOOPBACK lookup only.
   *
   * The assertions below are the boundary: the admitted side is every
   * spelling the URL parser normalises to the hostname `[::1]`, and the refused
   * side is every neighbouring literal that must NOT be mistaken for it. That
   * is what makes this a bound rather than a spot check - a future widening has
   * to delete a refusal, which is visible, instead of slipping past examples.
   */
  test('IPv6 loopback carries the token - and ONLY that address, in every spelling', async () => {
    const { isTrustedTokenHost } = await import('../src/lib/config.js');
    // Controls first: the predicate can still say yes and no at all.
    expect(isTrustedTokenHost('https://api.spycore.ai/api/x'), 'predicate never says yes').toBe(true);
    expect(isTrustedTokenHost('https://evil.example.com/api/x'), 'predicate never says no').toBe(false);

    // The mechanism, asserted directly so the reason stays visible: the parser
    // keeps the brackets, and normalises all four spellings to one hostname.
    for (const spelling of ['[::1]', '[::1]:8787', '[0:0:0:0:0:0:0:1]', '[::0001]']) {
      expect(new URL(`https://${spelling}/x`).hostname, `${spelling} normalises`).toBe('[::1]');
      expect(isTrustedTokenHost(`https://${spelling}/api/x`), `https://${spelling}`).toBe(true);
      expect(isTrustedTokenHost(`http://${spelling}/api/x`), `http://${spelling} is the dev case`).toBe(true);
    }

    // THE REFUSED SIDE. Neighbours of the loopback literal that the strip
    // must never admit. `[::ffff:127.0.0.1]` is the sharpest: it *reads* as
    // loopback and the parser rewrites it to `[::ffff:7f00:1]`, a different
    // literal, so it is refused - pinned so a future "helpful" normalisation
    // cannot quietly turn it into a yes.
    expect(new URL('https://[::ffff:127.0.0.1]/x').hostname).toBe('[::ffff:7f00:1]');
    for (const host of ['[::]', '[::2]', '[fe80::1]', '[::ffff:127.0.0.1]']) {
      expect(isTrustedTokenHost(`https://${host}/api/x`), `https://${host} must be refused`).toBe(false);
      expect(isTrustedTokenHost(`http://${host}/api/x`), `http://${host} must be refused`).toBe(false);
    }
    // Unbracketed `::1` is not a parseable URL host at all - fail-closed.
    expect(isTrustedTokenHost('https://::1/api/x')).toBe(false);

    // The scheme half is untouched by the widening: loopback gains http,
    // never anything else. This is the F-2c-26 property re-asserted at the
    // newly-admitted address, which is exactly where a regression would land.
    for (const scheme of ['ftp:', 'file:', 'ws:', 'wss:', 'gopher:']) {
      expect(
        isTrustedTokenHost(`${scheme}//[::1]/api/x`),
        `${scheme}//[::1] received the bearer token`,
      ).toBe(false);
    }
  });

  /**
   * TWO IMPLEMENTATIONS OF ONE PROPERTY, BOUND TOGETHER.
   *
   * `isTrustedTokenHost` (this module) and `validateRemoteMcpUrl`
   * (`agent/mcp-config.ts`) both decide "is this the loopback, and may it be
   * plain http". They are NOT one function: `mcp-config.ts` imports
   * `config.ts` at runtime, so sharing would be an import cycle. Two mechanisms
   * guarding one property is a bypass surface by construction - this is the
   * binding that replaces the shared function, and it is the reason the
   * duplication is acceptable rather than merely tolerated.
   */
  test('the token gate and the MCP URL gate agree on what loopback means', async () => {
    const { isTrustedTokenHost } = await import('../src/lib/config.js');
    const { validateRemoteMcpUrl } = await import('../src/lib/agent/mcp-config.js');

    const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
    const REMOTE = ['api.spycore.ai', 'evil.example.com'];

    // Control: the MCP validator can say no, so a clean sweep below is not
    // a validator that accepts everything.
    expect(validateRemoteMcpUrl('http://evil.example.com/mcp')).not.toBeNull();

    for (const host of LOOPBACK) {
      expect(validateRemoteMcpUrl(`http://${host}:9000/mcp`), `MCP: http://${host}`).toBeNull();
      expect(isTrustedTokenHost(`http://${host}:9000/api/x`), `token: http://${host}`).toBe(true);
    }
    for (const host of REMOTE) {
      // Both refuse plain http off-loopback. (The token gate additionally
      // refuses the remote host it does not know; that is its own concern.)
      expect(validateRemoteMcpUrl(`http://${host}/mcp`), `MCP: http://${host}`).not.toBeNull();
      expect(isTrustedTokenHost(`http://${host}/api/x`), `token: http://${host}`).toBe(false);
    }
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
