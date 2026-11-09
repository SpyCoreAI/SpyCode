/**
 * BYOK provider factory: turn a resolved `ByokConfig` into the adapter that
 * speaks its wire. Every adapter is loaded via dynamic import() so none of
 * them (or undici's streaming paths) ever lands on the CLI hot path - this
 * module itself is tiny and safe to import statically.
 */
import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';
import { getStoredProviders, setStoredProviders } from '../config.js';
import type { OAuthConfig } from '../oauth.js';
import type { ByokConfig } from './byok-config.js';
import type { Provider } from './types.js';

/**
 * Write a rotated refresh token back to its stored provider entry, so the
 * next process does not retry with the revoked token. Best-effort: the
 * in-process token is already updated, and a store write must not fail a
 * run that already holds a fresh access token.
 */
function persistRotatedRefreshToken(sourceName: string, refreshToken: string): void {
  try {
    const stored = getStoredProviders();
    const entry = stored.find((p) => p.name === sourceName);
    if (!entry || entry.oauthRefreshToken === refreshToken) return;
    setStoredProviders(
      stored.map((p) => (p.name === sourceName ? { ...p, oauthRefreshToken: refreshToken } : p)),
    );
  } catch {
    /* best-effort - see above */
  }
}

export async function createByokProvider(config: ByokConfig): Promise<Provider> {
  switch (config.type) {
    case 'openai': {
      const { OpenAICompatibleProvider } = await import('./openai-compatible.js');
      return new OpenAICompatibleProvider({ baseURL: config.baseURL, apiKey: config.apiKey });
    }
    case 'anthropic': {
      const apiKey = requireKey(config);
      const { AnthropicProvider } = await import('./anthropic.js');
      return new AnthropicProvider({ baseURL: config.baseURL, apiKey });
    }
    case 'google': {
      const { GoogleProvider } = await import('./google.js');
      // If OAuth refresh token is present, get a fresh access token.
      // Otherwise use the API key.
      if (config.oauthRefreshToken) {
        const { refreshAccessToken, googleOAuthConfig } = await import('../oauth.js');
        // The STORED client id first - it is the id the refresh token was
        // issued against, and a stored provider must work without
        // SPYCORE_GOOGLE_CLIENT_ID on later runs. The env var is the
        // fallback for providers stored before the id was kept; with
        // neither, googleOAuthConfig throws the setup hint. Use a dummy
        // port - we only need the token URL and client ID for refresh.
        // googleOAuthConfig throws a plain Error - wrap it so the CLI
        // renders the code + hint instead of a raw stack.
        let oauthConfig: OAuthConfig;
        try {
          oauthConfig = googleOAuthConfig(0, config.oauthClientId);
        } catch (err) {
          throw new SpycoreCliError(
            err instanceof Error ? err.message : String(err),
            EXIT_USER_ERROR,
            'Re-authenticate with `spycore provider add --type google --oauth`.',
          );
        }
        // Refresh on demand, not just once at construction: access tokens
        // expire after ~1h, so a provider built here used to die mid-run
        // with 401. The initial refresh still runs now (a bad refresh
        // token fails fast, as before); the provider replays it on 401.
        // The CURRENT refresh token, not the one construction started with:
        // a provider that rotates it revokes the old one, so every refresh
        // must send the newest token or the next refresh fails. A rotation
        // is also persisted to the stored entry (when this provider came
        // from one) so the next process does not retry with a revoked token.
        let currentRefreshToken = config.oauthRefreshToken;
        const refresh = async (): Promise<string> => {
          // refreshAccessToken has no timeout of its own (its fetch takes
          // no signal - see the lib batch's oauth.ts follow-up), so bound
          // it here: a hung token endpoint must fail the refresh after
          // 30s instead of hanging provider construction - or a mid-run
          // 401 retry - forever. The race only unblocks the caller; the
          // underlying fetch still settles on its own.
          const tokens = await withTimeout(
            refreshAccessToken(oauthConfig, currentRefreshToken),
            OAUTH_REFRESH_TIMEOUT_MS,
            'Google OAuth token refresh timed out after 30s',
          );
          if (tokens.refreshToken !== currentRefreshToken) {
            currentRefreshToken = tokens.refreshToken;
            if (config.sourceName) persistRotatedRefreshToken(config.sourceName, tokens.refreshToken);
          }
          return tokens.accessToken;
        };
        try {
          const accessToken = await refresh();
          return new GoogleProvider({
            baseURL: config.baseURL,
            oauthAccessToken: accessToken,
            refreshOAuthToken: refresh,
          });
        } catch (err) {
          throw new SpycoreCliError(
            `Google OAuth token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
            EXIT_USER_ERROR,
            'Re-authenticate with `spycore provider add --type google --oauth`.',
          );
        }
      }
      // An OAuth client id with no refresh token and no key is an
      // incomplete OAuth config, not a missing-key config - say so.
      if (config.oauthClientId && !config.oauthRefreshToken && !config.apiKey) {
        throw new SpycoreCliError(
          'Provider uses Google OAuth but has no refresh token stored.',
          EXIT_USER_ERROR,
          'Re-authenticate with `spycore provider add --type google --oauth`.',
        );
      }
      const apiKey = requireKey(config);
      return new GoogleProvider({ baseURL: config.baseURL, apiKey });
    }
  }
  // No default case on purpose: a runtime (tampered) config with an
  // unknown type must fail loudly here instead of resolving to undefined
  // and crashing later at the first method call.
  throw new SpycoreCliError(
    `Unknown BYOK provider type: ${String((config as { type?: unknown }).type ?? '')}.`,
    EXIT_USER_ERROR,
    'A stored provider config lists one of: openai, anthropic, google. Re-save it with `spycore provider add`.',
  );
}

/** Bound on a Google OAuth refresh (call-site only - see the refresh closure). */
const OAUTH_REFRESH_TIMEOUT_MS = 30_000;

/** Race a promise against a timeout; the timeout error names the operation. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Defensive re-check: resolution already errors on a missing key for the
 * native cloud types, so reaching this with no key means a programming error
 * upstream - fail closed with the same user-facing wording rather than send
 * an unauthenticated request.
 */
function requireKey(config: ByokConfig): string {
  if (config.apiKey && config.apiKey.length > 0) return config.apiKey;
  throw new SpycoreCliError(
    `An API key is required for the ${config.type} provider.`,
    EXIT_USER_ERROR,
    'Set the provider\'s API-key env var or pass --api-key-env <VAR>.',
  );
}
