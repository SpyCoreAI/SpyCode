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

  test('coerceValue normalizes booleans for providerFallback (H11)', async () => {
    const { coerceValue, getConfigStore } = await import('../src/lib/config.js');
    expect(coerceValue('providerFallback', 'true')).toBe(true);
    expect(coerceValue('providerFallback', 'false')).toBe(false);
    expect(() => coerceValue('providerFallback', 'maybe')).toThrow();
    // The stored value must be a real boolean: agent.ts checks `=== true`
    // strictly, so the raw string "true" silently never enabled fallback.
    getConfigStore().set('providerFallback', coerceValue('providerFallback', 'true'));
    expect(getConfigStore().get('providerFallback')).toBe(true);
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

// R3-7: a hand-edited config scalar of the wrong type used to crash at
// resolve time with a raw TypeError (`raw.toLowerCase is not a function`,
// `base.replace is not a function`). It now fails with a clean,
// actionable config error.
describe('R3-7 · hand-edited config scalars fail cleanly', () => {
  test('a numeric defaultModel throws a clean config error', async () => {
    const { getConfigStore } = await import('../src/lib/config.js');
    const { resolveModelSlug } = await import('../src/lib/models.js');
    getConfigStore().set('defaultModel', 42 as never);
    expect(() => resolveModelSlug(undefined)).toThrow(/Invalid config: defaultModel/);
    // An explicit input bypasses the stored value entirely.
    expect(resolveModelSlug('minos')).toBe('minos');
  });

  test('a numeric apiUrl throws a clean config error', async () => {
    const { getConfigStore, normalizeApiBase, resolveApiUrl } = await import('../src/lib/config.js');
    getConfigStore().set('apiUrl', 42 as never);
    expect(() => resolveApiUrl()).toThrow(/Invalid config: apiUrl/);
    expect(() => normalizeApiBase(42 as never)).toThrow(/Invalid config: apiUrl/);
    expect(normalizeApiBase('https://api.spycore.ai')).toBe('https://api.spycore.ai/api');
  });
});
