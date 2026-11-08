import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
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

/**
 * Phase 3i - wait for the PipeWrap census to drain back to baseline.
 *
 * WHY. Branch CI run 42510887833 (head 66ceeb1) identified the +1 in the
 * hooks pipe-survivor test: after settle, exactly one extra handle -
 * `[4] NEW Socket destroyed=true readable=false writable=false
 * connecting=false pending=true`, no inner handle, no fd, and the
 * ChildProcess already reaped. That is the hook's stdin socket: destroyed
 * (the flush-callback destroy in `src/lib/hooks.ts`), its libuv PipeWrap
 * not yet released because a shutdown operation is still pending on the
 * Windows named pipe. It is NOT a live child pipe holding the loop.
 *
 * PROOF (Linux, `/tmp/phase3i/probe1.mjs`, `probe3.mjs`, 3/3 runs each):
 * destroy() on a child-stdin socket with a pending write leaves the
 * census elevated by exactly 1 in the SAME tick, with the socket reading
 * `destroyed=true pending=true _handle=null` - byte-for-byte the Windows
 * after-settle line - and the count drains back to baseline ~2ms later
 * with NO further action on the socket. On Windows the same drain takes
 * longer than the synchronous census taken right after settle resolves,
 * so the test read 5 vs 4. The drain is passive and unconditional; the
 * wait below only gives the loop the turns it needs.
 *
 * WHY NOT THE OTHER DIRECTIONS.
 * (b) Settle already awaits the stdin socket's `'close'` (bounded by
 * `STDIN_CLOSE_WAIT_MS`, `src/lib/hooks.ts`) - that IS the 3f fix, and
 * the 3h evidence shows the PipeWrap still listed after it. There is
 * nothing further to await: `'close'` is the terminal event. Extending
 * the wait to the stdout/stderr sockets is impossible by design -
 * `'close'` fires only once EVERY inherited pipe is shut, and the
 * survivor holds them for 30s; the sibling test pins settle <1500ms
 * while the holder lives 3s.
 * (c) Excluding destroyed+pending sockets from the census would be
 * lying about the loop: `getActiveResourcesInfo` still lists the handle
 * precisely BECAUSE the pending operation keeps it alive until it
 * completes. A destroyed socket is not a leak, but it is a real,
 * transient loop-keeping resource - the honest assertion is that it
 * drains, not that it is invisible.
 *
 * FALSIFIABILITY. A genuinely leaked LIVE pipe - open, ref'd, never
 * destroyed - never drains, so this wait times out above baseline and
 * the test still fails. Pinned by 'a live refd pipe never reaches
 * quiescence' below (probe2: live ref'd pipes hold the census elevated
 * for the whole window). The holder-alive assertion in the hooks test
 * still proves the survivor lives at assert time, so a pass cannot be
 * the survivor having died.
 *
 * BOUND. 2000ms: the Windows named-pipe shutdown completes well inside
 * it (the 3f comment records the libuv EOF timer on a Windows pipe as
 * 50ms, the drain as 200ms, `STDIN_CLOSE_WAIT_MS` as 500ms). A handle
 * that has not drained in 2s is, for this test's purposes, a leak.
 *
 * PHASE 3j - the bound above was FALSIFIED on Windows (branch CI run
 * 42514127594, head 24cc5b6): the after-quiescence dump ~2s after
 * settle is byte-identical to after-settle, still 5 PipeWraps with the
 * same destroyed+pending socket. The drain is NOT slow; it is gated on
 * the survivor, which holds the stdin read end open and never reads,
 * so the `end()` shutdown never completes until the survivor dies.
 * The production fix is in `src/lib/hooks.ts`: the payload is sent with
 * `write()` instead of `end()`, so no shutdown request is ever started
 * and there is nothing to stall - the handle retires on the next loop
 * turn on every platform. This wait stays as a guard (it returns at
 * once when the fix works) and still fails a live leak. The 'hooks: a
 * hook that reads stdin to EOF' test below pins the other half of the
 * fix: write()+destroy() must still deliver the full payload followed
 * by EOF to a reading hook. Windows CI is the verdict for the survivor
 * test - on Linux the old code drained in ~2ms too, so no Linux test
 * can discriminate the two teardown paths.
 */
const PIPE_QUIESCENCE_TIMEOUT_MS = 2000;
const PIPE_QUIESCENCE_POLL_MS = 10;

async function waitForPipeQuiescence(
  baseline: number,
  timeoutMs: number = PIPE_QUIESCENCE_TIMEOUT_MS,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = activeCount('PipeWrap');
    if (count <= baseline) return count;
    if (Date.now() >= deadline) return count;
    await new Promise((resolve) => setTimeout(resolve, PIPE_QUIESCENCE_POLL_MS));
  }
}

/**
 * Phase 3h diagnostic (CI-only evidence): handle-IDENTITY dump for the
 * pipe-survivor census, printed with console.log so it lands in the
 * vitest output on the CI log. Always on for the hooks pipe-survivor
 * test below - a passing run's dump is evidence too.
 *
 * WHY identity, not just a count. The bare count cannot say WHICH handle
 * is the +1: the 3g warm-up theory (the process's own lazy stdout) was
 * falsified on Windows run 42510257506 (still 5 vs 4 on both legs), and
 * the destroy-placement axis was already falsified in 3d/3e/3f. The next
 * question is only answerable from the runner: is the extra handle the
 * hook's stdin socket (fd, direction writable-only), a stdout/stderr
 * socket, the process's own stdio, or something else entirely.
 *
 * WHAT identifies a handle here. `process.getActiveResourcesInfo()`
 * returns type strings ONLY - there is no public API pairing a resource
 * type with an asyncId - so identity is established three other ways:
 * (1) OBJECT identity across dumps: every handle is tagged `base` at
 * baseline, then `same` (present at baseline) or `NEW` (appeared after
 * baseline) in later dumps - the +1 handle is the NEW line; (2) the
 * underlying fd (`_handle.fd`: the hook child's stdio pipes read as
 * real fds on POSIX; on Windows pipes carry no fd, so the field is
 * absent there and the direction flags carry the identification);
 * (3) direction flags: a stdin socket is writable-only
 * (`readable=false, writable=true`), stdout/stderr are readable.
 * `ref=` is the underlying handle's `hasRef()` - an unref'd handle
 * drops out of the census even with the pipe still open, so a NEW line
 * with `ref=false` cannot be the counted +1.
 */
const PIPE_SURVIVOR_TEST =
  'hooks: a pipe-holding survivor leaves NO child pipe holding the event loop';
let censusBaselineHandles: ReadonlySet<unknown> = new Set();

function describeHandle(handle: unknown): string {
  const h = handle as {
    constructor?: { name?: string };
    _handle?: { constructor?: { name?: string }; fd?: unknown; hasRef?: () => boolean };
    fd?: unknown;
    destroyed?: unknown;
    readable?: unknown;
    writable?: unknown;
    connecting?: unknown;
    pending?: unknown;
  };
  const parts = [h.constructor?.name ?? typeof handle];
  if (h._handle?.constructor?.name) parts.push(`inner=${h._handle.constructor.name}`);
  if (typeof h._handle?.fd === 'number') parts.push(`fd=${h._handle.fd}`);
  else if (typeof h.fd === 'number') parts.push(`fd=${h.fd}`);
  if (typeof h._handle?.hasRef === 'function') parts.push(`ref=${h._handle.hasRef()}`);
  const flags: Array<[string, unknown]> = [
    ['destroyed', h.destroyed],
    ['readable', h.readable],
    ['writable', h.writable],
    ['connecting', h.connecting],
    ['pending', h.pending],
  ];
  for (const [key, value] of flags) {
    if (typeof value === 'boolean') parts.push(`${key}=${value}`);
  }
  return parts.join(' ');
}

function dumpPipeCensus(phase: string): void {
  const resources = process.getActiveResourcesInfo();
  const handles = (
    process as unknown as { _getActiveHandles: () => unknown[] }
  )._getActiveHandles();
  if (phase === 'baseline') censusBaselineHandles = new Set(handles);
  const counts: Record<string, number> = {};
  for (const r of resources) counts[r] = (counts[r] ?? 0) + 1;
  const lines = handles.map((h, i) => {
    const tag = phase === 'baseline' ? 'base' : censusBaselineHandles.has(h) ? 'same' : 'NEW';
    return `  [${i}] ${tag} ${describeHandle(h)}`;
  });
  console.log(
    `[pipe-census][${PIPE_SURVIVOR_TEST}][${phase}] pipeWraps=${counts.PipeWrap ?? 0} resources=${JSON.stringify(resources)}\n${lines.join('\n')}`,
  );
}

/**
 * Bring the process's own stdio Sockets into existence before any
 * PipeWrap baseline is taken.
 *
 * WHY. `process.getActiveResourcesInfo()` lists only handles keeping the
 * event loop alive, and `process.stdout`/`stderr`/`stdin` are created
 * LAZILY: a worker whose stdout Socket does not exist yet reads one
 * fewer PipeWrap than the same worker a moment later. Measured in a fresh
 * piped node process: the census reads 1 PipeWrap before the first stdout
 * touch and 2 right after it - a +1 with no child involved at all. That
 * is exactly the signature branch CI run 42507192367 showed on Windows
 * (5 vs a baseline of 4, stable across both legs), and it is NOT a hook
 * pipe: the hook's three stdio streams are all unref'd at settle
 * (`releaseChildStdio`), and an unref'd handle drops out of this census
 * even when the pipe is still open (measured: unref on a live open stdin
 * socket takes the count from 6 to 5). So no destroy placement - 3d, 3e,
 * 3f - could ever have been the variable, and no fourth one can be
 * either. The baseline must be the process's steady state, so every test
 * in this file warms the stdio up first; a real leaked child pipe is
 * still caught, because the warm-up touches only the process's own
 * stdio, never a child pipe. The mechanism is pinned by the
 * 'pipe census baseline discipline' tests below.
 */
async function warmUpProcessStdio(): Promise<void> {
  void process.stdout;
  void process.stderr;
  void process.stdin;
  // The handle attaches on a later tick than the first access (the first
  // console write's own census still reads the old count), so yield once
  // before any baseline is taken.
  await new Promise((resolve) => setImmediate(resolve));
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
  await warmUpProcessStdio();
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
    // Phase 3h diagnostic: handle-identity dumps at baseline, in flight
    // (~50ms into the hook run, while the hook child is alive or its
    // pipes are still draining), and after settle. The assertion below
    // is unchanged - the dumps are evidence only.
    dumpPipeCensus('baseline');
    const inflight = setTimeout(() => dumpPipeCensus('after-spawn'), 50);
    inflight.unref();
    const started = Date.now();
    await fireHookEvent(s, 'prompt-submit', { prompt: 'x' });
    clearTimeout(inflight);
    dumpPipeCensus('after-settle');
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(holderAlive(pidFile)).toBe(true);
    // Phase 3i: on Windows the after-settle census still lists the hook's
    // DESTROYED stdin socket (destroyed=true, pending=true - CI run
    // 42510887833) while its named-pipe shutdown completes. That handle
    // drains on its own; the test's property is that no pipe is LEFT
    // holding the loop, so wait for quiescence (bounded) and assert on
    // the drained count. A live leaked pipe never drains - see the
    // 'pipe census quiescence' tests below - so this cannot mask one.
    // The 3h dumps above stay: after-settle is the evidence, this dump
    // is the drain.
    // Phase 3j: the 3i wait was falsified on Windows (CI run 42514127594
    // - after-quiescence byte-identical at 2s): the shutdown is gated on
    // the survivor, not slow. The production fix is in src/lib/hooks.ts
    // (write() instead of end(), so no shutdown request is ever
    // started); this wait stays as a guard and returns at once when the
    // fix works.
    const settledCount = await waitForPipeQuiescence(before);
    dumpPipeCensus('after-quiescence');
    expect(settledCount).toBe(before);
  });

  test('hooks: a hook that reads stdin to EOF still receives the full payload', async () => {
    // Phase 3j regression test for the write()-instead-of-end() fix in
    // src/lib/hooks.ts. Destroying the write end must still deliver the
    // payload followed by EOF: a hook that reads stdin to 'end' receives
    // the whole JSON payload and exits promptly. If EOF were never
    // delivered the hook would run to its 5s cap and this test would
    // fail on the elapsed time, not hang the suite.
    const outFile = join(scriptDir, 'reader-got.txt');
    const reader = writeScript(
      'reader-hook.mjs',
      `import { writeFileSync } from 'node:fs';\n` +
        `let d = '';\n` +
        `process.stdin.setEncoding('utf8');\n` +
        `process.stdin.on('data', (c) => { d += c; });\n` +
        `process.stdin.on('end', () => { writeFileSync(${JSON.stringify(outFile)}, d, 'utf8'); });\n`,
    );
    writeFileSync(
      join(configDir, 'hooks.json'),
      JSON.stringify({
        hooks: [
          {
            event: 'prompt-submit',
            command: nodeCmd(reader),
            timeoutSeconds: 5,
          },
        ],
      }),
      'utf8',
    );
    const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(workDir);
    const started = Date.now();
    const r = await fireHookEvent(s, 'prompt-submit', { prompt: 'hello world' });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_500);
    expect(r.notices.some((n) => n.includes('timed out'))).toBe(false);
    expect(existsSync(outFile)).toBe(true);
    const payload = JSON.parse(readFileSync(outFile, 'utf8')) as Record<string, unknown>;
    expect(payload.event).toBe('prompt-submit');
    expect(payload.prompt).toBe('hello world');
    expect(typeof payload.sessionId).toBe('string');
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

describe('pipe census baseline discipline', () => {
  /**
   * Pins the lazy-stdio mechanism behind the `warmUpProcessStdio` call in
   * `beforeEach` - in a FRESH child process, where the worker's own
   * already-materialized stdio cannot hide it. A child that reads its
   * PipeWrap census before touching stdout reads one fewer than the same
   * child right after its first stdout write: the process's own stdout
   * Socket materializes lazily, and that +1 is indistinguishable in a bare
   * count from a leaked child pipe. Warming the stdio up first (touch all
   * three streams, yield a tick) makes the census stable across the same
   * write. If this test ever goes red, the warm-up premise is wrong and
   * the pipe tests' baselines are suspect again - do not "fix" it by
   * deleting the warm-up.
   */
  const CENSUS_CHILD = `
import { writeFileSync } from 'node:fs';
const [outFile, mode] = process.argv.slice(2);
const census = () => process.getActiveResourcesInfo().filter((r) => r === 'PipeWrap').length;
if (mode === 'warm') {
  void process.stdout; void process.stderr; void process.stdin;
  await new Promise((r) => setImmediate(r));
}
const first = census();
console.log('touch');
const second = census();
writeFileSync(outFile, JSON.stringify({ first, second }));
`;
  function runCensusChild(warm: boolean): { first: number; second: number } {
    const script = writeScript('census-child.mjs', CENSUS_CHILD);
    const outFile = join(scriptDir, `census-${warm ? 'warm' : 'cold'}.json`);
    const r = spawnSync(process.execPath, [script, outFile, warm ? 'warm' : 'cold'], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.status).toBe(0);
    return JSON.parse(readFileSync(outFile, 'utf8')) as { first: number; second: number };
  }

  test('a cold census grows by one on first stdout touch; a warmed one is stable', () => {
    const cold = runCensusChild(false);
    expect(cold.second).toBe(cold.first + 1);
    const warm = runCensusChild(true);
    expect(warm.second).toBe(warm.first);
  });
});

describe('pipe census quiescence', () => {
  /**
   * Pins the Phase 3i mechanism behind `waitForPipeQuiescence`, in the
   * exact shape branch CI run 42510887833 showed on Windows: after
   * settle, the hook's stdin socket reads `destroyed=true pending=true`
   * with no handle, its PipeWrap still listed, the child already reaped
   * - and it drains on its own. The first test reproduces that state on
   * Linux (probes `/tmp/phase3i/probe1.mjs`, `probe3.mjs`: the same-tick
   * census after destroy() is elevated by 1 with the socket destroyed
   * and pending, and ~2ms later it is back at baseline with no further
   * action). The second test is the falsifier: a LIVE ref'd pipe never
   * drains, so the wait times out above baseline - a real leak still
   * fails the hooks test. If either test goes red, the quiescence
   * premise is wrong and the hooks test's wait is suspect - do not "fix"
   * it by deleting the wait.
   */
  test('a destroyed socket with a pending write drains on its own; the quiescence wait sees it', async () => {
    const before = activeCount('PipeWrap');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000);'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      child.stdout?.resume();
      child.stderr?.resume();
      await new Promise((resolve) => setTimeout(resolve, 50));
      child.stdin?.on('error', () => {});
      child.stdin?.write('x');
      child.stdin?.destroy();
      // The Windows after-settle signature, in the same tick as the
      // destroy: still counted, destroyed, a shutdown pending, no handle.
      const stdinState = child.stdin as unknown as { destroyed?: boolean; pending?: boolean };
      expect(stdinState.destroyed).toBe(true);
      expect(stdinState.pending).toBe(true);
      expect(activeCount('PipeWrap')).toBeGreaterThan(before);
      // Mirror the hook settle state: read pipes unref'd, child reaped.
      const { releaseChildStdio } = await import('../src/lib/child-stdio.js');
      releaseChildStdio(child);
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once('exit', () => resolve());
      });
      const drained = await waitForPipeQuiescence(before);
      expect(drained).toBe(before);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });

  test('a live refd pipe never reaches quiescence; the wait times out above baseline', async () => {
    const before = activeCount('PipeWrap');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000);'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      child.stdout?.resume();
      child.stderr?.resume();
      await new Promise((resolve) => setTimeout(resolve, 50));
      // All three pipes open, ref'd, child alive: nothing drains.
      expect(activeCount('PipeWrap')).toBeGreaterThan(before);
      const result = await waitForPipeQuiescence(before, 200);
      expect(result).toBeGreaterThan(before);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
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
