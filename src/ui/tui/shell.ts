/**
 * `!` shell mode: run the user's own shell command directly, with no agent
 * and no approval gate - exactly as if typed at their own prompt. Output is
 * capped (collapse.ts) so a runaway command cannot flood the transcript.
 * Never throws: failures come back as a result with `ok: false`.
 */
import { execFile } from 'node:child_process';
import { releaseChildStdio, STDIO_DRAIN_MS } from '../../lib/child-stdio.js';
import { capShellOutput } from './collapse.js';

export interface ShellResult {
  /** The command that ran (echoed, sanitized by the caller). */
  command: string;
  ok: boolean;
  /** Capped stdout+stderr text. */
  output: string;
  truncated: boolean;
  /** e.g. 'exit 0 (1.2s)' / 'exit 1 (0.3s)' / 'timed out after 120s'. */
  statusLabel: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** Hard cap on raw bytes accumulated from child stdio (maxBuffer is dead without a callback). */
const MAX_RAW_BYTES = 256 * 1024;

export function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const elapsed = (): string => `${((Date.now() - started) / 1000).toFixed(1)}s`;
    let child;
    try {
      // The user's own shell: inherit nothing, capture everything.
      // Windows has no `sh` — use the system command interpreter there.
      const shellCmd =
        process.platform === 'win32'
          ? { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
          : { file: 'sh', args: ['-c', command] };
      child = execFile(shellCmd.file, shellCmd.args, {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        signal,
      });
    } catch {
      resolve({
        command,
        ok: false,
        output: 'could not start the shell',
        truncated: false,
        statusLabel: `failed (${elapsed()})`,
      });
      return;
    }
    let out = '';
    let settled = false;
    let drainTimer: ReturnType<typeof setTimeout> | null = null;
    // Settle once, on whatever arrives first. 'close' waits for EVERY
    // inherited pipe to shut - a backgrounded descendant (`sleep 60 &`)
    // holds it open forever - so the process being gone ('exit') plus a
    // short drain is the bound that cannot outlive the child.
    let finish = (code: number | null, signal: NodeJS.Signals | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      if (drainTimer) clearTimeout(drainTimer);
      releaseChildStdio(child);
      const capped = capShellOutput(out);
      if (spawnError) {
        resolve({
          command,
          ok: false,
          output: capped.text || 'could not start the shell',
          truncated: capped.truncated,
          statusLabel: `failed (${elapsed()})`,
        });
        return;
      }
      if (signal === 'SIGTERM') {
        resolve({
          command,
          ok: false,
          output: capped.text,
          truncated: capped.truncated,
          statusLabel: `timed out after ${Math.round(timeoutMs / 1000)}s`,
        });
        return;
      }
      resolve({
        command,
        ok: code === 0,
        output: capped.text,
        truncated: capped.truncated,
        statusLabel: `exit ${code ?? '?'} (${elapsed()})`,
      });
    };
    child.stdout?.on('data', (d: Buffer) => {
      // Cap during accumulation: maxBuffer is dead config without a callback,
      // so bound it here to avoid OOM on runaway commands (`!yes`).
      if (out.length < MAX_RAW_BYTES) out += d.toString('utf8').slice(0, MAX_RAW_BYTES - out.length);
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (out.length < MAX_RAW_BYTES) out += d.toString('utf8').slice(0, MAX_RAW_BYTES - out.length);
    });
    child.on('error', (err) => {
      finish(null, null, err.message);
    });
    child.on('exit', (code, signal) => {
      if (settled || drainTimer) return;
      drainTimer = setTimeout(() => finish(code, signal, null), STDIO_DRAIN_MS);
    });
    child.on('close', (code, signal) => {
      finish(code, signal, null);
    });
    // SIGKILL escalation: execFile's timeout sends SIGTERM once. If the child
    // ignores it (trap '' TERM), the promise would hang forever. Escalate.
    const killTimer = setTimeout(() => {
      if (!settled && child.exitCode === null) {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
        // Force-settle even if 'close' never fires.
        const forceTimer = setTimeout(() => {
          finish(null, 'SIGKILL', null);
        }, 2000);
        forceTimer.unref?.();
      }
    }, timeoutMs + 5000);
    killTimer.unref?.();
    // Ensure the kill timer doesn't fire after normal settlement.
    const _finish = finish;
    finish = (code, signal, spawnError) => {
      clearTimeout(killTimer);
      _finish(code, signal, spawnError);
    };
  });
}
