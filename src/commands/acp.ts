import { Command, Option } from 'commander';
import { resolveProviderSelection } from '../lib/providers/byok-config.js';
import { getStoredProviders, getDefaultProviderName } from '../lib/config.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../lib/errors.js';
import type { Provider } from '../lib/providers/types.js';

const ALLOWED_AGENT_MODELS = ['charon', 'styx', 'hermes', 'minos'] as const;

interface AcpCmdOpts {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  toolProtocol?: string;
  cmdTimeout?: string;
  maxTurns?: string;
}

/**
 * `spycore acp` — serve the SpyCode agent over the Agent Client Protocol
 * (https://agentclientprotocol.com, v1) on stdio, so ACP clients (Zed,
 * JetBrains, …) can drive it: streaming session updates, permission requests
 * for writes/commands/MCP tools, and cancellation.
 *
 * stdout carries ONLY protocol frames; logs go to stderr. Provider/model are
 * fixed for the server's lifetime via the same flags as `spycore agent`
 * (default: the spycore provider with the STYX coding model — there is no
 * per-prompt auto-routing in ACP mode). SpyCore login is NOT required to start
 * the server: the ACP auth flow advertises `spycore-login` and sessions return
 * the auth-required error until the user runs `spycore login`.
 */
export function registerAcpCommand(program: Command): void {
  program
    .command('acp')
    .description('Serve the agent over the Agent Client Protocol (stdio) for IDE clients')
    .addOption(
      new Option(
        '--provider <name>',
        'Provider to use: a saved name or a built-in type (spycore, openai, anthropic, google). Omit to use your configured default',
      ),
    )
    .addOption(
      new Option('-m, --model <model>', `Model for all sessions (${ALLOWED_AGENT_MODELS.join('|')} for spycore; required for BYOK)`),
    )
    .addOption(new Option('--base-url <url>', 'Base URL for a BYOK provider'))
    .addOption(new Option('--api-key-env <var>', 'Env var holding the API key for a BYOK provider'))
    .addOption(
      new Option('--tool-protocol <mode>', 'Tool-call wire: auto, native, or fenced')
        .choices(['auto', 'native', 'fenced'])
        .default('auto'),
    )
    .addOption(new Option('--cmd-timeout <sec>', 'Timeout for each run_command, in seconds').default('120'))
    .addOption(new Option('--max-turns <n>', 'Max model round-trips per prompt turn (1-200)').default('25'))
    .action(async (opts: AcpCmdOpts, cmd: Command) => {
      const parentOpts = cmd.parent?.opts<{ apiUrl?: string }>() ?? {};

      // Resolve the provider exactly like `spycore agent` (saved name >
      // built-in type > default), but with a FIXED model for the whole server:
      // ACP has no per-prompt triage. BYOK configs error early (stderr) —
      // that's pre-protocol, the IDE shows the launch failure.
      const selection = resolveProviderSelection({
        providerFlag: opts.provider,
        baseUrl: opts.baseUrl,
        model: opts.model,
        apiKeyEnv: opts.apiKeyEnv,
        env: process.env,
        stored: getStoredProviders(),
        defaultProvider: getDefaultProviderName(),
      });

      let provider: Provider;
      let model: string;
      if (selection.kind === 'byok') {
        const { createByokProvider } = await import('../lib/providers/factory.js');
        provider = await createByokProvider(selection.config);
        model = selection.config.model;
      } else {
        const slug = String(opts.model ?? 'styx').toLowerCase();
        if (!(ALLOWED_AGENT_MODELS as readonly string[]).includes(slug)) {
          throw new SpycoreCliError(
            `Unknown model: ${opts.model}`,
            EXIT_USER_ERROR,
            `Allowed: ${ALLOWED_AGENT_MODELS.join(', ')}`,
          );
        }
        const { SpyCoreProvider } = await import('../lib/providers/spycore.js');
        provider = new SpyCoreProvider();
        model = slug;
      }

      const cmdTimeoutSec = Math.max(1, Math.min(3600, Number(opts.cmdTimeout ?? 120) || 120));
      const maxTurns = Math.max(1, Math.min(200, Number(opts.maxTurns ?? 25) || 25));
      const toolProtocol = (opts.toolProtocol ?? 'auto') as 'auto' | 'native' | 'fenced';

      // Lazy-load the server so registering the command stays on the hot path.
      const [{ JsonRpcEndpoint }, { AcpAgentServer }, { isAuthenticated }, { readFileSync }, { fileURLToPath }, pathMod] =
        await Promise.all([
          import('../lib/acp/jsonrpc.js'),
          import('../lib/acp/server.js'),
          import('../lib/auth.js'),
          import('node:fs'),
          import('node:url'),
          import('node:path'),
        ]);

      // Agent version for initialize.agentInfo — best-effort package.json walk.
      let version = '0.0.0';
      try {
        let dir = pathMod.dirname(fileURLToPath(import.meta.url));
        for (let i = 0; i < 6; i += 1) {
          try {
            const pkg = JSON.parse(readFileSync(pathMod.join(dir, 'package.json'), 'utf8')) as {
              name?: string;
              version?: string;
            };
            if (pkg.name === '@spycore/cli' && typeof pkg.version === 'string') {
              version = pkg.version;
              break;
            }
          } catch {
            /* keep walking */
          }
          const parent = pathMod.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
      } catch {
        /* default stands */
      }

      const endpoint = new JsonRpcEndpoint(process.stdin, process.stdout);
      new AcpAgentServer({
        endpoint,
        provider,
        model,
        toolProtocol,
        apiUrlOverride: parentOpts.apiUrl,
        requiresSpycoreAuth: selection.kind === 'spycore',
        isAuthenticated,
        agentVersion: version,
        commandTimeoutMs: cmdTimeoutSec * 1000,
        maxTurns,
      });

      process.stderr.write(`spycore acp: serving Agent Client Protocol v1 on stdio (model ${model})\n`);
      // Serve until the client closes our stdin.
      await endpoint.start();
    });
}
