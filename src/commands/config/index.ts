import { Command } from 'commander';
import {
  coerceValue,
  getConfigPath,
  getConfigStore,
  isKnownKey,
  listKnownKeys,
  peekStoredValue,
  type CliConfigSchema,
} from '../../lib/config.js';
import {
  EXIT_USER_ERROR,
  SpycoreCliError,
} from '../../lib/errors.js';
import {
  fail,
  formatOption,
  getOutputOptions,
  json,
  print,
  resolveFormat,
  success,
  writeFormatted,
} from '../../lib/output.js';
import { isSecretKey, REDACTED, redactSecrets } from '../../lib/redact.js';

function suggestKey(input: string): string | null {
  // Cheap "did you mean" — pick the known key whose lowercase form is the
  // closest by Levenshtein distance, but only suggest when it's reasonably
  // close (≤ 3 edits) so we don't say "did you mean theme?" for "xyz".
  const known = listKnownKeys();
  const lower = input.toLowerCase();
  let best: { key: string; distance: number } | null = null;
  for (const key of known) {
    const d = levenshtein(lower, key.toLowerCase());
    if (best === null || d < best.distance) best = { key, distance: d };
  }
  return best && best.distance <= 3 ? best.key : null;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const next = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(
        (next[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= b.length; j++) prev[j] = next[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

function unknownKeyError(key: string): SpycoreCliError {
  const suggestion = suggestKey(key);
  return new SpycoreCliError(
    `Unknown config key: ${key}`,
    EXIT_USER_ERROR,
    suggestion
      ? `Did you mean \`${suggestion}\`?  Known keys: ${listKnownKeys().join(', ')}.`
      : `Known keys: ${listKnownKeys().join(', ')}.`,
  );
}

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('Manage CLI configuration (api url, default model, etc.)');

  configCmd
    .command('get [key]')
    .description('Print one config value, or the whole config if no key is given (secrets redacted)')
    .option('--reveal', 'Reveal a secret value (e.g. the token) instead of redacting it')
    .action((key: string | undefined, opts: { reveal?: boolean }) => {
      const store = getConfigStore();
      if (!key) {
        // Bulk dump — always redact secrets, in every format. `--reveal` is
        // intentionally NOT honoured here; reveal a secret only by naming it.
        const redacted = redactSecrets(store.store);
        if (getOutputOptions().json) {
          json(redacted);
        } else {
          for (const k of listKnownKeys()) {
            const v = (redacted as Record<string, unknown>)[k];
            if (v !== undefined) print(`${k} = ${formatValue(v)}`);
          }
        }
        return;
      }
      // Secret keys (e.g. __token__) aren't part of CliConfigSchema; surface
      // them redacted by default, raw only with --reveal.
      if (isSecretKey(key)) {
        const raw = peekStoredValue(key);
        if (raw === undefined) {
          if (getOutputOptions().json) json({ [key]: null });
          else print(`${key} is unset (the CLI token is usually stored in the OS keychain, not the config file)`);
          return;
        }
        if (getOutputOptions().json) {
          json({ [key]: opts.reveal ? raw : REDACTED });
        } else {
          print(`${key} = ${opts.reveal ? formatValue(raw) : REDACTED}`);
        }
        return;
      }
      if (!isKnownKey(key)) fail(unknownKeyError(key));
      const v = store.get(key);
      if (getOutputOptions().json) {
        json({ [key]: v });
      } else if (v === undefined) {
        print(`${key} is unset`);
      } else {
        print(`${key} = ${formatValue(v)}`);
      }
    });

  configCmd
    .command('set <key> <value>')
    .description('Set a config value (validated)')
    .action((key: string, value: string) => {
      if (!isKnownKey(key)) fail(unknownKeyError(key));
      let coerced: CliConfigSchema[keyof CliConfigSchema];
      try {
        coerced = coerceValue(key, value);
      } catch (err) {
        fail(
          new SpycoreCliError(
            err instanceof Error ? err.message : String(err),
            EXIT_USER_ERROR,
          ),
        );
      }
      // `lastWhoami` is structured; refuse to set via CLI.
      if (key === 'lastWhoami') {
        fail(
          new SpycoreCliError(
            'lastWhoami is managed automatically and cannot be set manually.',
            EXIT_USER_ERROR,
          ),
        );
      }
      getConfigStore().set(key, coerced);
      if (getOutputOptions().json) {
        json({ key, value: coerced });
      } else {
        success(`${key} set to ${formatValue(coerced)}`);
      }
    });

  configCmd
    .command('unset <key>')
    .description('Remove a config value (revert to default)')
    .action((key: string) => {
      if (!isKnownKey(key)) fail(unknownKeyError(key));
      getConfigStore().delete(key);
      if (getOutputOptions().json) {
        json({ key, status: 'unset' });
      } else {
        success(`${key} unset`);
      }
    });

  configCmd
    .command('list')
    .description('Print every config value (alias for `get`); secrets are redacted')
    .addOption(formatOption())
    .action((opts: { format?: string }) => {
      // Always feed the formatter the REDACTED store — never the raw token.
      const redacted = redactSecrets(getConfigStore().store);
      const fmt = resolveFormat(opts.format);
      if (fmt === 'json') {
        json(redacted);
        return;
      }
      if (fmt !== 'text') {
        writeFormatted(redacted, fmt);
        return;
      }
      print(`# config: ${getConfigPath()}`);
      for (const k of listKnownKeys()) {
        const v = (redacted as Record<string, unknown>)[k];
        if (v !== undefined) print(`${k} = ${formatValue(v)}`);
      }
    });

  configCmd
    .command('reset')
    .description('Clear ALL config values (does not revoke your token)')
    .option('--yes', 'Skip the confirmation prompt')
    .action(async (opts: { yes?: boolean }) => {
      if (!opts.yes) {
        if (!process.stdout.isTTY) {
          fail(
            new SpycoreCliError(
              'Refusing to reset without --yes in a non-interactive shell.',
              EXIT_USER_ERROR,
            ),
          );
        }
        // Minimal stdin yes/no prompt — we don't want to pull in a prompt
        // library just for this one path.
        process.stdout.write('Reset all CLI config? Type "yes" to confirm: ');
        const answer = await readLine();
        if (answer.trim().toLowerCase() !== 'yes') {
          if (getOutputOptions().json) {
            json({ status: 'aborted' });
          } else {
            print('Reset aborted.');
          }
          return;
        }
      }
      getConfigStore().clear();
      if (getOutputOptions().json) {
        json({ status: 'reset' });
      } else {
        success('Config reset to defaults');
      }
    });
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return JSON.stringify(v);
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf-8');
      if (buf.includes('\n')) {
        process.stdin.off('data', onData);
        process.stdin.pause();
        resolve(buf.split('\n')[0] ?? '');
      }
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}
