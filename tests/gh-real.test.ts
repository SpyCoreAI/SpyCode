import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { ghAuthed, ghAvailable, ghPrCreate } from '../src/lib/gh.js';

/**
 * H13 - the real `src/lib/gh.ts` runs here, against a fake `gh` binary on
 * PATH. Previously the only coverage mocked the module itself
 * (`tests/git-commands.test.ts`), so a wrong flag, a mis-parsed error or a
 * mishandled auth failure stayed invisible.
 *
 * The fake records every argv it receives (GH_FAKE_LOG) and its behaviour
 * is steered by GH_FAKE_MODE: `ok` (default), `auth-fail`, `pr-fail`
 * (stderr + exit 1), `pr-fail-empty` (exit 1, no stderr).
 */
const FAKE_MJS = `
import { appendFileSync } from 'node:fs';
const log = process.env.GH_FAKE_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + '\\n');
const mode = process.env.GH_FAKE_MODE ?? 'ok';
const [cmd, sub] = process.argv.slice(2);
if (cmd === '--version') { console.log('gh version 2.74.0'); process.exit(0); }
if (cmd === 'auth' && sub === 'status') {
  if (mode === 'auth-fail') { console.error('Failed to log into github.com'); process.exit(1); }
  console.log('Logged in to github.com'); process.exit(0);
}
if (cmd === 'pr' && sub === 'create') {
  if (mode === 'pr-fail') { console.error('gh: pull request creation failed: bad base'); process.exit(1); }
  if (mode === 'pr-fail-empty') { process.exit(1); }
  console.log('https://github.com/SpyCoreAI/SpyCode/pull/99');
  process.exit(0);
}
console.error('unexpected gh call: ' + process.argv.slice(2).join(' '));
process.exit(2);
`;

let binDir: string;
let logFile: string;
let bodyFile: string;
let origPath: string | undefined;
let origMode: string | undefined;
let origLog: string | undefined;

function readLog(): string[][] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'spycode-fake-gh-'));
  logFile = join(binDir, 'calls.log');
  bodyFile = join(binDir, 'body.md');
  writeFileSync(bodyFile, '# test body\n');
  writeFileSync(join(binDir, 'gh-fake.mjs'), FAKE_MJS);
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'gh.cmd'), '@echo off\r\nnode "%~dp0gh-fake.mjs" %*\r\n');
  } else {
    writeFileSync(join(binDir, 'gh'), '#!/bin/sh\nexec node "$(dirname "$0")/gh-fake.mjs" "$@"\n');
    chmodSync(join(binDir, 'gh'), 0o755);
  }
  origPath = process.env.PATH;
  origMode = process.env.GH_FAKE_MODE;
  origLog = process.env.GH_FAKE_LOG;
  process.env.PATH = `${binDir}${delimiter}${origPath ?? ''}`;
  process.env.GH_FAKE_LOG = logFile;
  delete process.env.GH_FAKE_MODE;
});

afterEach(() => {
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
  if (origMode === undefined) delete process.env.GH_FAKE_MODE;
  else process.env.GH_FAKE_MODE = origMode;
  if (origLog === undefined) delete process.env.GH_FAKE_LOG;
  else process.env.GH_FAKE_LOG = origLog;
  rmSync(binDir, { recursive: true, force: true });
});

describe('gh (real module, fake binary)', () => {
  test('ghAvailable is true when a gh binary answers --version', () => {
    expect(ghAvailable()).toBe(true);
    expect(readLog()).toEqual([['--version']]);
  });

  test('ghAvailable is false when no gh binary is on PATH', () => {
    process.env.PATH = binDir; // only the fake dir - but remove the fake itself
    rmSync(join(binDir, process.platform === 'win32' ? 'gh.cmd' : 'gh'));
    // `node` is still needed by nothing here: ghAvailable only spawns `gh`.
    expect(ghAvailable()).toBe(false);
  });

  test('ghAuthed is true when `gh auth status` succeeds', () => {
    expect(ghAuthed()).toBe(true);
    expect(readLog()).toEqual([['auth', 'status']]);
  });

  test('ghAuthed is false when `gh auth status` fails', () => {
    process.env.GH_FAKE_MODE = 'auth-fail';
    expect(ghAuthed()).toBe(false);
  });

  test('ghPrCreate builds the full argument list and returns the PR URL', () => {
    const url = ghPrCreate({
      cwd: binDir,
      title: 'Test PR',
      bodyFile,
      base: 'main',
      draft: true,
    });
    expect(url).toBe('https://github.com/SpyCoreAI/SpyCode/pull/99');
    expect(readLog()).toEqual([
      ['pr', 'create', '--title', 'Test PR', '--body-file', bodyFile, '--base', 'main', '--draft'],
    ]);
  });

  test('ghPrCreate omits --base and --draft when unset', () => {
    const url = ghPrCreate({ cwd: binDir, title: 'T', bodyFile });
    expect(url).toBe('https://github.com/SpyCoreAI/SpyCode/pull/99');
    expect(readLog()).toEqual([['pr', 'create', '--title', 'T', '--body-file', bodyFile]]);
  });

  test('ghPrCreate surfaces gh stderr verbatim on failure', () => {
    process.env.GH_FAKE_MODE = 'pr-fail';
    expect(() => ghPrCreate({ cwd: binDir, title: 'T', bodyFile })).toThrow(
      'gh: pull request creation failed: bad base',
    );
  });

  test('ghPrCreate falls back to the spawn error message with empty stderr', () => {
    process.env.GH_FAKE_MODE = 'pr-fail-empty';
    expect(() => ghPrCreate({ cwd: binDir, title: 'T', bodyFile })).toThrow(/Command failed/);
  });
});
