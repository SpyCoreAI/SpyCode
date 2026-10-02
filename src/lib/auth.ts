import {
  clearStoredTokenInFile,
  getStoredTokenFromFile,
  setStoredTokenInFile,
} from './config.js';

/**
 * Token storage. We try the OS keychain first via keytar (an optional
 * dependency — keytar's native bindings can fail to install on stripped
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
  // SPYCORE_TOKEN takes precedence — primary path for CI / agent invocation
  // where the keychain is unavailable and putting credentials on disk is
  // undesirable. Empty string is treated as unset so `SPYCORE_TOKEN= cmd`
  // doesn't accidentally authenticate.
  const envToken = process.env.SPYCORE_TOKEN;
  if (envToken && envToken.length > 0) return envToken;

  const keytar = await loadKeytar();
  if (keytar) {
    try {
      const v = await keytar.getPassword(SERVICE, ACCOUNT);
      if (v) return v;
    } catch {
      // keychain read can fail on Linux when DBus / libsecret isn't running.
      // Fall through to the file backend.
    }
  }
  return getStoredTokenFromFile();
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
  const t = await getToken();
  return Boolean(t && t.startsWith('spycli_'));
}
