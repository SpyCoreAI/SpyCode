/**
 * Terminal light/dark detection for the TUI theme.
 *
 * The `theme` config key ('auto' | 'light' | 'dark', default 'auto') already
 * exists; nothing read it until now. 'auto' probes the terminal's ACTUAL
 * background via an OSC 11 query before Ink mounts (stdin is still in cooked
 * mode there, so the response can be read with a plain timeout). Anything
 * inconclusive falls back to dark - the palette was designed dark-first.
 *
 * Reduced motion is a separate axis: SPYCORE_REDUCED_MOTION=1 swaps the
 * breathing activity indicator for a static one. No animation may exist
 * without this off-ramp.
 */
import type { ThemeMode } from '../theme/tokens.js';

export type ThemeSetting = 'auto' | 'light' | 'dark';

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/**
 * Parse an OSC 11 background-color response. Terminals answer
 * `ESC ] 11 ; rgb:RRRR/GGGG/BBBB (BEL|ST)` with 1-4 hex digits per channel;
 * the most significant byte wins (so `ffff` and `ff` both mean 1.0).
 */
export function parseOsc11Response(data: string): Rgb | null {
  const m = data.match(
    /\]11;rgb:([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})\/([0-9a-fA-F]{1,4})/,
  );
  if (!m) return null;
  const scale = (h: string): number => {
    const byte = h.length >= 2 ? h.slice(0, 2) : h + h;
    return parseInt(byte, 16) / 255;
  };
  return { r: scale(m[1]!), g: scale(m[2]!), b: scale(m[3]!) };
}

/** Relative luminance; above one half the background reads as light. */
export function isLightBackground({ r, g, b }: Rgb): boolean {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5;
}

/** Resolve the effective theme mode from the config setting + probe result. */
export function resolveThemeMode(
  setting: ThemeSetting,
  probed: ThemeMode | null,
): ThemeMode {
  if (setting === 'light') return 'light';
  if (setting === 'dark') return 'dark';
  return probed ?? 'dark';
}

export function detectReducedMotion(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = (env.SPYCORE_REDUCED_MOTION ?? '').toLowerCase();
  return v === '1' || v === 'true';
}

/**
 * Ask the terminal for its background color (OSC 11). MUST be called before
 * Ink mounts - afterwards stdin is in raw mode and owned by Ink's input
 * handler. Resolves null on timeout, non-TTY, or an unparseable answer.
 *
 * Deliberate tradeoff, documented honestly: while the probe listens (at most
 * `timeoutMs`, default 250ms, only when `theme` is `auto`), keystrokes the
 * user types are consumed by the probe's discard buffer and NEVER replayed.
 * Replaying them would mean feeding bytes back into Ink's stdin pipeline
 * after mount - risking double-processing and ordering bugs worse than
 * losing a few startup keystrokes. The window is tiny, startup-only, and
 * bounded; hard rule #5 ("never eat a keystroke") holds everywhere else.
 */
export async function probeTerminalBackground(
  timeoutMs = 250,
): Promise<ThemeMode | null> {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    return null;
  }
  // Never probe a dumb terminal: it would render the OSC 11 query as garbage.
  if (process.env.TERM === 'dumb') {
    return null;
  }
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let buffer = '';
    let done = false;
    const finish = (value: ThemeMode | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      try {
        (stdin as unknown as { setRawMode?: (mode: boolean) => void }).setRawMode?.(false);
      } catch {
        /* never break startup */
      }
      try {
        stdin.pause();
      } catch {
        /* never break startup */
      }
      resolve(value);
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const rgb = parseOsc11Response(buffer);
      if (rgb) finish(isLightBackground(rgb) ? 'light' : 'dark');
      // Bound the buffer: a terminal that chatters without ever answering
      // must not grow this unboundedly.
      if (buffer.length > 4096) finish(null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    // Unref so a hung probe can never hold the process open by itself.
    (timer as unknown as { unref?: () => void }).unref?.();
    stdin.on('data', onData);
    stdin.resume();
    // The terminal's answer carries no newline, so canonical mode would
    // buffer it until the user pressed Enter - raw mode is required to
    // receive it. Restored in finish(), whatever the outcome.
    try {
      (stdin as unknown as { setRawMode?: (mode: boolean) => void }).setRawMode?.(true);
    } catch {
      /* non-TTY-ish stdin - the write below still resolves via timeout */
    }
    try {
      process.stdout.write('\x1b]11;?\x1b\\');
    } catch {
      finish(null);
    }
  });
}
