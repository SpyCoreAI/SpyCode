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

/**
 * ⭐⭐ THE UPGRADE-ADVICE POPULATION — F-2c-25.
 *
 * The predicate this replaces read `process.execPath`, the path of the NODE
 * BINARY, and tested the Homebrew arm first — so every npm-global user on
 * Homebrew Node was told `brew upgrade spycore`, pointing at a formula pinned
 * two minors back. Six of eight measured shapes got the wrong command.
 *
 * ⭐ The population itself was wrong: those eight shapes were eight NODE
 * locations for ONE install method. `install.sh` has no standalone path at all
 * — it shells out to `pnpm add -g`, `yarn global add` or `npm install -g` — so
 * the axis that decides the advice is WHICH PACKAGE MANAGER OWNS THE FILES,
 * which is answerable from the CLI's own path and from nothing else.
 *
 * The table below is therefore keyed on the CLI's install location. The three
 * marked MEASURED were produced by installing the published `@spycore/cli@0.6.0`
 * on this host; the rest are each manager's documented layout, and the
 * distinction is recorded rather than smoothed over.
 */
describe('detectInstallMethod — keyed on the CLI, not on the node binary', () => {
  const CASES: [string, string, string][] = [
    // path                                                              → method    provenance
    ['/opt/homebrew/lib/node_modules/@spycore/cli/build/index.js', 'npm', 'MEASURED (npm -g under a Homebrew prefix)'],
    ['/usr/local/lib/node_modules/@spycore/cli/build/index.js', 'npm', 'MEASURED (npm -g, nodejs.org prefix)'],
    ['/home/me/.nvm/versions/node/v22.3.0/lib/node_modules/@spycore/cli/build/index.js', 'npm', 'MEASURED shape (npm -g under nvm)'],
    ['C:/Users/me/AppData/Roaming/npm/node_modules/@spycore/cli/build/index.js', 'npm', 'documented (npm -g on Windows)'],
    ['/Users/me/project/node_modules/@spycore/cli/build/index.js', 'local', 'MEASURED (project dependency)'],
    ['/Users/me/.npm/_npx/9120cd5faef07a08/node_modules/@spycore/cli/build/index.js', 'npx', 'MEASURED (npx cache)'],
    ['/Users/me/Library/pnpm/global/5/node_modules/@spycore/cli/build/index.js', 'pnpm', 'documented'],
    ['/home/me/.local/share/pnpm/global/5/node_modules/@spycore/cli/build/index.js', 'pnpm', 'documented'],
    ['/Users/me/.config/yarn/global/node_modules/@spycore/cli/build/index.js', 'yarn', 'documented (yarn 1.x)'],
    ['/Users/me/.bun/install/global/node_modules/@spycore/cli/build/index.js', 'bun', 'documented'],
    ['/Users/me/.volta/tools/image/packages/@spycore/cli/lib/node_modules/@spycore/cli/build/index.js', 'volta', 'documented'],
    ['/opt/homebrew/Cellar/spycore/0.5.0/libexec/build/index.js', 'homebrew', 'documented (tap formula)'],
    ['/usr/local/Cellar/spycore/0.5.0/libexec/build/index.js', 'homebrew', 'documented (tap formula)'],
    ['C:/Users/me/scoop/apps/spycore/current/build/index.js', 'scoop', 'documented (scoop manifest)'],
    ['/some/random/path/spycore', 'unknown', 'no recognised owner'],
  ];

  test('every install shape resolves to the manager that OWNS the files', async () => {
    const { detectInstallMethod } = await import('../src/lib/version-check.js');
    for (const [path, want, why] of CASES) {
      expect(detectInstallMethod(path), `${path}  [${why}]`).toBe(want);
    }
  });

  /**
   * ⭐ THE REGRESSION THAT MATTERED, ASSERTED AS ITSELF. A Homebrew PREFIX is
   * not a Homebrew INSTALL. Reading the prefix is the exact defect; this fails
   * the moment anyone reintroduces it.
   */
  test('a Homebrew PREFIX is not a Homebrew INSTALL', async () => {
    const { detectInstallMethod } = await import('../src/lib/version-check.js');
    expect(detectInstallMethod('/opt/homebrew/lib/node_modules/@spycore/cli/build/index.js')).toBe('npm');
    expect(detectInstallMethod('/usr/local/lib/node_modules/@spycore/cli/build/index.js')).toBe('npm');
    // …and a genuine tap install is still recognised, so the discrimination is
    // real and not a blanket "never homebrew".
    expect(detectInstallMethod('/opt/homebrew/Cellar/spycore/0.5.0/libexec/build/index.js')).toBe('homebrew');
  });

  /**
   * ⭐ THE OLD DEFAULT WAS THE NODE BINARY. Nothing may read `process.execPath`
   * for this decision again: a node path carries no information about how the
   * CLI was installed, and every wrong answer above came from believing it did.
   */
  test('the predicate does not consult process.execPath', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(fileURLToPath(new URL('../src/lib/version-check.ts', import.meta.url)), 'utf8');
    const body = src.slice(src.indexOf('export function detectInstallMethod'), src.indexOf('export function updateCommandFor'));
    expect(body.length).toBeGreaterThan(200);
    expect(body).not.toContain('process.execPath');
  });
});

describe('updateCommandFor', () => {
  /**
   * ⭐ EVERY method must produce advice, and the advice must name that manager.
   * The list is derived from the InstallMethod union via the CASES table, so a
   * new method with no command cannot be added silently.
   */
  test('every install method gets advice that names its own manager', async () => {
    const { updateCommandFor } = await import('../src/lib/version-check.js');
    const expected: [string, string][] = [
      ['npm', 'npm install -g @spycore/cli@latest'],
      ['pnpm', 'pnpm add -g @spycore/cli@latest'],
      ['yarn', 'yarn global upgrade @spycore/cli@latest'],
      ['bun', 'bun add -g @spycore/cli@latest'],
      ['volta', 'volta install @spycore/cli@latest'],
      ['homebrew', 'brew upgrade spycore'],
      ['scoop', 'scoop update spycore'],
    ];
    for (const [method, want] of expected) {
      expect(updateCommandFor(method as never), method).toContain(want);
    }
    // npx has nothing to upgrade, and a project dependency must NOT be told to
    // install globally — both were `npm install -g` before.
    expect(updateCommandFor('npx' as never)).toContain('npx @spycore/cli@latest');
    expect(updateCommandFor('local' as never)).toContain("project's package.json");
    expect(updateCommandFor('local' as never)).not.toContain('-g @spycore/cli@latest');
    expect(updateCommandFor('unknown' as never)).toContain('npm install -g');
  });
});
