import Conf from 'conf';
import { chmodSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import type { StoredProviderConfig } from './providers/byok-config.js';
import type { McpServerConfig } from './agent/mcp-config.js';
// Runtime-safe: effort.ts has only a type-only import of models.ts, so this
// import adds no runtime cycle (config ← models ← effort would be one, but
// effort imports nothing at runtime).
import { isEffortLevel, type EffortLevel } from './effort.js';

/**
 * Persistent CLI configuration. Stored at the OS-appropriate config dir
 * (XDG-compliant on Linux, ~/Library/Preferences on macOS, %APPDATA% on
 * Windows) — `conf` handles the platform difference for us.
 *
 * Schema-validated so a typo in `spycore config set` fails loudly rather
 * than silently writing garbage.
 */
export interface CliConfigSchema {
  apiUrl: string;
  defaultModel: string;
  defaultStream: boolean;
  /**
   * Default reasoning effort for chat ('auto' | 'low' | 'medium' | 'high' |
   * 'max'). Clamped per-model at send time; overridden by `chat --effort`.
   * Defaults to 'auto'. Billing is effort-neutral, so this never changes cost.
   */
  defaultEffort: EffortLevel;
  /**
   * Inject the generated CODEBASE_GUIDE.md into each new chat conversation's
   * context (Part 3a). Default true; set false to trim context. Read alongside
   * SPYCODE.md by `buildContextInjection`.
   */
  injectGuide: boolean;
  /**
   * Inject the latest CODEBASE_CHANGELOG.md entries into each new chat
   * conversation's context (Part 3a). Default true; set false to trim context.
   */
  injectChangelog: boolean;
  /**
   * After an agent task completes, auto-append a newest-first entry to
   * ./CODEBASE_CHANGELOG.md when it exists (Part 3b). Default true.
   */
  autoChangelog: boolean;
  /**
   * After an agent task that changed the repo's top-level structure or
   * package.json deps, regenerate ./CODEBASE_GUIDE.md (preserving its
   * "## Notes (manual)" section) (Part 3b). Default true.
   */
  autoRefreshGuide: boolean;
  theme: 'auto' | 'light' | 'dark';
  outputFormat: 'text' | 'json' | 'markdown';
  /**
   * Cache of the most recent whoami response. Used by ping/whoami when the
   * --offline-friendly behaviour is requested. Always overwritten — never
   * a source of truth.
   */
  lastWhoami?: {
    email: string;
    plan: string;
    cachedAt: string;
  };
  /** Saved named provider configs (`spycore provider add`). Managed by the
   *  `provider` command, not raw `config set` (so they're kept out of KNOWN_KEYS). */
  providers?: StoredProviderConfig[];
  /** The default provider for `agent` runs: a saved name, or 'spycore'. */
  defaultProvider?: string;
  /** User-global MCP servers (`spycore mcp add`). Managed by the `mcp` command,
   *  not raw `config set` (kept out of KNOWN_KEYS). Project-level servers live in
   *  ./.spycore/mcp.json and merge over these by name. */
  mcpServers?: McpServerConfig[];
  /** Absolute workspace paths the user has trusted to run PROJECT-scoped MCP
   *  servers (./.spycore/mcp.json). Managed by the trust gate, not raw
   *  `config set` (kept out of KNOWN_KEYS). See isWorkspaceTrusted/trustWorkspace. */
  trustedWorkspaces?: string[];
}

const DEFAULT_API_URL = 'https://api.spycore.ai/api';

const defaults: CliConfigSchema = {
  apiUrl: DEFAULT_API_URL,
  defaultModel: 'hermes',
  defaultStream: true,
  defaultEffort: 'auto',
  injectGuide: true,
  injectChangelog: true,
  autoChangelog: true,
  autoRefreshGuide: true,
  theme: 'auto',
  outputFormat: 'text',
};

const KNOWN_KEYS = new Set<keyof CliConfigSchema>([
  'apiUrl',
  'defaultModel',
  'defaultStream',
  'defaultEffort',
  'injectGuide',
  'injectChangelog',
  'autoChangelog',
  'autoRefreshGuide',
  'theme',
  'outputFormat',
  'lastWhoami',
]);

/**
 * `conf` writes synchronously, so tests can swap the backing dir via the
 * `cwd` option. We keep a singleton in production but allow opt-in resets
 * for tests via `__resetConfigForTests`.
 */
let store: Conf<CliConfigSchema> | null = null;

/**
 * The CLI's own version, read from its package.json. We walk up from this
 * module rather than using a fixed relative path because the depth differs
 * between the bundled build (build/index.js — one level under the package)
 * and the unbundled test run (src/lib/config.ts — two levels under), so a
 * hardcoded `..` would resolve in only one of them. Falls back to '0.0.0'
 * if the manifest can't be located. `conf` uses this for config migrations.
 */
function readCliVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, 'package.json'), 'utf-8'),
      ) as { name?: string; version?: string };
      if (pkg.name === '@spycore/cli' && typeof pkg.version === 'string') {
        return pkg.version;
      }
    } catch {
      // No (readable) package.json at this level — keep walking toward root.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

const CLI_VERSION = readCliVersion();

export function getConfigStore(): Conf<CliConfigSchema> {
  if (!store) {
    // Test hook: SPYCORE_TEST_CWD routes writes to a tmpdir so suites stay
    // isolated. SPYCORE_CONFIG_DIR is the user-facing override (XDG dirs on
    // shared servers, ephemeral CI runners, etc.). Test hook wins so the
    // suite never accidentally clobbers a developer's real config.
    const testCwd = process.env.SPYCORE_TEST_CWD;
    const userCwd = process.env.SPYCORE_CONFIG_DIR;
    const cwd = testCwd && testCwd.length > 0
      ? testCwd
      : userCwd && userCwd.length > 0
        ? userCwd
        : undefined;
    store = new Conf<CliConfigSchema>({
      projectName: 'spycore',
      defaults,
      projectVersion: CLI_VERSION,
      ...(cwd ? { cwd } : {}),
    });
  }
  return store;
}

/** Test hook: reset the singleton so unit tests pick up a fresh tmpdir. */
export function __resetConfigForTests(): void {
  store = null;
}

export function isKnownKey(key: string): key is keyof CliConfigSchema {
  return KNOWN_KEYS.has(key as keyof CliConfigSchema);
}

export function listKnownKeys(): string[] {
  return Array.from(KNOWN_KEYS);
}

/**
 * Resolve apiUrl with the precedence the brief specifies:
 *   1. CLI flag (--api-url)
 *   2. Env var (SPYCORE_API_URL)
 *   3. Config file
 *   4. Default
 *
 * Callers pass the parsed CLI flag value (may be undefined).
 */
export function resolveApiUrl(flagValue?: string | undefined): string {
  if (flagValue && flagValue.trim().length > 0) return flagValue.trim();
  const envValue = process.env.SPYCORE_API_URL;
  if (envValue && envValue.trim().length > 0) return envValue.trim();
  return getConfigStore().get('apiUrl');
}

/**
 * Normalise a resolved API base so it always ends in exactly one `/api`
 * segment. Handles a missing suffix, trailing slashes, and an already-present
 * suffix — every variant below normalises to `https://api.spycore.ai/api`:
 *   https://api.spycore.ai       https://api.spycore.ai/api
 *   https://api.spycore.ai/      https://api.spycore.ai/api/
 *
 * The transport layer (lib/api.ts, lib/sse.ts) calls this so neither has to
 * special-case the suffix at every request. Previously a base configured
 * without `/api` silently 404'd every bare-path request, since only the
 * `/api/`-prefixed call sites happened to resolve.
 */
export function normalizeApiBase(base: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

export function getConfigPath(): string {
  return getConfigStore().path;
}

/**
 * Hosts that may receive the bearer token. The CLI's token is a SpyCore
 * credential, so it is attached ONLY to the SpyCore API — spycore.ai (canonical)
 * plus the permanent .ca alias — and to localhost for dev / self-hosting. Any
 * other host resolved from `--api-url` / `SPYCORE_API_URL` (an attacker-supplied
 * or prompt-injected base URL) must NOT receive the token, or it is exfiltrated.
 * The transport layer (lib/api.ts, lib/sse.ts) gates the Authorization header on
 * this. KEEP-BOTH: api.spycore.ai is canonical, api.spycore.ca a permanent alias.
 */
const TOKEN_HOST_ALLOWLIST = new Set([
  'api.spycore.ai',
  'api.spycore.ca',
  'localhost',
  '127.0.0.1',
  '::1',
]);

/**
 * True when the resolved request URL's host is allowed to receive the bearer
 * token (see TOKEN_HOST_ALLOWLIST). Unparseable URLs fail closed (no token).
 */
export function isTrustedTokenHost(url: string): boolean {
  let host: string;
  try {
    // `hostname` drops the port and strips IPv6 brackets ('[::1]' → '::1').
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return TOKEN_HOST_ALLOWLIST.has(host);
}

/**
 * Lock the config file down to owner-only (0600), and its dir to 0700. The file
 * holds the bearer token and may hold inline provider keys. Best-effort: chmod
 * is a no-op on Windows, and the file may not exist before the first write —
 * both are swallowed. Call after every secret-bearing write. (The dir mode is
 * the durable guard, since `conf`'s atomic writes recreate the file.)
 */
export function ensureConfigFileMode(): void {
  try {
    const file = getConfigPath();
    chmodSync(file, 0o600);
    chmodSync(dirname(file), 0o700);
  } catch {
    /* best-effort: no POSIX modes on Windows, ENOENT before first write, etc. */
  }
}

/**
 * Token storage helpers. We deliberately keep `token` OUT of the
 * `CliConfigSchema` type so it isn't a first-class config key. It can still
 * land in `getConfigStore().store`, so bulk dumps (`config list` / `get`)
 * run the store through redactSecrets() before printing. These accessors are
 * the only sanctioned way to read/write the token from the file backend.
 */
const TOKEN_KEY = '__token__';

export function getStoredTokenFromFile(): string | null {
  const raw = (getConfigStore() as unknown as {
    get(k: string): unknown;
  }).get(TOKEN_KEY);
  return typeof raw === 'string' ? raw : null;
}

export function setStoredTokenInFile(token: string): void {
  ;(getConfigStore() as unknown as { set(k: string, v: string): void }).set(
    TOKEN_KEY,
    token,
  );
  ensureConfigFileMode();
}

/**
 * Saved provider configs. Persisted under the `providers` key (kept out of
 * KNOWN_KEYS so `config set` can't touch them — they're managed by the
 * `provider` command). `config list`/`get` runs the store through
 * redactSecrets(), which masks any `apiKey`/`apiKeyEnv` field at any depth.
 */
export function getStoredProviders(): StoredProviderConfig[] {
  const raw = getConfigStore().get('providers');
  return Array.isArray(raw) ? raw : [];
}

export function setStoredProviders(list: StoredProviderConfig[]): void {
  getConfigStore().set('providers', list);
  ensureConfigFileMode();
}

/** The default provider name for `agent` runs ('spycore' or a saved name); undefined → spycore. */
export function getDefaultProviderName(): string | undefined {
  const raw = getConfigStore().get('defaultProvider');
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export function setDefaultProviderName(name: string | undefined): void {
  const store = getConfigStore();
  if (name === undefined || name.length === 0) store.delete('defaultProvider');
  else store.set('defaultProvider', name);
  ensureConfigFileMode();
}

export function clearStoredTokenInFile(): void {
  ;(getConfigStore() as unknown as { delete(k: string): void }).delete(TOKEN_KEY);
}

/**
 * User-global MCP servers. Persisted under the `mcpServers` key (kept out of
 * KNOWN_KEYS so `config set` can't touch them — they're managed by the `mcp`
 * command). Project-level servers (./.spycore/mcp.json) merge over these by
 * name; see lib/agent/mcp-config.ts.
 */
export function getStoredMcpServers(): McpServerConfig[] {
  const raw = getConfigStore().get('mcpServers');
  return Array.isArray(raw) ? raw : [];
}

export function setStoredMcpServers(list: McpServerConfig[]): void {
  getConfigStore().set('mcpServers', list);
  ensureConfigFileMode();
}

/**
 * Workspace trust for PROJECT-scoped MCP servers. A cloned/opened repo can ship
 * a ./.spycore/mcp.json that would otherwise spawn arbitrary commands the moment
 * `spycore agent` starts (clone-and-run RCE). We therefore record, in the user's
 * GLOBAL config (never in the repo), the set of absolute workspace paths the user
 * has explicitly trusted. Project MCP servers spawn only for a trusted workspace;
 * user-global (~/.spycore) servers are user-authored and always trusted.
 * Stored under `trustedWorkspaces` (kept out of KNOWN_KEYS — managed here, not by
 * raw `config set`).
 */
function normalizeWorkspacePath(cwd: string): string {
  // resolve() collapses `.`/`..` and a trailing slash so the same workspace maps
  // to one canonical key regardless of how cwd was spelled.
  return resolve(cwd);
}

export function getTrustedWorkspaces(): string[] {
  const raw = getConfigStore().get('trustedWorkspaces');
  return Array.isArray(raw) ? raw.filter((p): p is string => typeof p === 'string') : [];
}

export function isWorkspaceTrusted(cwd: string): boolean {
  return getTrustedWorkspaces().includes(normalizeWorkspacePath(cwd));
}

export function trustWorkspace(cwd: string): void {
  const path = normalizeWorkspacePath(cwd);
  const list = getTrustedWorkspaces();
  if (list.includes(path)) return;
  list.push(path);
  getConfigStore().set('trustedWorkspaces', list);
  ensureConfigFileMode();
}

/**
 * Revoke a previously-trusted workspace. Returns true when a stored entry was
 * removed, false when the path was not trusted. The counterpart to
 * trustWorkspace, driven by `spycore mcp untrust`.
 */
export function untrustWorkspace(cwd: string): boolean {
  const path = normalizeWorkspacePath(cwd);
  const list = getTrustedWorkspaces();
  const next = list.filter((p) => p !== path);
  if (next.length === list.length) return false;
  getConfigStore().set('trustedWorkspaces', next);
  ensureConfigFileMode();
  return true;
}

/**
 * Read a raw stored value by key, including non-schema keys like `__token__`.
 * Returns undefined when absent. `config get` uses this to surface (redacted,
 * unless --reveal) secret keys without widening CliConfigSchema.
 */
export function peekStoredValue(key: string): unknown {
  return (getConfigStore() as unknown as { get(k: string): unknown }).get(key);
}

/**
 * Validate + coerce a value before storing it. Booleans accept the obvious
 * string forms ("true" / "false") so users can `spycore config set defaultStream false`.
 */
export function coerceValue(
  key: keyof CliConfigSchema,
  raw: string,
): CliConfigSchema[keyof CliConfigSchema] {
  switch (key) {
    case 'apiUrl': {
      try {
        const url = new URL(raw);
        if (!['http:', 'https:'].includes(url.protocol)) {
          throw new Error('apiUrl must use http or https');
        }
        return raw;
      } catch {
        throw new Error(`Invalid apiUrl: ${raw}`);
      }
    }
    case 'defaultStream':
    case 'injectGuide':
    case 'injectChangelog':
    case 'autoChangelog':
    case 'autoRefreshGuide': {
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new Error(`${key} must be 'true' or 'false', got: ${raw}`);
    }
    case 'defaultEffort': {
      const lower = raw.toLowerCase();
      if (!isEffortLevel(lower)) {
        throw new Error(
          `defaultEffort must be one of: auto, low, medium, high, max`,
        );
      }
      return lower;
    }
    case 'theme': {
      if (!['auto', 'light', 'dark'].includes(raw)) {
        throw new Error(`theme must be one of: auto, light, dark`);
      }
      return raw as 'auto' | 'light' | 'dark';
    }
    case 'outputFormat': {
      if (!['text', 'json', 'markdown'].includes(raw)) {
        throw new Error(`outputFormat must be one of: text, json, markdown`);
      }
      return raw as 'text' | 'json' | 'markdown';
    }
    default:
      return raw;
  }
}
