/**
 * Parse a `--limit` / `--page` style numeric CLI flag.
 *
 * `Number('abc')` is NaN, and NaN sails straight through Math.max/Math.min
 * - `--limit abc` used to yield an empty list (`slice(0, NaN)`), `--page
 * abc` requested `page=NaN`, and `conversations show --limit abc` sliced
 * `-NaN` (every message). Non-numeric input is an error now, not a silent
 * wrong result. A numeric value outside [min, max] still clamps, as
 * before - only the unparseable case errors.
 */
import { EXIT_USER_ERROR, SpycoreCliError } from './errors.js';

export function parseIntFlag(
  raw: string | undefined,
  flag: string,
  opts: { min: number; max?: number; defaultValue: number },
): number {
  if (raw === undefined) return opts.defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new SpycoreCliError(
      `Invalid --${flag}: "${raw}" is not a positive integer.`,
      EXIT_USER_ERROR,
      `Pass --${flag} <n> with ${opts.min} <= n${opts.max !== undefined ? ` <= ${opts.max}` : ''}.`,
    );
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) {
    throw new SpycoreCliError(
      `Invalid --${flag}: "${raw}" is too large.`,
      EXIT_USER_ERROR,
      `Pass --${flag} <n> with ${opts.min} <= n${opts.max !== undefined ? ` <= ${opts.max}` : ''}.`,
    );
  }
  const upper = opts.max ?? Number.POSITIVE_INFINITY;
  return Math.max(opts.min, Math.min(upper, n));
}
