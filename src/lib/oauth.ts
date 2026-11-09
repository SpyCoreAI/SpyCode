/**
 * OAuth 2.0 with PKCE for BYOK providers (Google AI).
 *
 * Implements the authorization code flow:
 * 1. Generate PKCE verifier/challenge
 * 2. Open browser to provider's auth URL
 * 3. Local HTTP server receives the callback with auth code
 * 4. Exchange code for access + refresh tokens
 * 5. Store refresh token securely (config file, 0600)
 * 6. Refresh access token as needed
 *
 * Currently supports Google. Extensible to other OAuth providers.
 */

import { createServer, type Server } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { openInBrowser } from './browser.js';

// Google OAuth endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Scopes for Google AI (Generative Language API)
const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/generative-language'];

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  tokenType: string;
}

export interface OAuthConfig {
  clientId: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  redirectPort: number;
}

/**
 * Google OAuth config. Client ID comes from `SPYCORE_GOOGLE_CLIENT_ID` env
 * var, or from an explicitly passed `clientId` - a stored provider's
 * `oauthClientId`, which exists precisely so the provider works without the
 * env var on later runs. An explicit id wins over the env var; with neither,
 * this throws the setup hint.
 */
export function googleOAuthConfig(port: number, clientId?: string): OAuthConfig {
  const id = clientId?.trim() || process.env.SPYCORE_GOOGLE_CLIENT_ID?.trim();
  if (!id) {
    throw new Error(
      'Google OAuth client ID not configured.\n' +
        'Register an OAuth client in Google Cloud Console (Desktop app type),\n' +
        'then set SPYCORE_GOOGLE_CLIENT_ID env var and try again.\n' +
        'Alternatively, use --api-key with a Google AI Studio key.',
    );
  }
  return {
    clientId: id,
    authUrl: GOOGLE_AUTH_URL,
    tokenUrl: GOOGLE_TOKEN_URL,
    scopes: GOOGLE_SCOPES,
    redirectPort: port,
  };
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** Generate PKCE verifier and challenge. */
function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Open URL in default browser (cross-platform). Reuses openInBrowser's
 * argv-based opener (no shell, no string interpolation): the previous
 * exec-string form mangled the percent-encoded OAuth URL on Windows
 * (cmd.exe expands %XX before any other parsing) and duplicated the
 * browser opener instead of reusing it.
 */
function openBrowser(url: string): void {
  if (!openInBrowser(url)) {
    console.log(`\nPlease open this URL in your browser:\n${url}\n`);
  }
}

/**
 * Run the OAuth authorization code flow with PKCE.
 * Opens the browser, waits for the callback, exchanges the code for tokens.
 */
export async function runOAuthFlow(config: OAuthConfig): Promise<OAuthTokens> {
  const { verifier, challenge } = generatePkce();
  const state = base64UrlEncode(randomBytes(16));
  const redirectUri = `http://127.0.0.1:${config.redirectPort}/callback`;

  const authUrl =
    `${config.authUrl}?` +
    new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: config.scopes.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline', // get refresh token
      prompt: 'consent',
    }).toString();

  return new Promise((resolve, reject) => {
    let server: Server | null = null;
    // server.close() only stops accepting NEW connections: a browser
    // keep-alive connection would hold the CLI process after it. Drain
    // every close site through here so closeAllConnections() always runs
    // first and no path can leave a live socket behind.
    const closeServer = (): void => {
      try {
        server?.closeAllConnections();
      } catch {
        /* already closing - close() below still runs */
      }
      try {
        server?.close();
      } catch {
        /* already closing */
      }
    };
    const timeout = setTimeout(() => {
      closeServer();
      reject(new Error('OAuth flow timed out after 5 minutes.'));
    }, 5 * 60 * 1000);

    server = createServer(async (req, res) => {
      if (!req.url?.startsWith('/callback')) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const url = new URL(req.url, `http://127.0.0.1:${config.redirectPort}`);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Authorization failed</h1><p>You can close this window.</p>');
        closeServer();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (returnedState !== state) {
        clearTimeout(timeout);
        res.writeHead(400);
        res.end('Invalid state');
        closeServer();
        reject(new Error('OAuth state mismatch - possible CSRF attack.'));
        return;
      }

      if (!code) {
        res.writeHead(400);
        res.end('Missing code');
        return;
      }

      try {
        const tokens = await exchangeCodeForTokens(config, code, verifier, redirectUri);
        clearTimeout(timeout);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>Success!</h1><p>You can close this window and return to the terminal.</p>');
        closeServer();
        resolve(tokens);
      } catch (err) {
        clearTimeout(timeout);
        res.writeHead(500);
        res.end('Token exchange failed');
        closeServer();
        reject(err);
      }
    });

    server.listen(config.redirectPort, '127.0.0.1', () => {
      console.log('\nOpening browser for Google authorization...');
      console.log('If the browser does not open, visit:\n');
      console.log(authUrl);
      console.log('');
      openBrowser(authUrl);
    });

    server.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });
  });
}

async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const resp = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }).toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    token_type: string;
  };

  if (!data.refresh_token) {
    throw new Error('No refresh token received. Try revoking access and trying again.');
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + data.expires_in * 1000,
    tokenType: data.token_type,
  };
}

/** Refresh an access token using the refresh token. */
export const OAUTH_FETCH_TIMEOUT_MS = 30_000;

export async function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
  opts: { timeoutMs?: number } = {},
): Promise<OAuthTokens> {
  const timeoutMs = opts.timeoutMs ?? OAUTH_FETCH_TIMEOUT_MS;
  let resp: Response;
  try {
    // A hung token endpoint used to hang provider construction forever -
    // the fetch had no timeout at all.
    resp = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `Token refresh timed out after ${timeoutMs / 1000}s.`,
      );
    }
    throw err;
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    /** Present when the provider rotates the refresh token: keep it, or the next refresh fails. */
    refresh_token?: string;
    expires_in: number;
    token_type: string;
  };

  return {
    accessToken: data.access_token,
    // A rotated refresh token replaces the old one (Google revokes the old
    // token on rotation); without a new one the old token is still valid.
    refreshToken: data.refresh_token ?? refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
    tokenType: data.token_type,
  };
}
