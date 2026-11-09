import { beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';

// Force the file fallback path: pretend keytar is unavailable.
vi.mock('keytar', () => {
  throw new Error('not installed');
});

beforeEach(() => {
  freshConfigDir();
});

describe('auth token storage with file fallback', () => {
  test('round-trips a token through set/get/clear', async () => {
    const { setToken, getToken, clearToken, isAuthenticated } = await import(
      '../src/lib/auth.js'
    );

    expect(await getToken()).toBeNull();
    expect(await isAuthenticated()).toBe(false);

    await setToken('spycli_abc123');
    expect(await getToken()).toBe('spycli_abc123');
    expect(await isAuthenticated()).toBe(true);

    await clearToken();
    expect(await getToken()).toBeNull();
    expect(await isAuthenticated()).toBe(false);
  });

  test('isAuthenticated agrees with getToken: any stored token authenticates', async () => {
    const { setToken, isAuthenticated } = await import('../src/lib/auth.js');
    // getToken() returns a SPYCORE_TOKEN verbatim with no prefix
    // requirement, so isAuthenticated must too - the old `spycli_`
    // prefix check reported "Not logged in" for a token that
    // authenticated every request.
    await setToken('not-a-real-token');
    expect(await isAuthenticated()).toBe(true);
  });
});
