import { Command, Option } from 'commander';
import {
  getStoredProviders,
  setStoredProviders,
  getDefaultProviderName,
  setDefaultProviderName,
} from '../../lib/config.js';
import {
  BYOK_TYPES,
  BYOK_TYPE_DEFAULTS,
  PROVIDER_KINDS,
  isByokType,
  resolveProviderSelection,
  type StoredProviderConfig,
} from '../../lib/providers/byok-config.js';
import { EXIT_NETWORK_ERROR, EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { getOutputOptions, info, json, print, success, warn } from '../../lib/output.js';

/**
 * `spycore provider <subcommand>` — save and manage named OpenAI-compatible
 * providers so a user can `spycore agent "…"` against their own model/endpoint
 * without re-typing flags (and, for BYOK, without a SpyCore account).
 *
 * Identity-safe by construction: help/examples use generic wording only — never
 * an upstream provider name. Keys are never printed in full; the inline-key form
 * is discouraged in favour of an env var.
 */

/** Reserved names that map to built-in behaviour and can't be saved. */
const RESERVED = new Set<string>(PROVIDER_KINDS); // 'spycore', 'openai', 'anthropic', 'google'

/** How a provider's key is sourced, for `list` — never the key itself. */
function keySource(p: StoredProviderConfig): string {
  if (p.apiKeyEnv && p.apiKeyEnv.length > 0) return `env:${p.apiKeyEnv}`;
  if (p.apiKey && p.apiKey.length > 0) return `stored:••••${p.apiKey.slice(-4)}`;
  // Key-required types fall back to their default env var at run time; the
  // keyless state is only meaningful for OpenAI-compatible local servers.
  const defaults = BYOK_TYPE_DEFAULTS[p.type];
  return defaults.keyOptional ? 'none' : `env:${defaults.apiKeyEnv} (default)`;
}

function registerAdd(group: Command): void {
  group
    .command('add <name>')
    .description('Save a named model provider to run agents against')
    .addOption(
      new Option('--type <type>', `Provider type: ${BYOK_TYPES.join(', ')} (openai = any OpenAI-compatible endpoint)`).default('openai'),
    )
    .addOption(new Option('--base-url <url>', 'Base URL of the endpoint (defaults per type)'))
    .addOption(new Option('--model <id>', 'Default model id for this provider'))
    .addOption(new Option('--api-key-env <var>', 'Env var holding the API key (preferred — not written to disk)'))
    .addOption(new Option('--api-key <key>', 'Inline API key (written to disk; prefer --api-key-env)'))
    .action((name: string, opts: { type?: string; baseUrl?: string; model?: string; apiKeyEnv?: string; apiKey?: string }) => {
      const type = String(opts.type ?? 'openai').toLowerCase();
      if (!isByokType(type)) {
        throw new SpycoreCliError(
          `Unsupported provider type: ${opts.type}`,
          EXIT_USER_ERROR,
          `Supported types: ${BYOK_TYPES.join(', ')} (openai = any OpenAI-compatible endpoint).`,
        );
      }
      const trimmedName = name.trim();
      if (trimmedName.length === 0) {
        throw new SpycoreCliError('A provider name is required.', EXIT_USER_ERROR);
      }
      if (RESERVED.has(trimmedName.toLowerCase())) {
        throw new SpycoreCliError(
          `"${trimmedName}" is a reserved name.`,
          EXIT_USER_ERROR,
          'spycore and openai are built-in — choose a different name.',
        );
      }
      const existing = getStoredProviders();
      if (existing.some((p) => p.name === trimmedName)) {
        throw new SpycoreCliError(
          `A provider named "${trimmedName}" already exists.`,
          EXIT_USER_ERROR,
          'Remove it first (`spycore provider remove`) or pick another name.',
        );
      }
      // Optional — each type has a sensible vendor default base URL.
      const baseUrlRaw = (opts.baseUrl ?? '').trim() || BYOK_TYPE_DEFAULTS[type].baseURL;
      let parsed: URL;
      try {
        parsed = new URL(baseUrlRaw);
      } catch {
        throw new SpycoreCliError(`Invalid --base-url: ${baseUrlRaw}`, EXIT_USER_ERROR, 'Pass a full URL, e.g. https://host/v1');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new SpycoreCliError('--base-url must use http or https.', EXIT_USER_ERROR);
      }
      const apiKeyEnv = (opts.apiKeyEnv ?? '').trim();
      const apiKey = (opts.apiKey ?? '').trim();
      if (apiKeyEnv.length > 0 && apiKey.length > 0) {
        throw new SpycoreCliError('Pass either --api-key-env or --api-key, not both.', EXIT_USER_ERROR);
      }
      const model = (opts.model ?? '').trim();
      const entry: StoredProviderConfig = {
        name: trimmedName,
        type,
        baseURL: baseUrlRaw.replace(/\/+$/, ''),
        ...(model.length > 0 ? { model } : {}),
        ...(apiKeyEnv.length > 0 ? { apiKeyEnv } : {}),
        ...(apiKey.length > 0 ? { apiKey } : {}),
      };
      setStoredProviders([...existing, entry]);
      if (apiKey.length > 0) {
        warn('The API key was written to the config file (locked to 0600). Prefer --api-key-env <VAR> to keep it off disk.');
      }
      success(`Saved provider "${trimmedName}" (${type} · ${entry.baseURL}).`);
      info(`Use it: spycore agent --provider ${trimmedName} "<task>"  ·  make default: spycore provider use ${trimmedName}`);
    });
}

function registerList(group: Command): void {
  group
    .command('list')
    .description('List saved providers (keys are masked)')
    .action(() => {
      const providers = getStoredProviders();
      const effectiveDefault = getDefaultProviderName() ?? 'spycore';
      if (getOutputOptions().json) {
        json({
          defaultProvider: effectiveDefault,
          providers: providers.map((p) => ({
            name: p.name,
            type: p.type,
            baseURL: p.baseURL,
            model: p.model ?? null,
            keySource: keySource(p),
            default: p.name === effectiveDefault,
          })),
        });
        return;
      }
      print(`Default: ${effectiveDefault}${effectiveDefault === 'spycore' ? ' (built-in)' : ''}`);
      if (providers.length === 0) {
        info('No saved providers. Add one: spycore provider add <name> --base-url <url> [--model <id>] [--api-key-env <VAR>]');
        return;
      }
      const rows = providers.map((p) => ({
        mark: p.name === effectiveDefault ? '*' : ' ',
        name: p.name,
        type: p.type,
        base: p.baseURL,
        model: p.model ?? '-',
        key: keySource(p),
      }));
      const w = (sel: (r: (typeof rows)[number]) => string, head: string): number =>
        Math.max(head.length, ...rows.map((r) => sel(r).length));
      const wName = w((r) => r.name, 'NAME');
      const wType = w((r) => r.type, 'TYPE');
      const wBase = w((r) => r.base, 'BASE-URL');
      const wModel = w((r) => r.model, 'MODEL');
      print(
        `  ${'NAME'.padEnd(wName)}  ${'TYPE'.padEnd(wType)}  ${'BASE-URL'.padEnd(wBase)}  ${'MODEL'.padEnd(wModel)}  KEY`,
      );
      for (const r of rows) {
        print(
          `${r.mark} ${r.name.padEnd(wName)}  ${r.type.padEnd(wType)}  ${r.base.padEnd(wBase)}  ${r.model.padEnd(wModel)}  ${r.key}`,
        );
      }
    });
}

function registerRemove(group: Command): void {
  group
    .command('remove <name>')
    .alias('rm')
    .description('Delete a saved provider')
    .action((name: string) => {
      const trimmed = name.trim();
      const list = getStoredProviders();
      if (!list.some((p) => p.name === trimmed)) {
        throw new SpycoreCliError(`No saved provider named "${trimmed}".`, EXIT_USER_ERROR, 'List them: spycore provider list');
      }
      setStoredProviders(list.filter((p) => p.name !== trimmed));
      if (getDefaultProviderName() === trimmed) {
        setDefaultProviderName(undefined);
        info('It was the default — default reset to spycore.');
      }
      success(`Removed provider "${trimmed}".`);
    });
}

function registerUse(group: Command): void {
  group
    .command('use <name>')
    .description('Set the default provider for `agent` runs (use "spycore" to reset to the built-in)')
    .action((name: string) => {
      const target = name.trim();
      if (target.toLowerCase() === 'spycore') {
        setDefaultProviderName('spycore');
        success('Default provider set to spycore (built-in).');
        return;
      }
      if (!getStoredProviders().some((p) => p.name === target)) {
        throw new SpycoreCliError(
          `No saved provider named "${target}".`,
          EXIT_USER_ERROR,
          'List them: spycore provider list  ·  reset to built-in: spycore provider use spycore',
        );
      }
      setDefaultProviderName(target);
      success(`Default provider set to "${target}".`);
    });
}

function registerTest(group: Command): void {
  group
    .command('test <name>')
    .description('Make one minimal request through a saved provider and report the result')
    .addOption(new Option('--model <id>', 'Model to test with (overrides the saved model)'))
    .action(async (name: string, opts: { model?: string }) => {
      const target = name.trim();
      if (!getStoredProviders().some((p) => p.name === target)) {
        throw new SpycoreCliError(`No saved provider named "${target}".`, EXIT_USER_ERROR, 'List them: spycore provider list');
      }
      // Reuse the exact agent-run resolution (key precedence, missing-model error).
      const selection = resolveProviderSelection({
        providerFlag: target,
        model: opts.model,
        baseUrl: undefined,
        apiKeyEnv: undefined,
        env: process.env,
        stored: getStoredProviders(),
        defaultProvider: undefined,
      });
      if (selection.kind !== 'byok') {
        throw new SpycoreCliError(`Provider "${target}" is not testable.`, EXIT_USER_ERROR);
      }
      const { config } = selection;
      info(`Testing "${target}" → ${config.baseURL} (model ${config.model})…`);
      // The factory lazy-loads whichever adapter speaks this config's wire.
      const { createByokProvider } = await import('../../lib/providers/factory.js');
      const provider = await createByokProvider(config);
      const conversationId = await provider.createConversation({ model: config.model });
      let errMsg: string | null = null;
      for await (const ev of provider.streamChat({ conversationId, message: 'Reply with: OK', model: config.model })) {
        if (ev.type === 'error') {
          errMsg = ev.message;
          break;
        }
        if (ev.type === 'done') break;
      }
      if (errMsg) {
        throw new SpycoreCliError(`Provider "${target}" test failed: ${errMsg}`, EXIT_NETWORK_ERROR);
      }
      success(`Provider "${target}" is reachable.`);
    });
}

export function registerProviderCommand(program: Command): void {
  const group = program
    .command('provider')
    .description('Save and manage your own model providers (OpenAI-compatible, Anthropic, or Google AI endpoints)');

  registerAdd(group);
  registerList(group);
  registerRemove(group);
  registerUse(group);
  registerTest(group);

  group
    .command('help', { isDefault: true, hidden: true })
    .description('Show help for the provider subcommand')
    .action(() => {
      group.help();
    });
}
