import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import {
  DEFAULT_LIMITS,
  dispatchTool,
  type ToolContext,
} from '../src/lib/agent/tools.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';
import { runShellCommand } from '../src/lib/agent/builtin-tools.js';

const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });
const REJECT: RequestApproval = () => Promise.resolve({ approved: false, reason: 'no' });

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
}
let responder: ((url: string, init: { method: string }) => MockResp) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET' });
  }),
}));

let workDir: string;

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  workDir = mkdtempSync(join(tmpdir(), 'spycli-builtin-edge-'));
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  cwd: workDir,
  limits: DEFAULT_LIMITS,
  requestApproval: ACCEPT,
  apiUrlOverride: 'http://test.invalid',
  ...extra,
});
const fp = (name: string): string => join(workDir, name);
const run = (name: string, args: unknown, extra: Partial<ToolContext> = {}) =>
  dispatchTool(name, args, ctx(extra));

// MUST stay the first writeAtomic caller in this file: the atomic-write temp
// name embeds a per-module counter, and this test pre-creates the exact temp
// path (counter 1) as a directory so the write fails and the cleanup unlink
// fails too, covering the inner-catch arm of writeAtomic.
test('writeAtomic cleanup failure is swallowed into a tool error', async () => {
  mkdirSync(fp(`.f.txt.spycore-${process.pid}-1.tmp`));
  const res = await run('write_file', { path: 'f.txt', content: 'hello' });
  expect(res.ok).toBe(false);
});

describe('read_file', () => {
  test('directory path throws', async () => {
    mkdirSync(fp('subdir'));
    const res = await run('read_file', { path: 'subdir' });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('is a directory');
  });

  // FIFOs do not exist on Windows: `mkfifo` has no meaning there, so the
  // path the test creates is not visible to Win32 `stat` and the assertion
  // about "not a regular file" can never be reached.
  test.skipIf(process.platform === 'win32')('FIFO throws without reading', async () => {
    execFileSync('mkfifo', [fp('pipe')]);
    const res = await run('read_file', { path: 'pipe' });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('not a regular file');
  });

  test('secret path is blocked', async () => {
    writeFileSync(fp('.env'), 'TOKEN=abc');
    const res = await run('read_file', { path: '.env' });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('sensitive path');
  });
});

describe('list_dir and glob', () => {
  test('list_dir errors', async () => {
    const missing = await run('list_dir', { path: 'nope' });
    expect(missing.ok).toBe(false);
    expect(missing.content).toContain('directory not found');
    writeFileSync(fp('a.txt'), 'x');
    const fileAsDir = await run('list_dir', { path: 'a.txt' });
    expect(fileAsDir.ok).toBe(false);
    expect(fileAsDir.content).toContain('is not a directory');
  });

  test('list_dir and glob truncate past maxEntries', async () => {
    mkdirSync(fp('many'));
    for (let i = 0; i < 501; i += 1) writeFileSync(fp(`many/f${i}.txt`), 'x');
    const listed = await run('list_dir', { path: 'many' });
    expect(listed.ok).toBe(true);
    expect(listed.summary).toBe('501 entries');
    expect(listed.content).toContain('[+1 more]');
    const globbed = await run('glob', { pattern: 'many/*' });
    expect(globbed.ok).toBe(true);
    expect(globbed.summary).toBe('501 files');
    expect(globbed.content).toContain('[+1 more]');
  });

  test('list_dir hides a directory whose children are spycoreignored', async () => {
    writeFileSync(fp('.spycoreignore'), 'private/*\n');
    mkdirSync(fp('private'));
    writeFileSync(fp('private/secret.txt'), 'x');
    writeFileSync(fp('visible.txt'), 'x');
    const res = await run('list_dir', {});
    expect(res.ok).toBe(true);
    expect(res.content).not.toContain('private/');
    expect(res.content).toContain('visible.txt');
  });

  // NOTE: no pattern makes globby throw under suppressErrors:true (an
  // invalid pattern like '[' just yields no matches), so the glob catch arm
  // is defensive-only; it is listed as unreachable in the coverage report
  // rather than faked here.
});

describe('grep', () => {
  beforeEach(() => {
    writeFileSync(fp('a.txt'), 'hello needle\nplain\n');
    mkdirSync(fp('sub'));
    writeFileSync(fp('sub/b.txt'), 'needle here\n');
  });

  test('path scopes: file, directory, and dot', async () => {
    const file = await run('grep', { pattern: 'needle', path: 'a.txt' });
    expect(file.content).toContain('a.txt:1:');
    expect(file.content).not.toContain('sub/b.txt');
    const dir = await run('grep', { pattern: 'needle', path: 'sub' });
    expect(dir.content).toContain('sub/b.txt:1:');
    expect(dir.content).not.toContain('a.txt:');
    const dot = await run('grep', { pattern: 'needle', path: '.' });
    expect(dot.content).toContain('a.txt:1:');
    expect(dot.content).toContain('sub/b.txt:1:');
    const scoped = await run('grep', { pattern: 'needle', glob: '*.txt' });
    expect(scoped.content).toContain('a.txt:1:');
    expect(scoped.content).not.toContain('sub/b.txt');
  });

  test('pre-aborted signal stops the scan immediately', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const res = await run('grep', { pattern: 'needle' }, { signal: ctl.signal });
    expect(res.ok).toBe(true);
    expect(res.content).toBe('(no matches)');
  });

  test('scan caps at 10000 matches', async () => {
    const lines = Array.from({ length: 10001 }, () => 'needle').join('\n');
    writeFileSync(fp('big.txt'), lines);
    const res = await run('grep', { pattern: 'needle', path: 'big.txt' });
    expect(res.content).toContain('[scan capped at 10000 matches');
    expect(res.summary).toContain('(scan capped)');
  });

  test('oversize files are skipped', async () => {
    const buf = Buffer.alloc(2 * 1024 * 1024 + 100, 'z');
    writeFileSync(fp('huge.txt'), Buffer.concat([buf, Buffer.from('\nneedle\n')]));
    const res = await run('grep', { pattern: 'needle', path: 'huge.txt' });
    expect(res.ok).toBe(true);
    expect(res.content).toBe('(no matches)');
  });

  test('long matching lines are trimmed with an ellipsis', async () => {
    writeFileSync(fp('long.txt'), `${'y'.repeat(250)} needle\n`);
    const res = await run('grep', { pattern: 'needle', path: 'long.txt' });
    expect(res.content).toContain('…');
    expect(res.content).not.toContain('y'.repeat(250));
  });

  test('dangling symlink does not crash the scan', async () => {
    symlinkSync(fp('missing-target.txt'), fp('dangling.txt'));
    const res = await run('grep', { pattern: 'needle' });
    expect(res.ok).toBe(true);
  });
});

describe('repo_map', () => {
  test('package.json variants', async () => {
    const none = await run('repo_map', {});
    expect(none.content).not.toContain('package.json:');

    writeFileSync(fp('package.json'), JSON.stringify({ name: 'demo' }));
    const unnamed = await run('repo_map', {});
    expect(unnamed.content).toContain('package.json: demo');
    expect(unnamed.content).not.toContain('scripts:');

    writeFileSync(
      fp('package.json'),
      JSON.stringify({ name: 'demo', description: 'd', scripts: { test: 'vitest' } }),
    );
    const full = await run('repo_map', {});
    expect(full.content).toContain('package.json: demo - "d"');
    expect(full.content).toContain('scripts: test');

    writeFileSync(fp('package.json'), '{not json');
    const malformed = await run('repo_map', {});
    expect(malformed.content).not.toContain('package.json:');

    writeFileSync(fp('package.json'), JSON.stringify({ description: 'no name here' }));
    const noname = await run('repo_map', {});
    expect(noname.content).toContain('package.json: (unnamed) - "no name here"');
  });

  test('spycoreignored directory is hidden from the top level', async () => {
    writeFileSync(fp('.spycoreignore'), 'private/*\n');
    mkdirSync(fp('private'));
    writeFileSync(fp('private/x.txt'), 'x');
    const res = await run('repo_map', {});
    expect(res.content).not.toContain('private/');
  });

  test('file count samples at 8000', async () => {
    for (let i = 0; i < 8001; i += 1) writeFileSync(fp(`f${i}.txt`), 'x');
    const res = await run('repo_map', {});
    expect(res.content).toContain('Files scanned: 8001 (sampled 8000)');
  });
});

describe('diagnostics', () => {
  const withLsp = () => {
    const prev = process.env.SPYCODE_LSP;
    process.env.SPYCODE_LSP = '1';
    return () => {
      if (prev === undefined) delete process.env.SPYCODE_LSP;
      else process.env.SPYCODE_LSP = prev;
    };
  };

  test('secret file is refused', async () => {
    const restore = withLsp();
    try {
      writeFileSync(fp('.env'), 'TOKEN=abc');
      const res = await run('diagnostics', { path: '.env' });
      expect(res.ok).toBe(false);
      expect(res.content).toContain('refusing to diagnose a secret file');
    } finally {
      restore();
    }
  });

  test('missing server binary surfaces as a tool error', async () => {
    const restore = withLsp();
    try {
      writeFileSync(fp('a.ts'), 'const x: number = 1;\n');
      const res = await run('diagnostics', { path: 'a.ts', timeout: 1 });
      expect(res.ok).toBe(false);
      expect(res.content).toContain('no language server');
    } finally {
      restore();
    }
  });

  test('unsupported extension maps its LspError to a ToolError', async () => {
    const restore = withLsp();
    try {
      writeFileSync(fp('file.xyz'), 'whatever\n');
      const res = await run('diagnostics', { path: 'file.xyz' });
      expect(res.ok).toBe(false);
      expect(res.content).toContain('no language server configured for ".xyz" files');
    } finally {
      restore();
    }
  });

  test('workspace mode reports zero diagnostics with a skip line', async () => {
    const restore = withLsp();
    try {
      writeFileSync(fp('a.ts'), 'const x: number = 1;\n');
      // A 1s budget breaks out before any server is attempted, so use the
      // default budget: the missing binary then fails fast into a skip.
      const res = await run('diagnostics', {});
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('0 diagnostics workspace-wide');
      expect(res.content).toContain('(skipped typescript:');
    } finally {
      restore();
    }
  });
});

describe('load_skill', () => {
  test('no skills installed', async () => {
    const res = await run('load_skill', { name: 'anything' });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('no skills are installed');
  });

  test('unknown skill and already-loaded notice', async () => {
    writeFileSync(fp('SKILL.md'), 'Do the thing.');
    const skills = new Map([
      ['demo', { name: 'demo', description: 'd', source: 'project' as const, path: fp('SKILL.md') }],
    ]);
    const unknown = await run('load_skill', { name: 'nope' }, { skills });
    expect(unknown.ok).toBe(false);
    expect(unknown.content).toContain('unknown skill "nope"');
    const loaded = await run(
      'load_skill',
      { name: 'demo' },
      { skills, loadedSkills: new Set(['demo']) },
    );
    expect(loaded.ok).toBe(true);
    expect(loaded.summary).toBe('already loaded');
  });

  test('unreadable skill file and one-line summary', async () => {
    const skills = new Map([
      ['gone', { name: 'gone', description: 'd', source: 'project' as const, path: fp('gone.md') }],
    ]);
    const gone = await run('load_skill', { name: 'gone' }, { skills });
    expect(gone.ok).toBe(false);
    expect(gone.content).toContain('could not be read');
    writeFileSync(fp('SKILL.md'), 'Do the thing.');
    const one = new Map([
      ['one', { name: 'one', description: 'd', source: 'project' as const, path: fp('SKILL.md') }],
    ]);
    const res = await run('load_skill', { name: 'one' }, { skills: one });
    expect(res.ok).toBe(true);
    expect(res.summary).toBe('1 line');
  });
});

describe('web tools', () => {
  const jsonResp = (status: number, body: unknown): MockResp => ({
    statusCode: status,
    headers: {},
    body: { json: async () => body },
  });

  test('web_search shapes titles, urls, and snippets', async () => {
    responder = (url) => {
      expect(url).toContain('/search');
      return jsonResp(200, {
        success: true,
        data: [
          { title: 'First', url: 'https://x.example', content: 'snip' },
          { content: 'only content' },
          { title: '', url: 123 },
        ],
      });
    };
    const res = await run('web_search', { query: 'test query' });
    expect(res.ok).toBe(true);
    expect(res.summary).toBe('3 results');
    expect(res.content).toContain('1. First');
    expect(res.content).toContain('https://x.example');
    expect(res.content).toContain('snip');
    expect(res.content).toContain('2. (untitled)');
    expect(res.content).toContain('only content');
    expect(res.content).toContain('3. (untitled)');
  });

  test('web_search API failure', async () => {
    responder = () => jsonResp(500, { success: false, error: 'boom' });
    const res = await run('web_search', { query: 'test query' });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('Web search failed');
  });

  test('fetch_url fallbacks, empty page, validation, and failure', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: { url: 'https://final.example', title: 'T', text: 'body text' },
      });
    const full = await run('fetch_url', { url: 'https://orig.example' });
    expect(full.ok).toBe(true);
    expect(full.summary).toBe('9 chars');
    expect(full.content).toContain('URL: https://final.example');
    expect(full.content).toContain('Title: T');

    responder = () => jsonResp(200, { success: true, data: { text: 'hi' } });
    const bare = await run('fetch_url', { url: 'https://orig.example' });
    expect(bare.content).toContain('URL: https://orig.example');
    expect(bare.content).toContain('Title: \n');

    responder = () => jsonResp(200, { success: true, data: { text: '' } });
    const empty = await run('fetch_url', { url: 'https://orig.example' });
    expect(empty.ok).toBe(true);
    expect(empty.summary).toBe('empty page');

    // Absent (not merely empty) text takes the same empty-page path via the
    // non-string fallback.
    responder = () => jsonResp(200, { success: true, data: {} });
    const absent = await run('fetch_url', { url: 'https://orig.example' });
    expect(absent.ok).toBe(true);
    expect(absent.summary).toBe('empty page');

    const invalid = await run('fetch_url', { url: 'not a url' });
    expect(invalid.ok).toBe(false);
    expect(invalid.content).toContain('valid absolute');
    const ftp = await run('fetch_url', { url: 'ftp://x.example' });
    expect(ftp.ok).toBe(false);
    expect(ftp.content).toContain('http or https');

    responder = () => jsonResp(500, { success: false, error: 'boom' });
    const failed = await run('fetch_url', { url: 'https://orig.example' });
    expect(failed.ok).toBe(false);
    expect(failed.content).toContain('Could not fetch URL');
  });
});

describe('mutations', () => {
  test('write_file to a directory throws', async () => {
    mkdirSync(fp('adir'));
    const res = await run('write_file', { path: 'adir', content: 'x' });
    expect(res.ok).toBe(false);
    expect(res.content).toContain('is a directory');
  });

  test('edit_file validation and no-op', async () => {
    const empty = await run('edit_file', { path: 'f.txt', old_str: '', new_str: 'x' });
    expect(empty.ok).toBe(false);
    expect(empty.content).toContain('must not be empty');
    writeFileSync(fp('.env'), 'TOKEN=abc');
    const secret = await run('edit_file', { path: '.env', old_str: 'a', new_str: 'b' });
    expect(secret.ok).toBe(false);
    expect(secret.content).toContain('sensitive path');
    mkdirSync(fp('adir'));
    const dir = await run('edit_file', { path: 'adir', old_str: 'a', new_str: 'b' });
    expect(dir.ok).toBe(false);
    expect(dir.content).toContain('not a regular file');
    writeFileSync(fp('same.txt'), 'hello\n');
    const noop = await run('edit_file', { path: 'same.txt', old_str: 'hello', new_str: 'hello' });
    expect(noop.ok).toBe(true);
    expect(noop.summary).toBe('no change');
  });
});

describe('run_command', () => {
  test('validation and catastrophic guard', async () => {
    const empty = await run('run_command', { command: '   ' });
    expect(empty.ok).toBe(false);
    expect(empty.content).toContain('must not be empty');
    const danger = await run('run_command', { command: 'rm -rf /' });
    expect(danger.ok).toBe(false);
    expect(danger.content).toContain('catastrophic');
  });

  test('approval rejection', async () => {
    const res = await run('run_command', { command: 'echo hi' }, { requestApproval: REJECT });
    expect(res.ok).toBe(false);
    expect(res.summary).toBe('rejected');
  });

  test('deny and allow command rules', async () => {
    const notices: Array<{ kind: string }> = [];
    const onCommandRuleNotice = (n: { kind: string }) => {
      notices.push(n);
    };
    const deny = await run(
      'run_command',
      { command: 'echo hi' },
      {
        commandRules: {
          allow: [],
          deny: [{ entry: 'echo hi', tokens: ['echo', 'hi'], kind: 'deny', scope: 'project' }],
        },
        onCommandRuleNotice,
      },
    );
    expect(deny.ok).toBe(false);
    expect(deny.summary).toBe('denied by a command rule');
    expect(notices.map((n) => n.kind)).toEqual(['deny']);
    notices.length = 0;
    const allow = await run(
      'run_command',
      { command: 'echo hi' },
      {
        commandRules: {
          allow: [{ entry: 'echo hi', tokens: ['echo', 'hi'], kind: 'allow', scope: 'project' }],
          deny: [],
        },
        onCommandRuleNotice,
      },
    );
    expect(allow.ok).toBe(true);
    expect(allow.content).toContain('hi');
    expect(notices.map((n) => n.kind)).toEqual(['auto_approve']);
  });

  test('timeout and pre-aborted signal abort the run', async () => {
    const timed = await run('run_command', { command: 'sleep 30' }, { commandTimeoutMs: 200 });
    expect(timed.timedOut).toBe(true);
    expect(timed.summary).toContain('timed out');

    const ctl = new AbortController();
    ctl.abort();
    const aborted = await run(
      'run_command',
      { command: 'sleep 30' },
      { signal: ctl.signal, commandTimeoutMs: 30_000 },
    );
    expect(aborted.ok).toBe(false);
  }, 30_000);

  // The SIGTERM legs assert POSIX-only behaviour: Windows has no SIGTERM for
  // Node to report (a terminated child reports `exit 1`, not a signal), and
  // `trap` does not exist under cmd.exe. The timeout and pre-abort legs above
  // stay cross-platform.
  test.skipIf(process.platform === 'win32')('SIGTERM-ignored abort ends by SIGKILL', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const aborted = await run(
      'run_command',
      { command: 'sleep 30' },
      { signal: ctl.signal, commandTimeoutMs: 30_000 },
    );
    expect(aborted.ok).toBe(false);
    expect(aborted.summary).toContain('killed (SIGTERM)');

    // SIGTERM is ignored, so the timeout fires first (setting the hard-kill
    // timer) and the later abort re-enters scheduleHardKill, covering its
    // already-scheduled return arm; SIGKILL finally ends the run.
    const ctl2 = new AbortController();
    setTimeout(() => ctl2.abort(), 500);
    const trapped = await run(
      'run_command',
      { command: "trap '' TERM; sleep 30" },
      { signal: ctl2.signal, commandTimeoutMs: 200 },
    );
    expect(trapped.timedOut).toBe(true);
    expect(trapped.summary).toContain('timed out');
  }, 30_000);

  test('survivor on the pipes settles on drain, then close re-enters done', async () => {
    const res = await run('run_command', { command: 'sleep 0.6 & echo done' });
    expect(res.ok).toBe(true);
    expect(res.content).toContain('done');
  });

  test('output capture caps at 1MB', async () => {
    // Dispatch char-caps the result long before the 1MB marker, so the cap
    // is observed through the executor directly. The generator is a script
    // file: the `seq` probe hung past the 10s default on Windows (run 38),
    // and a script file removes the MSYS2/cmd variable from the measurement.
    // The 30s test timeout matches the command's own 30s budget.
    const gen = fp('gen-1mb.mjs');
    writeFileSync(gen, `for (let i = 1; i <= 300000; i++) console.log(i);\n`);
    const direct = await runShellCommand(`"${process.execPath}" "${gen}"`, workDir, 30_000, undefined);
    expect(direct.combined).toContain('[output capped at');
  }, 30_000);

  test('long tails truncate with a leading ellipsis', async () => {
    // A script file, not inline `node -e`: `cmd /d /s /c` strips the
    // outermost quotes, so the nested quotes in an inline script do not
    // survive on Windows.
    const gen = fp('gen-tail.mjs');
    writeFileSync(gen, `for (let i = 0; i < 50; i++) console.log('y'.repeat(200));\n`);
    const res = await run('run_command', {
      command: `"${process.execPath}" "${gen}"`,
    });
    expect(res.ok).toBe(true);
    expect(res.outputTail!.startsWith('…')).toBe(true);
  });

  // `kill` does not exist under cmd.exe, and Windows has no SIGKILL for Node
  // to report (a terminated child reports `exit 1`, not a signal). The
  // spawn-error legs below stay cross-platform.
  test.skipIf(process.platform === 'win32')('signal kill reports SIGKILL', async () => {
    const killed = await run('run_command', { command: 'kill -9 $$' });
    expect(killed.ok).toBe(false);
    expect(killed.summary).toContain('killed (SIGKILL)');
  });

  test('spawn error statuses', async () => {
    const failed = await run('run_command', { command: 'echo hi' }, { cwd: '/nonexistent-dir-xyz' });
    expect(failed.ok).toBe(false);
    // No signal in the status: only the duration parenthetical follows.
    expect(failed.summary).toMatch(/^killed \(\d+\.\d+s\)$/);
    const direct = await runShellCommand('echo hi', '/nonexistent-dir-xyz', 5000, undefined);
    expect(direct.exitCode).toBe(null);
    expect(direct.signal).toBe(null);
    expect(direct.combined).toContain('spawn error');
  });
});
