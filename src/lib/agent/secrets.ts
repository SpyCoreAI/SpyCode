/**
 * Secret protection for the agent's filesystem tools.
 *
 * Applies to BOTH reads and writes: denied paths never have their contents
 * surfaced to the model, and mutating tools refuse to touch them. There are
 * two layers:
 *   1. A built-in denylist that is ALWAYS on (keys, credentials, .git, .ssh …).
 *   2. An optional `.spycoreignore` at the cwd root (gitignore syntax) for
 *      project-specific additions.
 *
 * The `.spycoreignore` predicate is loaded once (globby, imported lazily) and
 * the returned guard is synchronous so callers can filter large file lists
 * without awaiting per entry.
 */
import { existsSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';

/** Private-key / credential file extensions — always blocked. */
const SECRET_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.pkcs12', '.keystore', '.jks', '.asc', '.gpg',
]);

/** Exact credential / secret basenames — always blocked. */
const SECRET_BASENAMES = new Set([
  '.env', '.npmrc', '.netrc', '.dockercfg', '.pgpass', '.htpasswd',
  'credentials', 'credentials.json', 'secrets.json',
]);

/** Path segments whose entire subtree is always blocked. */
const SECRET_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gnupg']);

/** SSH/key filename prefixes (matches `id_rsa*`, `id_ed25519*`, …). */
const KEYFILE_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

/**
 * Built-in, always-on denylist match for a cwd-relative path. Pure + sync so
 * it is cheap to call per file.
 */
export function matchesBuiltinDenylist(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  if (segments.some((s) => SECRET_SEGMENTS.has(s))) return true;
  const base = basename(relPath);
  if (SECRET_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true; // .env.local, .env.production, …
  if (KEYFILE_PREFIXES.some((p) => base.startsWith(p))) return true;
  if (SECRET_EXTENSIONS.has(extname(base).toLowerCase())) return true;
  return false;
}

/** Synchronous predicate: true ⇒ the absolute path must not be read or written. */
export type SecretGuard = (absPath: string) => boolean;

/**
 * Build the secret guard for a working directory: the built-in denylist plus
 * any `.spycoreignore` patterns. Async only to load the optional ignore file;
 * the returned predicate is synchronous.
 */
export async function loadSecretGuard(cwd: string): Promise<SecretGuard> {
  let ignorePred: SecretGuard = () => false;
  if (existsSync(join(cwd, '.spycoreignore'))) {
    try {
      const { isIgnoredByIgnoreFilesSync } = await import('globby');
      const pred = isIgnoredByIgnoreFilesSync('.spycoreignore', { cwd });
      ignorePred = (abs) => {
        try {
          return pred(abs);
        } catch {
          return false;
        }
      };
    } catch {
      ignorePred = () => false;
    }
  }
  return (abs: string): boolean => {
    const rel = relative(cwd, abs);
    if (matchesBuiltinDenylist(rel)) return true;
    return ignorePred(abs);
  };
}
