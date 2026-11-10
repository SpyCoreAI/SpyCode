import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LIMITS,
  describeCallArg,
  dispatchTool,
  matchesCatastrophic,
  type ToolContext,
} from '../src/lib/agent/tools.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';
import { wrapMcpToolResult } from '../src/lib/agent/mcp.js';
import { MAX_RESULT_CHARS } from '../src/lib/agent/tool-core.js';
import { clampToWireMax } from '../src/lib/wire-limits.js';
import { clampComposerState, COMPOSER_MAX_CHARS } from '../src/ui/tui/editing.js';
import { matchExcerpt } from '../src/ui/tui/transcript-search.js';
import { runShellCommand } from '../src/ui/tui/shell.js';
import { snapshotWorkspace } from '../src/lib/agent/workspace-delta.js';

const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });

/** True when `s` carries a high surrogate without its low half (or vice versa). */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) {
      const p = s.charCodeAt(i - 1);
      if (!(p >= 0xd800 && p <= 0xdbff)) return true;
    }
  }
  return false;
}

describe('R1 pass 3 - process substitution bypasses the catastrophic screen', () => {
  const blocked = (c: string): boolean => matchesCatastrophic(c) !== null;

  test('the five reported bypasses are blocked', () => {
    for (const c of [
      'cat <(rm -rf /)',
      'diff <(rm -rf /) <(echo x)',
      'tee >(rm -rf /)',
      'echo <(rm -rf /)',
      'echo $(cat <(rm -rf /))',
    ]) {
      expect(blocked(c), c).toBe(true);
    }
  });

  test('the nested gate applies inside the substitution, as in $(...)', () => {
    // A launcher head inside the substitution still lifts the gate.
    expect(blocked('cat <(arch -arm64 rm -rf /)')).toBe(true);
    expect(blocked('diff <(sudo rm -rf /) <(echo x)')).toBe(true);
    // A mention stays a mention: echo is the command, rm is its data.
    expect(blocked('cat <(echo rm -rf /)')).toBe(false);
    expect(blocked('tee >(echo rm -rf /)')).toBe(false);
    // A process substitution in a ${...} word runs (bash: expands to
    // /dev/fd/N), so it is screened; inside double quotes it is literal
    // text (bash prints the span), so it stays allowed.
    expect(blocked('echo ${x:-<(rm -rf /)}')).toBe(true);
    expect(blocked('echo "<(rm -rf /)"')).toBe(false);
  });

  test('benign process substitution stays allowed', () => {
    for (const c of [
      'diff <(echo a) <(echo b)',
      'cat <(sort file.txt)',
      'tee >(gzip > out.gz) <<< hello',
      'comm <(sort a.txt) <(sort b.txt)',
    ]) {
      expect(blocked(c), c).toBe(false);
    }
  });
});

describe('R1 pass 3 - PowerShell abbreviated parameters', () => {
  const blocked = (c: string): boolean => matchesCatastrophic(c) !== null;

  test('every unambiguous prefix of -Recurse is blocked, on every alias head', () => {
    for (const prefix of ['-r', '-re', '-rec', '-recu', '-recur', '-recurs', '-recurse']) {
      for (const head of ['Remove-Item', 'rm', 'ri', 'del', 'rd']) {
        const c = `powershell -c ${head} ${prefix} C:\\`;
        expect(blocked(c), c).toBe(true);
      }
    }
    // Case-insensitive, and with a :$value suffix.
    expect(blocked('powershell -c Remove-Item -R C:\\')).toBe(true);
    expect(blocked('powershell -c Remove-Item -RE C:\\')).toBe(true);
    expect(blocked('powershell -c Remove-Item -Recurse:$true C:\\')).toBe(true);
    expect(blocked('powershell -c Remove-Item -r:$true C:\\')).toBe(true);
  });

  test('the launcher flag itself accepts its unambiguous prefixes', () => {
    for (const flag of ['-c', '-co', '-com', '-comm', '-command']) {
      expect(blocked(`powershell ${flag} Remove-Item -r C:\\`), flag).toBe(true);
    }
    expect(blocked('powershell -Command Remove-Item -re C:\\')).toBe(true);
  });

  test('single-file deletes and unrelated -r flags stay allowed', () => {
    for (const c of [
      'powershell -c Remove-Item C:\\file.txt',
      'powershell -c rm C:\\temp\\one-file.txt',
      'powershell -c Get-ChildItem -r C:\\temp',
      'powershell -c Get-ChildItem C:\\temp',
    ]) {
      expect(blocked(c), c).toBe(false);
    }
  });
});

describe('R1 pass 3 - MCP frame names are measured', () => {
  test('a 30 KB server name still frames whole, sentinel intact', () => {
    const out = wrapMcpToolResult('hello', 'x'.repeat(30_000), 'tool');
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(out.endsWith('</spycode-mcp-content>')).toBe(true);
    expect(out).toContain('…');
  });

  test('a 30 KB tool name, and both names long with a large body', () => {
    const out = wrapMcpToolResult('hello', 'srv', 'y'.repeat(30_000));
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(out.endsWith('</spycode-mcp-content>')).toBe(true);
    const big = wrapMcpToolResult('z'.repeat(100_000), 'x'.repeat(30_000), 'y'.repeat(30_000));
    expect(big.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(big.endsWith('</spycode-mcp-content>')).toBe(true);
    expect(big).toContain('[MCP content truncated at');
  });

  test('short names are untouched in the frame line', () => {
    const out = wrapMcpToolResult('hi', 'my-server', 'lookup');
    expect(out).toContain('MCP server "my-server" tool "lookup"');
  });
});

describe('R1 pass 3 - truncation never splits a surrogate pair', () => {
  test('dispatch cap: the finding reproduction at maxResultChars 29', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'r1p3-dispatch-'));
    try {
      const ctx: ToolContext = {
        cwd: workDir,
        limits: { ...DEFAULT_LIMITS, maxResultChars: 29 },
        requestApproval: ACCEPT,
      };
      const r = await dispatchTool('run_command', { command: "printf '\\360\\237\\230\\200'" }, ctx);
      expect(hasLoneSurrogate(r.content)).toBe(false);
      expect(r.content).toContain('[result truncated to 29 characters]');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('wire clamp: both branches, including the keep <= 0 fallback', () => {
    expect(hasLoneSurrogate(clampToWireMax('ab\u{1F600}cdefgh', 3))).toBe(false);
    expect(clampToWireMax('ab\u{1F600}cdefgh', 3)).toBe('ab');
    // keep <= 0 (marker longer than the budget): still no lone surrogate.
    expect(hasLoneSurrogate(clampToWireMax('ab\u{1F600}cdefgh', 1))).toBe(false);
    expect(clampToWireMax('ab\u{1F600}cdefgh', 1).length).toBeLessThanOrEqual(1);
    expect(clampToWireMax('short', 100)).toBe('short');
  });

  test('composer clamp at the 20,000 cap', () => {
    const s = clampComposerState({ value: 'a'.repeat(19_999) + '\u{1F600}', cursor: 20_001 });
    expect(hasLoneSurrogate(s.value)).toBe(false);
    expect(s.value.length).toBeLessThanOrEqual(COMPOSER_MAX_CHARS);
    expect(s.value).toBe('a'.repeat(19_999));
    expect(s.cursor).toBe(19_999);
  });

  test('describeCallArg cuts do not split a pair (81-char shape kept for plain text)', () => {
    const cmd = 'x'.repeat(79) + '\u{1F600}yyyy';
    const label = describeCallArg('run_command', { command: cmd });
    expect(hasLoneSurrogate(label)).toBe(false);
    // The cut lands mid-emoji, so truncateSafe backs off one unit: 79 x's
    // + `…` (80 total). Plain-ASCII input still yields the pinned 81.
    expect(label).toBe('x'.repeat(79) + '…');
    expect(describeCallArg('run_command', { command: 'x'.repeat(100) }).length).toBe(81);
  });

  test('matchExcerpt window edges keep a pair whole', () => {
    const text = `prefix \u{1F600} needle \u{1F600} suffix`;
    const e = matchExcerpt(text, 'needle', 4);
    expect(e).not.toBeNull();
    expect(hasLoneSurrogate(e!.before)).toBe(false);
    expect(hasLoneSurrogate(e!.after)).toBe(false);
    expect(e!.match).toBe('needle');
  });

  test('buildShellSpawn wraps the command for cmd /s and passes argv verbatim on Windows', async () => {
    const { buildShellSpawn } = await import('../src/ui/tui/shell.js');
    // The /c argument carries its own outer pair: cmd.exe /s strips exactly
    // the first and last quote, so the strip removes the outer pair and the
    // user's command survives intact. Without the wrap the strip eats the
    // command's own first and last quotes and `"exe" "script"` fails.
    const win = buildShellSpawn('"C:\\node\\node.exe" "C:\\tmp\\probe.js"', 'win32');
    expect(win.file).toBe('cmd.exe');
    expect(win.args).toEqual(['/d', '/s', '/c', '""C:\\node\\node.exe" "C:\\tmp\\probe.js""']);
    expect(win.windowsVerbatimArguments).toBe(true);
    // An unquoted command gets the same wrap: the /s strip removes exactly
    // the outer pair, so the command reaches cmd.exe unchanged.
    expect(buildShellSpawn('echo hi', 'win32').args[3]).toBe('"echo hi"');
  });

  test('buildShellSpawn keeps the POSIX spawn unchanged', async () => {
    const { buildShellSpawn } = await import('../src/ui/tui/shell.js');
    expect(buildShellSpawn('echo hi', 'linux')).toEqual({
      file: 'sh',
      args: ['-c', 'echo hi'],
      windowsVerbatimArguments: false,
    });
  });

  test('TUI shell output: a UTF-8 sequence split across chunk events decodes whole', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'r1p3-shell-'));
    try {
      // A script file, not inline `node -e`: the nested quotes (and
      // parentheses) of an inline script do not survive `cmd /d /s /c`
      // on Windows. The single-level quoting below (`"node" "probe.js"`)
      // is the everyday shape a Windows user types; the product's
      // buildShellSpawn carries it through cmd.exe intact (outer pair +
      // verbatim argv - the R1-CI1 fix changed only the command and left
      // the transport broken, so this test still failed on both Windows
      // legs at head a9cfc03). Same pattern as
      // tests/builtin-tools-edges.test.ts.
      const probe = join(workDir, 'split-utf8.mjs');
      writeFileSync(
        probe,
        "process.stdout.write(Buffer.from([0xF0,0x9F]));setTimeout(()=>process.stdout.write(Buffer.from([0x98,0x80])),50);\n",
      );
      // Two writes, 50 ms apart, each carrying half of U+1F600 (F0 9F | 98 80).
      const cmd = `"${process.execPath}" "${probe}"`;
      const r = await runShellCommand(cmd, workDir, 10_000, undefined);
      expect(r.ok).toBe(true);
      expect(r.output).toContain('\u{1F600}');
      expect(r.output).not.toContain('\uFFFD');
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('R1 pass 3 - workspace delta ignores are case-insensitive', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'r1p3-delta-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('Node_Modules / BUILD / Dist / .GIT trees are not snapshotted', async () => {
    for (const d of ['Node_Modules', 'BUILD', 'Dist', '.GIT']) {
      mkdirSync(join(dir, d), { recursive: true });
      writeFileSync(join(dir, d, 'keep.js'), 'x');
    }
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'a.js'), 'x');
    writeFileSync(join(dir, 'real.js'), 'x');
    const snap = await snapshotWorkspace(dir);
    expect([...(snap?.entries.keys() ?? [])].sort()).toEqual(['real.js']);
  });
});
