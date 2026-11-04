import { describe, expect, test } from 'vitest';
import {
  byokRoutingLine,
  BYOK_TYPE_DEFAULTS,
  isByokType,
  isLocalBaseURL,
  parseProviderKind,
  resolveByokConfig,
} from '../src/lib/providers/byok-config.js';

describe('isByokType', () => {
  test('the three adapter types, nothing else', () => {
    expect(isByokType('openai')).toBe(true);
    expect(isByokType('anthropic')).toBe(true);
    expect(isByokType('google')).toBe(true);
    expect(isByokType('spycore')).toBe(false);
    expect(isByokType('')).toBe(false);
    expect(isByokType('OpenAI')).toBe(false);
  });
});

describe('parseProviderKind', () => {
  test('defaults to spycore, accepts each kind case-insensitively-ish', () => {
    expect(parseProviderKind(undefined)).toBe('spycore');
    expect(parseProviderKind('')).toBe('spycore');
    expect(parseProviderKind('spycore')).toBe('spycore');
    expect(parseProviderKind('openai')).toBe('openai');
    expect(parseProviderKind(' anthropic ')).toBe('anthropic');
  });

  test('unknown providers are a clean user error', () => {
    expect(() => parseProviderKind('ollama')).toThrow('Unknown provider: ollama');
  });
});

describe('isLocalBaseURL', () => {
  test('loopback shapes count as local', () => {
    expect(isLocalBaseURL('http://localhost:11434')).toBe(true);
    expect(isLocalBaseURL('http://127.0.0.1:8080/v1')).toBe(true);
    expect(isLocalBaseURL('http://0.0.0.0:8000')).toBe(true);
    expect(isLocalBaseURL('http://mybox.local:11434')).toBe(true);
  });

  test('KNOWN GAP: IPv6 loopback is missed on Node 24 - URL keeps the brackets', () => {
    // The source comment claims `new URL('http://[::1]/').hostname` is '::1';
    // measured on this runtime it is '[::1]', so the '::1' check never fires.
    // Flagged for a fix; pinned here so the gap cannot be re-described away.
    expect(new URL('http://[::1]:11434').hostname).toBe('[::1]');
    expect(isLocalBaseURL('http://[::1]:11434')).toBe(false);
  });

  test('public hosts are not local', () => {
    expect(isLocalBaseURL('https://api.openai.com/v1')).toBe(false);
    expect(isLocalBaseURL('https://example.com')).toBe(false);
    expect(isLocalBaseURL('http://localhost.evil.com')).toBe(false);
  });

  test('unparseable input is not local', () => {
    expect(isLocalBaseURL('not a url')).toBe(false);
    expect(isLocalBaseURL('')).toBe(false);
  });
});

describe('byokRoutingLine', () => {
  test('names the model and adapter', () => {
    expect(byokRoutingLine('openai', 'gpt-4o', 'https://api.openai.com/v1')).toBe(
      'Model: gpt-4o (openai)',
    );
  });

  test('local endpoints get the local label', () => {
    expect(byokRoutingLine('openai', 'qwen3', 'http://localhost:11434/v1')).toBe(
      'Model: qwen3 (openai · local)',
    );
  });
});

describe('BYOK_TYPE_DEFAULTS', () => {
  test('each adapter has a base URL, key env var, and key requirement', () => {
    expect(BYOK_TYPE_DEFAULTS.openai.baseURL).toBe('https://api.openai.com/v1');
    expect(BYOK_TYPE_DEFAULTS.openai.apiKeyEnv).toBe('OPENAI_API_KEY');
    expect(BYOK_TYPE_DEFAULTS.openai.keyOptional).toBe(true);
    expect(BYOK_TYPE_DEFAULTS.anthropic.keyOptional).toBe(false);
    expect(BYOK_TYPE_DEFAULTS.google.keyOptional).toBe(false);
  });
});

describe('resolveByokConfig', () => {
  test('model is required for BYOK', () => {
    expect(() => resolveByokConfig({ model: undefined, baseUrl: undefined, apiKeyEnv: undefined, env: {} })).toThrow(
      '`--model <id>` is required',
    );
    expect(() => resolveByokConfig({ model: '   ', baseUrl: undefined, apiKeyEnv: undefined, env: {} })).toThrow(
      '`--model <id>` is required',
    );
  });

  test('openai works keyless against a local server', () => {
    const cfg = resolveByokConfig({
      model: 'qwen3',
      baseUrl: 'http://localhost:11434/v1/',
      apiKeyEnv: undefined,
      env: {},
    });
    expect(cfg).toMatchObject({
      type: 'openai',
      model: 'qwen3',
      baseURL: 'http://localhost:11434/v1', // trailing slash stripped
      apiKey: undefined,
    });
    expect(cfg.routingLine).toBe('Model: qwen3 (openai · local)');
  });

  test('key is read from the named env var', () => {
    const cfg = resolveByokConfig({
      type: 'anthropic',
      model: 'claude-x',
      baseUrl: undefined,
      apiKeyEnv: undefined,
      env: { ANTHROPIC_API_KEY: 'sk-test' },
    });
    expect(cfg.apiKey).toBe('sk-test');
    expect(cfg.baseURL).toBe('https://api.anthropic.com');
  });

  test('native cloud types require a key', () => {
    expect(() =>
      resolveByokConfig({ type: 'google', model: 'gemini-x', baseUrl: undefined, apiKeyEnv: undefined, env: {} }),
    ).toThrow('An API key is required for the google provider.');
  });

  test('a custom --api-key-env is honoured', () => {
    const cfg = resolveByokConfig({
      type: 'google',
      model: 'gemini-x',
      baseUrl: undefined,
      apiKeyEnv: 'MY_KEY',
      env: { MY_KEY: 'k' },
    });
    expect(cfg.apiKey).toBe('k');
  });

  test('blank env values count as missing', () => {
    expect(() =>
      resolveByokConfig({
        type: 'anthropic',
        model: 'claude-x',
        baseUrl: undefined,
        apiKeyEnv: undefined,
        env: { ANTHROPIC_API_KEY: '   ' },
      }),
    ).toThrow('An API key is required');
  });
});
