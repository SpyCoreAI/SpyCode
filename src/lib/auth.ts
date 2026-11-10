import {
  clearStoredTokenInFile,
  getStoredTokenFromFile,
  setStoredTokenInFile,
} from './config.js';

/**
 * Token storage. We try the OS keychain first via keytar (an optional
 * dependency - keytar's native bindings can fail to install on stripped
 * Linux containers, so we never hard-require it). When keytar isn't
 * available we fall back to the conf-managed JSON file. The file lives at
 * 0600 perms via the OS default for the user-config dir; not as good as
 * the keychain, but it keeps the CLI usable in CI / containers.
 *
 * Stored under service "@spycore/cli" + account "default" so existing
 * users can have multiple identities later via `spycore login --profile`.
 */
const SERVICE = '@spycore/cli';
const ACCOUNT = 'default';

type Keytar = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

let keytarCache: Keytar | null | undefined; // undefined = not yet attempted

async function loadKeytar(): Promise<Keytar | null> {
  if (keytarCache !== undefined) return keytarCache;
  try {
    const mod = (await import('keytar')) as { default?: Keytar } & Keytar;
    keytarCache = (mod.default ?? mod) as Keytar;
    // Touch one method to make sure native bindings actually loaded.
    if (typeof keytarCache.getPassword !== 'function') keytarCache = null;
  } catch {
    keytarCache = null;
  }
  return keytarCache;
}

export async function getToken(): Promise<string | null> {
  // SPYCORE_TOKEN takes precedence - primary path for CI / agent invocation
  // where the keychain is unavailable and putting credentials on disk is
  // undesirable. Empty string is treated as unset so `SPYCORE_TOKEN= cmd`
  // doesn't accidentally authenticate. The value is trimmed (R2-14): a
  // trailing newline/space from copy-paste or an env file is otherwise sent
  // verbatim and undici rejects the Authorization header outright
  // (`InvalidArgumentError: invalid authorization header`) on every call -
  // the same class the BYOK side already trims keys for. A whitespace-only
  // value counts as unset, like the empty-string case.
  const envToken = process.env.SPYCORE_TOKEN?.trim();
  if (envToken && envToken.length > 0) return envToken;

  const keytar = await loadKeytar();
  if (keytar) {
    try {
      const v = await keytar.getPassword(SERVICE, ACCOUNT);
      const trimmed = v?.trim();
      if (trimmed) return trimmed;
    } catch {
      // keychain read can fail on Linux when DBus / libsecret isn't running.
      // Fall through to the file backend.
    }
  }
  const stored = getStoredTokenFromFile();
  const trimmedStored = stored?.trim();
  return trimmedStored && trimmedStored.length > 0 ? trimmedStored : null;
}

export async function setToken(token: string): Promise<void> {
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.setPassword(SERVICE, ACCOUNT, token);
      // Best effort: clear any leftover file copy from a previous fallback.
      clearStoredTokenInFile();
      return;
    } catch {
      // fall through
    }
  }
  setStoredTokenInFile(token);
}

export async function clearToken(): Promise<void> {
  const keytar = await loadKeytar();
  if (keytar) {
    try {
      await keytar.deletePassword(SERVICE, ACCOUNT);
    } catch {
      // ignore
    }
  }
  clearStoredTokenInFile();
}

export async function isAuthenticated(): Promise<boolean> {
  // Any non-empty token authenticates requests - getToken() returns a
  // SPYCORE_TOKEN trimmed, with no prefix requirement. The old
  // `spycli_` prefix check disagreed with that: a token without the
  // prefix authenticated every request while whoami/ping reported
  // "Not logged in". A stored token from another tool is still the
  // user's own credential surface, not a foreign one - the prefix was
  // never an authentication boundary, only a display convention.
  const t = await getToken();
  return Boolean(t);
}
