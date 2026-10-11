/**
 * H-16 - one env builder for every spawn: secret-keyed entries never reach a
 * child process; explicit per-spawn vars are layered on top and win.
 */
import { describe, expect, test, vi, afterEach } from 'vitest';
import { buildSubprocessEnv } from '../src/lib/spawn-env.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('H-16 buildSubprocessEnv', () => {
  test('strips secret-keyed entries but keeps the rest', () => {
    vi.stubEnv('SPYCORE_TOKEN', 'tok-123');
    vi.stubEnv('GITHUB_TOKEN', 'ghp-abc');
    vi.stubEnv('MY_PASSWORD', 'hunter2');
    vi.stubEnv('PATH', '/usr/bin:/bin');
    vi.stubEnv('HOME', '/home/user');
    const env = buildSubprocessEnv();
    expect(env['SPYCORE_TOKEN']).toBeUndefined();
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    expect(env['MY_PASSWORD']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin:/bin');
    expect(env['HOME']).toBe('/home/user');
  });

  test('explicit vars win over the stripped base', () => {
    vi.stubEnv('SPYCORE_TOKEN', 'tok-123');
    vi.stubEnv('PATH', '/usr/bin');
    const env = buildSubprocessEnv({ SPYCORE_TOKEN: 'per-server-token', EXTRA: 'yes' });
    // Deliberate per-server configuration survives - it was explicit, not ambient.
    expect(env['SPYCORE_TOKEN']).toBe('per-server-token');
    expect(env['EXTRA']).toBe('yes');
    expect(env['PATH']).toBe('/usr/bin');
  });

  test('explicit undefined removes a key', () => {
    vi.stubEnv('PATH', '/usr/bin');
    const env = buildSubprocessEnv({ PATH: undefined });
    expect('PATH' in env).toBe(false);
  });

  test('never mutates process.env', () => {
    vi.stubEnv('SPYCORE_TOKEN', 'tok-123');
    buildSubprocessEnv({ SPYCORE_TOKEN: 'other' });
    expect(process.env['SPYCORE_TOKEN']).toBe('tok-123');
  });
});
