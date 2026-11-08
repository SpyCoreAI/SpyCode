import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import {
  DEFAULT_LIMITS,
  dispatchTool,
  type ToolContext,
} from '../src/lib/agent/tools.js';
import { runShellCommand } from '../src/lib/agent/builtin-tools.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';

/**
 * H17 - portable equivalents for the tests that can only run on POSIX.
 *
 * The `test.skipIf(win32)` guards in the suite stay where the property
 * itself is POSIX-only (FIFO, 0600 modes, chmod-000, hostile filenames
 * with control characters, SIGINT emission killing the vitest worker,
 * SIGTERM/SIGKILL signal reporting, the cmd.exe-less screen-differential
 * corpus). What this file proves, on every platform including Windows, is
 * the same mechanism with the shell idiom removed:
 *
 * - run cancellation: the AbortSignal path the SIGINT handler feeds, driven
 *   directly instead of via `process.emit('SIGINT')` (which kills the
 *   vitest worker on Windows).
 * - pipe-survivor settle/release: a node script file spawns the detached
 *   holder instead of `sleep 30 &`, so the shell is out of the measurement.
 * - self-terminating children: a node script kills its parent shell, so the
 *   report (`killed (SIGTERM)` on POSIX, `exit 1` on Windows) is checked in
 *   each platform's own vocabulary, and prompt termination is checked
 *   everywhere. The kill command is a `; :` list on POSIX: macOS /bin/sh
 *   is bash, which execs a single simple command, so a bare killer would
 *   kill the vitest worker itself (three dead macOS runs) instead of a
 *   shell - see `killerCmd` in the self-terminating describe block.
 *
 * The Windows legs below run in branch CI (windows-latest); the Linux legs
 * are verified here.
 */
interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: {
    json: () => Promise<unknown>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
  };
}

let responder:
  | ((url: string, init: { method: string; body?: unknown }) => MockResp)
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET', body: init.body });
  }),
}));

let configDir: string;
let workDir: string;
let scriptDir: string;
const holderPids: number[] = [];

/** Handles of the given type currently keeping the event loop alive. */
function activeCount(type: string): number {
  return process.getActiveResourcesInfo().filter((r) => r === type).length;
}

function nodeCmd(script: string, ...args: string[]): string {
  return [`"${process.execPath}"`, `"${script}"`, ...args.map((a) => `"${a}"`)].join(' ');
}

function writeScript(name: string, source: string): string {
  const file = join(scriptDir, name);
  writeFileSync(file, source, 'utf8');
  return file;
}

function holderAlive(pidFile: string): boolean {
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (!Number.isFinite(pid) || pid <= 0) return false;
  holderPids.push(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  configDir = freshConfigDir();
  responder = null;
  workDir = mkdtempSync(join(tmpdir(), 'spycode-win-equiv-'));
  scriptDir = mkdtempSync(join(tmpdir(), 'spycode-win-equiv-scripts-'));
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  for (const pid of holderPids.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  vi.resetModules();
  for (const d of [workDir, scriptDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: {
      json: async () => ({}),
      [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator](),
    },
  };
}

const block = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

describe('run cancellation via AbortSignal (SIGINT equivalent)', () => {
  test('an abort between turns cancels the run', async () => {
    writeFileSync(join(workDir, 'x.txt'), 'x\n');
    const ctl = new AbortController();
    const turns = [block('read_file', { path: 'x.txt' }), 'Done.'];
    let i = 0;
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'cnv_cancel' } });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        // The SIGINT handler in the CLI aborts this same controller; drive
        // it directly so the test runs on Windows too.
        ctl.abort();
        const reply = turns[i] ?? 'Done.';
        i += 1;
        return sseResp([{ type: 'text', content: reply }, { type: 'done' }]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'do the thing',
      cwd: workDir,
      signal: ctl.signal,
      onEvent: (e) => events.push(e),
    });
    expect(result.cancelled).toBe(true);
    expect(result.finalText).toBe('');
    expect(result.turns).toBeLessThanOrEqual(1);
  });
});

describe('pipe-holding survivors, shell-free', () => {
  /**
   * The spawner exits at once; its detached child inherits the spawner's
   * stdout/stderr (the pipes back to this process) and holds them for 30s.
   * The pid file lets the test prove the survivor is still ALIVE at assert
   * time, so "no pipe held" can only be the release, never the survivor
   * having died on its own.
   */
  const SPAWNER = `
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const [holderScript, pidFile] = process.argv.slice(2);
const child = spawn(process.execPath, [holderScript], { detached: true, stdio: 'inherit' });
writeFileSync(pidFile, String(child.pid));
child.unref();
`;
  const HOLDER = `setTimeout(() => {}, 30000);\n`;

  test('run_command: a pipe-holding survivor neither withholds the result nor holds the loop', async () => {
    const holder = writeScript('holder-30s.mjs', HOLDER);
    const pidFile = join(scriptDir, 'holder.pid');
    // One script: print, then spawn the detached holder and exit.
    const run = writeScript(
      'print-and-spawn.mjs',
      `console.log('work-done');\n` +
        `const { spawn } = await import('node:child_process');\n` +
        `const { writeFileSync } = await import('node:fs');\n` +
        `const child = spawn(process.execPath, [${JSON.stringify(holder)}], { detached: true, stdio: 'inherit' });\n` +
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
        `child.unref();\n`,
    );
    const before = activeCount('PipeWrap');
    const started = Date.now();
    const res = await runShellCommand(nodeCmd(run), workDir, 30_000, undefined);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_500);
    expect(res.timedOut).toBe(false);
    expect(res.combined).toContain('work-done');
    expect(holderAlive(pidFile)).toBe(true);
    expect(activeCount('PipeWrap')).toBe(before);
  });

  test('run_command via dispatch: the tool result settles while the survivor lives', async () => {
    const holder = writeScript('holder-30s.mjs', HOLDER);
    const pidFile = join(scriptDir, 'holder2.pid');
    const run = writeScript(
      'print-and-spawn2.mjs',
      `console.log('work-done');\n` +
        `const { spawn } = await import('node:child_process');\n` +
        `const { writeFileSync } = await import('node:fs');\n` +
        `const child = spawn(process.execPath, [${JSON.stringify(holder)}], { detached: true, stdio: 'inherit' });\n` +
        `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));\n` +
        `child.unref();\n`,
    );
    const ctx: ToolContext = {
      cwd: workDir,
      limits: DEFAULT_LIMITS,
      requestApproval: () => Promise.resolve({ approved: true }),
    };
    const before = activeCount('PipeWrap');
    const started = Date.now();
    const res = await dispatchTool('run_command', { command: nodeCmd(run) }, ctx);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('work-done');
    expect(holderAlive(pidFile)).toBe(true);
    expect(activeCount('PipeWrap')).toBe(before);
  });

  test('hooks: a pipe-holding survivor leaves NO child pipe holding the event loop', async () => {
    const holder = writeScript('holder-30s.mjs', HOLDER);
    const spawner = writeScript('spawner.mjs', SPAWNER);
    const pidFile = join(scriptDir, 'holder3.pid');
    writeFileSync(
      join(configDir, 'hooks.json'),
      JSON.stringify({
        hooks: [
          {
            event: 'prompt-submit',
            command: nodeCmd(spawner, holder, pidFile),
            timeoutSeconds: 30,
          },
        ],
      }),
      'utf8',
    );
    const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(workDir);
    const before = activeCount('PipeWrap');
    const started = Date.now();
    await fireHookEvent(s, 'prompt-submit', { prompt: 'x' });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(holderAlive(pidFile)).toBe(true);
    expect(activeCount('PipeWrap')).toBe(before);
  });

  test('hooks: settle on the hook PROCESS exiting, not on its pipes closing', async () => {
    // The holder lives 3s; a settle on 'close' would take ~3s, a settle on
    // 'exit' + drain takes ~200ms. Same shape as the POSIX test, with the
    // shell backgrounding replaced by a script file.
    const holder = writeScript('holder-3s.mjs', `setTimeout(() => {}, 3000);\n`);
    const spawner = writeScript('spawner.mjs', SPAWNER);
    const pidFile = join(scriptDir, 'holder4.pid');
    writeFileSync(
      join(configDir, 'hooks.json'),
      JSON.stringify({
        hooks: [
          {
            event: 'prompt-submit',
            command: nodeCmd(spawner, holder, pidFile),
            timeoutSeconds: 30,
          },
        ],
      }),
      'utf8',
    );
    const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(workDir);
    const started = Date.now();
    const r = await fireHookEvent(s, 'prompt-submit', { prompt: 'x' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_500);
    expect(r.notices.some((n) => n.includes('timed out'))).toBe(false);
    expect(holderAlive(pidFile)).toBe(true);
  });

  test.skipIf(process.platform !== 'win32')(
    'hooks: on Windows the hook still settles at its cap (tree-kill partial)',
    async () => {
      // Windows has no process group to signal, so killTree falls back to
      // the single-process kill and a forked grandchild survives there - the
      // marker assertion of the POSIX tree-kill pin cannot run. What DOES
      // hold on Windows is the settle: the hook itself dies at the cap and
      // the wait reports the timeout instead of hanging on the survivor.
      const marker = join(scriptDir, 'survived.txt');
      const grandchild = writeScript(
        'tree-marker.mjs',
        `import { writeFileSync } from 'node:fs';\n` +
          `setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, 'survived'); }, 3000);\n`,
      );
      const spawner = writeScript(
        'tree-spawner.mjs',
        `const { spawn } = await import('node:child_process');\n` +
          `const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { detached: true, stdio: 'inherit' });\n` +
          `child.unref();\n` +
          // The hook itself must still be ALIVE at the 1s cap for the cap
          // to kill it and the wait to report the timeout: the previous
          // shape exited the moment the grandchild was spawned, so the
          // hook settled at ~200ms with exit 0 and no timeout notice ever
          // fired. The 5s sleep keeps the hook past the cap while the
          // grandchild (3s marker) survives the single-process kill - the
          // documented Windows tree-kill gap, unchanged.
          `setTimeout(() => {}, 5000);\n`,
      );
      writeFileSync(
        join(configDir, 'hooks.json'),
        JSON.stringify({
          hooks: [{ event: 'prompt-submit', command: nodeCmd(spawner), timeoutSeconds: 1 }],
        }),
        'utf8',
      );
      const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
      const s = await loadHookSession(workDir);
      const started = Date.now();
      const r = await fireHookEvent(s, 'prompt-submit', { prompt: 'x' });
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(r.notices.some((n) => n.includes('timed out'))).toBe(true);
      // The grandchild may survive on Windows - that is the documented gap,
      // not an assertion. Its marker file is removed with the script dir.
    },
  );
});

describe('self-terminating children', () => {
  /**
   * The killer must kill the SHELL, not the script - and on macOS the
   * shell is only there if the command is a list. macOS `/bin/sh` is
   * bash, and bash execs a single simple command: the node script's
   * parent is then the vitest worker itself, and SIGTERM to it kills the
   * worker - three consecutive macOS runs died with "Worker exited
   * unexpectedly" and this file never reporting, while Linux (dash, which
   * never execs) and Windows (cmd.exe, which never execs) passed. A
   * trailing `; :` makes the command a list, so bash forks for it and
   * stays the parent to be killed. Proven locally: bash + single command
   * killed the parent process (exit 143, "Terminated"); bash + `; :`
   * left the parent alive and the child died SIGTERM. Windows needs no
   * suffix - cmd.exe never execs - so the command is unchanged there.
   */
  function killerCmd(script: string): string {
    return process.platform === 'win32' ? nodeCmd(script) : `${nodeCmd(script)} ; :`;
  }

  test('bash execs a single command, so the killer must not run as one', async () => {
    // Pins the macOS worker-death mechanism on the shells that have it.
    // A node parent spawns bash -c with the killer as a single command,
    // and again as a `; :` list; the parent reports whether it survived.
    // Skipped where bash is absent (Windows runs the win32 branch above).
    if (process.platform === 'win32') return;
    const bash = spawnSync('bash', ['--version'], { encoding: 'utf8' });
    if (bash.error || bash.status !== 0) return; // no bash on this machine - nothing to pin
    const parent = writeScript(
      'bash-exec-parent.mjs',
      `import { spawn } from 'node:child_process';\n` +
        `const mode = process.argv[2];\n` +
        `const killer = process.argv[3];\n` +
        `const cmd = mode === 'single' ? killer : killer + ' ; :';\n` +
        `const child = spawn(cmd, { shell: '/bin/bash', stdio: ['ignore', 'pipe', 'pipe'] });\n` +
        `child.on('exit', (code, signal) => {\n` +
        `  console.log(JSON.stringify({ childSignal: signal, childCode: code }));\n` +
        `  process.exit(0);\n` +
        `});\n` +
        `setTimeout(() => { console.log(JSON.stringify({ childSignal: null })); process.exit(0); }, 2000);\n`,
    );
    const killer = writeScript('bash-exec-killer.mjs', `process.kill(process.ppid, 'SIGTERM');\n`);
    const runParent = (mode: string): { status: number | null; signal: NodeJS.Signals | null; out: string } => {
      const r = spawnSync(process.execPath, [parent, mode, nodeCmd(killer)], { encoding: 'utf8' });
      return { status: r.status, signal: r.signal, out: r.stdout ?? '' };
    };
    // Single command: bash execs the killer, so the killer's parent is
    // this parent process - it dies SIGTERM, exactly as the vitest
    // worker did on macOS.
    const single = runParent('single');
    expect(single.signal).toBe('SIGTERM');
    // Compound command: bash stays the parent and dies instead; the
    // parent survives and reports the child's SIGTERM.
    const compound = runParent('list');
    expect(compound.signal).toBeNull();
    expect(compound.status).toBe(0);
    expect(JSON.parse(compound.out.trim()).childSignal).toBe('SIGTERM');
  });

  test('a child that kills itself is reported terminated, promptly, on every platform', async () => {
    // Kill the PARENT (the shell runShellCommand spawned), not this script:
    // the signal/exit is then reported for the direct child, which is what
    // the executor observes. Killing the script itself would only make the
    // shell exit 143.
    const killer = writeScript(
      'self-kill.mjs',
      `process.kill(process.ppid, 'SIGTERM');\n`,
    );
    const ctx: ToolContext = {
      cwd: workDir,
      limits: DEFAULT_LIMITS,
      requestApproval: () => Promise.resolve({ approved: true }),
    };
    const started = Date.now();
    const res = await dispatchTool('run_command', { command: killerCmd(killer) }, ctx);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000);
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(false);
    // The vocabulary differs by platform - Node reports no signal on
    // Windows, so a terminated child reports `exit 1` there - but the
    // property (prompt, failed, not timed out) is the same.
    if (process.platform === 'win32') {
      expect(res.summary).toMatch(/exit 1|killed/);
    } else {
      expect(res.summary).toContain('killed (SIGTERM)');
    }
  });

  test('runShellCommand reports the self-kill at the executor level', async () => {
    const killer = writeScript(
      'self-kill2.mjs',
      `process.kill(process.ppid, 'SIGTERM');\n`,
    );
    const started = Date.now();
    const run = await runShellCommand(killerCmd(killer), workDir, 30_000, undefined);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(run.timedOut).toBe(false);
    if (process.platform === 'win32') {
      expect(run.signal).toBeNull();
      expect(run.exitCode).not.toBe(0);
    } else {
      expect(run.signal).toBe('SIGTERM');
      expect(run.exitCode).toBeNull();
    }
  });
});
