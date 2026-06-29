import { beforeEach, describe, expect, test } from 'vitest';
import { freshConfigDir } from './helpers.js';

beforeEach(() => {
  freshConfigDir();
});

describe('config schema', () => {
  test('isKnownKey accepts known keys and rejects unknowns', async () => {
    const { isKnownKey } = await import('../src/lib/config.js');
    expect(isKnownKey('apiUrl')).toBe(true);
    expect(isKnownKey('theme')).toBe(true);
    expect(isKnownKey('definitelyNotAThing')).toBe(false);
  });

  test('coerceValue rejects bad apiUrl and accepts good ones', async () => {
    const { coerceValue } = await import('../src/lib/config.js');
    expect(coerceValue('apiUrl', 'https://example.com/api')).toBe(
      'https://example.com/api',
    );
    expect(() => coerceValue('apiUrl', 'ftp://nope.example')).toThrow();
    expect(() => coerceValue('apiUrl', 'not-a-url')).toThrow();
  });

  test('coerceValue normalizes booleans for defaultStream', async () => {
    const { coerceValue } = await import('../src/lib/config.js');
    expect(coerceValue('defaultStream', 'true')).toBe(true);
    expect(coerceValue('defaultStream', 'false')).toBe(false);
    expect(() => coerceValue('defaultStream', 'maybe')).toThrow();
  });

  test('coerceValue enforces theme enum', async () => {
    const { coerceValue } = await import('../src/lib/config.js');
    expect(coerceValue('theme', 'auto')).toBe('auto');
    expect(coerceValue('theme', 'light')).toBe('light');
    expect(() => coerceValue('theme', 'pink')).toThrow();
  });

  test('living-memory toggles are known boolean keys defaulting to true', async () => {
    const { isKnownKey, coerceValue, getConfigStore } = await import(
      '../src/lib/config.js'
    );
    // Read-at-start (Part 3a) + write-at-end (Part 3b) toggles.
    for (const key of ['injectGuide', 'injectChangelog', 'autoChangelog', 'autoRefreshGuide'] as const) {
      expect(isKnownKey(key)).toBe(true);
      expect(coerceValue(key, 'true')).toBe(true);
      expect(coerceValue(key, 'false')).toBe(false);
      expect(() => coerceValue(key, 'maybe')).toThrow();
      // Default true so living memory works out of the box.
      expect(getConfigStore().get(key)).toBe(true);
    }
  });
});

describe('resolveApiUrl precedence', () => {
  test('flag > env > config > default', async () => {
    const { resolveApiUrl, getConfigStore } = await import(
      '../src/lib/config.js'
    );

    // 1. Default when nothing else is set
    expect(resolveApiUrl()).toBe('https://api.spycore.ai/api');

    // 2. Config file wins over default
    getConfigStore().set('apiUrl', 'https://config.example/api');
    expect(resolveApiUrl()).toBe('https://config.example/api');

    // 3. Env var wins over config file
    process.env.SPYCORE_API_URL = 'https://env.example/api';
    expect(resolveApiUrl()).toBe('https://env.example/api');

    // 4. Flag wins over env var
    expect(resolveApiUrl('https://flag.example/api')).toBe(
      'https://flag.example/api',
    );

    delete process.env.SPYCORE_API_URL;
  });
});

describe('token storage helpers stay out of the schema', () => {
  test('setStoredTokenInFile + getStoredTokenFromFile round-trip', async () => {
    const {
      getStoredTokenFromFile,
      setStoredTokenInFile,
      clearStoredTokenInFile,
    } = await import('../src/lib/config.js');

    expect(getStoredTokenFromFile()).toBeNull();
    setStoredTokenInFile('spycli_test_value');
    expect(getStoredTokenFromFile()).toBe('spycli_test_value');
    clearStoredTokenInFile();
    expect(getStoredTokenFromFile()).toBeNull();
  });

  test('stored token does not appear in `store.store` known-keys output', async () => {
    const { getConfigStore, listKnownKeys, setStoredTokenInFile } =
      await import('../src/lib/config.js');

    setStoredTokenInFile('spycli_should_not_leak');
    const store = getConfigStore();
    for (const key of listKnownKeys()) {
      expect(String(store.get(key) ?? '')).not.toContain(
        'spycli_should_not_leak',
      );
    }
  });
});
