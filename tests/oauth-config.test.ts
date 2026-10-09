import { afterEach, describe, expect, test } from 'vitest';
import { googleOAuthConfig } from '../src/lib/oauth.js';

const ENV_KEY = 'SPYCORE_GOOGLE_CLIENT_ID';

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe('googleOAuthConfig', () => {
  test('throws a helpful error when the client id is not configured', () => {
    expect(() => googleOAuthConfig(8080)).toThrow('Google OAuth client ID not configured');
  });

  test('blank client ids count as missing', () => {
    process.env[ENV_KEY] = '   ';
    expect(() => googleOAuthConfig(8080)).toThrow('Google OAuth client ID not configured');
  });

  test('builds the OAuth config from the env client id', () => {
    process.env[ENV_KEY] = '  my-client-id  ';
    const cfg = googleOAuthConfig(9182);
    expect(cfg.clientId).toBe('my-client-id'); // trimmed
    expect(cfg.redirectPort).toBe(9182);
    expect(cfg.authUrl).toContain('accounts.google.com');
    expect(cfg.tokenUrl.length).toBeGreaterThan(0);
    expect(cfg.scopes.length).toBeGreaterThan(0);
  });
});
