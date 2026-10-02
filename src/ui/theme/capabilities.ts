/**
 * Terminal capability detection: TTY-ness, color level, dimensions and Unicode
 * support. Honors NO_COLOR and FORCE_COLOR. No React here — pure functions so
 * they can be unit-tested with injected env/stream objects.
 */
import type { ColorLevel } from './tokens.js';

export interface TerminalCapabilities {
  isTTY: boolean;
  colorLevel: ColorLevel;
  columns: number;
  rows: number;
  unicode: boolean;
}

interface StreamLike {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}
interface DetectInput {
  stream?: StreamLike;
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;

/**
 * Resolve the supported color level. Precedence:
 *   1. NO_COLOR present  → none (accessibility wins, regardless of value).
 *   2. FORCE_COLOR set    → explicit level.
 *   3. Not a TTY          → none.
 *   4. COLORTERM/TERM heuristics → truecolor / 256 / 16.
 */
export function detectColorLevel(
  env: NodeJS.ProcessEnv = process.env,
  stream: StreamLike = process.stdout,
): ColorLevel {
  // NO_COLOR: https://no-color.org — presence disables color regardless of value.
  if (env.NO_COLOR !== undefined) return 'none';

  const force = env.FORCE_COLOR;
  if (force !== undefined) {
    if (force === '0' || force === 'false' || force === '') return 'none';
    if (force === '1' || force === 'true') return 'ansi16';
    if (force === '2') return 'ansi256';
    return 'truecolor'; // '3' or any other truthy value
  }

  if (!stream.isTTY) return 'none';

  const colorterm = env.COLORTERM ?? '';
  if (colorterm === 'truecolor' || colorterm === '24bit') return 'truecolor';

  const term = env.TERM ?? '';
  if (term === 'dumb') return 'none';
  if (/-?256(color)?\b/.test(term)) return 'ansi256';
  if (colorterm !== '') return 'ansi16';
  if (term !== '') return 'ansi16';
  return 'none';
}

/**
 * Best-effort Unicode support. Modern *nix terminals are UTF-8; honor an
 * explicit non-UTF locale. On Windows only assume Unicode for known-good hosts
 * (Windows Terminal, VS Code, ConEmu).
 */
export function detectUnicode(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.TERM === 'dumb') return false;
  if (process.platform !== 'win32') {
    const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? '';
    if (locale !== '' && !/UTF-?8/i.test(locale)) return false;
    return true;
  }
  return Boolean(env.WT_SESSION || env.TERM_PROGRAM === 'vscode' || env.ConEmuTask);
}

export function detectCapabilities(input: DetectInput = {}): TerminalCapabilities {
  const env = input.env ?? process.env;
  const stream = input.stream ?? process.stdout;
  const columns =
    typeof stream.columns === 'number' && stream.columns > 0
      ? stream.columns
      : DEFAULT_COLUMNS;
  const rows =
    typeof stream.rows === 'number' && stream.rows > 0 ? stream.rows : DEFAULT_ROWS;
  return {
    isTTY: Boolean(stream.isTTY),
    colorLevel: detectColorLevel(env, stream),
    columns,
    rows,
    unicode: detectUnicode(env),
  };
}
