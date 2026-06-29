import { describe, expect, test } from 'vitest';
import { isSecretKey, REDACTED, redactSecrets } from '../src/lib/redact.js';

describe('redact', () => {
  test('isSecretKey flags __token__ and secret-ish names, not normal keys', () => {
    expect(isSecretKey('__token__')).toBe(true);
    expect(isSecretKey('apiKey')).toBe(true);
    expect(isSecretKey('api_key')).toBe(true);
    expect(isSecretKey('PASSWORD')).toBe(true);
    expect(isSecretKey('bearerToken')).toBe(true);
    expect(isSecretKey('clientSecret')).toBe(true);
    expect(isSecretKey('apiUrl')).toBe(false);
    expect(isSecretKey('defaultModel')).toBe(false);
    expect(isSecretKey('theme')).toBe(false);
  });

  test('redactSecrets replaces secret values with the placeholder', () => {
    const out = redactSecrets({
      apiUrl: 'https://x',
      __token__: 'spycli_secret',
    }) as Record<string, unknown>;
    expect(out.apiUrl).toBe('https://x');
    expect(out.__token__).toBe(REDACTED);
    expect(JSON.stringify(out)).not.toContain('spycli_secret');
  });

  test('redactSecrets recurses into nested objects and arrays', () => {
    const out = redactSecrets({
      nested: { apiKey: 'k', safe: 1 },
      list: [{ password: 'p' }, { ok: true }],
    }) as { nested: Record<string, unknown>; list: Array<Record<string, unknown>> };
    expect(out.nested.apiKey).toBe(REDACTED);
    expect(out.nested.safe).toBe(1);
    expect(out.list[0]?.password).toBe(REDACTED);
    expect(out.list[1]?.ok).toBe(true);
  });

  test('redactSecrets does not mutate the input', () => {
    const input = { __token__: 'spycli_secret', apiUrl: 'x' };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(input.__token__).toBe('spycli_secret');
    expect(out.__token__).toBe(REDACTED);
  });

  test('redactSecrets passes primitives through unchanged', () => {
    expect(redactSecrets('hello')).toBe('hello');
    expect(redactSecrets(42)).toBe(42);
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(true)).toBe(true);
  });
});
