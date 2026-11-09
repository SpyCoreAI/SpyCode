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
        // Raw bytes, not pre-decoded strings: with the default `utf8`
        // encoding Node decodes each chunk through its own StringDecoder
        // and hands this code strings, so a byte budget counted in
        // `out.length` was really a UTF-16-unit budget under a BYTES name
        // (262,144 astral chars ≈ 1 MiB of UTF-8). Taking Buffers makes
        // the code own the bytes and the single decode below.
        encoding: 'buffer',
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
    // R1 pass 3 - accumulate RAW BYTES, decode ONCE at settle. The old
    // code decoded each `data` chunk independently AND counted the budget
    // in UTF-16 code units against a constant named MAX_RAW_BYTES. (As
    // written, `execFile`'s default utf8 encoding meant Node's own
    // StringDecoder had already joined sequences split across chunk
    // events before this code saw them, so the U+FFFD half of the finding
    // did not reproduce through this path - but the budget half did: the
    // cap admitted up to ~1 MiB of astral text under a 256 KiB name.
    // Taking Buffers via `encoding: 'buffer'` above makes this code own
    // both the bytes and the decode, so neither half can regress.)
    // Chunks are sliced in BYTES here; the single `toString('utf8')` in
    // `finish` is what makes chunk boundaries invisible. (A sequence cut
    // by the byte cap itself still ends as U+FFFD - the bytes past the cap
    // are gone, so no decoder could complete it.)
    const outChunks: Buffer[] = [];
    let outBytes = 0;
    const takeChunk = (d: Buffer): void => {
      if (outBytes >= MAX_RAW_BYTES) return;
      const take = d.subarray(0, MAX_RAW_BYTES - outBytes);
      outChunks.push(Buffer.from(take));
      outBytes += take.length;
    };
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
      const out = Buffer.concat(outChunks).toString('utf8');
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
      takeChunk(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      takeChunk(d);
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
