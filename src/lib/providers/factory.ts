/**
 * BYOK provider factory: turn a resolved `ByokConfig` into the adapter that
 * speaks its wire. Every adapter is loaded via dynamic import() so none of
 * them (or undici's streaming paths) ever lands on the CLI hot path - this
 * module itself is tiny and safe to import statically.
 */
import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';
import { getStoredProviders, setStoredProviders } from '../config.js';
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
        const oauthConfig = googleOAuthConfig(0, config.oauthClientId);
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
          const tokens = await refreshAccessToken(oauthConfig, currentRefreshToken);
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
      const apiKey = requireKey(config);
      return new GoogleProvider({ baseURL: config.baseURL, apiKey });
    }
  }
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
