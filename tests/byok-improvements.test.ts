import { describe, expect, test, beforeEach } from 'vitest';
import {
  recordByokUsage,
  getByokUsage,
  isFallbackEligibleError,
} from '../src/lib/byok-usage.js';
import { connectionErrorMessage } from '../src/lib/providers/wire.js';
import { __resetConfigForTests } from '../src/lib/config.js';

describe('B2: BYOK usage tracking', () => {
  beforeEach(() => {
    process.env.SPYCORE_TEST_CWD = `/tmp/byok-usage-test-${Date.now()}-${Math.random()}`;
    __resetConfigForTests();
  });

  test('recordByokUsage accumulates calls and tokens', () => {
    recordByokUsage('my-provider', 100, 50);
    recordByokUsage('my-provider', 200, 75);
    const usage = getByokUsage();
    expect(usage['my-provider']?.calls).toBe(2);
    expect(usage['my-provider']?.inputTokens).toBe(300);
    expect(usage['my-provider']?.outputTokens).toBe(125);
    expect(usage['my-provider']?.lastUsed).toBeDefined();
  });

  test('recordByokUsage tracks multiple providers separately', () => {
    recordByokUsage('provider-a', 100, 50);
    recordByokUsage('provider-b', 200, 100);
    const usage = getByokUsage();
    expect(usage['provider-a']?.calls).toBe(1);
    expect(usage['provider-b']?.calls).toBe(1);
  });

  test('getByokUsage returns empty object when no usage', () => {
    const usage = getByokUsage();
    expect(usage).toEqual({});
  });

  test('recordByokUsage never throws', () => {
    // Even with invalid inputs, should not throw
    expect(() => recordByokUsage('', -1, -1)).not.toThrow();
  });
});

describe('B4: fallback error detection', () => {
  test('detects 401/403 auth errors', () => {
    expect(isFallbackEligibleError({ code: 401 })).toBe(true);
    expect(isFallbackEligibleError({ code: 403 })).toBe(true);
    expect(isFallbackEligibleError(new Error('401 Unauthorized'))).toBe(true);
    expect(isFallbackEligibleError(new Error('Invalid API key'))).toBe(true);
  });

  test('detects rate limit errors', () => {
    expect(isFallbackEligibleError({ code: 429 })).toBe(true);
    expect(isFallbackEligibleError(new Error('Rate limit exceeded'))).toBe(true);
  });

  test('detects the probe timeout wording ("timed out" has no "timeout" in it)', () => {
    expect(isFallbackEligibleError(new Error('BYOK provider probe timed out after 15s'))).toBe(true);
    expect(isFallbackEligibleError(new Error('request timed out'))).toBe(true);
  });

  test('detects network errors', () => {
    expect(isFallbackEligibleError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isFallbackEligibleError(new Error('ENOTFOUND'))).toBe(true);
    expect(isFallbackEligibleError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isFallbackEligibleError(new Error('Network error'))).toBe(true);
  });

  test('detects server errors', () => {
    expect(isFallbackEligibleError({ code: 502 })).toBe(true);
    expect(isFallbackEligibleError({ code: 503 })).toBe(true);
  });

  test('detects the REAL adapter strings: connectionErrorMessage prose + HTTP 5xx (R2 M1)', () => {
    // The matcher used to look for the errno spellings `econnrefused` /
    // `enotfound`, but connectionErrorMessage rewrites those into prose
    // that never contains them - so the two most common down-endpoint
    // cases hard-failed instead of falling back. Feed the real strings.
    const refused = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(
      isFallbackEligibleError(
        new Error(connectionErrorMessage(refused, 'http://127.0.0.1:11434/v1/chat/completions')),
      ),
    ).toBe(true);
    const dns = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    expect(
      isFallbackEligibleError(
        new Error(connectionErrorMessage(dns, 'https://nope.invalid/v1/chat/completions')),
      ),
    ).toBe(true);
    // Probe failures arrive as plain Errors carrying the adapter string.
    expect(isFallbackEligibleError(new Error('Model endpoint returned HTTP 500.'))).toBe(true);
    expect(isFallbackEligibleError(new Error('Model endpoint returned HTTP 502.'))).toBe(true);
    expect(isFallbackEligibleError(new Error('Model endpoint returned HTTP 503.'))).toBe(true);
    expect(isFallbackEligibleError(new Error('Model endpoint returned HTTP 504.'))).toBe(true);
    // A revoked Google refresh token surfaces as invalid_grant.
    expect(
      isFallbackEligibleError(
        new Error(
          'Google OAuth token refresh failed: Token refresh failed (400): {"error":"invalid_grant"}',
        ),
      ),
    ).toBe(true);
    // Control: a 400 is a user error, not a down endpoint.
    expect(isFallbackEligibleError(new Error('Model endpoint returned HTTP 400.'))).toBe(false);
  });

  test('does not flag user errors', () => {
    expect(isFallbackEligibleError(new Error('Invalid request format'))).toBe(false);
    expect(isFallbackEligibleError(null)).toBe(false);
    expect(isFallbackEligibleError(undefined)).toBe(false);
    expect(isFallbackEligibleError('string error')).toBe(false);
  });
});

describe('B2b: BYOK usage file validation (4c)', () => {
  beforeEach(() => {
    process.env.SPYCORE_TEST_CWD = `/tmp/byok-usage-test-${Date.now()}-${Math.random()}`;
    __resetConfigForTests();
  });

  test('corrupt stored entries cannot poison sums (string calls / NaN tokens)', async () => {
    const { getConfigPath } = await import('../src/lib/config.js');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const file = join(dirname(getConfigPath()), 'byok-usage.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        'my-provider': { calls: '3', inputTokens: '100', outputTokens: null, lastUsed: 42 },
        'junk': 'not-an-entry',
      }),
      'utf-8',
    );
    // Recording one more call must add numerically, not concatenate.
    recordByokUsage('my-provider', 10, 5);
    const usage = getByokUsage();
    expect(usage['my-provider']?.calls).toBe(1);
    expect(usage['my-provider']?.inputTokens).toBe(10);
    expect(usage['my-provider']?.outputTokens).toBe(5);
    expect(usage['junk']).toBeUndefined();
  });

  test('NaN/Infinity token counts from a broken provider event are ignored, not summed', () => {
    recordByokUsage('my-provider', Number.NaN, Number.POSITIVE_INFINITY);
    const usage = getByokUsage();
    expect(usage['my-provider']?.calls).toBe(1);
    expect(usage['my-provider']?.inputTokens).toBe(0);
    expect(usage['my-provider']?.outputTokens).toBe(0);
    expect(Number.isNaN(usage['my-provider']?.inputTokens ?? 0)).toBe(false);
  });
});
