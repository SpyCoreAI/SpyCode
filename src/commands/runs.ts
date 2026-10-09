import { Command, Option } from 'commander';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigPath } from '../lib/config.js';
import { formatOption, getOutputOptions, json, print, resolveFormat, success, warn } from '../lib/output.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../lib/errors.js';
import { sanitizeForDisplay } from '../lib/sanitize-display.js';

/*
 * F14 - DETACHED / HOSTED RUNS (client-local scaffolding).
 * =========================================================
 *
 * What exists today: `spycore agent --detached` starts the agent in a
 * background child process on THIS machine (nohup-style, stdio redirected to
 * a log file) and `spycore runs {list,attach,kill}` manages those local
 * children. That is the whole scope of this file - everything here is
 * client-local and invents no server behavior.
 *
 * PLATFORM API GAPS (true hosted runs, NOT implemented):
 * -------------------------------------------------------
 * A "run it on SpyCore's infra and hand me a run id" feature needs server
 * endpoints the platform API does not expose yet. When they land, the client
 * should:
 *   - POST   /api/runs          { task, model, provider, budgets, … } → run id
 *   - GET    /api/runs          → list the caller's runs (status, progress)
 *   - GET    /api/runs/:id      → run detail (status, exit code, summary)
 *   - GET    /api/runs/:id/logs → tail/stream the run's transcript (SSE?)
 *   - DELETE /api/runs/:id      → cancel a running run
 *   plus, to be usable: auth scoping for BYOK secrets on hosted runners,
 *   workspace snapshotting (what code does the hosted run see?), and artifact
 *   retrieval (diffs, files written). Until those exist, `--detached` below is
 *   deliberately a local-process shim and says so in its help text.
 */

// ---------------------------------------------------------------------------
// Local run store
// ---------------------------------------------------------------------------

export type DetachedRunStatus =
  | 'running'
  | 'done'
  | 'failed'
  | 'killed'
  | 'exited';

export interface DetachedRunRecord {
  id: string;
  task: string;
  cwd: string;
  pid: number | null;
  status: DetachedRunStatus;
  exitCode: number | null;
  startedAt: string;
  updatedAt: string;
  logFile: string;
  /** The exact argv the detached child was started with (for debugging). */
  argv: string[];
  /**
   * System boot time in ms since epoch when the run was launched (B1).
   * `runs kill` refuses to signal the pid when the current boot time
   * differs - after a reboot the pid may have been recycled by the OS
   * and belong to an unrelated process. Null when the boot time could
   * not be determined (old records predate this field).
   */
  bootTimeMs: number | null;
}

const DETACHED_RUN_ENV = 'SPYCORE_DETACHED_RUN_ID';
const MAX_TASK_SNIPPET = 120;

/**
 * System boot time in ms since epoch, or null when it cannot be determined.
 * Used as a staleness anchor for run records (B1): PIDs are recycled by the
 * OS, so after a reboot a recorded pid may belong to an unrelated process.
 */
export function getSystemBootTimeMs(): number | null {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync('/proc/stat', 'utf-8');
      const m = stat.match(/^btime (\d+)$/m);
      if (m) return Number(m[1]) * 1000;
    } else if (process.platform === 'darwin') {
      // sysctl -n kern.boottime -> "{ sec = 1234567890, usec = 0 } Thu Jan  1 ..."
      const out = execFileSync('sysctl', ['-n', 'kern.boottime'], { encoding: 'utf-8' });
      const m = out.match(/sec = (\d+)/);
      if (m) return Number(m[1]) * 1000;
    }
  } catch {
    // fall through to null
  }
  return null;
}

/**
 * Runtime type guard for run records (m1). A hand-edited or corrupt record
 * with wrong field types must not reach `process.kill` as a TypeError.
 */
function isDetachedRunRecord(v: unknown): v is DetachedRunRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.task === 'string' &&
    typeof r.cwd === 'string' &&
    (typeof r.pid === 'number' || r.pid === null) &&
    typeof r.status === 'string' &&
    ['running', 'done', 'failed', 'killed', 'exited'].includes(r.status as string) &&
    (typeof r.exitCode === 'number' || r.exitCode === null) &&
    typeof r.startedAt === 'string' &&
    typeof r.updatedAt === 'string' &&
    typeof r.logFile === 'string' &&
    Array.isArray(r.argv) &&
    (typeof r.bootTimeMs === 'number' || r.bootTimeMs === null || r.bootTimeMs === undefined)
  );
}

function runsDir(create = true): string {
  const dir = join(dirname(getConfigPath()), 'runs');
  if (create) mkdirSync(dir, { recursive: true });
  return dir;
}

function recordPath(id: string): string {
  // n1: reads must not create directories - only the launch path creates.
  return join(runsDir(false), `${id}.json`);
}

function isValidRunId(id: string): boolean {
  // run ids are generated below as `run_` + hex; the check keeps `attach` /
  // `kill` from reading arbitrary files via path traversal.
  return /^run_[0-9a-f]{12}$/.test(id);
}

function readRecord(id: string): DetachedRunRecord | null {
  if (!isValidRunId(id)) return null;
  try {
    const raw = readFileSync(recordPath(id), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    // m1: reject records with wrong field types instead of crashing later
    // in process.kill with a TypeError.
    return isDetachedRunRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeRecord(rec: DetachedRunRecord): void {
  const next: DetachedRunRecord = {
    ...rec,
    updatedAt: new Date().toISOString(),
  };
  // M3: run records hold the task snippet and full replayed argv, which may
  // contain pasted secrets - 0600 like projects.json, not umask-default.
  // Atomic write via tmp+rename (m4): a crash mid-write must not leave a
  // torn record.
  const path = recordPath(rec.id);
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch {
    // rename failed - try direct write as fallback, then clean up tmp
    writeFileSync(path, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
  }
}

function updateRunRecord(id: string, patch: Partial<DetachedRunRecord>): void {
  const rec = readRecord(id);
  if (!rec) return;
  writeRecord({ ...rec, ...patch });
}

/**
 * True while the recorded pid still refers to a live process. ESRCH means
 * the pid is gone; EPERM means it exists but belongs to another user. PID
 * reuse is a known client-local limitation - the child's own exit handler
 * (finishDetachedRun) is the authoritative status writer; this is only a
 * best-effort liveness probe for `runs list`.
 */
export function isRunAlive(rec: DetachedRunRecord): boolean {
  if (typeof rec.pid !== 'number' || rec.pid <= 0) return false;
  try {
    process.kill(rec.pid, 0);
    return true;
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    return code === 'EPERM';
  }
}

function refreshStatus(rec: DetachedRunRecord): DetachedRunRecord {
  if (rec.status === 'running' && !isRunAlive(rec)) {
    const next = { ...rec, status: 'exited' as DetachedRunStatus };
    try {
      // m3: a full disk must not crash `runs list` - the in-memory
      // reconciliation still applies; the write is best-effort.
      writeRecord(next);
    } catch {
      // fall through with the in-memory status
    }
    return next;
  }
  return rec;
}

export function listDetachedRuns(): DetachedRunRecord[] {
  let files: string[] = [];
  try {
    files = readdirSync(runsDir());
  } catch {
    return [];
  }
  const recs: DetachedRunRecord[] = [];
  for (const f of files) {
    if (!f.startsWith('run_') || !f.endsWith('.json')) continue;
    const rec = readRecord(f.slice(0, -'.json'.length));
    if (rec) recs.push(refreshStatus(rec));
  }
  recs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  return recs;
}

// ---------------------------------------------------------------------------
// Launching a detached run
// ---------------------------------------------------------------------------

/**
 * Resolve the CLI entry point the detached child should execute. Installed
 * packages always ship build/index.js next to this file's build/commands/
 * sibling; a dev checkout falls back to re-invoking the same loader chain
 * (e.g. tsx) the user used, so `pnpm dev agent --detached …` works too.
 * Returns the argv slice to append after `process.execPath`.
 */
function resolveCliEntry(): string[] {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(thisDir, '..', '..');
  const built = join(pkgRoot, 'build', 'index.js');
  if (existsSync(built)) return [built];
  // dev: re-invoke via the same loader chain (e.g. tsx) the user used
  const invoked = process.argv[1];
  if (!invoked) {
    throw new SpycoreCliError(
      'Cannot determine the CLI entry point for a detached run.',
      EXIT_USER_ERROR,
    );
  }
  return [...process.execArgv, invoked];
}

/**
 * Remove the `--detached` flag from argv for the child replay (M2).
 * Only occurrences BEFORE a `--` separator are removed - anything after
 * `--` is literal task text (e.g. `spycore agent --detached -- document
 * the --detached flag`) and must be preserved verbatim. Removing all
 * occurrences unconditionally would silently corrupt the task.
 */
function stripDetachedFlag(args: string[]): string[] {
  const sepIdx = args.indexOf('--');
  const searchEnd = sepIdx === -1 ? args.length : sepIdx;
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (i < searchEnd && arg === '--detached') continue;
    result.push(arg);
  }
  return result;
}

function newRunId(): string {
  return `run_${randomBytes(6).toString('hex')}`;
}

/**
 * Start the SAME agent invocation as a detached background child: stdio goes
 * to `<runsDir>/<id>.log`, the child unrefs so the parent can exit, and a
 * JSON record tracks pid/status. The parent prints the run id and exits 0 -
 * launching is fire-and-forget; the child's own exit is what determines
 * done/failed (see noteDetachedChild).
 */
export async function launchDetachedRun(
  rawArgs: string[],
  task: string,
): Promise<void> {
  const id = newRunId();
  const dir = runsDir();
  const logFile = join(dir, `${id}.log`);

  // Replay the exact invocation minus `--detached`, so the child behaves as
  // if the user had run the same command in the foreground.
  const childArgs = stripDetachedFlag(rawArgs);
  const entry = resolveCliEntry();

  // M3: the log captures the full agent transcript, which may contain pasted
  // secrets - 0600, not umask-default.
  const logStream = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
  await new Promise<void>((resolveStream, rejectStream) => {
    logStream.on('open', () => resolveStream());
    logStream.on('error', rejectStream);
  });
  const logFd = (logStream as unknown as { fd: number }).fd;

  const child = spawn(process.execPath, [...entry, ...childArgs], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    cwd: process.cwd(),
    env: { ...process.env, [DETACHED_RUN_ENV]: id },
  });
  child.unref();
  logStream.end();

  writeRecord({
    id,
    task: task.length > MAX_TASK_SNIPPET ? `${task.slice(0, MAX_TASK_SNIPPET)}…` : task,
    cwd: process.cwd(),
    pid: child.pid ?? null,
    status: 'running',
    exitCode: null,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logFile,
    argv: childArgs,
    // B1: staleness anchor - `runs kill` refuses to signal when the system
    // has rebooted since launch (pid may have been recycled).
    bootTimeMs: getSystemBootTimeMs(),
  });

  // m2: if the child already exited before the record landed, the exit hook
  // (noteDetachedChild) had no record to update - reconcile immediately.
  if (child.exitCode !== null) {
    updateRunRecord(id, {
      status: child.exitCode === 0 ? 'done' : 'failed',
      exitCode: child.exitCode,
    });
  }

  if (getOutputOptions().json) {
    json({ id, status: 'running', logFile });
    return;
  }
  success(`Detached run started: ${id}`);
  print(`  log: ${sanitizeForDisplay(logFile)}`);
  print(`  Follow with: spycore runs attach ${id}`);
}

// ---------------------------------------------------------------------------
// Bookkeeping inside the detached child
// ---------------------------------------------------------------------------

/**
 * Called at the top of the agent command's action. In a normal foreground
 * invocation the env var is unset and this is a no-op. Inside a detached
 * child it marks the run `running` and installs a process-exit hook that
 * records the child's real exit code - the authoritative status writer.
 * A `killed` status set by `runs kill` is never downgraded back.
 */
export function noteDetachedChild(): void {
  const id = process.env[DETACHED_RUN_ENV];
  if (!id || !isValidRunId(id)) return;
  // n2: defense-in-depth - only claim the record if its pid matches ours (or
  // is unset). A stale SPYCORE_DETACHED_RUN_ID lingering in a shell's
  // environment must not let a foreground `spycore agent` hijack another
  // run's record.
  const rec = readRecord(id);
  if (rec && rec.pid !== null && rec.pid !== process.pid) return;
  updateRunRecord(id, { status: 'running', pid: process.pid });
  process.on('exit', (code) => {
    try {
      const rec = readRecord(id);
      if (!rec || rec.status !== 'running') return;
      writeRecord({
        ...rec,
        status: code === 0 ? 'done' : 'failed',
        exitCode: code,
      });
    } catch {
      // exit handlers must never throw
    }
  });
}

// ---------------------------------------------------------------------------
// `spycore runs` command
// ---------------------------------------------------------------------------

function resolveRunOrThrow(id: string): DetachedRunRecord {
  const rec = readRecord(id);
  if (!rec) {
    throw new SpycoreCliError(
      `No detached run '${sanitizeForDisplay(id)}'.`,
      EXIT_USER_ERROR,
      'List runs with `spycore runs list`.',
    );
  }
  return refreshStatus(rec);
}

function statusChip(status: DetachedRunStatus): string {
  switch (status) {
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'failed':
      return 'failed';
    case 'killed':
      return 'killed';
    case 'exited':
      return 'exited (pid gone, no exit recorded)';
  }
}

function printRunsTable(recs: DetachedRunRecord[]): void {
  if (recs.length === 0) {
    print('No detached runs.');
    print('Start one with: spycore agent --detached "<task>"');
    return;
  }
  for (const rec of recs) {
    const task = sanitizeForDisplay(rec.task);
    const exit = rec.exitCode === null ? '' : ` exit=${rec.exitCode}`;
    print(`${rec.id}  ${statusChip(rec.status)}${exit}  pid=${rec.pid ?? '—'}`);
    print(`    ${task}`);
  }
}

interface AttachOpts {
  lines?: string;
  follow?: boolean;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

/**
 * Print the run's log and, with --follow (default), keep printing new bytes
 * until the run leaves `running` and the log is drained. Ctrl-C stops the
 * attach only - the detached run keeps going (that is the point of it).
 */
async function attachRun(rec: DetachedRunRecord, opts: AttachOpts): Promise<void> {
  const follow = opts.follow !== false;
  const maxLines = Math.max(0, Number(opts.lines ?? 50) || 0);

  let offset = 0;
  const printNewBytes = (): void => {
    let data: Buffer;
    try {
      data = readFileSync(rec.logFile);
    } catch {
      return;
    }
    if (data.length <= offset) return;
    const chunk = data.subarray(offset).toString('utf-8');
    offset = data.length;
    // The log carries raw agent output (model narration, tool results, MCP
    // text) - it bypassed every display boundary on the way in. Sanitize
    // here so OSC-52 clipboard writes, CSI cursor moves, and fake-prompt
    // line rewrites from a hostile run cannot drive the terminal.
    process.stdout.write(sanitizeForDisplay(chunk));
  };

  if (maxLines > 0) {
    let data = Buffer.alloc(0);
    try {
      data = readFileSync(rec.logFile);
    } catch {
      // log not written yet - fall through to follow
    }
    const lines = data.toString('utf-8').split('\n');
    const tail = lines.slice(-maxLines).join('\n');
    process.stdout.write(tail.length > 0 ? `${sanitizeForDisplay(tail)}\n` : '');
    offset = data.length;
  }

  if (!follow) return;

  let current = refreshStatus(rec);
  while (current.status === 'running') {
    printNewBytes();
    await sleep(500);
    current = refreshStatus(current);
  }
  printNewBytes();
  print(`\nRun ${rec.id} ${statusChip(current.status)}.`);
}

export function registerRunsCommand(program: Command): void {
  const runs = program
    .command('runs')
    .description(
      'Manage detached agent runs (local background processes; hosted runs are not yet available)',
    );

  runs
    .command('list')
    .description('List detached agent runs started with `spycore agent --detached`')
    .addOption(formatOption())
    .action((opts: { format?: string }) => {
      const recs = listDetachedRuns();
      if (resolveFormat(opts.format) === 'json') {
        json(recs);
        return;
      }
      printRunsTable(recs);
    });

  runs
    .command('attach <id>')
    .description("Tail a detached run's log output (Ctrl-C detaches; the run keeps going)")
    .addOption(new Option('--lines <n>', 'Print the last N log lines before following').default('50'))
    .addOption(new Option('--no-follow', 'Print the log tail and exit instead of following'))
    .action(async (id: string, opts: AttachOpts) => {
      const rec = resolveRunOrThrow(id);
      if (getOutputOptions().json) {
        json(rec);
        return;
      }
      await attachRun(rec, opts);
    });

  runs
    .command('kill <id>')
    .description('Stop a detached run (SIGTERM, escalates to SIGKILL)')
    .action(async (id: string) => {
      const rec = resolveRunOrThrow(id);
      if (rec.status !== 'running') {
        warn(`Run ${rec.id} is already ${statusChip(rec.status)} - nothing to kill.`);
        return;
      }
      if (rec.pid === null) {
        throw new SpycoreCliError(
          `Run ${rec.id} has no recorded pid.`,
          EXIT_USER_ERROR,
          'The run record is incomplete; remove it from the runs directory manually.',
        );
      }
      // B1: PID reuse guard. If the system rebooted since the run launched,
      // the recorded pid may now belong to an unrelated process - refuse.
      // Records predating the boot-time anchor cannot be verified either.
      const bootNow = getSystemBootTimeMs();
      if (rec.bootTimeMs == null || bootNow == null) {
        throw new SpycoreCliError(
          `Run ${rec.id} cannot be safely killed: no boot-time anchor to verify the pid is still the agent.`,
          EXIT_USER_ERROR,
          'The run record predates pid-reuse protection. Verify the process manually (e.g. `ps`) and remove the record file if stale.',
        );
      }
      if (bootNow !== rec.bootTimeMs) {
        throw new SpycoreCliError(
          `Run ${rec.id} was started before the last system boot - its pid (${rec.pid}) may have been reused by an unrelated process. Refusing to kill.`,
          EXIT_USER_ERROR,
          'Verify the process manually and remove the stale record file.',
        );
      }
      // M4: SIGTERM, verify death, escalate to SIGKILL. The status is only
      // set to `killed` after the process is actually gone.
      // M1: signal the process GROUP (negative pid) so direct children
      // (shell commands not in their own group) die too. MCP/LSP servers
      // run in their own groups - the agent's SIGTERM handler shuts those
      // down orderly via shutdownAllMcpClients/shutdownLspManagers.
      const pid = rec.pid;
      const sigtermTargets = [pid, -pid];
      let signaled = false;
      for (const target of sigtermTargets) {
        try {
          process.kill(target, 'SIGTERM');
          signaled = true;
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          if (code === 'ESRCH') continue;
          if (code === 'EPERM') {
            throw new SpycoreCliError(
              `No permission to signal pid ${pid} (run ${rec.id}). It may belong to another user.`,
              EXIT_USER_ERROR,
            );
          }
          throw err;
        }
      }
      if (!signaled) {
        // Already gone - reconcile and report.
        updateRunRecord(rec.id, { status: 'exited' });
        success(`Run ${rec.id} had already exited.`);
        return;
      }
      // Wait up to 5s for graceful exit, then SIGKILL.
      const deadline = Date.now() + 5000;
      let alive = true;
      while (Date.now() < deadline) {
        await sleep(200);
        try {
          process.kill(pid, 0);
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          if (code === 'ESRCH') {
            alive = false;
            break;
          }
          if (code === 'EPERM') break; // exists but not ours - stop waiting
        }
      }
      if (alive) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (err) {
          const code = (err as { code?: unknown }).code;
          if (code !== 'ESRCH') throw err;
        }
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // group may already be gone
        }
        // Brief grace for SIGKILL to land.
        await sleep(500);
        try {
          process.kill(pid, 0);
        } catch (err) {
          if ((err as { code?: unknown }).code === 'ESRCH') alive = false;
        }
      }
      if (!alive) {
        updateRunRecord(rec.id, { status: 'killed' });
      } else {
        // m4: don't lie - if it's still alive, say so.
        warn(`Run ${rec.id} (pid ${pid}) did not exit after SIGKILL - still running.`);
        return;
      }
      if (getOutputOptions().json) {
        json({ id: rec.id, status: 'killed' });
        return;
      }
      success(`Killed detached run ${rec.id}.`);
    });
}
