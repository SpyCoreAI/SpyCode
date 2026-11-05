/**
 * Pure MCP (Model Context Protocol) server configuration: the stored shape, env
 * handling, the project-file (./.spycore/mcp.json) I/O, and the user⊕project
 * merge. Kept free of any process-spawning so it stays tiny and trivially
 * unit-testable; the stdio client (mcp-client.ts) and the agent bridge (mcp.ts)
 * are separate modules loaded only when a server is actually used.
 *
 * Two scopes, mirroring skills precedence:
 * user     <configDir> mcpServers[]          (all projects)
 * project  ./.spycore/mcp.json { servers:[] } (cwd-relative)
 * On a name collision the PROJECT entry wins. With zero servers configured the
 * merged list is empty and the agent run spawns nothing (no behaviour change).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getStoredMcpServers, setStoredMcpServers } from '../config.js';
// redact.ts imports nothing, so this cannot form a cycle with config.ts.
import { redactUrlCredentials } from '../redact.js';

/**
 * One environment variable handed to a server child. `value === undefined` means
 * "pass the parent process's value for this NAME through at spawn time" - the
 * secret-safe form (the secret never lands in the config file). A defined
 * `value` is a literal stored verbatim (for non-secrets).
 */
export interface McpEnvVar {
  name: string;
  value?: string | undefined;
}

/** A stored MCP server entry (one per named server). */
export interface McpServerConfig {
  name: string;
  /**
   * Transport discriminator. Absent (every pre-1.9 config) or 'stdio' = local
   * child process; 'http' = remote server over the streamable HTTP transport.
   * Additive: existing stdio entries never carry this field.
   */
  type?: 'stdio' | 'http' | undefined;
  /** Executable to spawn (resolved via PATH). stdio entries only. */
  command?: string | undefined;
  /** Arguments passed to the command (no shell - argv array). stdio only. */
  args?: string[] | undefined;
  /** Env vars to expose to the child (names passed through, or literals). stdio only. */
  env?: McpEnvVar[] | undefined;
  /** Remote endpoint URL ('http' entries only). https required off-loopback. */
  url?: string | undefined;
  /**
   * Extra request headers ('http' entries only). VALUES may embed `${ENV_VAR}`
   * references, expanded from the parent environment at connect time - the
   * secret-safe form (the secret never lands in the config file). Values are
   * NEVER echoed in any output (see describeHeader).
   */
  headers?: Record<string, string> | undefined;
  /** Default true; a disabled server is kept but never spawned. */
  enabled?: boolean | undefined;
}

/** True for a remote (streamable HTTP) entry. */
export function isRemoteServer(s: McpServerConfig): boolean {
  return s.type === 'http';
}

/** Where a config scope lives. */
export type McpScope = 'user' | 'project';

/** A merged server with its scope and a normalised `enabled` boolean. */
export interface ResolvedMcpServer extends McpServerConfig {
  scope: McpScope;
  enabled: boolean;
}

/** Server names must be safe to embed in the `mcp__<name>__<tool>` tool id. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidServerName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Sanitise a server name into the `[A-Za-z0-9_-]` charset for a tool id. */
export function sanitizeServerName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Parse one `--env` value: `KEY=VALUE` → a literal; bare `KEY` → a passthrough
 * (value read from the parent env at spawn time). The split is on the FIRST `=`
 * so values may contain `=`. Throws on an empty/invalid name.
 */
export function parseEnvAssignment(raw: string): McpEnvVar {
  const eq = raw.indexOf('=');
  const name = (eq === -1 ? raw : raw.slice(0, eq)).trim();
  if (name.length === 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid env var name in "${raw}" (expected KEY or KEY=VALUE)`);
  }
  if (eq === -1) return { name };
  return { name, value: raw.slice(eq + 1) };
}

/**
 * A short, secret-safe label for one env var, for `mcp` detail output. The
 * VALUE is never echoed - even literals (a user may paste a token despite the
 * passthrough-by-NAME guidance); the config file remains the source of truth.
 */
export function describeEnvVar(e: McpEnvVar): string {
  return e.value === undefined ? `${e.name} (from env)` : `${e.name} (literal)`;
}

// ─────────────────────── remote (http) entries ───────────────────────

/** RFC 7230 header-name token (conservative). */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** `${ENV_VAR}` references inside a header value - the ONLY templating form. */
const ENV_REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Loopback hosts where plain http:// is permitted. Everything else = https. */
function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/**
 * Validate a remote MCP endpoint URL. Returns an error message, or null when
 * acceptable. HARD rules (no config escape hatch):
 * - https:// anywhere; http:// ONLY for loopback (localhost / 127.0.0.1 / ::1);
 * - no credentials in the URL (auth belongs in a header with a `${ENV}` ref).
 */
export function validateRemoteMcpUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `"${raw}" is not a valid URL`;
  }
  if (url.username !== '' || url.password !== '') {
    return 'credentials in the URL are not supported - pass auth via --header with a ${ENV_VAR} reference';
  }
  if (url.protocol === 'https:') return null;
  if (url.protocol === 'http:') {
    return isLoopbackHost(url.hostname)
      ? null
      : 'remote MCP servers require https:// (plain http is allowed only for loopback: localhost, 127.0.0.1, ::1)';
  }
  return `unsupported URL scheme "${url.protocol}" (use https://, or http:// on loopback)`;
}

/**
 * Parse one `--header` value: `Name: value` (first colon splits). The value may
 * embed `${ENV_VAR}` references, resolved at connect time. Throws on a missing
 * or invalid header name.
 */
export function parseHeaderAssignment(raw: string): { name: string; value: string } {
  const colon = raw.indexOf(':');
  const name = (colon === -1 ? raw : raw.slice(0, colon)).trim();
  if (name.length === 0 || !HEADER_NAME_RE.test(name)) {
    throw new Error(`invalid header name in "${raw.slice(0, 40)}" (expected "Name: value")`);
  }
  if (colon === -1) {
    throw new Error(`missing header value in "${raw.slice(0, 40)}" (expected "Name: value")`);
  }
  return { name, value: raw.slice(colon + 1).trim() };
}

/**
 * Expand every `${ENV_VAR}` reference in a server's header values from the
 * parent environment. Throws (per-server startup error - the session survives)
 * when a referenced variable is unset; the error names the header and the
 * VARIABLE only, never any value.
 */
export function expandServerHeaders(
  headers: Record<string, string> | undefined,
  parent: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, template] of Object.entries(headers ?? {})) {
    const missing: string[] = [];
    const value = template.replace(ENV_REF_RE, (_m, ref: string) => {
      const v = parent[ref];
      if (v === undefined) {
        missing.push(ref);
        return '';
      }
      return v;
    });
    if (missing.length > 0) {
      throw new Error(
        `header "${name}" references unset environment variable${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`,
      );
    }
    out[name] = value;
  }
  return out;
}

/**
 * A secret-safe label for one header, for `mcp` output. The VALUE is never
 * echoed in any form - not even literals.
 */
export function describeHeader(name: string, rawValue: string): string {
  // Fresh regex per call: ENV_REF_RE is /g (stateful lastIndex under .test()).
  return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(rawValue)
    ? `${name} (from env)`
    : `${name} (literal, hidden)`;
}

/**
 * The display target for a server: the command line (stdio) or the URL (http).
 *
 * F-2c-46: the remote branch strips URL userinfo. `validateRemoteMcpUrl`
 * refuses credentials in a URL, so nothing added through `mcp add` changes
 * shape here - but a hand-edited `mcp.json` is never re-validated on READ, and
 * this string is printed by `mcp list` and `mcp test`. Measured before the fix:
 * a hand-edited URL credential reached both.
 */
export function describeServerTarget(s: McpServerConfig): string {
  if (isRemoteServer(s)) return redactUrlCredentials(s.url ?? '');
  return [s.command ?? '', ...(s.args ?? [])].join(' ');
}

/**
 * Build the MINIMAL environment a server child inherits: PATH + HOME (so the
 * executable resolves and behaves), the platform essentials on Windows, and the
 * explicitly-configured vars only. The full parent env - which may hold
 * unrelated secrets - is deliberately NOT forwarded; the approval gate is the
 * control point for what an external server can do.
 */
export function buildMinimalEnv(
  vars: McpEnvVar[] | undefined,
  parent: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  const pass = (name: string): void => {
    const v = parent[name];
    if (v !== undefined) out[name] = v;
  };
  pass('PATH');
  pass('HOME');
  // Windows needs these for most executables (incl. node) to even launch.
  if (process.platform === 'win32') {
    pass('SystemRoot');
    pass('TEMP');
    pass('Path');
  }
  for (const e of vars ?? []) {
    if (e.value !== undefined) out[e.name] = e.value;
    else pass(e.name);
  }
  return out;
}

// ─────────────────────── project file I/O ───────────────────────

/** The project-scoped MCP config path: ./.spycore/mcp.json (cwd-relative). */
export function projectMcpPath(cwd: string): string {
  return join(cwd, '.spycore', 'mcp.json');
}

interface ProjectMcpFile {
  servers: McpServerConfig[];
}

/** True for a plausibly-valid server entry (lenient; bad entries are dropped). */
function isServerShape(v: unknown): v is McpServerConfig {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string') return false;
  // Remote entry: needs a url. Stdio entry (type absent/'stdio'): needs a command.
  if (o.type === 'http') return typeof o.url === 'string';
  return typeof o.command === 'string';
}

/** Coerce a raw parsed entry to a clean McpServerConfig (drops junk fields). */
function normalizeEntry(v: McpServerConfig): McpServerConfig {
  if (v.type === 'http') {
    const rawHeaders = v.headers;
    const headers: Record<string, string> = {};
    let headerCount = 0;
    if (rawHeaders !== null && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
      for (const [k, val] of Object.entries(rawHeaders)) {
        if (typeof val !== 'string') continue;
        headers[k] = val;
        headerCount += 1;
      }
    }
    return {
      name: v.name,
      type: 'http',
      url: String(v.url),
      ...(headerCount > 0 ? { headers } : {}),
      ...(v.enabled === false ? { enabled: false } : {}),
    };
  }
  // stdio (pre-1.9 shape) - byte-identical normalization to preserve
  // backward compatibility for every existing config file.
  const args = Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string') : undefined;
  const env = Array.isArray(v.env)
    ? v.env
        .filter((e): e is McpEnvVar => e !== null && typeof e === 'object' && typeof (e as McpEnvVar).name === 'string')
        .map((e) => (e.value === undefined ? { name: e.name } : { name: e.name, value: String(e.value) }))
    : undefined;
  return {
    name: v.name,
    command: v.command,
    ...(args && args.length > 0 ? { args } : {}),
    ...(env && env.length > 0 ? { env } : {}),
    ...(v.enabled === false ? { enabled: false } : {}),
  };
}

/**
 * Read project-scoped servers from ./.spycore/mcp.json. Never throws - a missing
 * or malformed file degrades to an empty list (a project shouldn't break every
 * agent run because someone hand-edited the JSON).
 */
export function loadProjectMcpServers(cwd: string): McpServerConfig[] {
  const file = projectMcpPath(cwd);
  try {
    if (!existsSync(file) || !statSync(file).isFile()) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ProjectMcpFile> | McpServerConfig[];
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.servers) ? parsed.servers : [];
    return list.filter(isServerShape).map(normalizeEntry);
  } catch {
    return [];
  }
}

/** Write project-scoped servers to ./.spycore/mcp.json (creates .spycore/). */
export function writeProjectMcpServers(cwd: string, servers: McpServerConfig[]): void {
  const file = projectMcpPath(cwd);
  mkdirSync(join(cwd, '.spycore'), { recursive: true });
  const body: ProjectMcpFile = { servers };
  writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
}

// ─────────────────────── load / merge / mutate ───────────────────────

/**
 * The merged, scope-tagged server list (user first, project overriding by
 * name). `enabled` is normalised to a boolean (default true). Sorted by name.
 */
export function loadMcpServers(cwd: string): ResolvedMcpServer[] {
  const byName = new Map<string, ResolvedMcpServer>();
  for (const s of getStoredMcpServers()) {
    byName.set(s.name, { ...s, scope: 'user', enabled: s.enabled !== false });
  }
  for (const s of loadProjectMcpServers(cwd)) {
    byName.set(s.name, { ...s, scope: 'project', enabled: s.enabled !== false }); // project wins
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The enabled subset of the merged list - what the agent bridge actually spawns. */
export function enabledMcpServers(cwd: string): ResolvedMcpServer[] {
  return loadMcpServers(cwd).filter((s) => s.enabled);
}

/** Read the server list for one scope (user store or project file). */
export function readScope(scope: McpScope, cwd: string): McpServerConfig[] {
  return scope === 'project' ? loadProjectMcpServers(cwd) : getStoredMcpServers();
}

/** Persist the server list for one scope. */
export function writeScope(scope: McpScope, cwd: string, servers: McpServerConfig[]): void {
  if (scope === 'project') writeProjectMcpServers(cwd, servers);
  else setStoredMcpServers(servers);
}
