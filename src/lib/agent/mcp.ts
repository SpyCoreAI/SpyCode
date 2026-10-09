/**
 * The agent-side MCP bridge: at run start it connects every ENABLED server -
 * stdio children spawned locally, `type:'http'` entries over the streamable
 * HTTP transport (in parallel, short timeout each) - lists their tools, and
 * exposes them to the tool registry as `mcp__<server>__<tool>` wrappers -
 * usable on EVERY provider, since they're plain entries in `ctx.extraTools`
 * routed through the same dispatch + approval path as the built-ins. Both
 * transports share ONE wrapper (McpClientHandle): identical classification
 * (mutating, agent-only), identical approval, identical hooks.
 *
 * Discipline carried over from the built-in tools:
 *  - EVERY MCP call requires approval (servers are external/opaque). The preview
 *    shows the server, tool, and JSON args. `A`/--yes apply via the controller.
 *  - Results are concatenated text content; non-text items are noted by type;
 *    the char-cap is dispatch's central `maxResultChars`.
 *  - A server that fails to start degrades to a dim warning - the run continues
 *    with the built-ins (and any servers that DID start). Never aborts the run.
 *  - Abort/Ctrl+C kills every child's process group; the run end shuts them down
 *    cleanly (close stdin → SIGTERM → SIGKILL).
 *  - Zero enabled servers ⇒ this returns null: no spawn, no prompt section, and
 *    the system prompt is byte-identical to a build without MCP.
 */
import {
  enabledMcpServers,
  buildMinimalEnv,
  expandServerHeaders,
  isRemoteServer,
  sanitizeServerName,
  validateRemoteMcpUrl,
  type ResolvedMcpServer,
} from './mcp-config.js';
import { isWorkspaceTrusted, trustWorkspace } from '../config.js';
import {
  McpStdioClient,
  DEFAULT_INIT_TIMEOUT_MS,
  isMcpTextContent,
  type McpCallResult,
  type McpContent,
  type McpToolDef,
} from './mcp-client.js';
import { McpHttpClient } from './mcp-http-client.js';
import type { ToolDefinition, ToolResult } from './tools.js';
import type { ApprovalRequest, RequestApproval } from './approval.js';
import { resolveApproval } from './approval.js';

/**
 * The transport-agnostic client surface the bridge programs against. Both
 * McpStdioClient and McpHttpClient satisfy it structurally, so remote tools
 * flow through the EXACT same registration/classification/approval/hook path
 * as stdio - there is no second path.
 */
export interface McpClientHandle {
  readonly pid: number | undefined;
  readonly serverInfo: { name?: string; version?: string } | null;
  readonly protocolVersion: string | null;
  listTools(): Promise<McpToolDef[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<McpCallResult>;
  kill(): void;
  shutdown(): Promise<void>;
}

/** Cap on the `# MCP tools` section appended to the system prompt (like skills). */
export const MCP_CATALOG_CAP = 4096;
/** Cap on a single tool's description in the catalog. */
const DESCRIPTION_CAP = 200;
/** Cap on the text fed back from one call BEFORE dispatch's byte-cap (a guard). */
const MAX_CALL_TEXT = 256 * 1024;

export interface McpBridge {
  /** `mcp__<server>__<tool>` → wrapper ToolDefinition, for `ctx.extraTools`. */
  tools: ReadonlyMap<string, ToolDefinition>;
  /** The `# MCP tools` system-prompt section ('' when no tools registered). */
  promptSection: string;
  /** Human-readable warnings for servers that failed to start. */
  warnings: string[];
  /** Servers that started successfully. */
  serverCount: number;
  /** Tools registered across all started servers. */
  toolCount: number;
  /** PIDs of the started server children (for diagnostics / teardown assertions). */
  serverPids: number[];
  /** Graceful teardown: detach the abort handler, stop every client. */
  shutdown(): Promise<void>;
}

export interface SetupMcpOptions {
  cwd: string;
  signal?: AbortSignal | undefined;
  requestApproval?: RequestApproval | undefined;
  /** Per-server handshake timeout (default 10s). */
  perServerTimeoutMs?: number | undefined;
  /** Per-call timeout (defaults to run_command's timeout via the loop). */
  callTimeoutMs?: number | undefined;
  /** Surface a server-startup warning (dim line in the UI). */
  onWarn?: ((message: string) => void) | undefined;
  /**
   * Trust resolver for PROJECT-scoped (cwd/.spycore) MCP servers in an UNTRUSTED
   * workspace. Provided ONLY in an interactive context (a TTY, not --yes/--json):
   * returning true persists trust for this workspace and spawns its project
   * servers; returning false - or omitting the callback entirely (headless / CI /
   * --yes) - skips them (fail-closed). User-global (~/.spycore) servers always
   * spawn regardless. This is the gate against clone-and-run RCE: a cloned repo's
   * project MCP config can no longer execute commands on `spycore agent` start
   * without an explicit, persisted per-workspace trust decision.
   */
  confirmProjectMcpTrust?:
    | ((req: { cwd: string; servers: ResolvedMcpServer[] }) => Promise<boolean>)
    | undefined;
}

interface StartedServer {
  server: ResolvedMcpServer;
  client: McpClientHandle;
  tools: McpToolDef[];
}

/**
 * Start ONE server on its configured transport and return a transport-agnostic
 * handle. stdio: spawn + handshake (unchanged). http: validate the URL (https
 * off-loopback - hard, no escape), expand `${ENV}` header refs (unresolved →
 * throws with the VARIABLE name only, never a value), then the streamable-HTTP
 * handshake. Throws McpError-ish messages that are safe to surface verbatim.
 */
async function startServerClient(
  server: ResolvedMcpServer,
  opts: SetupMcpOptions,
  initTimeout: number,
): Promise<McpClientHandle> {
  if (isRemoteServer(server)) {
    const url = server.url ?? '';
    const urlErr = validateRemoteMcpUrl(url);
    if (urlErr) throw new Error(urlErr);
    const headers = expandServerHeaders(server.headers, process.env);
    return McpHttpClient.connect({
      url,
      headers,
      initTimeoutMs: initTimeout,
      ...(opts.callTimeoutMs !== undefined ? { requestTimeoutMs: opts.callTimeoutMs } : {}),
      onPermanentFailure: (reason) => opts.onWarn?.(`MCP server "${server.name}" ${reason}`),
    });
  }
  return McpStdioClient.start({
    command: server.command ?? '',
    args: server.args ?? [],
    env: buildMinimalEnv(server.env, process.env),
    initTimeoutMs: initTimeout,
    ...(opts.callTimeoutMs !== undefined ? { requestTimeoutMs: opts.callTimeoutMs } : {}),
    // CL5: surface an overflow kill even when no request was in flight.
    onConnectionLost: (reason) => opts.onWarn?.(`MCP server "${server.name}" disconnected - ${reason}`),
  });
}

/**
 * Spawn + initialize every enabled server and build the bridge. Returns null
 * when no servers are enabled (or the run is already aborted) - the zero-config
 * no-op path. Never throws: per-server failures become warnings.
 */
export async function setupMcpBridge(opts: SetupMcpOptions): Promise<McpBridge | null> {
  const allEnabled = enabledMcpServers(opts.cwd);
  if (allEnabled.length === 0) return null;
  if (opts.signal?.aborted) return null;

  const warnings: string[] = [];
  // Apply the workspace-trust gate FIRST: drops project-scoped servers from an
  // untrusted workspace (unless the user grants trust this run). This runs
  // BEFORE any spawn, so a cloned repo's ./.spycore/mcp.json never executes.
  const servers = await resolveTrustedServers(allEnabled, opts, warnings);
  if (servers.length === 0) {
    // Nothing left to spawn. If the gate dropped everything, still return a
    // (tool-less) bridge so its warning surfaces; otherwise it's the pure
    // zero-config no-op (prompt byte-identical to MCP-off).
    if (warnings.length === 0) return null;
    return {
      tools: new Map(),
      promptSection: '',
      warnings,
      serverCount: 0,
      toolCount: 0,
      serverPids: [],
      shutdown: async () => {},
    };
  }

  const initTimeout = opts.perServerTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;

  const started = await Promise.all(
    servers.map(async (server): Promise<StartedServer | null> => {
      try {
        const client = await startServerClient(server, opts, initTimeout);
        const tools = await client.listTools();
        return { server, client, tools };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const msg = `MCP server "${server.name}" unavailable - ${reason}`;
        warnings.push(msg);
        opts.onWarn?.(msg);
        return null;
      }
    }),
  );

  const live = started.filter((s): s is StartedServer => s !== null);
  if (live.length === 0) {
    // Nothing started - return a bridge anyway so warnings surface, but with no
    // tools and no prompt section (byte-identical to MCP-off for the prompt).
    return {
      tools: new Map(),
      promptSection: '',
      warnings,
      serverCount: 0,
      toolCount: 0,
      serverPids: [],
      shutdown: async () => {},
    };
  }

  const tools = new Map<string, ToolDefinition>();
  const catalogEntries: CatalogEntry[] = [];
  // MINOR: guard against sanitized-name collisions (e.g. "a.b" and "a_b"
  // both sanitize to "a_b"). Without this, the second server's tools
  // silently overwrite the first's, routing calls to the wrong server.
  const seenPrefixes = new Set<string>();
  for (const { server, client, tools: serverTools } of live) {
    const prefix = `mcp__${sanitizeServerName(server.name)}__`;
    if (seenPrefixes.has(prefix)) {
      const msg = `Skipping MCP server "${server.name}": its sanitized name collides with another server. Rename one of them.`;
      warnings.push(msg);
      opts.onWarn?.(msg);
      continue;
    }
    seenPrefixes.add(prefix);
    for (const t of serverTools) {
      const fullName = `${prefix}${t.name}`;
      tools.set(fullName, makeWrapper(fullName, server.name, t, client, opts.callTimeoutMs));
      catalogEntries.push({ fullName, description: t.description, schema: t.inputSchema });
    }
  }

  const clients = live.map((s) => s.client);
  const killAll = (): void => {
    for (const c of clients) c.kill();
  };
  const signal = opts.signal;
  if (signal) signal.addEventListener('abort', killAll);

  return {
    tools,
    promptSection: buildMcpCatalog(catalogEntries),
    warnings,
    serverCount: live.length,
    toolCount: tools.size,
    serverPids: clients.map((c) => c.pid).filter((p): p is number => p !== undefined),
    shutdown: async () => {
      if (signal) signal.removeEventListener('abort', killAll);
      await Promise.all(clients.map((c) => c.shutdown().catch(() => {})));
    },
  };
}

/**
 * Workspace-trust gate. Returns the servers that may actually spawn:
 *  - user-global (~/.spycore) servers: always (user-authored, trusted);
 *  - project (cwd/.spycore) servers: only if the workspace is already trusted,
 *    or the interactive `confirmProjectMcpTrust` callback grants it this run
 *    (which persists the trust). Otherwise they are dropped with a warning -
 *    fail-closed, so a cloned repo can't run code at agent-start and `--yes`
 *    (no callback) can't silently grant trust.
 */
async function resolveTrustedServers(
  all: ResolvedMcpServer[],
  opts: SetupMcpOptions,
  warnings: string[],
): Promise<ResolvedMcpServer[]> {
  const projectServers = all.filter((s) => s.scope === 'project');
  // No project servers, or the workspace is already trusted → spawn everything.
  if (projectServers.length === 0 || isWorkspaceTrusted(opts.cwd)) return all;

  // Untrusted workspace with project-scoped servers. Ask only if an interactive
  // resolver was supplied; any failure / absence means "not trusted".
  let granted = false;
  if (opts.confirmProjectMcpTrust) {
    try {
      granted = await opts.confirmProjectMcpTrust({ cwd: opts.cwd, servers: projectServers });
    } catch {
      granted = false;
    }
  }
  if (granted) {
    trustWorkspace(opts.cwd);
    return all;
  }

  const names = projectServers.map((s) => s.name).join(', ');
  const n = projectServers.length;
  // Wording: byte-identical to pre-1.9 when every dropped server is stdio;
  // remote entries get an accurate variant (same gate, same fail-closed).
  const risk = projectServers.some(isRemoteServer)
    ? 'they run local commands or send requests with your credentials'
    : 'they run local commands';
  const msg =
    `Skipped ${n} project-scoped MCP server${n === 1 ? '' : 's'} (${names}) from an untrusted workspace. ` +
    `Run \`spycore mcp trust\` in this directory to enable them (${risk} - only trust repositories you know).`;
  warnings.push(msg);
  opts.onWarn?.(msg);
  return all.filter((s) => s.scope === 'user');
}

/** Build the per-call wrapper that gates on approval then routes via tools/call. */
function makeWrapper(
  fullName: string,
  serverName: string,
  tool: McpToolDef,
  client: McpClientHandle,
  callTimeoutMs: number | undefined,
): ToolDefinition {
  return {
    name: fullName,
    description: tool.description || `MCP tool from "${serverName}"`,
    // `parameters` is prompt-display only for MCP; dispatch skips the scalar
    // check (externalArgs) and the server validates the real JSON Schema.
    parameters: { type: 'object', properties: {} },
    // The server's real input schema, used verbatim for NATIVE tool declarations.
    jsonSchema:
      tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} },
    mutating: true,
    externalArgs: true,
    async execute(args, ctx): Promise<ToolResult> {
      const request: ApprovalRequest = {
        kind: 'mcp',
        server: serverName,
        tool: tool.name,
        fullName,
        args,
      };
      const outcome = await resolveApproval(ctx.requestApproval, request);
      if (!outcome.approved) {
        return {
          ok: false,
          kind: 'rejected',
          summary: 'rejected',
          content: `MCP tool ${fullName} was not run: ${outcome.reason ?? 'rejected by user'}.`,
        };
      }
      // Honour an abort that arrived while the approval was pending.
      if (ctx.signal?.aborted) {
        return { ok: false, summary: 'aborted', content: `MCP tool ${fullName} was aborted.` };
      }
      const timeoutMs = callTimeoutMs ?? ctx.commandTimeoutMs;
      let result;
      try {
        result = await client.callTool(tool.name, args, timeoutMs);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, summary: 'mcp error', content: `Error calling ${fullName}: ${reason}` };
      }
      const text = renderContent(result.content);
      const items = result.content.length;
      const summary = result.isError
        ? 'tool error'
        : `${items} item${items === 1 ? '' : 's'}`;
      return {
        ok: !result.isError,
        summary,
        content: text.length > 0 ? text : '(no content)',
      };
    },
  };
}

/** Concatenate text content; note non-text items by type. Guard-capped. */
function renderContent(content: McpContent[]): string {
  const parts: string[] = [];
  for (const item of content) {
    if (isMcpTextContent(item)) {
      parts.push(item.text);
    } else {
      parts.push(`[${item.type} content]`);
    }
  }
  const joined = parts.join('\n');
  return joined.length > MAX_CALL_TEXT ? joined.slice(0, MAX_CALL_TEXT) : joined;
}

// ─────────────────────── prompt catalogue ───────────────────────

interface CatalogEntry {
  fullName: string;
  description: string;
  schema: Record<string, unknown>;
}

/**
 * Summarise a JSON Schema's top-level params as `(a, b?, c?)` - required first
 * without `?`, optional with `?`. Bounded so a giant schema can't blow the cap.
 */
function summarizeSchema(schema: Record<string, unknown>): string {
  const props = schema.properties;
  if (props === null || typeof props !== 'object') return '';
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((r): r is string => typeof r === 'string'))
    : new Set<string>();
  const names = Object.keys(props as Record<string, unknown>);
  const ordered = [...names].sort((a, b) => Number(required.has(b)) - Number(required.has(a)));
  const shown = ordered.slice(0, 8).map((n) => (required.has(n) ? n : `${n}?`));
  const suffix = ordered.length > shown.length ? ', …' : '';
  return `(${shown.join(', ')}${suffix})`;
}

function oneLine(s: string, cap = DESCRIPTION_CAP): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

/**
 * The `# MCP tools` system-prompt section - '' when there are no tools (prompt
 * byte-identical to MCP-off). Full `- name(params): description` entries while
 * they fit MCP_CATALOG_CAP, then a names-only overflow line so every tool stays
 * discoverable. Mirrors the skills catalog shape.
 */
export function buildMcpCatalog(entries: CatalogEntry[]): string {
  if (entries.length === 0) return '';
  const header =
    '\n\n# MCP tools\nTools from connected MCP servers. Call them exactly like built-in tools (a spycore:tool block). EVERY call is shown to the user for approval first - the request shows the server, tool, and your JSON args. They run on any provider.\n';
  let out = header;
  let i = 0;
  for (; i < entries.length; i += 1) {
    const e = entries[i] as CatalogEntry;
    const sig = `${e.fullName}${summarizeSchema(e.schema)}`;
    const desc = e.description.length > 0 ? `: ${oneLine(e.description)}` : '';
    const entry = `- ${sig}${desc}\n`;
    if (out.length + entry.length > MCP_CATALOG_CAP) break;
    out += entry;
  }
  if (i < entries.length) {
    const rest = entries.slice(i).map((e) => e.fullName);
    let namesLine = `…plus ${rest.length} more, callable by exact name: `;
    let shown = 0;
    for (const n of rest) {
      const piece = `${shown > 0 ? ', ' : ''}${n}`;
      if (namesLine.length + piece.length > 500) break;
      namesLine += piece;
      shown += 1;
    }
    if (shown < rest.length) namesLine += `, +${rest.length - shown} more`;
    out += `${namesLine}\n`;
  }
  return out.replace(/\n$/, '');
}
