import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';

type MockBody = { json: () => Promise<unknown> };
type MockResp = { statusCode: number; body: MockBody; headers: Record<string, string | string[]> };
let nextResp: MockResp | (() => Promise<MockResp>) | Error | null = null;
let requestCalls = 0;

vi.mock('undici', () => ({
  request: vi.fn(async () => {
    requestCalls += 1;
    if (nextResp instanceof Error) throw nextResp;
    if (typeof nextResp === 'function') return await nextResp();
    if (!nextResp) throw new Error('test forgot to set nextResp');
    return nextResp;
  }),
}));

beforeEach(async () => {
  freshConfigDir();
  // Recreate the conf singleton so each test gets a clean cache dir.
  // (freshConfigDir only flips the env var; the singleton must be reset
  // for the new dir to take effect.)
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  nextResp = null;
  requestCalls = 0;
  delete process.env.SPYCORE_NO_UPDATE_CHECK;
  delete process.env.CI;
});

afterEach(() => {
  delete process.env.SPYCORE_NO_UPDATE_CHECK;
  delete process.env.CI;
});

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, body: { json: async () => body }, headers: {} };
}

describe('compareVersions', () => {
  test('orders patch/minor/major correctly', async () => {
    const { compareVersions } = await import('../src/lib/version-check.js');
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.10')).toBe(-1);
  });

  test('strips pre-release tags before comparison', async () => {
    const { compareVersions } = await import('../src/lib/version-check.js');
    // 0.2.0-beta.1 should compare as 0.2.0 — equal to a stable 0.2.0
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(0);
  });
});

describe('checkForUpdates', () => {
  test('returns hasUpdate=true when registry has a newer version', async () => {
    nextResp = jsonResp(200, { version: '0.2.0' });
    const { checkForUpdates } = await import('../src/lib/version-check.js');
    const result = await checkForUpdates({ currentVersion: '0.1.0' });
    expect(result).not.toBeNull();
    expect(result?.latest).toBe('0.2.0');
    expect(result?.hasUpdate).toBe(true);
  });

  test('returns hasUpdate=false when up-to-date', async () => {
    nextResp = jsonResp(200, { version: '0.1.0' });
    const { checkForUpdates } = await import('../src/lib/version-check.js');
    const result = await checkForUpdates({ currentVersion: '0.1.0' });
    expect(result?.hasUpdate).toBe(false);
  });

  test('cache hit on second call inside TTL', async () => {
    nextResp = jsonResp(200, { version: '0.5.0' });
    const { checkForUpdates } = await import('../src/lib/version-check.js');
    await checkForUpdates({ currentVersion: '0.1.0' });
    const callsAfterFirst = requestCalls;
    // Second call should hit cache, not the network
    await checkForUpdates({ currentVersion: '0.1.0' });
    expect(requestCalls).toBe(callsAfterFirst);
  });

  test('cache busts when TTL elapses', async () => {
    nextResp = jsonResp(200, { version: '0.5.0' });
    const { checkForUpdates } = await import('../src/lib/version-check.js');
    await checkForUpdates({ currentVersion: '0.1.0', cacheTtlMs: 1 });
    const callsAfterFirst = requestCalls;
    await new Promise((r) => setTimeout(r, 5));
    nextResp = jsonResp(200, { version: '0.6.0' });
    const result = await checkForUpdates({ currentVersion: '0.1.0', cacheTtlMs: 1 });
    expect(requestCalls).toBeGreaterThan(callsAfterFirst);
    expect(result?.latest).toBe('0.6.0');
  });

  test('honours SPYCORE_NO_UPDATE_CHECK env var', async () => {
    process.env.SPYCORE_NO_UPDATE_CHECK = '1';
    const { checkForUpdates } = await import('../src/lib/version-check.js');
    const result = await checkForUpdates({ currentVersion: '0.1.0' });
    expect(result).toBeNull();
    expect(requestCalls).toBe(0);
  });

  test('honours CI env var', async () => {
    process.env.CI = 'true';
    const { checkForUpdates } = await import('../src/lib/version-check.js');
    const result = await checkForUpdates({ currentVersion: '0.1.0' });
    expect(result).toBeNull();
    expect(requestCalls).toBe(0);
  });

  test('silent failure on network error', async () => {
    nextResp = new Error('ECONNREFUSED');
    const { checkForUpdates } = await import('../src/lib/version-check.js');
    const result = await checkForUpdates({ currentVersion: '0.1.0' });
    expect(result).toBeNull();
  });

  test('silent failure on non-2xx response', async () => {
    nextResp = jsonResp(500, { error: 'oops' });
    const { checkForUpdates } = await import('../src/lib/version-check.js');
    const result = await checkForUpdates({ currentVersion: '0.1.0' });
    expect(result).toBeNull();
  });

  test('silent failure on malformed response', async () => {
    nextResp = jsonResp(200, { not_a_version: true });
    const { checkForUpdates } = await import('../src/lib/version-check.js');
    const result = await checkForUpdates({ currentVersion: '0.1.0' });
    expect(result).toBeNull();
  });
});

describe('detectInstallMethod', () => {
  test('detects Homebrew install paths', async () => {
    const { detectInstallMethod } = await import('../src/lib/version-check.js');
    expect(detectInstallMethod('/opt/homebrew/bin/node')).toBe('homebrew');
    expect(detectInstallMethod('/usr/local/Cellar/node/20.0.0/bin/node')).toBe(
      'homebrew',
    );
  });

  test('detects Scoop install paths', async () => {
    const { detectInstallMethod } = await import('../src/lib/version-check.js');
    expect(
      detectInstallMethod('C:\\Users\\me\\scoop\\apps\\nodejs\\current\\node.exe'),
    ).toBe('scoop');
  });

  test('detects npm install paths', async () => {
    const { detectInstallMethod } = await import('../src/lib/version-check.js');
    expect(detectInstallMethod('/home/me/.nvm/versions/node/v20/bin/node')).toBe(
      'npm',
    );
    expect(
      detectInstallMethod('C:\\Users\\me\\AppData\\Roaming\\npm\\node.exe'),
    ).toBe('npm');
  });

  test('falls back to standalone for unrecognised paths', async () => {
    const { detectInstallMethod } = await import('../src/lib/version-check.js');
    expect(detectInstallMethod('/some/random/path/spycore')).toBe('standalone');
  });
});

describe('updateCommandFor', () => {
  test('returns the right command per install method', async () => {
    const { updateCommandFor } = await import('../src/lib/version-check.js');
    expect(updateCommandFor('homebrew')).toContain('brew upgrade');
    expect(updateCommandFor('scoop')).toContain('scoop update');
    expect(updateCommandFor('npm')).toContain('npm install -g');
    expect(updateCommandFor('standalone')).toContain('install.sh');
  });
});
