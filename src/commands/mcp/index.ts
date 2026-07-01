import { Command, Option } from 'commander';
import {
  loadMcpServers,
  readScope,
  writeScope,
  parseEnvAssignment,
  isValidServerName,
  describeEnvVar,
  type McpScope,
  type McpServerConfig,
} from '../../lib/agent/mcp-config.js';
import { EXIT_USER_ERROR, EXIT_NETWORK_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import {
  getTrustedWorkspaces,
  isWorkspaceTrusted,
  trustWorkspace,
  untrustWorkspace,
} from '../../lib/config.js';
import { getOutputOptions, info, json, print, success, warn } from '../../lib/output.js';
import { resolve as resolvePath } from 'node:path';

/**
 * `spycore mcp <subcommand>` — manage Model Context Protocol servers the agent
 * connects to over stdio. Configured servers are spawned at agent start (on
 * EVERY provider) and their tools join the registry as `mcp__<server>__<tool>`,
 * gated by the same approval discipline as the built-in mutating tools.
 *
 * Two scopes: user-global (the stored config) and project (./.spycore/mcp.json,
 * written with --project); project entries override user ones by name. Identity-
 * safe: help/examples never name an upstream provider.
 *
 * SAFETY: a server child inherits only a MINIMAL environment — PATH/HOME plus
 * the vars you pass with --env. The full parent env (which may hold unrelated
 * secrets) is NOT forwarded; the per-call approval prompt is the control point
 * for what an external server is allowed to do.
 */

/** Collect a repeatable --env KEY[=VALUE] into a list of raw strings. */
function collectEnv(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function scopeOf(projectFlag: boolean | undefined): McpScope {
  return projectFlag ? 'project' : 'user';
}

/** Build the env list from raw --env strings, surfacing a clear parse error. */
function parseEnvList(raw: string[]): McpServerConfig['env'] {
  const env = raw.map((r) => {
    try {
      return parseEnvAssignment(r);
    } catch (err) {
      throw new SpycoreCliError(
        `Invalid --env value: ${r}`,
        EXIT_USER_ERROR,
        err instanceof Error ? err.message : undefined,
      );
    }
  });
  return env.length > 0 ? env : undefined;
}

function registerAdd(group: Command): void {
  group
    .command('add <name> [command...]')
    .description('Add an MCP server. Everything after `--` is the command + its args')
    .addOption(
      new Option('--env <KEY=VALUE>', 'Env var to expose to the server child (repeatable; bare KEY passes the parent value through)')
        .argParser(collectEnv)
        .default([]),
    )
    .addOption(new Option('--project', 'Write to ./.spycore/mcp.json instead of your user config'))
    .action((name: string, command: string[], opts: { env: string[]; project?: boolean }) => {
      const trimmed = name.trim();
      if (!isValidServerName(trimmed)) {
        throw new SpycoreCliError(
          `Invalid server name: "${name}".`,
          EXIT_USER_ERROR,
          'Use letters, digits, "-" and "_", starting with a letter or digit (it becomes part of the tool id).',
        );
      }
      const argv = (command ?? []).filter((s) => s.length > 0);
      if (argv.length === 0) {
        throw new SpycoreCliError(
          'A command is required.',
          EXIT_USER_ERROR,
          'Example: spycore mcp add files -- npx -y @modelcontextprotocol/server-filesystem .',
        );
      }
      const scope = scopeOf(opts.project);
      const existing = readScope(scope, process.cwd());
      if (existing.some((s) => s.name === trimmed)) {
        throw new SpycoreCliError(
          `An MCP server named "${trimmed}" already exists in ${scope} scope.`,
          EXIT_USER_ERROR,
          'Remove it first (`spycore mcp remove`) or pick another name.',
        );
      }
      const [cmd, ...rest] = argv;
      const env = parseEnvList(opts.env ?? []);
      const entry: McpServerConfig = {
        name: trimmed,
        command: cmd as string,
        ...(rest.length > 0 ? { args: rest } : {}),
        ...(env ? { env } : {}),
      };
      writeScope(scope, process.cwd(), [...existing, entry]);
      success(`Added MCP server "${trimmed}" (${scope}).`);
      const cmdLine = [entry.command, ...(entry.args ?? [])].join(' ');
      info(`  ${cmdLine}`);
      if (env) info(`  env: ${env.map(describeEnvVar).join(', ')}`);
      info('It will be connected on your next `spycore agent` run (any provider). Test it now: spycore mcp test ' + trimmed);
    });
}

function registerList(group: Command): void {
  group
    .command('list')
    .description('List configured MCP servers (user + project)')
    .action(() => {
      const cwd = process.cwd();
      const servers = loadMcpServers(cwd);
      const trusted = getTrustedWorkspaces();
      if (getOutputOptions().json) {
        json({
          servers: servers.map((s) => ({
            name: s.name,
            command: [s.command, ...(s.args ?? [])].join(' '),
            scope: s.scope,
            enabled: s.enabled,
            env: (s.env ?? []).map(describeEnvVar),
          })),
          trustedWorkspaces: trusted,
          cwdTrusted: isWorkspaceTrusted(cwd),
        });
        return;
      }
      // Project-scoped servers only spawn in a trusted workspace — tell the user
      // whether THIS directory is trusted and how to change it.
      const hasProject = servers.some((s) => s.scope === 'project');
      const printTrustFooter = (): void => {
        if (!hasProject) return;
        if (isWorkspaceTrusted(cwd)) {
          info('This workspace is trusted — its project-scoped servers will run (spycore mcp untrust to revoke).');
        } else {
          warn('This workspace is NOT trusted — project-scoped servers are skipped. Run `spycore mcp trust` to enable them.');
        }
      };
      if (servers.length === 0) {
        info('No MCP servers configured.');
        print('Add one: spycore mcp add <name> -- <command> [args...]');
        printTrustFooter();
        return;
      }
      const rows = servers.map((s) => ({
        name: s.name,
        command: [s.command, ...(s.args ?? [])].join(' '),
        scope: s.scope,
        enabled: s.enabled ? 'yes' : 'no',
      }));
      const w = (sel: (r: (typeof rows)[number]) => string, head: string): number =>
        Math.max(head.length, ...rows.map((r) => sel(r).length));
      const wName = w((r) => r.name, 'NAME');
      const wCmd = w((r) => r.command, 'COMMAND');
      const wScope = w((r) => r.scope, 'SCOPE');
      print(`${'NAME'.padEnd(wName)}  ${'COMMAND'.padEnd(wCmd)}  ${'SCOPE'.padEnd(wScope)}  ENABLED`);
      for (const r of rows) {
        print(`${r.name.padEnd(wName)}  ${r.command.padEnd(wCmd)}  ${r.scope.padEnd(wScope)}  ${r.enabled}`);
      }
      printTrustFooter();
    });
}

/**
 * `spycore mcp trust [path]` — mark a workspace as trusted so its PROJECT-scoped
 * MCP servers (./.spycore/mcp.json) will spawn on `spycore agent`. This is the
 * explicit, user-driven grant the trust gate requires (fail-closed by default):
 * running this command IS the confirmation. Trust is stored in the user-global
 * config (never in the repo), so a cloned repo can never trust itself.
 */
function registerTrust(group: Command): void {
  group
    .command('trust [path]')
    .description('Trust a workspace so its project-scoped MCP servers run (defaults to the current directory)')
    .action((path: string | undefined) => {
      const target = resolvePath(path ?? process.cwd());
      if (isWorkspaceTrusted(target)) {
        info(`Workspace already trusted: ${target}`);
        return;
      }
      trustWorkspace(target);
      success(`Trusted workspace: ${target}`);
      info('Its project-scoped MCP servers will run on your next `spycore agent`. Only trust repositories you know.');
    });
}

/** `spycore mcp untrust [path]` — revoke a workspace's trust. */
function registerUntrust(group: Command): void {
  group
    .command('untrust [path]')
    .description('Revoke trust for a workspace (defaults to the current directory)')
    .action((path: string | undefined) => {
      const target = resolvePath(path ?? process.cwd());
      if (untrustWorkspace(target)) {
        success(`Revoked trust for workspace: ${target}`);
      } else {
        info(`Workspace was not trusted: ${target}`);
      }
    });
}

/** Shared mutator for remove/enable/disable: find by name in a scope and apply. */
function mutateServer(
  name: string,
  scope: McpScope,
  apply: (list: McpServerConfig[], idx: number) => McpServerConfig[],
  notFoundHint: string,
): void {
  const trimmed = name.trim();
  const list = readScope(scope, process.cwd());
  const idx = list.findIndex((s) => s.name === trimmed);
  if (idx === -1) {
    throw new SpycoreCliError(`No MCP server named "${trimmed}" in ${scope} scope.`, EXIT_USER_ERROR, notFoundHint);
  }
  writeScope(scope, process.cwd(), apply(list, idx));
}

function registerRemove(group: Command): void {
  group
    .command('remove <name>')
    .alias('rm')
    .description('Remove a configured MCP server')
    .addOption(new Option('--project', 'Target ./.spycore/mcp.json instead of your user config'))
    .action((name: string, opts: { project?: boolean }) => {
      const scope = scopeOf(opts.project);
      mutateServer(
        name,
        scope,
        (list, idx) => list.filter((_, i) => i !== idx),
        'List them: spycore mcp list (use --project for project scope).',
      );
      success(`Removed MCP server "${name.trim()}" (${scope}).`);
    });
}

function registerToggle(group: Command, enabled: boolean): void {
  const verb = enabled ? 'enable' : 'disable';
  group
    .command(`${verb} <name>`)
    .description(`${enabled ? 'Enable' : 'Disable'} a configured MCP server`)
    .addOption(new Option('--project', 'Target ./.spycore/mcp.json instead of your user config'))
    .action((name: string, opts: { project?: boolean }) => {
      const scope = scopeOf(opts.project);
      mutateServer(
        name,
        scope,
        (list, idx) =>
          list.map((s, i) => {
            if (i !== idx) return s;
            // enabled is the default; store the flag only when disabling.
            if (enabled) {
              const { enabled: _drop, ...rest } = s;
              return rest;
            }
            return { ...s, enabled: false };
          }),
        'List them: spycore mcp list (use --project for project scope).',
      );
      success(`${enabled ? 'Enabled' : 'Disabled'} MCP server "${name.trim()}" (${scope}).`);
    });
}

function registerTest(group: Command): void {
  group
    .command('test <name>')
    .description('Spawn a configured server, initialize, list its tools, and shut it down')
    .addOption(new Option('--timeout <sec>', 'Handshake timeout in seconds').default('10'))
    .action(async (name: string, opts: { timeout?: string }) => {
      const trimmed = name.trim();
      const server = loadMcpServers(process.cwd()).find((s) => s.name === trimmed);
      if (!server) {
        throw new SpycoreCliError(`No MCP server named "${trimmed}".`, EXIT_USER_ERROR, 'List them: spycore mcp list');
      }
      const timeoutMs = Math.max(1, Math.min(120, Number(opts.timeout ?? 10) || 10)) * 1000;
      // Lazy-load the client so registering the command never spawns anything.
      const { McpStdioClient } = await import('../../lib/agent/mcp-client.js');
      const { buildMinimalEnv } = await import('../../lib/agent/mcp-config.js');
      info(`Connecting to "${trimmed}" → ${[server.command, ...(server.args ?? [])].join(' ')}…`);
      let client;
      try {
        client = await McpStdioClient.start({
          command: server.command,
          args: server.args ?? [],
          env: buildMinimalEnv(server.env, process.env),
          initTimeoutMs: timeoutMs,
          requestTimeoutMs: timeoutMs,
        });
      } catch (err) {
        throw new SpycoreCliError(
          `Failed to connect to "${trimmed}".`,
          EXIT_NETWORK_ERROR,
          err instanceof Error ? err.message : String(err),
        );
      }
      try {
        const tools = await client.listTools();
        if (getOutputOptions().json) {
          json({
            name: trimmed,
            serverInfo: client.serverInfo,
            protocolVersion: client.protocolVersion,
            tools: tools.map((t) => ({ name: t.name, description: t.description })),
          });
          return;
        }
        const si = client.serverInfo;
        const label = si?.name ? `${si.name}${si.version ? ` ${si.version}` : ''}` : 'server';
        success(`Connected to ${sanitizeForDisplay(label)} (protocol ${sanitizeForDisplay(client.protocolVersion ?? 'unknown')}).`);
        if (tools.length === 0) {
          warn('The server exposed no tools.');
          return;
        }
        print(`${tools.length} tool${tools.length === 1 ? '' : 's'}:`);
        for (const t of tools) {
          const desc = t.description ? ` — ${sanitizeForDisplay(t.description.replace(/\s+/g, ' ')).slice(0, 100)}` : '';
          print(`  mcp__${trimmed}__${sanitizeForDisplay(t.name)}${desc}`);
        }
      } finally {
        await client.shutdown();
      }
    });
}

export function registerMcpCommand(program: Command): void {
  const group = program
    .command('mcp')
    .description('Connect the agent to Model Context Protocol servers (stdio). Servers run with a minimal env; every tool call is approved');

  registerAdd(group);
  registerList(group);
  registerRemove(group);
  registerToggle(group, true);
  registerToggle(group, false);
  registerTest(group);
  registerTrust(group);
  registerUntrust(group);

  group
    .command('help', { isDefault: true, hidden: true })
    .description('Show help for the mcp subcommand')
    .action(() => {
      group.help();
    });
}
