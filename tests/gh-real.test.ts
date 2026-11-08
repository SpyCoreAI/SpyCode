import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { buildCmdCommandLine, buildGhSpawn, ghAuthed, ghAvailable, ghPrCreate, resolveGhCommand } from '../src/lib/gh.js';

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

describe('resolveGhCommand (injected win32, runs on Linux)', () => {
  const PATHEXT = '.COM;.EXE;.BAT;.CMD';
  const dirs: string[] = [];

  // Files are planted with UPPERCASE extensions: the resolver walks PATHEXT
  // as given (uppercase, as Windows reports it), and this Linux filesystem
  // is case-sensitive - a lowercase gh.cmd would never match gh.CMD here.
  // On Windows the same lookup succeeds because NTFS is case-insensitive;
  // the walk order (dir-major, PATHEXT order) is what this pins.
  function fakeBin(files: string[]): string {
    const d = mkdtempSync(join(tmpdir(), 'spycode-gh-resolve-'));
    dirs.push(d);
    for (const f of files) {
      writeFileSync(join(d, f), '');
      chmodSync(join(d, f), 0o755);
    }
    return d;
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('dir-major walk: a .cmd in the first dir beats an .exe later on PATH', () => {
    const first = fakeBin(['gh.CMD']);
    const second = fakeBin(['gh.EXE']);
    expect(resolveGhCommand({ platform: 'win32', pathEnv: `${first};${second}`, pathext: PATHEXT })).toBe(
      join(first, 'gh.CMD'),
    );
  });

  test('extension order within a dir: .exe beats .cmd', () => {
    const d = fakeBin(['gh.CMD', 'gh.EXE']);
    expect(resolveGhCommand({ platform: 'win32', pathEnv: d, pathext: PATHEXT })).toBe(join(d, 'gh.EXE'));
  });

  test('null when no gh of any form is on PATH', () => {
    const d = fakeBin(['not-gh.cmd']);
    expect(resolveGhCommand({ platform: 'win32', pathEnv: d, pathext: PATHEXT })).toBeNull();
    expect(resolveGhCommand({ platform: 'win32', pathEnv: '', pathext: PATHEXT })).toBeNull();
  });

  test('posix returns the bare name regardless of PATH', () => {
    expect(resolveGhCommand({ platform: 'linux' })).toBe('gh');
    expect(resolveGhCommand({ platform: 'darwin' })).toBe('gh');
  });
});

describe('buildCmdCommandLine (cmd.exe quoting)', () => {
  test('spaces are quoted, plain tokens stay bare of escapes', () => {
    expect(
      buildCmdCommandLine([
        'C:\\Temp\\gh.CMD',
        'pr',
        'create',
        '--title',
        'Test PR',
        '--body-file',
        'C:\\Temp\\body.md',
      ]),
    ).toBe('"C:\\Temp\\gh.CMD" "pr" "create" "--title" "Test PR" "--body-file" "C:\\Temp\\body.md"');
  });

  test('a quote becomes \\", % and ^ get the cmd.exe escape', () => {
    expect(buildCmdCommandLine(['a"b'])).toBe('"a\\"b"');
    expect(buildCmdCommandLine(['100% ^x'])).toBe('"100^% ^^x"');
  });

  test('a trailing backslash doubles so it cannot swallow the closing quote', () => {
    expect(buildCmdCommandLine(['C:\\dir\\'])).toBe('"C:\\dir\\\\"');
  });

  test('backslashes before a quote double (MSVC argv rules)', () => {
    // Token: a + two backslashes + quote + b. The quoted form carries five
    // backslashes before the quote, which MSVC reads as two literal
    // backslashes plus a literal quote.
    expect(buildCmdCommandLine(['a\\\\"b'])).toBe(`"a${'\\'.repeat(5)}"b"`);
  });
});

describe('buildGhSpawn (injected win32, runs on Linux)', () => {
  // The `/c` argument as cmd.exe /s sees it: strip the first character
  // if it is a quote, and remove the last quote character on the line
  // (Microsoft cmd docs: /s "strip[s] the first and last quotes around
  // the <string> but leaves the rest of the command unchanged"). Only
  // the quote-stripping half is modelled here - not cmd.exe itself.
  function applyCmdSlashS(cArg: string): string {
    let s = cArg;
    if (s.startsWith('"')) s = s.slice(1);
    const last = s.lastIndexOf('"');
    if (last >= 0) s = s.slice(0, last) + s.slice(last + 1);
    return s;
  }

  // What Node's default argv quoting does to one argument: wrap in
  // quotes, escaping each inner `"` as `\"`. Used only to pin the
  // pre-3f failure shape - the quoting that produced the 42501464919
  // error.
  function nodeWin32QuoteArg(arg: string): string {
    return `"${arg.replace(/(\\*)"/g, (_m, slashes: string) => `${slashes}${slashes}\\"`)}"`;
  }

  test('a .cmd on win32 goes through cmd.exe, double-wrapped and verbatim', () => {
    const t = buildGhSpawn('C:\\Temp\\gh.CMD', ['--version'], 'win32');
    // The file is the system command interpreter, not the bare name:
    // Node docs make `process.env.ComSpec` the default shell on Windows
    // (the `shell` option defaults to it), and Windows always sets it to
    // the absolute path (`C:\Windows\system32\cmd.exe`) - which is what
    // branch CI run 42507192367 returned. The bare 'cmd.exe' is only the
    // fallback when ComSpec is unset, i.e. the Linux-only shape this test
    // used to pin by accident. The absolute path is also the safer spawn
    // target: it needs no PATH lookup, so no earlier `cmd.exe` on PATH
    // can shadow it. Production code is unchanged; the expectation now
    // states the rule instead of the fallback spelling.
    expect(t.file).toBe(process.env.ComSpec ?? 'cmd.exe');
    expect(t.argv).toEqual(['/d', '/s', '/c', '""C:\\Temp\\gh.CMD" "--version""']);
    expect(t.windowsVerbatimArguments).toBe(true);
  });

  test('the double wrap survives cmd.exe /s: the strip yields the built command line', () => {
    const tokens = [
      'C:\\Temp\\gh.CMD',
      'pr',
      'create',
      '--title',
      'Test PR',
      '--body-file',
      'C:\\Temp\\body.md',
    ];
    const t = buildGhSpawn(tokens[0] as string, tokens.slice(1), 'win32');
    expect(applyCmdSlashS(t.argv[3] as string)).toBe(buildCmdCommandLine(tokens));
  });

  test('the pre-3f single-wrapped form is what cmd.exe rejected', () => {
    // 3e passed buildCmdCommandLine(...) as a plain argv element; Node
    // quoted it, and /s stripped only the outer pair. The command name
    // cmd.exe then tried is exactly the one in the CI error:
    // '\"C:\...\gh.CMD\"' is not recognized as an internal or external command
    const inner = buildCmdCommandLine(['C:\\Temp\\gh.CMD', '--version']);
    const stripped = applyCmdSlashS(nodeWin32QuoteArg(inner));
    expect(stripped.split(' ')[0]).toBe('\\"C:\\Temp\\gh.CMD\\"');
    expect(stripped).not.toContain('"C:\\Temp\\gh.CMD"');
  });

  test('a .exe on win32 spawns directly, verbatim off', () => {
    expect(buildGhSpawn('C:\\Temp\\gh.EXE', ['--version'], 'win32')).toEqual({
      file: 'C:\\Temp\\gh.EXE',
      argv: ['--version'],
      windowsVerbatimArguments: false,
    });
  });

  test('posix spawns the bare name directly', () => {
    expect(buildGhSpawn('gh', ['--version'], 'linux')).toEqual({
      file: 'gh',
      argv: ['--version'],
      windowsVerbatimArguments: false,
    });
    expect(buildGhSpawn('gh', ['--version'], 'darwin')).toEqual({
      file: 'gh',
      argv: ['--version'],
      windowsVerbatimArguments: false,
    });
  });
});
