/**
 * Pure BYOK (bring-your-own-key) configuration helpers — provider-kind parsing,
 * base-URL defaults, local-endpoint detection, env-var key lookup, and the
 * identity-safe routing line. Kept free of any HTTP client so it stays tiny and
 * trivially unit-testable; the actual OpenAI-compatible Provider (which pulls in
 * undici) is a separate module that's lazy-loaded only when a BYOK run starts.
 */
import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';

/** Built-in provider kinds the `--provider` flag accepts (besides saved names). */
export const PROVIDER_KINDS = ['spycore', 'openai', 'anthropic', 'google'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** The BYOK adapter types (every built-in kind except the SpyCore backend). */
export const BYOK_TYPES = ['openai', 'anthropic', 'google'] as const;
export type ByokProviderType = (typeof BYOK_TYPES)[number];

export function isByokType(value: string): value is ByokProviderType {
  return (BYOK_TYPES as readonly string[]).includes(value);
}

interface ByokTypeDefaults {
  /** The vendor's public API root; `--base-url` repoints it. */
  baseURL: string;
  /** Default env var holding the key when none is named. */
  apiKeyEnv: string;
  /**
   * Whether the type works with NO key at all. Only the OpenAI-compatible
   * type does (local servers); the native cloud APIs always require one.
   */
  keyOptional: boolean;
}

/** Per-type defaults — base URL, key env var, and whether keyless is valid. */
export const BYOK_TYPE_DEFAULTS: Record<ByokProviderType, ByokTypeDefaults> = {
  openai: { baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', keyOptional: true },
  anthropic: { baseURL: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', keyOptional: false },
  google: { baseURL: 'https://generativelanguage.googleapis.com', apiKeyEnv: 'GEMINI_API_KEY', keyOptional: false },
};

/** OpenAI's public API base. Repoint with `--base-url` for any other endpoint. */
export const OPENAI_DEFAULT_BASE_URL = BYOK_TYPE_DEFAULTS.openai.baseURL;

/** Default env var holding the key for the OpenAI-compatible type. */
export const DEFAULT_API_KEY_ENV = BYOK_TYPE_DEFAULTS.openai.apiKeyEnv;

/** Parse + validate the `--provider` value (default `spycore`). */
export function parseProviderKind(raw: string | undefined): ProviderKind {
  const v = (raw ?? '').trim().toLowerCase();
  if (v.length === 0) return 'spycore';
  if ((PROVIDER_KINDS as readonly string[]).includes(v)) return v as ProviderKind;
  throw new SpycoreCliError(
    `Unknown provider: ${raw}`,
    EXIT_USER_ERROR,
    `Allowed: ${PROVIDER_KINDS.join(', ')}`,
  );
}

/** True when the base URL points at a local server (drives the "· local" label). */
export function isLocalBaseURL(baseURL: string): boolean {
  let host: string;
  try {
    host = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  // URL strips the brackets from an IPv6 literal, so `[::1]` → `::1`.
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host.endsWith('.local')
  );
}

/** The identity-safe routing line for a BYOK run — the user's OWN model + endpoint. */
export function byokRoutingLine(type: ByokProviderType, model: string, baseURL: string): string {
  return `Model: ${model} (${type}${isLocalBaseURL(baseURL) ? ' · local' : ''})`;
}

export interface ByokConfig {
  /** Which adapter speaks this endpoint's wire. */
  type: ByokProviderType;
  /** The wire model id, sent verbatim (no SpyCore slug validation, no triage). */
  model: string;
  /** Normalised base URL (no trailing slash). */
  baseURL: string;
  /**
   * API key. Undefined is only valid for the OpenAI-compatible type (local
   * servers → no auth header); the native cloud types error before this point.
   */
  apiKey: string | undefined;
  /** Identity-safe status line, e.g. `Model: gpt-4o (openai)`. */
  routingLine: string;
}

/** Throw the clear missing-key error for types that cannot run keyless. */
function requireKey(
  type: ByokProviderType,
  apiKey: string | undefined,
  consultedVar: string,
): void {
  if (apiKey !== undefined || BYOK_TYPE_DEFAULTS[type].keyOptional) return;
  throw new SpycoreCliError(
    `An API key is required for the ${type} provider.`,
    EXIT_USER_ERROR,
    `Set ${consultedVar}, point --api-key-env at another env var, or save a key with \`spycore provider add\`.`,
  );
}

/**
 * Resolve an ad-hoc BYOK run's configuration from the raw CLI flags + the
 * environment. `--model` is REQUIRED for a non-spycore provider (there is no
 * SpyCore default model or auto-routing); throws a clear error when it is
 * missing. The key is read ONLY from the named env var (default per type) and
 * never persisted. An unset/empty var yields `undefined` for the
 * OpenAI-compatible type (no auth header — local servers); the native cloud
 * types have no keyless mode, so a missing key errors BEFORE any request.
 */
export function resolveByokConfig(opts: {
  /** Adapter type; defaults to the OpenAI-compatible one. */
  type?: ByokProviderType | undefined;
  model: string | undefined;
  baseUrl: string | undefined;
  apiKeyEnv: string | undefined;
  env: NodeJS.ProcessEnv;
}): ByokConfig {
  const type = opts.type ?? 'openai';
  const defaults = BYOK_TYPE_DEFAULTS[type];
  const model = (opts.model ?? '').trim();
  if (model.length === 0) {
    throw new SpycoreCliError(
      '`--model <id>` is required when --provider is not spycore.',
      EXIT_USER_ERROR,
      'BYOK runs your own model directly — there is no SpyCore default or auto-routing. Example: --model gpt-4o',
    );
  }
  const baseURL = ((opts.baseUrl ?? '').trim() || defaults.baseURL).replace(/\/+$/, '');
  const apiKeyEnv = (opts.apiKeyEnv ?? '').trim() || defaults.apiKeyEnv;
  const raw = opts.env[apiKeyEnv];
  const apiKey = raw && raw.trim().length > 0 ? raw : undefined;
  requireKey(type, apiKey, apiKeyEnv);
  return { type, model, baseURL, apiKey, routingLine: byokRoutingLine(type, model, baseURL) };
}

/** A persisted named provider config (`spycore provider add`). */
export interface StoredProviderConfig {
  name: string;
  /** Adapter type: 'openai' (OpenAI-compatible), 'anthropic', or 'google'. */
  type: ByokProviderType;
  baseURL: string;
  model?: string | undefined;
  /** Env var holding the key (preferred). */
  apiKeyEnv?: string | undefined;
  /** Inline key (discouraged — written to disk). */
  apiKey?: string | undefined;
}

/** The outcome of resolving which provider an agent run should use. */
export type ProviderSelection =
  | { kind: 'spycore' }
  | { kind: 'byok'; config: ByokConfig; sourceName: string | null };

/**
 * Key precedence for a SAVED provider: an explicit `--api-key-env` flag wins,
 * else the saved env-var name, else the saved inline key. With none of those,
 * a key-REQUIRED type (anthropic/google) falls back to its default env var —
 * the OpenAI-compatible type deliberately does NOT (a stored keyless config is
 * the local-server use case, and silently picking up OPENAI_API_KEY would
 * change what gets sent). Returns the key plus the env var that was consulted
 * (for the missing-key error message).
 */
function resolveStoredKey(
  apiKeyEnvFlag: string | undefined,
  stored: StoredProviderConfig,
  env: NodeJS.ProcessEnv,
): { apiKey: string | undefined; consultedVar: string } {
  const defaults = BYOK_TYPE_DEFAULTS[stored.type];
  const fromVar = (name: string): string | undefined => {
    const v = env[name];
    return v && v.trim().length > 0 ? v : undefined;
  };
  const flagEnv = (apiKeyEnvFlag ?? '').trim();
  if (flagEnv.length > 0) return { apiKey: fromVar(flagEnv), consultedVar: flagEnv };
  const storedEnv = (stored.apiKeyEnv ?? '').trim();
  if (storedEnv.length > 0) return { apiKey: fromVar(storedEnv), consultedVar: storedEnv };
  if (stored.apiKey && stored.apiKey.length > 0) {
    return { apiKey: stored.apiKey, consultedVar: defaults.apiKeyEnv };
  }
  if (!defaults.keyOptional) {
    return { apiKey: fromVar(defaults.apiKeyEnv), consultedVar: defaults.apiKeyEnv };
  }
  return { apiKey: undefined, consultedVar: defaults.apiKeyEnv };
}

/**
 * Resolve which provider an `agent` run uses, with this precedence:
 *   1. `--provider <value>`: a saved config NAME, else a built-in type
 *      (`spycore` / `openai`), else a clear error.
 *   2. No flag: the saved `defaultProvider`, else `spycore`.
 * Explicit `--base-url` / `--model` / `--api-key-env` OVERRIDE a saved config's
 * fields. BYOK still requires a model (from the config or the flag). Pure — the
 * caller supplies the stored configs + env so it stays trivially testable.
 */
export function resolveProviderSelection(opts: {
  providerFlag: string | undefined;
  baseUrl: string | undefined;
  model: string | undefined;
  apiKeyEnv: string | undefined;
  env: NodeJS.ProcessEnv;
  stored: StoredProviderConfig[];
  defaultProvider: string | undefined;
}): ProviderSelection {
  const flag = (opts.providerFlag ?? '').trim();
  const target = flag.length > 0 ? flag : (opts.defaultProvider ?? '').trim() || 'spycore';

  // Built-in SpyCore default.
  if (target.toLowerCase() === 'spycore') return { kind: 'spycore' };

  // A saved provider config, matched by name.
  const stored = opts.stored.find((p) => p.name === target);
  if (stored) {
    const model = (opts.model ?? stored.model ?? '').trim();
    if (model.length === 0) {
      throw new SpycoreCliError(
        `Provider "${stored.name}" has no model — pass --model <id>.`,
        EXIT_USER_ERROR,
        `Save one with \`spycore provider add ${stored.name} ... --model <id>\`, or pass --model for this run.`,
      );
    }
    const type = stored.type;
    const baseURL = ((opts.baseUrl ?? '').trim() || stored.baseURL || BYOK_TYPE_DEFAULTS[type].baseURL)
      .replace(/\/+$/, '');
    const { apiKey, consultedVar } = resolveStoredKey(opts.apiKeyEnv, stored, opts.env);
    requireKey(type, apiKey, consultedVar);
    return {
      kind: 'byok',
      config: { type, model, baseURL, apiKey, routingLine: byokRoutingLine(type, model, baseURL) },
      sourceName: stored.name,
    };
  }

  // A built-in ad-hoc BYOK type (openai / anthropic / google).
  const builtIn = target.toLowerCase();
  if (isByokType(builtIn)) {
    return {
      kind: 'byok',
      config: resolveByokConfig({
        type: builtIn,
        model: opts.model,
        baseUrl: opts.baseUrl,
        apiKeyEnv: opts.apiKeyEnv,
        env: opts.env,
      }),
      sourceName: null,
    };
  }

  throw new SpycoreCliError(
    `Unknown provider: ${target}`,
    EXIT_USER_ERROR,
    'Use a saved provider (see `spycore provider list`) or a built-in type: spycore, openai, anthropic, google.',
  );
}
