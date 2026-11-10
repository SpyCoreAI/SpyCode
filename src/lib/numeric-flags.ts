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

/**
 * Strict positive-integer flag parsing for the runaway-guard flags
 * (--max-turns, --max-tool-calls-per-turn, --cmd-timeout, --max-tokens,
 * --max-time). Unlike parseIntFlag above (which clamps) and
 * resolveMaxTurns (which silently falls back to the default), an
 * unparseable or out-of-range value is an error: `--max-turns abc` or
 * `0` must never silently become 25, and a cap must never silently go
 * uncapped.
 *
 * Shared by src/commands/agent.ts and src/commands/acp.ts (deduped
 * 2026-11-09: the two local copies were byte-identical).
 */
export function parseStrictIntFlag(
  raw: string | undefined,
  flag: string,
  min: number,
  max: number,
  defaultValue: number,
): number {
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new SpycoreCliError(
      `Invalid --${flag}: "${raw}" is not a positive integer.`,
      EXIT_USER_ERROR,
      `Pass --${flag} <n> with ${min} <= n <= ${max}.`,
    );
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new SpycoreCliError(
      `Invalid --${flag}: "${raw}" is outside ${min}–${max}.`,
      EXIT_USER_ERROR,
      `Pass --${flag} <n> with ${min} <= n <= ${max}.`,
    );
  }
  return n;
}
