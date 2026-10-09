import { describe, expect, test } from 'vitest';
import {
  isSecretKey,
  REDACTED,
  redactFreeText,
  redactSecrets,
} from '../src/lib/redact.js';

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

describe('redactFreeText (S2: transcript export)', () => {
  test('redacts Bearer tokens, keeping the scheme', () => {
    const out = redactFreeText('Authorization: Bearer abcdef1234567890XYZ');
    expect(out).toBe(`Authorization: Bearer ${REDACTED}`);
    expect(out).not.toContain('abcdef1234567890XYZ');
  });

  test('redacts common API key prefixes', () => {
    expect(redactFreeText('key is sk-abcdefghijklmnop1234')).toBe(
      `key is ${REDACTED}`,
    );
    expect(redactFreeText('token ghp_abcdefghijklmnop1234 here')).toBe(
      `token ${REDACTED} here`,
    );
    expect(redactFreeText('AKIAIOSFODNN7EXAMPLE here')).toBe(
      `${REDACTED} here`,
    );
  });

  test('redacts labeled secrets in key=value form', () => {
    const out = redactFreeText('api_key=supersecret123');
    expect(out).not.toContain('supersecret123');
    expect(out).toContain(REDACTED);
    const out2 = redactFreeText('password: "hunter2"');
    expect(out2).not.toContain('hunter2');
  });

  test('redacts full PEM private key blocks', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7b\n-----END RSA PRIVATE KEY-----';
    const out = redactFreeText(`here is the key:\n${pem}\ndone`);
    expect(out).not.toContain('MIIEpAIBAAKCAQEA7b');
    expect(out).toContain(REDACTED);
  });

  test('redacts credentials embedded in URLs', () => {
    const out = redactFreeText('see https://user:s3cr3t@example.com/path');
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('user:');
    expect(out).toContain('@example.com');
  });

  test('leaves ordinary text untouched', () => {
    const plain = 'The quick brown fox jumps over the lazy dog. 12345.';
    expect(redactFreeText(plain)).toBe(plain);
  });

  test('redacts Anthropic sk-ant- keys (R1 finding)', () => {
    const out = redactFreeText('my key: sk-ant-api03-abcdefghijklmnop1234');
    expect(out).not.toContain('sk-ant-api03');
    expect(out).toContain(REDACTED);
  });

  test('redacts OpenAI sk-proj- keys (R1 finding)', () => {
    const out = redactFreeText('key sk-proj-abcdefghijklmnop12345678 here');
    expect(out).not.toContain('sk-proj-');
    expect(out).toContain(REDACTED);
  });

  test('redacts Google AIza keys (R1 finding)', () => {
    const out = redactFreeText('AIzaSyAbcDefGhIjKlMnOpQrStUvWx1234567');
    expect(out).toBe(REDACTED);
  });

  test('does not mangle innocent "secret:" prose (R1 finding)', () => {
    const prose = 'The secret: to good code is simplicity';
    expect(redactFreeText(prose)).toBe(prose);
  });

  test('does not mangle "pwd:" paths (R1 finding)', () => {
    const prose = 'run pwd: /home/user to see the directory';
    expect(redactFreeText(prose)).toBe(prose);
  });

  test('redacts credentials in non-HTTP URLs (R1 finding)', () => {
    const out = redactFreeText('connect to postgres://admin:s3cr3t@db:5432/app');
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain('admin:');
    expect(out).toContain('@db:5432');
  });

  test('still redacts password= and api_key with values', () => {
    expect(redactFreeText('password=hunter2')).not.toContain('hunter2');
    expect(redactFreeText('api_key: "abc123xyz"')).not.toContain('abc123xyz');
  });

  test('redacts additional vendor key prefixes (R2 findings)', () => {
    expect(redactFreeText('ghs_abcdefghijklmnop1234')).toBe(REDACTED);
    expect(redactFreeText('ghu_abcdefghijklmnop1234')).toBe(REDACTED);
    expect(redactFreeText('glpat-abcdefghijklmnop12')).toBe(REDACTED);
    expect(redactFreeText('sk_live_abcdefghijklmnop')).toBe(REDACTED);
    expect(redactFreeText('sk_test_abcdefghijklmnop')).toBe(REDACTED);
    expect(redactFreeText('npm_abcdefghijklmnop12')).toBe(REDACTED);
    expect(redactFreeText('hf_abcdefghijklmnop1234')).toBe(REDACTED);
    expect(redactFreeText('xoxe-abcdefghijklmnop12')).toBe(REDACTED);
  });

  test('redacts ENCRYPTED PRIVATE KEY and PGP blocks (R2 findings)', () => {
    const enc =
      '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIBvTBXBgkqhkiG9w0BBQ0wSjApBgkq\n-----END ENCRYPTED PRIVATE KEY-----';
    expect(redactFreeText(enc)).toBe(REDACTED);
    const pgp =
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQdGBF...\n-----END PGP PRIVATE KEY BLOCK-----';
    expect(redactFreeText(pgp)).toBe(REDACTED);
  });

  test('redacts camelCase apiSecret= (R2 finding)', () => {
    expect(redactFreeText('apiSecret=mysecretvalue123')).not.toContain(
      'mysecretvalue123',
    );
  });

  test('redacts empty-username URL credentials like redis://:pass@host (R2 finding)', () => {
    const out = redactFreeText('redis://:s3cr3t@localhost:6379/0');
    expect(out).not.toContain('s3cr3t');
    expect(out).toContain(REDACTED);
  });

  test('ReDoS guard: 100KB plain text redacts in under 1s (R2 finding)', () => {
    const big = 'lorem ipsum dolor sit amet '.repeat(4000); // ~108KB
    const start = Date.now();
    redactFreeText(big);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
