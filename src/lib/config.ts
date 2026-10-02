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
  /**
   * Offer the agent the web tools (web_search / fetch_url). Default true; set
   * false to remove them entirely (the model never sees them). The per-run
   * `spycore agent --no-web` flag wins over this.
   */
  agentWebTools: boolean;
  /**
   * Observe the workspace around each opaque tool call so `run_command`, MCP
   * tools and tool hooks are journaled and `spycore rewind` can restore them.
   * ⭐ Default FALSE — see the `SPY-416` note at the end of this comment.
   *
   * ⭐ IT COSTS. The observer enumerates, reads and hashes the workspace twice
   * per opaque call, and the cost grows with the FILE COUNT. Measured through
   * the real calls: ~30 ms on a 298-file package, ~375 ms on a 2,472-file
   * monorepo, ~1.4 s at the 20,000-file cap. Set false to pay none of it.
   *
   * ⭐ WHAT SURVIVES WHEN IT IS OFF, stated because a partial capability
   * described precisely beats a total one described falsely: `write_file` and
   * `edit_file` report their own changes, so those stay journaled and stay
   * rewindable. What is lost is exactly the opaque set — shell commands, MCP
   * tools and tool hooks. The run says so once, at the time.
   *
   * The per-run `spycore agent --observe` / `--no-observe` flags win over this.
   *
   * ⭐⭐ `SPY-416` / R-CLI-1 — THE DEFAULT IS **OFF**, AND THAT IS A PRODUCT
   * DECISION RATHER THAN A SAFETY ONE. Observation reads the full plaintext of
   * every file the ignore rules do not hide and stores it in an on-disk
   * journal. The published `0.6.0` writes nothing of the kind, so leaving this
   * on by default would give a user who merely UPDATES a new on-disk archive of
   * their project that they never asked for. No capability is removed: one
   * `spycore config set agentObserveWorkspace true`, or `--observe` for a
   * single run, turns it on, and everything it does is unchanged when it is on.
   */
  agentObserveWorkspace: boolean;
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
  /** PHASE-1 1.6: per-hook approvals for PROJECT-scoped lifecycle hooks
   *  (./.spycore/hooks.json). Each entry keys the workspace to the EXACT
   *  command string the user approved — any change to the string requires a
   *  fresh approval. Managed by the hook loader, not raw `config set` (kept
   *  out of KNOWN_KEYS). */
  approvedProjectHooks?: { workspace: string; command: string }[];
  /** PHASE-1 1.10: per-entry approvals for PROJECT-scoped command allow/deny
   *  rules (./.spycore/command-rules.json). Each approval keys the workspace
   *  to the rule kind AND the EXACT entry string — any change to the string
   *  requires a fresh approval. Managed by the command-rules loader, not raw
   *  `config set` (kept out of KNOWN_KEYS). */
  approvedProjectCommandRules?: { workspace: string; kind: 'allow' | 'deny'; entry: string }[];
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
  agentWebTools: true,
  agentObserveWorkspace: false,
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
  'agentWebTools',
  'agentObserveWorkspace',
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
 * plus the permanent .ca alias — and to loopback for dev / self-hosting. Any
 * other host resolved from `--api-url` / `SPYCORE_API_URL` (an attacker-supplied
 * or prompt-injected base URL) must NOT receive the token, or it is exfiltrated.
 * The transport layer (lib/api.ts, lib/sse.ts) gates the Authorization header on
 * this. KEEP-BOTH: api.spycore.ai is canonical, api.spycore.ca a permanent alias.
 *
 * ⭐⭐ THE SET IS SPLIT BY SCHEME POLICY, NOT BY TASTE. The predicate below used
 * to consult `hostname` ALONE, so the scheme was never part of the decision.
 * Measured against the real transport with a live sentinel token:
 *
 *     https://api.spycore.ai/api/user/me  ->  Bearer <token>   (intended)
 *     http://api.spycore.ai/api/user/me   ->  Bearer <token>   ⛔ CLEARTEXT
 *     https://evil.example.com/…          ->  no header        (control)
 *
 * A base URL is attacker- or prompt-reachable (`--api-url`, `SPYCORE_API_URL`),
 * and neither `resolveApiUrl` nor `normalizeApiBase` validates the scheme, so
 * `http://api.spycore.ai` put a SpyCore bearer token on the wire in the clear.
 * Non-http schemes (`ftp:`, `file:`, `ws:`, `gopher:`, …) were accepted too —
 * 27 of 48 probed scheme×host combinations attached the token to a non-https
 * URL. The gate is therefore scheme-AWARE from here on, and only ever narrows:
 * remote hosts require `https:`; loopback additionally allows `http:`, which is
 * what a local dev server actually serves.
 */
const TOKEN_HOST_ALLOWLIST_REMOTE = new Set([
  'api.spycore.ai',
  'api.spycore.ca',
]);

/**
 * Loopback hosts, where plain `http:` is the ordinary dev / self-hosting case
 * and the token never leaves the machine.
 *
 * ⭐⭐ `'::1'` WAS UNREACHABLE, AND THAT WAS A FUNCTIONAL DEFECT, NOT A
 * PROTECTION. `new URL('https://[::1]/x').hostname` returns `'[::1]'` — WITH
 * the brackets — so the entry never matched and a developer whose local server
 * listens on IPv6 loopback got no token at all. F-2c-26 measured that and
 * deliberately left it alone, because making it match WIDENS a credential
 * allowlist and that is a decision rather than a defect fix. The decision was
 * taken (F-2c-27): admit the loopback address and nothing else.
 *
 * ⭐ THE WIDENING IS BOUNDED BY MEASUREMENT, NOT BY INTENT. Bracket-stripping
 * is applied ONLY to the loopback lookup, so the only hostnames it can newly
 * admit are the ones already in this set — and `::1` is the only bracketable
 * member. Driven over a 240-cell scheme × host corpus (tests/api.test.ts):
 * 8 cells changed, all four spellings of ONE address (`[::1]`, `[::1]:8787`,
 * `[0:0:0:0:0:0:0:1]`, `[::0001]` — the URL parser normalises all four to the
 * hostname `[::1]`) × the two schemes loopback allows. Every other cell of the
 * 240 is byte-identical. Measured NOT admitted, and pinned as such:
 * `[::]` · `[::2]` · `[fe80::1]` · `[::ffff:127.0.0.1]` (which the parser
 * normalises to `[::ffff:7f00:1]`, a different literal) and the unbracketed
 * `::1`, which does not parse as a URL host at all.
 *
 * ⭐ THE STRIP FORM IS THE REPOSITORY'S OWN, COPIED VERBATIM from
 * `agent/mcp-config.ts:isLoopbackHost` rather than re-invented — F-2c-26 wrote
 * a fresh one (`/^[[]|[]]$/`) that can NEVER MATCH in JavaScript, because
 * `[]]` is an empty character class followed by a literal `]`. It is not
 * IMPORTED from there because `mcp-config.ts` imports this module at runtime,
 * so the dependency would be a cycle; instead the two predicates' agreement on
 * the loopback set is pinned directly (tests/api.test.ts), which is the
 * binding that stops two implementations of one property drifting apart.
 */
const TOKEN_HOST_ALLOWLIST_LOOPBACK = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
]);

/**
 * True when the resolved request URL may receive the bearer token: an allowed
 * host AND an allowed scheme for that host. Unparseable URLs fail closed.
 */
export function isTrustedTokenHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const scheme = parsed.protocol.toLowerCase();
  if (TOKEN_HOST_ALLOWLIST_REMOTE.has(host)) return scheme === 'https:';
  // Brackets are stripped for the LOOPBACK lookup only. A remote host is never
  // bracketed, so widening the strip to that lookup would be reach without
  // purpose — and the whole point of this change is that it admits one address.
  if (TOKEN_HOST_ALLOWLIST_LOOPBACK.has(host.replace(/^\[|\]$/g, ''))) {
    return scheme === 'https:' || scheme === 'http:';
  }
  return false;
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
 * PHASE-1 1.6: per-hook approval store for PROJECT-scoped lifecycle hooks.
 * A project hook is repo-supplied code execution, so beyond workspace trust
 * each hook needs a one-time approval keyed to the EXACT command string (and
 * the workspace). Editing the command in .spycore/hooks.json invalidates the
 * approval — the string no longer matches. Stored in the user's GLOBAL
 * config (never in the repo), mirroring trustedWorkspaces.
 */
export interface ApprovedProjectHook {
  workspace: string;
  command: string;
}

export function getApprovedProjectHooks(): ApprovedProjectHook[] {
  const raw = getConfigStore().get('approvedProjectHooks');
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is ApprovedProjectHook =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as ApprovedProjectHook).workspace === 'string' &&
      typeof (e as ApprovedProjectHook).command === 'string',
  );
}

export function isProjectHookApproved(cwd: string, command: string): boolean {
  const workspace = resolve(cwd);
  return getApprovedProjectHooks().some(
    (e) => e.workspace === workspace && e.command === command,
  );
}

export function approveProjectHook(cwd: string, command: string): void {
  const workspace = resolve(cwd);
  if (isProjectHookApproved(cwd, command)) return;
  const list = getApprovedProjectHooks();
  list.push({ workspace, command });
  getConfigStore().set('approvedProjectHooks', list);
  ensureConfigFileMode();
}

/**
 * PHASE-1 1.10: per-entry approval store for PROJECT-scoped command
 * allow/deny rules. A project rule changes how run_command approvals behave
 * for repo-supplied strings, so beyond workspace trust (CL1) each entry
 * needs a one-time approval keyed to the workspace, the rule KIND, and the
 * EXACT entry string. Editing the entry in .spycore/command-rules.json
 * invalidates the approval — the string no longer matches. Stored in the
 * user's GLOBAL config (never in the repo), mirroring approvedProjectHooks.
 */
export interface ApprovedProjectCommandRule {
  workspace: string;
  kind: 'allow' | 'deny';
  entry: string;
}

export function getApprovedProjectCommandRules(): ApprovedProjectCommandRule[] {
  const raw = getConfigStore().get('approvedProjectCommandRules');
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is ApprovedProjectCommandRule =>
      !!e &&
      typeof e === 'object' &&
      typeof (e as ApprovedProjectCommandRule).workspace === 'string' &&
      ((e as ApprovedProjectCommandRule).kind === 'allow' ||
        (e as ApprovedProjectCommandRule).kind === 'deny') &&
      typeof (e as ApprovedProjectCommandRule).entry === 'string',
  );
}

export function isProjectCommandRuleApproved(
  cwd: string,
  kind: 'allow' | 'deny',
  entry: string,
): boolean {
  const workspace = resolve(cwd);
  return getApprovedProjectCommandRules().some(
    (e) => e.workspace === workspace && e.kind === kind && e.entry === entry,
  );
}

export function approveProjectCommandRule(
  cwd: string,
  kind: 'allow' | 'deny',
  entry: string,
): void {
  const workspace = resolve(cwd);
  if (isProjectCommandRuleApproved(cwd, kind, entry)) return;
  const list = getApprovedProjectCommandRules();
  list.push({ workspace, kind, entry });
  getConfigStore().set('approvedProjectCommandRules', list);
  ensureConfigFileMode();
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
    case 'autoRefreshGuide':
    case 'agentWebTools':
    case 'agentObserveWorkspace': {
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
