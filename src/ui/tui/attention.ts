/**
 * Attention signals: the terminal bell plus a best-effort OS notification.
 *
 * The TUI is designed to be looked away from during long runs: an approval
 * request ALWAYS rings the bell (action required), and a completed run rings
 * it too. The OS notification fires only when the terminal is blurred (or
 * focus state is unknown and cannot be determined) — no point notifying
 * someone staring at the terminal. It is fire-and-forget and can never throw,
 * block, or delay the session. No bundled sound files at v1.
 */
import { spawn } from 'node:child_process';

/** Tracks terminal focus via DEC 1004 focus reports. Defaults to focused. */
let blurred = false;
let focusTracking = false;

export function isTerminalBlurred(): boolean {
  return blurred;
}

/** Enable DEC 1004 focus reporting; call once at startup. Safe no-op if unsupported. */
export function enableFocusTracking(): void {
  if (focusTracking || process.stdin.isTTY !== true) return;
  focusTracking = true;
  try {
    process.stdout.write('\x1b[?1004h');
    const onData = (data: Buffer): void => {
      const s = data.toString('utf8');
      if (s.includes('\x1b[I')) blurred = false;
      else if (s.includes('\x1b[O')) blurred = true;
    };
    process.stdin.on('data', onData);
  } catch {
    /* focus tracking is best-effort */
  }
}

/** Disable DEC 1004 focus reporting; call on shutdown. */
export function disableFocusTracking(): void {
  if (!focusTracking) return;
  focusTracking = false;
  try {
    process.stdout.write('\x1b[?1004l');
  } catch {
    /* best-effort */
  }
}

export function ringBell(): void {
  try {
    process.stdout.write('\x07');
  } catch {
    /* a bell must never break the session */
  }
}

/**
 * Best-effort desktop notification. Fires only when the terminal is blurred
 * (no point notifying someone staring at the terminal). Detached + unref'd
 * with ignored stdio so it can never hold the event loop; every failure path
 * is swallowed by design. (Same shape as lib/browser.ts: spawn + stdio
 * 'ignore' + unref.)
 */
export function notifyUser(title: string, body: string): void {
  if (process.env.SPYCORE_NO_NOTIFY === '1') return;
  if (!isTerminalBlurred()) return;
  try {
    let child;
    const opts = { detached: true, stdio: 'ignore' as const, windowsHide: true };
    if (process.platform === 'darwin') {
      child = spawn(
        'osascript',
        [
          '-e',
          `display notification ${JSON.stringify(body.slice(0, 200))} with title ${JSON.stringify(title.slice(0, 80))}`,
        ],
        opts,
      );
    } else if (process.platform === 'linux') {
      child = spawn('notify-send', [title.slice(0, 80), body.slice(0, 200)], opts);
    } else {
      return;
    }
    child.unref();
    child.on('error', () => {
      /* helper missing - silently nothing */
    });
  } catch {
    /* never break the session */
  }
}
