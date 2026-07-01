/**
 * Pure MCP (Model Context Protocol) server configuration: the stored shape, env
 * handling, the project-file (./.spycore/mcp.json) I/O, and the user⊕project
 * merge. Kept free of any process-spawning so it stays tiny and trivially
 * unit-testable; the stdio client (mcp-client.ts) and the agent bridge (mcp.ts)
 * are separate modules loaded only when a server is actually used.
 *
 * Two scopes, mirroring skills precedence:
 *   user     <configDir> mcpServers[]          (all projects)
 *   project  ./.spycore/mcp.json { servers:[] } (cwd-relative)
 * On a name collision the PROJECT entry wins. With zero servers configured the
 * merged list is empty and the agent run spawns nothing (no behaviour change).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getStoredMcpServers, setStoredMcpServers } from '../config.js';

/**
 * One environment variable handed to a server child. `value === undefined` means
 * "pass the parent process's value for this NAME through at spawn time" — the
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
  /** Executable to spawn (resolved via PATH). */
  command: string;
  /** Arguments passed to the command (no shell — argv array). */
  args?: string[] | undefined;
  /** Env vars to expose to the child (names passed through, or literals). */
  env?: McpEnvVar[] | undefined;
  /** Default true; a disabled server is kept but never spawned. */
  enabled?: boolean | undefined;
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
 * VALUE is never echoed — even literals (a user may paste a token despite the
 * passthrough-by-NAME guidance); the config file remains the source of truth.
 */
export function describeEnvVar(e: McpEnvVar): string {
  return e.value === undefined ? `${e.name} (from env)` : `${e.name} (literal)`;
}

/**
 * Build the MINIMAL environment a server child inherits: PATH + HOME (so the
 * executable resolves and behaves), the platform essentials on Windows, and the
 * explicitly-configured vars only. The full parent env — which may hold
 * unrelated secrets — is deliberately NOT forwarded; the approval gate is the
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
  return typeof o.name === 'string' && typeof o.command === 'string';
}

/** Coerce a raw parsed entry to a clean McpServerConfig (drops junk fields). */
function normalizeEntry(v: McpServerConfig): McpServerConfig {
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
 * Read project-scoped servers from ./.spycore/mcp.json. Never throws — a missing
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

/** The enabled subset of the merged list — what the agent bridge actually spawns. */
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
