import { describe, expect, test, beforeEach } from 'vitest';
import {
  recordByokUsage,
  getByokUsage,
  isFallbackEligibleError,
} from '../src/lib/byok-usage.js';
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

  test('does not flag user errors', () => {
    expect(isFallbackEligibleError(new Error('Invalid request format'))).toBe(false);
    expect(isFallbackEligibleError(null)).toBe(false);
    expect(isFallbackEligibleError(undefined)).toBe(false);
    expect(isFallbackEligibleError('string error')).toBe(false);
  });
});
