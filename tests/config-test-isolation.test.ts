/**
 * C2 regression: the suite must never write into the developer's REAL config
 * dir. `trustWorkspace()` routes through `getConfigStore()`, which builds its
 * singleton against `SPYCORE_TEST_CWD` when set - so every suite that trusts
 * a workspace must set the hook first (`freshConfigDir()`) and reset the
 * singleton, or the write lands in `~/.config/spycore` (or the OS
 * equivalent). That is what happened at five call sites before this fix.
 */
import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshConfigDir } from './helpers.js';
import {
  __resetConfigForTests,
  getConfigPath,
  trustWorkspace,
} from '../src/lib/config.js';

/**
 * Where Conf would put the real config when neither the test hook nor the
 * user override is set - the same resolution `getConfigStore()` falls back
 * to (`env-paths` layout for project `spycore`).
 */
function realConfigPath(): string {
  const override = process.env.SPYCORE_CONFIG_DIR;
  if (override && override.length > 0) return join(override, 'config.json');
  const home = homedir();
  if (platform() === 'win32') {
    const base =
      process.env.APPDATA && process.env.APPDATA.length > 0
        ? process.env.APPDATA
        : join(home, 'AppData', 'Roaming');
    return join(base, 'spycore', 'config.json');
  }
  if (platform() === 'darwin') {
    return join(home, 'Library', 'Application Support', 'spycore', 'config.json');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(home, '.config');
  return join(base, 'spycore', 'config.json');
}

describe('the suite never touches the real config dir', () => {
  test('trustWorkspace with the test hook writes only to the fresh tmpdir', () => {
    const real = realConfigPath();
    const before = existsSync(real) ? readFileSync(real) : null;
    const beforeMtime = existsSync(real) ? statSync(real).mtimeMs : null;
    const prevHook = process.env.SPYCORE_TEST_CWD;
    try {
      const dir = freshConfigDir();
      __resetConfigForTests();
      trustWorkspace(join(tmpdir(), 'spycli-c2-probe-ws'));

      // The write landed in the fresh dir, not the real one.
      expect(getConfigPath().startsWith(dir)).toBe(true);
      expect(existsSync(join(dir, 'config.json'))).toBe(true);

      // And the real config file is byte-identical and untouched.
      if (before === null) {
        expect(existsSync(real)).toBe(false);
      } else {
        expect(readFileSync(real)).toEqual(before);
        expect(statSync(real).mtimeMs).toBe(beforeMtime);
      }
    } finally {
      if (prevHook === undefined) delete process.env.SPYCORE_TEST_CWD;
      else process.env.SPYCORE_TEST_CWD = prevHook;
      __resetConfigForTests();
    }
  });

  test('every suite that calls trustWorkspace sets the test hook', () => {
    // Structural net for future call sites: a trustWorkspace call in a file
    // that never sets SPYCORE_TEST_CWD writes to the real config dir on
    // every local run. `freshConfigDir()` is the established hook; a file
    // that sets SPYCORE_TEST_CWD directly counts too.
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.test.ts')) continue;
      const text = readFileSync(join(dir, file), 'utf8');
      if (!text.includes('trustWorkspace(')) continue;
      if (text.includes('freshConfigDir') || text.includes('SPYCORE_TEST_CWD')) continue;
      offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
