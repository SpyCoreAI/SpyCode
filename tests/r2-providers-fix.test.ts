import { afterEach, describe, expect, test, vi } from 'vitest';
import { get as httpGet } from 'node:http';

/**
 * R2 OAuth flow regressions (L2, L3): the code-exchange fetch timeout and
 * the missing-code callback branch. Both go through the real local
 * callback server - the flow's state is read out of the auth URL it logs.
 */

const origLog = console.log;
let logLines: string[] = [];

afterEach(() => {
  console.log = origLog;
  vi.unstubAllGlobals();
  vi.resetModules();
});

function captureLogs(): void {
  logLines = [];
  console.log = ((...args: unknown[]) => {
    logLines.push(args.map((a) => String(a)).join(' '));
  }) as typeof console.log;
}

/** Drive the real callback server with a plain node:http GET. */
function hitCallback(port: number, query: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpGet(`http://127.0.0.1:${port}/callback${query}`, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
  });
}

async function startFlow(): Promise<{
  promise: Promise<unknown>;
  port: number;
  state: string;
  fetchMock: ReturnType<typeof vi.fn>;
}> {
  captureLogs();
  const fetchMock = vi.fn(async (_url: string, _opts: { signal?: AbortSignal }) => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      token_type: 'Bearer',
    }),
  }));
  vi.stubGlobal('fetch', fetchMock);
  const port = 49152 + Math.floor(Math.random() * 16383);
  const { runOAuthFlow } = await import('../src/lib/oauth.js');
  const promise = runOAuthFlow({
    clientId: 'cid-1',
    authUrl: 'https://example.com/auth',
    tokenUrl: 'https://example.com/token',
    scopes: [],
    redirectPort: port,
  });
  // The L3 arm rejects from inside the callback handler, before the test
  // attaches its assertion - a noop handler keeps the rejection from
  // surfacing as an unhandled error in the runner. The tests still assert
  // on the original promise.
  promise.catch(() => {});
  // The listen callback logs the auth URL (with the generated state).
  let authUrl = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    authUrl = logLines.find((l) => l.startsWith('https://example.com/auth?')) ?? '';
    if (authUrl) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(authUrl.length).toBeGreaterThan(0);
  const state = new URL(authUrl).searchParams.get('state');
  expect(state).toBeTruthy();
  return { promise, port, state: state!, fetchMock };
}

describe('runOAuthFlow - code exchange fetch has a timeout (R2 L2)', () => {
  test('the token exchange is issued with an abort signal', async () => {
    const { promise, port, state, fetchMock } = await startFlow();
    const tokens = await Promise.race([
      (async () => {
        await hitCallback(port, `?code=auth-code-1&state=${state}`);
        return promise;
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('flow did not settle')), 10_000),
      ),
    ]);
    expect(tokens).toMatchObject({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const signal = (fetchMock.mock.calls[0]?.[1] as { signal?: unknown } | undefined)?.signal;
    expect(signal instanceof AbortSignal).toBe(true);
  });
});

describe('runOAuthFlow - callback without a code rejects promptly (R2 L3)', () => {
  test('no code settles the promise with a clear error instead of the 5-minute timeout', async () => {
    const { promise, port, state } = await startFlow();
    const status = await hitCallback(port, `?state=${state}`);
    expect(status).toBe(400);
    await expect(promise).rejects.toThrow(/missing code/i);
  });
});
