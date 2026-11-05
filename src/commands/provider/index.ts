import { Command, Option } from 'commander';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
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
  isLocalBaseURL,
  resolveProviderSelection,
  type StoredProviderConfig,
} from '../../lib/providers/byok-config.js';
import { EXIT_NETWORK_ERROR, EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { formatOption, getOutputOptions, info, json, print, resolveFormat, success, warn } from '../../lib/output.js';
import { confirmYesNo } from '../../lib/prompt.js';
import { redactUrlCredentials } from '../../lib/redact.js';

/**
 * `spycore provider <subcommand>` - save and manage named OpenAI-compatible
 * providers so a user can `spycore agent "…"` against their own model/endpoint
 * without re-typing flags (and, for BYOK, without a SpyCore account).
 *
 * Keys are never printed in full; the inline-key form
 * is discouraged in favour of an env var.
 */

/** Reserved names that map to built-in behaviour and can't be saved. */
const RESERVED = new Set<string>(PROVIDER_KINDS); // 'spycore', 'openai', 'anthropic', 'google'

/** How a provider's key is sourced, for `list` - never the key itself. */
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
    .addOption(new Option('--api-key-env <var>', 'Env var holding the API key (preferred - not written to disk)'))
    .addOption(new Option('--api-key <key>', 'Inline API key (written to disk; prefer --api-key-env)'))
    .addOption(new Option('--oauth', 'Use OAuth 2.0 flow instead of API key (Google only)'))
    .addOption(new Option('--skip-test', 'Skip the automatic connectivity test after saving'))
    .action(async (name: string, opts: { type?: string; baseUrl?: string; model?: string; apiKeyEnv?: string; apiKey?: string; oauth?: boolean; skipTest?: boolean }) => {
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
          'spycore and openai are built-in - choose a different name.',
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
      // Optional - each type has a sensible vendor default base URL.
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
      // Warn on a suspicious --base-url before a key is ever sent to it.
      // A vendor API key (anthropic/google) paired with a non-vendor host
      // sends that key to a third party; plain http sends it in cleartext.
      // The openai type is documented as any OpenAI-compatible endpoint, so
      // a custom host is normal there - only the scheme is checked. Local
      // endpoints are exempt from both warnings.
      const baseUrlExplicit = (opts.baseUrl ?? '').trim();
      if (baseUrlExplicit.length > 0 && !isLocalBaseURL(baseUrlRaw)) {
        if (parsed.protocol === 'http:') {
          warn(
            'Warning: --base-url uses plain http:// - your API key will travel unencrypted. ' +
              'Use https:// unless you meant a local endpoint.',
          );
        }
        if (type !== 'openai') {
          const defaultHost = new URL(BYOK_TYPE_DEFAULTS[type].baseURL).hostname.toLowerCase();
          if (parsed.hostname.toLowerCase() !== defaultHost) {
            warn(
              `Warning: --base-url host "${sanitizeForDisplay(parsed.hostname)}" is not the vendor default ` +
                `for type "${type}" (${defaultHost}) - your ${type} API key will be sent to a third party.`,
            );
          }
        }
      }
      const apiKeyEnv = (opts.apiKeyEnv ?? '').trim();
      const apiKey = (opts.apiKey ?? '').trim();
      if (apiKeyEnv.length > 0 && apiKey.length > 0) {
        throw new SpycoreCliError('Pass either --api-key-env or --api-key, not both.', EXIT_USER_ERROR);
      }
      // OAuth validation
      if (opts.oauth) {
        if (type !== 'google') {
          throw new SpycoreCliError('--oauth is only supported for Google providers.', EXIT_USER_ERROR);
        }
        if (apiKey.length > 0 || apiKeyEnv.length > 0) {
          throw new SpycoreCliError('Pass either --oauth or an API key, not both.', EXIT_USER_ERROR);
        }
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

      // Run OAuth flow for Google before saving.
      if (opts.oauth) {
        const { runOAuthFlow, googleOAuthConfig } = await import('../../lib/oauth.js');
        // Use a random high port for the callback server.
        const port = 49152 + Math.floor(Math.random() * 16383);
        const oauthConfig = googleOAuthConfig(port);
        info('Starting Google OAuth flow...');
        try {
          const tokens = await runOAuthFlow(oauthConfig);
          entry.oauthRefreshToken = tokens.refreshToken;
          entry.oauthClientId = oauthConfig.clientId;
          success('OAuth authorization successful.');
        } catch (err) {
          throw new SpycoreCliError(
            `OAuth failed: ${err instanceof Error ? err.message : String(err)}`,
            EXIT_USER_ERROR,
            'The provider was not saved. Try again or use --api-key instead.',
          );
        }
      }

      setStoredProviders([...existing, entry]);
      if (apiKey.length > 0) {
        warn('The API key was written to the config file (locked to 0600). Prefer --api-key-env <VAR> to keep it off disk.');
      }
      success(`Saved provider "${trimmedName}" (${type} · ${entry.baseURL}).`);
      info(`Use it: spycore agent --provider ${trimmedName} "<task>"  ·  make default: spycore provider use ${trimmedName}`);

      // Automatic health check after save (unless --skip-test).
      // Non-blocking on failure - warns but keeps the saved provider.
      // Skipped when no model was specified (nothing to test with).
      // 30s timeout - a stalled provider must not hang `provider add`.
      if (!opts.skipTest && entry.model) {
        info(`Testing "${trimmedName}"…`);
        try {
          // Reuse the exact resolution the test command uses.
          const selection = resolveProviderSelection({
            providerFlag: trimmedName,
            model: undefined,
            baseUrl: undefined,
            apiKeyEnv: undefined,
            env: process.env,
            stored: getStoredProviders(),
            defaultProvider: undefined,
          });
          if (selection.kind !== 'byok') {
            warn('Health check skipped: provider did not resolve to BYOK.');
          } else {
            const { createByokProvider } = await import('../../lib/providers/factory.js');
            const provider = await createByokProvider(selection.config);
            const conversationId = await provider.createConversation({
              model: selection.config.model,
            });
            let errMsg: string | null = null;
            // Timeout: abort the stream if it stalls. The AbortController
            // ensures the background network connection is actually closed,
            // not just abandoned by Promise.race.
            const timeoutMs = 30_000;
            const abort = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            const streamPromise = (async () => {
              for await (const ev of provider.streamChat({
                conversationId,
                message: 'Reply with: OK',
                model: selection.config.model,
                signal: abort.signal,
              })) {
                if (ev.type === 'error') {
                  errMsg = ev.message;
                  break;
                }
                if (ev.type === 'done') break;
              }
            })();
            const timeoutPromise = new Promise<'timeout'>((resolve) => {
              timer = setTimeout(() => resolve('timeout'), timeoutMs);
            });
            const result = await Promise.race([streamPromise.then(() => 'done' as const), timeoutPromise]);
            // clear the timer - a pending handle keeps the event loop alive
            // and delays process exit by the full timeout.
            if (timer) clearTimeout(timer);
            // Abort the stream on timeout so the connection doesn't leak.
            if (result === 'timeout') abort.abort();
            if (result === 'timeout') {
              warn('Health check timed out after 30s.');
              warn('The provider was saved, but may not work. Check the key and base URL.');
            } else if (errMsg) {
              // m2: errMsg comes from the provider SSE error event (server-
              // controlled) - sanitize before rendering.
              warn(`Health check failed: ${sanitizeForDisplay(errMsg)}`);
              warn('The provider was saved, but may not work. Check the key and base URL.');
            } else {
              success(`Health check passed - "${trimmedName}" is reachable.`);
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // m2: sanitize server-controlled error text.
          warn(`Health check failed: ${sanitizeForDisplay(msg)}`);
          warn('The provider was saved, but may not work. Check the key and base URL.');
        }
      } else if (!opts.skipTest && !entry.model) {
        info('Skipped health check (no --model specified). Run `spycore provider test <name> --model <id>` to verify.');
      }
    });
}

function registerList(group: Command): void {
  group
    .command('list')
    .description('List saved providers (keys are masked)')
    .addOption(formatOption())
    .action((opts: { format?: string }) => {
      const providers = getStoredProviders();
      const effectiveDefault = getDefaultProviderName() ?? 'spycore';
      if (resolveFormat(opts.format) === 'json') {
        json({
          defaultProvider: effectiveDefault,
          providers: providers.map((p) => ({
            name: p.name,
            type: p.type,
            // F-2c-46: a hand-edited baseURL can carry userinfo; the endpoint
            // stays readable, the credential does not.
            baseURL: redactUrlCredentials(p.baseURL),
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
        base: redactUrlCredentials(p.baseURL),
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
    .addOption(new Option('-y, --yes', 'Delete without the confirmation prompt'))
    .action(async (name: string, opts: { yes?: boolean }) => {
      const trimmed = name.trim();
      const list = getStoredProviders();
      if (!list.some((p) => p.name === trimmed)) {
        throw new SpycoreCliError(`No saved provider named "${trimmed}".`, EXIT_USER_ERROR, 'List them: spycore provider list');
      }
      // Destructive: confirm first. The prompt sanitizes the composed
      // question (see prompt.ts); a non-answer cancels the deletion.
      if (!opts.yes && !(await confirmYesNo(`Delete saved provider "${trimmed}"?`))) {
        info('Cancelled - nothing deleted.');
        return;
      }
      setStoredProviders(list.filter((p) => p.name !== trimmed));
      if (getDefaultProviderName() === trimmed) {
        setDefaultProviderName(undefined);
        info('It was the default - default reset to spycore.');
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

/**
 * Show per-provider BYOK usage (calls, tokens, last used).
 * Data is local-only, tracked from provider `usage` events.
 */
function registerUsage(group: Command): void {
  group
    .command('usage')
    .description('Show token usage per BYOK provider (local tracking only)')
    .action(async () => {
      const { getByokUsage } = await import('../../lib/byok-usage.js');
      const usage = getByokUsage();
      const names = Object.keys(usage).sort();
      if (names.length === 0) {
        info('No BYOK usage recorded yet.');
        info('Usage is tracked automatically when you use a BYOK provider.');
        return;
      }
      // Simple table output
      const rows = names.map((name) => {
        const u = usage[name]!;
        return {
          Provider: name,
          Calls: String(u.calls),
          'Input tokens': u.inputTokens.toLocaleString(),
          'Output tokens': u.outputTokens.toLocaleString(),
          'Last used': new Date(u.lastUsed).toLocaleString(),
        };
      });
      console.table(rows);
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
  registerUsage(group);

  group
    .command('help', { isDefault: true, hidden: true })
    .description('Show help for the provider subcommand')
    .action(() => {
      group.help();
    });
}
