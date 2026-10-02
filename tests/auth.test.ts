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

  test('isAuthenticated rejects non-spycli prefixes', async () => {
    const { setToken, isAuthenticated } = await import('../src/lib/auth.js');
    // Smuggle in a value that doesn't have the prefix; this protects
    // against a stale OS keychain entry from another tool.
    await setToken('not-a-real-token');
    expect(await isAuthenticated()).toBe(false);
  });
});
