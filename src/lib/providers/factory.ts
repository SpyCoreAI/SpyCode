/**
 * BYOK provider factory: turn a resolved `ByokConfig` into the adapter that
 * speaks its wire. Every adapter is loaded via dynamic import() so none of
 * them (or undici's streaming paths) ever lands on the CLI hot path - this
 * module itself is tiny and safe to import statically.
 */
import { EXIT_USER_ERROR, SpycoreCliError } from '../errors.js';
import type { ByokConfig } from './byok-config.js';
import type { Provider } from './types.js';

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
      if (config.oauthRefreshToken && config.oauthClientId) {
        const { refreshAccessToken, googleOAuthConfig } = await import('../oauth.js');
        // Use a dummy port - we only need the token URL and client ID for refresh.
        const oauthConfig = googleOAuthConfig(0);
        oauthConfig.clientId = config.oauthClientId;
        try {
          const tokens = await refreshAccessToken(oauthConfig, config.oauthRefreshToken);
          return new GoogleProvider({
            baseURL: config.baseURL,
            oauthAccessToken: tokens.accessToken,
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
