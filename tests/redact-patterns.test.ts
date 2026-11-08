import { describe, expect, test } from 'vitest';
import {
  REDACTED,
  redactConfigDump,
  redactFreeText,
  redactTemplatedValue,
  redactUrlCredentials,
} from '../src/lib/redact.js';

/**
 * H18 - every documented `redactFreeText` pattern gets a direct pin, and
 * `redactTemplatedValue`, `redactUrlCredentials` and `redactConfigDump`
 * get direct unit tests (previously only indirect coverage via
 * `tests/config-disclosure.test.ts` driving the commands).
 *
 * All tokens below are synthetic shapes built to satisfy the documented
 * regexes - none is a real credential.
 */
describe('redactFreeText documented patterns (H18)', () => {
  test.each([
    ['GitHub OAuth token (gho_)', 'gho_abcdefghij123456'],
    ['GitHub fine-grained PAT (github_pat_)', 'github_pat_11ABCDEFGHijklmnop_0123456789abcd'],
    ['PyPI token (pypi-)', `pypi-${'a'.repeat(50)}`],
    ['AWS temporary credentials (ASIA)', 'ASIA1234567890ABCDEF'],
    ['Google OAuth token (ya29.)', `ya29.${'a'.repeat(20)}`],
    ['DigitalOcean token (dop_v1_)', `dop_v1_${'0123456789abcdef'.repeat(4)}`],
    ['SendGrid key (SG.)', `SG.${'A'.repeat(22)}`],
    ['Tailscale API key (tskey-api-)', `tskey-api-${'a'.repeat(30)}`],
    ['xAI key (xai-)', `xai-${'a'.repeat(32)}`],
    ['Discord MFA token (mfa.)', `mfa.${'a'.repeat(84)}`],
    ['Slack app token (xapp-)', `xapp-${'a'.repeat(20)}`],
    ['Telegram bot token', `123456789:${'A'.repeat(35)}`],
    [
      'JWT',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    ],
  ])('redacts %s', (_label, token) => {
    const out = redactFreeText(`leaked: ${token} end`);
    expect(out).not.toContain(token);
    expect(out).toContain(REDACTED);
    expect(out).toContain('leaked: ');
    expect(out).toContain(' end');
  });

  test.each([
    ['OPENSSH', 'OPENSSH'],
    ['EC', 'EC'],
    ['DSA', 'DSA'],
    ['ED25519', 'ED25519'],
    ['generic (no algorithm)', ''],
  ])('redacts %s PEM private key block', (_label, algo) => {
    const begin = `-----BEGIN ${algo ? `${algo} ` : ''}PRIVATE KEY-----`;
    const end = `-----END ${algo ? `${algo} ` : ''}PRIVATE KEY-----`;
    const block = `${begin}\nMIIEpAIBAAKCAQEA7b\n${end}`;
    const out = redactFreeText(`before\n${block}\nafter`);
    expect(out).not.toContain('MIIEpAIBAAKCAQEA7b');
    expect(out).not.toContain(begin);
    expect(out).toContain(REDACTED);
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  test('does not redact short lookalikes that fail the documented lengths', () => {
    // pypi- needs 50+ chars, xai- needs 32+, tskey-api- needs 30+.
    expect(redactFreeText('pypi-short')).toBe('pypi-short');
    expect(redactFreeText('xai-short')).toBe('xai-short');
    expect(redactFreeText('tskey-api-short')).toBe('tskey-api-short');
    expect(redactFreeText('ya29.short')).toBe('ya29.short');
  });
});

describe('redactTemplatedValue (H18)', () => {
  test('a plain literal value redacts wholesale', () => {
    expect(redactTemplatedValue('Bearer abc123')).toBe(REDACTED);
    expect(redactTemplatedValue('')).toBe(REDACTED);
  });

  test('a bare ${ENV_VAR} reference is preserved verbatim', () => {
    expect(redactTemplatedValue('${MY_TOKEN}')).toBe('${MY_TOKEN}');
  });

  test('literal runs around references redact, references stay', () => {
    expect(redactTemplatedValue('Bearer ${MY_TOKEN}')).toBe(`${REDACTED}\${MY_TOKEN}`);
    expect(redactTemplatedValue('prefix ${A} middle ${B} suffix')).toBe(
      `${REDACTED}\${A}${REDACTED}\${B}${REDACTED}`,
    );
  });

  test('only well-formed ${NAME} references are kept', () => {
    // `${}` and `${1BAD}` are not env references - the whole value redacts.
    expect(redactTemplatedValue('Bearer ${}')).toBe(REDACTED);
    expect(redactTemplatedValue('Bearer ${1BAD}')).toBe(REDACTED);
    // A `$VAR` without braces is not the templating form either.
    expect(redactTemplatedValue('Bearer $MY_TOKEN')).toBe(REDACTED);
  });
});

describe('redactUrlCredentials (H18)', () => {
  test('a URL without userinfo is returned byte-identical', () => {
    const url = 'https://example.com:8443/path?q=1';
    expect(redactUrlCredentials(url)).toBe(url);
  });

  test('user:pass userinfo is replaced by the placeholder', () => {
    expect(redactUrlCredentials('https://user:s3cr3t@example.com/path')).toBe(
      `https://${REDACTED}@example.com/path`,
    );
  });

  test('a user-only userinfo is replaced too', () => {
    expect(redactUrlCredentials('https://user@example.com/')).toBe(
      `https://${REDACTED}@example.com/`,
    );
  });

  test('a non-URL containing @ is returned unchanged', () => {
    expect(redactUrlCredentials('not a url user@host')).toBe('not a url user@host');
    expect(redactUrlCredentials('plain text, no at sign')).toBe('plain text, no at sign');
  });

  test('an @ in the query string without userinfo is untouched', () => {
    const url = 'https://example.com/path?email=a@b.com';
    expect(redactUrlCredentials(url)).toBe(url);
  });
});

describe('redactConfigDump (H18)', () => {
  test('name-keyed secrets still redact, then the shape pass tightens', () => {
    const out = redactConfigDump({
      __token__: 'live-token-value',
      apiUrl: 'https://user:s3cr3t@example.com',
      providers: [{ name: 'p', baseURL: 'https://k:sekrit@h.example/v1' }],
      mcpServers: [
        {
          url: 'https://admin:pw@mcp.example',
          headers: {
            Authorization: 'Bearer literal-value',
            'X-From-Env': 'Bearer ${MY_TOKEN}',
          },
          env: [{ name: 'KEY', value: 'env-literal-value' }],
        },
      ],
    }) as Record<string, unknown>;
    expect(out.__token__).toBe(REDACTED);
    expect(out.apiUrl).toBe(`https://${REDACTED}@example.com/`);
    const provider = (out.providers as Record<string, unknown>[])[0]!;
    expect(provider.baseURL).toBe(`https://${REDACTED}@h.example/v1`);
    const server = (out.mcpServers as Record<string, unknown>[])[0]!;
    expect(server.url).toBe(`https://${REDACTED}@mcp.example/`);
    const headers = server.headers as Record<string, unknown>;
    expect(headers.Authorization).toBe(REDACTED);
    // The env reference is preserved by design (see redactTemplatedValue).
    expect(headers['X-From-Env']).toBe(`${REDACTED}\${MY_TOKEN}`);
    const env = server.env as Record<string, unknown>[];
    expect(env[0]!.value).toBe(REDACTED);
  });

  test('non-secret values pass through and the input is not mutated', () => {
    const input = { defaultModel: 'styx', nested: { count: 3, tags: ['a', 'b'] } };
    const out = redactConfigDump(input) as typeof input;
    expect(out).toEqual(input);
    expect(out.nested).not.toBe(input.nested);
    expect(out).not.toBe(input);
  });

  test('non-object inputs pass through unchanged', () => {
    expect(redactConfigDump(null)).toBeNull();
    expect(redactConfigDump('plain')).toBe('plain');
    expect(redactConfigDump(['a'])).toEqual(['a']);
  });
});
