import chalk from 'chalk';
import { Option } from 'commander';
import {
  EXIT_USER_ERROR,
  isSpycoreCliError,
  type SpycoreErrorCode,
} from './errors.js';
import {
  formatOutput,
  isOutputFormat,
  OUTPUT_FORMATS,
  type OutputFormat,
} from './output-formats/index.js';

/**
 * Output helpers. Every command should funnel through these so that --json
 * and --no-color flags work uniformly.
 *
 * Convention:
 *  - results land on stdout (so `spycore whoami --json | jq` works)
 *  - errors land on stderr (so they don't pollute pipes)
 *  - in --json mode chalk is bypassed and only structured output is emitted
 */
export interface OutputOptions {
  json: boolean;
  color: boolean;
}

/**
 * NO_COLOR is the cross-tool standard (https://no-color.org). SPYCORE_NO_COLOR
 * is the namespaced alias. Either being set forces color off regardless of
 * the --no-color flag (presence of the env var is the signal — even an empty
 * string counts).
 */
function envForcesNoColor(): boolean {
  return (
    process.env.NO_COLOR !== undefined ||
    process.env.SPYCORE_NO_COLOR !== undefined
  );
}

let current: OutputOptions = {
  json: false,
  color: !envForcesNoColor(),
};

if (envForcesNoColor()) {
  chalk.level = 0;
}

export function configureOutput(opts: Partial<OutputOptions>): void {
  current = { ...current, ...opts };
  if (envForcesNoColor()) current.color = false;
  if (!current.color) {
    chalk.level = 0;
  }
}

export function getOutputOptions(): OutputOptions {
  return current;
}

/** Plain stdout text. Suppressed in JSON mode (use json() instead). */
export function print(msg: string): void {
  if (current.json) return;
  process.stdout.write(`${msg}\n`);
}

export function success(msg: string): void {
  if (current.json) return;
  process.stdout.write(`${chalk.green('✓')} ${msg}\n`);
}

export function info(msg: string): void {
  if (current.json) return;
  process.stdout.write(`${chalk.cyan('i')} ${msg}\n`);
}

export function warn(msg: string): void {
  if (current.json) return;
  process.stderr.write(`${chalk.yellow('!')} ${msg}\n`);
}

/**
 * Structured output. Always emitted on stdout regardless of mode — but in
 * non-JSON mode we pretty-print so humans get readable text.
 */
export function json(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, current.json ? 0 : 2)}\n`);
}

/**
 * Reusable `--format <fmt>` option for read/list commands. `--json` stays a
 * shorthand for `--format json` (see resolveFormat). A fresh Option instance
 * is returned per call because commander mutates option state per command.
 */
export function formatOption(): Option {
  return new Option(
    '--format <fmt>',
    `Output format (${OUTPUT_FORMATS.join('|')}); --json is shorthand for --format json`,
  ).choices([...OUTPUT_FORMATS]);
}

/**
 * Resolve the effective output format. An explicit `--format` wins; otherwise
 * the global `--json` flag maps to 'json'; default 'text'. Commander's
 * `.choices()` already rejects unknown values — isOutputFormat is the type
 * guard that narrows the string to OutputFormat.
 */
export function resolveFormat(formatOpt?: string): OutputFormat {
  if (formatOpt && isOutputFormat(formatOpt)) return formatOpt;
  return current.json ? 'json' : 'text';
}

/**
 * Write structured data in a non-text machine format (markdown/yaml) to
 * stdout. Written unconditionally — print() is suppressed in --json mode and
 * would otherwise swallow these. For 'json', call json() directly.
 */
export function writeFormatted(payload: unknown, fmt: 'markdown' | 'yaml'): void {
  process.stdout.write(`${formatOutput(payload, fmt)}\n`);
}

/**
 * Print an error and exit. Stay friendly: surface the hint when present so
 * users get an actionable next step instead of just "Auth error".
 */
export function fail(err: unknown, fallbackCode: SpycoreErrorCode = EXIT_USER_ERROR): never {
  let message: string;
  let code: SpycoreErrorCode = fallbackCode;
  let hint: string | undefined;

  if (isSpycoreCliError(err)) {
    message = err.message;
    code = err.code;
    hint = err.hint;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }

  if (current.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: message, code, hint: hint ?? null })}\n`,
    );
  } else {
    process.stderr.write(`${chalk.red('✗')} ${message}\n`);
    if (hint) {
      process.stderr.write(`  ${chalk.dim(hint)}\n`);
    }
  }
  process.exit(code);
}
