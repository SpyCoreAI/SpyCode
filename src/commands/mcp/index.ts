import { Command, Option } from 'commander';
import {
  loadMcpServers,
  readScope,
  writeScope,
  parseEnvAssignment,
  parseHeaderAssignment,
  isValidServerName,
  isRemoteServer,
  describeEnvVar,
  describeHeader,
  describeServerTarget,
  validateRemoteMcpUrl,
  type McpScope,
  type McpServerConfig,
} from '../../lib/agent/mcp-config.js';
import { EXIT_USER_ERROR, EXIT_NETWORK_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { redactUrlCredentials } from '../../lib/redact.js';
import {
  getTrustedWorkspaces,
  isWorkspaceTrusted,
  trustWorkspace,
  untrustWorkspace,
} from '../../lib/config.js';
import { formatOption, getOutputOptions, info, json, print, resolveFormat, success, warn } from '../../lib/output.js';
import { confirmYesNo } from '../../lib/prompt.js';
import { resolve as resolvePath } from 'node:path';

/**
 * `spycore mcp <subcommand>` - manage Model Context Protocol servers the agent
 * connects to: local children over stdio, or remote servers over the
 * streamable HTTP transport (`--url`, https required off-loopback, header auth
 * via `${ENV_VAR}` references whose values are never echoed). Configured
 * servers are connected at agent start (on EVERY provider) and their tools
 * join the registry as `mcp__<server>__<tool>`, gated by the same approval
 * discipline as the built-in mutating tools - identically for both transports.
 *
 * Two scopes: user-global (the stored config) and project (./.spycore/mcp.json,
 * written with --project); project entries override user ones by name.
 *
 * SAFETY: a server child inherits only a MINIMAL environment - PATH/HOME plus
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

/** Collect a repeatable --header "Name: value" into a list of raw strings. */
function collectHeader(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** Parse --header strings into a headers record, surfacing a clear error. */
function parseHeaderList(raw: string[]): Record<string, string> | undefined {
  if (raw.length === 0) return undefined;
  const headers: Record<string, string> = {};
  for (const r of raw) {
    try {
      const { name, value } = parseHeaderAssignment(r);
      headers[name] = value;
    } catch (err) {
      throw new SpycoreCliError(
        'Invalid --header value.',
        EXIT_USER_ERROR,
        err instanceof Error ? err.message : undefined,
      );
    }
  }
  return headers;
}

function registerAdd(group: Command): void {
  group
    .command('add <name> [command...]')
    .description('Add an MCP server: a local command (everything after `--`), or a remote URL via --url')
    .addOption(
      new Option('--env <KEY=VALUE>', 'Env var to expose to the server child (repeatable; bare KEY passes the parent value through; stdio only)')
        .argParser(collectEnv)
        .default([]),
    )
    .addOption(
      new Option('--url <url>', 'Remote server endpoint (streamable HTTP). https:// required except on loopback')
    )
    .addOption(
      new Option('--header <Name: value>', 'Request header for a --url server (repeatable). Reference secrets as ${ENV_VAR} - never paste them')
        .argParser(collectHeader)
        .default([]),
    )
    .addOption(new Option('--project', 'Write to ./.spycore/mcp.json instead of your user config'))
    .action((name: string, command: string[], opts: { env: string[]; url?: string; header: string[]; project?: boolean }) => {
      const trimmed = name.trim();
      if (!isValidServerName(trimmed)) {
        throw new SpycoreCliError(
          `Invalid server name: "${name}".`,
          EXIT_USER_ERROR,
          'Use letters, digits, "-" and "_", starting with a letter or digit (it becomes part of the tool id).',
        );
      }
      const argv = (command ?? []).filter((s) => s.length > 0);
      const scope = scopeOf(opts.project);
      const existing = readScope(scope, process.cwd());
      if (existing.some((s) => s.name === trimmed)) {
        throw new SpycoreCliError(
          `An MCP server named "${trimmed}" already exists in ${scope} scope.`,
          EXIT_USER_ERROR,
          'Remove it first (`spycore mcp remove`) or pick another name.',
        );
      }

      let entry: McpServerConfig;
      if (opts.url !== undefined) {
        // Remote (streamable HTTP) entry.
        if (argv.length > 0) {
          throw new SpycoreCliError(
            'Pass either a command (stdio) or --url (remote) - not both.',
            EXIT_USER_ERROR,
          );
        }
        if ((opts.env ?? []).length > 0) {
          throw new SpycoreCliError(
            '--env applies to stdio servers only; use --header with a ${ENV_VAR} reference for remote auth.',
            EXIT_USER_ERROR,
          );
        }
        const urlErr = validateRemoteMcpUrl(opts.url);
        if (urlErr) {
          throw new SpycoreCliError(`Invalid --url.`, EXIT_USER_ERROR, urlErr);
        }
        const headers = parseHeaderList(opts.header ?? []);
        entry = { name: trimmed, type: 'http', url: opts.url, ...(headers ? { headers } : {}) };
      } else {
        if (argv.length === 0) {
          throw new SpycoreCliError(
            'A command (or --url for a remote server) is required.',
            EXIT_USER_ERROR,
            'Examples: spycore mcp add files -- npx -y @modelcontextprotocol/server-filesystem .\n' +
              '          spycore mcp add remote --url https://mcp.example.com/mcp --header \'Authorization: Bearer ${MCP_TOKEN}\'',
          );
        }
        if ((opts.header ?? []).length > 0) {
          throw new SpycoreCliError('--header applies to --url servers only.', EXIT_USER_ERROR);
        }
        const [cmd, ...rest] = argv;
        const env = parseEnvList(opts.env ?? []);
        entry = {
          name: trimmed,
          command: cmd as string,
          ...(rest.length > 0 ? { args: rest } : {}),
          ...(env ? { env } : {}),
        };
      }
      writeScope(scope, process.cwd(), [...existing, entry]);
      success(`Added MCP server "${trimmed}" (${scope}).`);
      if (isRemoteServer(entry)) {
        // Defence in depth: `validateRemoteMcpUrl` above already refuses
        // credentials in a URL, so this is byte-identical for every accepted
        // input - one matching model rather than two.
        info(`  ${sanitizeForDisplay(redactUrlCredentials(entry.url ?? ''))} (streamable HTTP)`);
        const hdrs = Object.entries(entry.headers ?? {});
        // Header VALUES are never echoed - names + provenance only.
        if (hdrs.length > 0)
          info(
            `  headers: ${sanitizeForDisplay(
              hdrs.map(([n, v]) => describeHeader(n, v)).join(', '),
            )}`,
          );
      } else {
        const cmdLine = [entry.command, ...(entry.args ?? [])].join(' ');
        info(`  ${sanitizeForDisplay(cmdLine)}`);
        if (entry.env)
          info(`  env: ${sanitizeForDisplay(entry.env.map(describeEnvVar).join(', '))}`);
      }
      info('It will be connected on your next `spycore agent` run (any provider). Test it now: spycore mcp test ' + trimmed);
    });
}

function registerList(group: Command): void {
  group
    .command('list')
    .description('List configured MCP servers (user + project)')
    .addOption(formatOption())
    .action((opts: { format?: string }) => {
      const cwd = process.cwd();
      const servers = loadMcpServers(cwd);
      const trusted = getTrustedWorkspaces();
      if (resolveFormat(opts.format) === 'json') {
        json({
          servers: servers.map((s) =>
            isRemoteServer(s)
              ? {
                  name: s.name,
                  type: 'http',
                  // F-2c-46: header VALUES were already never emitted here,
                  // and the URL was emitted verbatim - so this sink, the one
                  // built to never echo a secret, disclosed one anyway.
                  url: s.url === undefined ? s.url : redactUrlCredentials(s.url),
                  // Header VALUES are never emitted - names + provenance only.
                  headers: Object.entries(s.headers ?? {}).map(([n, v]) => describeHeader(n, v)),
                  scope: s.scope,
                  enabled: s.enabled,
                }
              : {
                  // stdio rows keep the exact pre-1.9 keys (backward compat).
                  name: s.name,
                  command: [s.command, ...(s.args ?? [])].join(' '),
                  scope: s.scope,
                  enabled: s.enabled,
                  env: (s.env ?? []).map(describeEnvVar),
                },
          ),
          trustedWorkspaces: trusted,
          cwdTrusted: isWorkspaceTrusted(cwd),
        });
        return;
      }
      // Project-scoped servers only spawn in a trusted workspace - tell the user
      // whether THIS directory is trusted and how to change it.
      const hasProject = servers.some((s) => s.scope === 'project');
      const printTrustFooter = (): void => {
        if (!hasProject) return;
        if (isWorkspaceTrusted(cwd)) {
          info('This workspace is trusted - its project-scoped servers will run (spycore mcp untrust to revoke).');
        } else {
          warn('This workspace is NOT trusted - project-scoped servers are skipped. Run `spycore mcp trust` to enable them.');
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
        type: isRemoteServer(s) ? 'http' : 'stdio',
        command: describeServerTarget(s),
        scope: s.scope,
        enabled: s.enabled ? 'yes' : 'no',
      }));
      const w = (sel: (r: (typeof rows)[number]) => string, head: string): number =>
        Math.max(head.length, ...rows.map((r) => sel(r).length));
      const wName = w((r) => r.name, 'NAME');
      const wCmd = w((r) => r.command, 'COMMAND');
      const wScope = w((r) => r.scope, 'SCOPE');
      // The TYPE column appears only when a remote entry exists, so a
      // stdio-only config renders the exact pre-1.9 table.
      const hasRemote = servers.some(isRemoteServer);
      if (hasRemote) {
        const wType = w((r) => r.type, 'TYPE');
        print(`${'NAME'.padEnd(wName)}  ${'TYPE'.padEnd(wType)}  ${'COMMAND'.padEnd(wCmd)}  ${'SCOPE'.padEnd(wScope)}  ENABLED`);
        for (const r of rows) {
          print(
          `${sanitizeForDisplay(r.name).padEnd(wName)}  ${sanitizeForDisplay(r.type).padEnd(
            wType,
          )}  ${sanitizeForDisplay(r.command).padEnd(wCmd)}  ${sanitizeForDisplay(r.scope).padEnd(
            wScope,
          )}  ${r.enabled}`,
        );
        }
      } else {
        print(`${'NAME'.padEnd(wName)}  ${'COMMAND'.padEnd(wCmd)}  ${'SCOPE'.padEnd(wScope)}  ENABLED`);
        for (const r of rows) {
          print(
          `${sanitizeForDisplay(r.name).padEnd(wName)}  ${sanitizeForDisplay(r.command).padEnd(
            wCmd,
          )}  ${sanitizeForDisplay(r.scope).padEnd(wScope)}  ${r.enabled}`,
        );
        }
      }
      printTrustFooter();
    });
}

/**
 * `spycore mcp trust [path]` - mark a workspace as trusted so its PROJECT-scoped
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

/** `spycore mcp untrust [path]` - revoke a workspace's trust. */
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
    .addOption(new Option('-y, --yes', 'Remove without the confirmation prompt'))
    .action(async (name: string, opts: { project?: boolean; yes?: boolean }) => {
      const scope = scopeOf(opts.project);
      const trimmed = name.trim();
      // Fail before prompting when there is nothing to remove.
      const existing = readScope(scope, process.cwd());
      if (!existing.some((s) => s.name === trimmed)) {
        throw new SpycoreCliError(
          `No MCP server named "${trimmed}" in ${scope} scope.`,
          EXIT_USER_ERROR,
          'List them: spycore mcp list (use --project for project scope).',
        );
      }
      // Destructive: confirm first. The prompt sanitizes the composed
      // question (see prompt.ts); a non-answer cancels the removal.
      if (!opts.yes && !(await confirmYesNo(`Remove MCP server "${trimmed}" (${scope})?`))) {
        info('Cancelled - nothing removed.');
        return;
      }
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
      const cwd = process.cwd();
      const server = loadMcpServers(cwd).find((s) => s.name === trimmed);
      if (!server) {
        throw new SpycoreCliError(`No MCP server named "${trimmed}".`, EXIT_USER_ERROR, 'List them: spycore mcp list');
      }
      // WORKSPACE TRUST - THE SAME FAIL-CLOSED GATE THE AGENT BRIDGE APPLIES.
      // `loadMcpServers` MERGES project-scoped entries from ./.spycore/mcp.json,
      // so without this a cloned repo's server runs on `spycore mcp test <name>`
      // in a workspace the user never trusted - the clone-and-run RCE the gate
      // exists to stop, reached through a different command. PROVEN, not
      // reasoned: a spawn sentinel in an untrusted hostile repo FIRED here
      // (`SPAWNED pid=… cwd=…/hostile-repo`) while `setupMcpBridge` over the
      // SAME workspace spawned zero, and spawned one once the workspace was
      // trusted - so the differential isolates this command, not the fixture.
      // Both transports are gated because both act on the user's behalf: stdio
      // runs a local command, remote sends requests carrying `${ENV}` header
      // credentials. User-scoped servers are user-authored and unaffected.
      if (server.scope === 'project' && !isWorkspaceTrusted(cwd)) {
        throw new SpycoreCliError(
          `"${trimmed}" is a project-scoped MCP server and this workspace is not trusted.`,
          EXIT_USER_ERROR,
          'Run `spycore mcp trust` in this directory to enable it (project servers run local commands or send requests with your credentials - only trust repositories you know).',
        );
      }
      const timeoutMs = Math.max(1, Math.min(120, Number(opts.timeout ?? 10) || 10)) * 1000;
      info(`Connecting to "${trimmed}" → ${sanitizeForDisplay(describeServerTarget(server))}…`);
      let client;
      try {
        if (isRemoteServer(server)) {
          // Lazy-load so registering the command never opens a connection.
          const { McpHttpClient } = await import('../../lib/agent/mcp-http-client.js');
          const { expandServerHeaders } = await import('../../lib/agent/mcp-config.js');
          const urlErr = validateRemoteMcpUrl(server.url ?? '');
          if (urlErr) throw new Error(urlErr);
          client = await McpHttpClient.connect({
            url: server.url ?? '',
            headers: expandServerHeaders(server.headers, process.env),
            initTimeoutMs: timeoutMs,
            requestTimeoutMs: timeoutMs,
          });
        } else {
          // Lazy-load the client so registering the command never spawns anything.
          const { McpStdioClient } = await import('../../lib/agent/mcp-client.js');
          const { buildMinimalEnv } = await import('../../lib/agent/mcp-config.js');
          client = await McpStdioClient.start({
            command: server.command ?? '',
            args: server.args ?? [],
            env: buildMinimalEnv(server.env, process.env),
            initTimeoutMs: timeoutMs,
            requestTimeoutMs: timeoutMs,
          });
        }
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
          const desc = t.description ? ` - ${sanitizeForDisplay(t.description.replace(/\s+/g, ' ')).slice(0, 100)}` : '';
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
    .description('Connect the agent to Model Context Protocol servers - local (stdio) or remote (streamable HTTP via --url). Local servers run with a minimal env; remote ones require https off-loopback; every tool call is approved');

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
