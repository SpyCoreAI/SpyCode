/**
 * THE path guard: the one canonical module that decides whether a filesystem
 * path may be read or written. Secret REDACTION of text lives in
 * `lib/redact.ts`; display SANITIZATION (ANSI/control sequences) lives in
 * `lib/sanitize-display.ts`. The three overlap in theme but never in duty:
 * this file judges paths, the others scrub text.
 *
 * Secret protection for the agent's filesystem tools.
 *
 * Applies to BOTH reads and writes: denied paths never have their contents
 * surfaced to the model, and mutating tools refuse to touch them. There are
 * two layers:
 * 1. A built-in denylist that is ALWAYS on (keys, credentials, .git, .ssh …).
 * 2. An optional `.spycoreignore` at the cwd root (gitignore syntax) for
 * project-specific additions.
 *
 * The `.spycoreignore` predicate is loaded once (globby, imported lazily) and
 * the returned guard is synchronous so callers can filter large file lists
 * without awaiting per entry.
 */
import { existsSync, realpathSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { canonicalize } from '../path-containment.js';
import { osFold } from '../os-fold.js';

/** Private-key / credential file extensions - always blocked. */
const SECRET_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.pkcs12', '.keystore', '.jks', '.asc', '.gpg',
]);

/** Exact credential / secret basenames - always blocked. */
const SECRET_BASENAMES = new Set([
  '.env', '.npmrc', '.netrc', '.dockercfg', '.pgpass', '.htpasswd',
  'credentials', 'credentials.json', 'secrets.json',
]);

/** Path segments whose entire subtree is always blocked. */
const SECRET_SEGMENTS = new Set(['.git', '.ssh', '.aws', '.gnupg']);

/** SSH/key filename prefixes (matches `id_rsa*`, `id_ed25519*`, …). */
const KEYFILE_PREFIXES = ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'];

/**
 * One denylist pass over a cwd-relative path. Comparisons are CASE-FOLDED:
 * this CLI's two most common desktop platforms resolve filenames case-blind
 * (macOS APFS, Windows NTFS), so comparing case-sensitively judges a name the
 * OS will never open - `.ENV` was allowed while the OS served the real `.env`.
 *
 * F-22 - `toLowerCase()` IS NOT SUFFICIENT, AND THE CLAIM THAT IT
 * WAS IS CORRECTED HERE RATHER THAN LEFT TO DECAY. It reproduces the 26 ASCII
 * cases and U+212A, but the filesystem folds TEN further scalars that it does
 * not: `ß`→ss, `ſ`→s, `ẞ`→ss and the six ligatures `ﬀ ﬁ ﬂ ﬃ ﬄ ﬅ ﬆ`. Measured
 * against the OS itself, six of seven denylisted names were served in full under
 * a long-s spelling. The earlier note was right that the Turkish dotted capital I
 * and fullwidth Latin do NOT resolve - those were measured and remain excluded -
 * but it generalised from "the forms I tested do not resolve" to "a plain
 * `toLowerCase()` is sufficient", and that step was never measured.
 *
 * This was a GAP shared with the published 0.6.0, not a regression: 0.6.0 did
 * no case folding here at all. See `lib/os-fold.ts` for the fold's derivation.
 */
function matchesDenylistPass(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  // Both readings are offered, never substituted: `osFold` can only ever map a
  // name ONTO a denylist entry, so this can add blocks and never remove one.
  if (segments.some((s) => SECRET_SEGMENTS.has(s.toLowerCase()) || SECRET_SEGMENTS.has(osFold(s)))) {
    return true;
  }
  for (const base of [basename(relPath).toLowerCase(), osFold(basename(relPath))]) {
    if (SECRET_BASENAMES.has(base)) return true;
    if (base.startsWith('.env.')) return true; // .env.local, .env.production, …
    if (KEYFILE_PREFIXES.some((p) => base.startsWith(p))) return true;
    if (SECRET_EXTENSIONS.has(extname(base))) return true;
  }
  return false;
}

/**
 * Rewrite a path into the form the OS would actually open, for the name shapes
 * that only exist on Windows: trailing dots and spaces are stripped by Win32
 * path resolution (`.env ` opens `.env`), and an NTFS alternate-data-stream
 * suffix selects a stream of the file named before the colon (`.env::$DATA`
 * opens `.env`). Applied per segment.
 *
 * Never used ALONE - see `matchesBuiltinDenylist`. Normalisation SHORTENS a
 * name, which could turn a match into a non-match, so it is only ever unioned
 * with the un-normalised pass and can therefore only add blocks.
 */
function normalizeForFilesystem(relPath: string): string {
  return relPath
    .split(/[\\/]/)
    .map((seg) => {
      const ads = seg.indexOf(':');
      const head = ads === -1 ? seg : seg.slice(0, ads);
      return head.replace(/[. ]+$/, '');
    })
    .join('/');
}

/**
 * Built-in, always-on denylist match for a cwd-relative path. Pure + sync so
 * it is cheap to call per file.
 *
 * The UNION of the path as given and the path as a filesystem would resolve
 * it. Union, not replacement: each pass can only add blocks, so no name that
 * is refused today can become allowed.
 */
export function matchesBuiltinDenylist(relPath: string): boolean {
  if (matchesDenylistPass(relPath)) return true;
  const normalized = normalizeForFilesystem(relPath);
  return normalized !== relPath && matchesDenylistPass(normalized);
}

/**
 * The real path of `abs`, resolving every symlink in it - or of its nearest
 * existing ancestor with the missing tail re-appended, so a synthetic probe
 * path (list_dir's directory test) still resolves through a symlinked parent.
 * `null` when nothing on the path exists or the resolve fails; callers treat
 * that as "no extra information", never as permission.
 */
function realPathOrNull(abs: string, cache?: Map<string, string | null>): string | null {
  // The walk moved to `lib/path-containment.ts`: this file and `tools.ts`
  // each carried their own copy of it, which is two mechanisms for one
  // property. A thin alias so the guard below reads unchanged.
  if (cache !== undefined) {
    const hit = cache.get(abs);
    if (hit !== undefined) return hit;
    const real = canonicalize(abs);
    cache.set(abs, real);
    return real;
  }
  return canonicalize(abs);
}

/** Synchronous predicate: true ⇒ the absolute path must not be read or written. */
export type SecretGuard = (absPath: string) => boolean;

/** No project ignore layer - the built-in denylist alone. */
const NO_IGNORE: SecretGuard = () => false;

/**
 * Load the optional `.spycoreignore` predicate. Async because `globby` is an
 * ESM-only package: it can only be reached through `await import`, and there is
 * no synchronous form of that.
 */
async function loadIgnorePred(cwd: string): Promise<SecretGuard> {
  if (!existsSync(join(cwd, '.spycoreignore'))) return NO_IGNORE;
  try {
    const { isIgnoredByIgnoreFilesSync } = await import('globby');
    const pred = isIgnoredByIgnoreFilesSync('.spycoreignore', { cwd });
    return (abs) => {
      try {
        return pred(abs);
      } catch {
        return false;
      }
    };
  } catch {
    return NO_IGNORE;
  }
}

/**
 * THE ONE DECISION MECHANISM. Every secret guard in the package - async or
 * sync - is this function; the loaders differ only in which optional ignore
 * layer they can supply. Two mechanisms guarding one property is a bypass
 * surface by construction, so the denylist + resolved-path logic below exists
 * exactly once and both entry points share it.
 */
function buildGuard(cwd: string, ignorePred: SecretGuard, realPathCache?: Map<string, string | null>): SecretGuard {
  // Resolved once per guard, not per call: the guard is invoked per file in
  // the glob/grep loops, and realpath of the cwd cannot change under it.
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    realCwd = cwd;
  }
  return (abs: string): boolean => {
    if (matchesBuiltinDenylist(relative(cwd, abs))) return true;
    // A name-based guard judges the name it is GIVEN; the filesystem opens the
    // name it RESOLVES. An ordinary symlink inside the workspace defeats the
    // first without escaping the sandbox at all - `notes.md -> .env` was read
    // out in full, on every platform. So the resolved path is judged too.
    const real = realPathOrNull(abs, realPathCache);
    if (real !== null && real !== abs) {
      const realRel = relative(realCwd, real);
      if (matchesBuiltinDenylist(realRel)) return true;
      // Re-based onto the caller's spelling of cwd before the ignore layer:
      // `realCwd` and `cwd` differ whenever cwd is itself reached through a
      // symlink (on macOS, every path under /tmp), and the ignore predicate
      // was built against `cwd`, so handing it a real path silently matches
      // nothing.
      if (ignorePred(join(cwd, realRel))) return true;
    }
    return ignorePred(abs);
  };
}

/**
 * Build the secret guard for a working directory: the built-in denylist plus
 * any `.spycoreignore` patterns. Async only to load the optional ignore file;
 * the returned predicate is synchronous.
 */
export interface SecretGuardOpts {
  /**
   * Shared per-path realpath memo. The guard resolves every path it judges;
   * a caller that invokes the guard per file over a large tree (grep, glob)
   * passes one map for the whole scan so each path resolves at most once.
   * Cached and uncached guards judge identically.
   */
  realPathCache?: Map<string, string | null> | undefined;
}

export async function loadSecretGuard(cwd: string, opts: SecretGuardOpts = {}): Promise<SecretGuard> {
  return buildGuard(cwd, await loadIgnorePred(cwd), opts.realPathCache);
}

/**
 * The same guard, built synchronously, for the CONTEXT-ASSEMBLY readers - the
 * `@import` chain, the SPYCODE/GUIDE/CHANGELOG loaders, skill and slash-command
 * discovery, and the README summary. Every one of those is synchronous (one of
 * them on a React render path), so they cannot await; before F-2c-6 they simply
 * consulted no guard at all and read whatever the path resolved to.
 *
 * THE ONE DIFFERENCE, STATED RATHER THAN GLOSSED: this carries the always-on
 * built-in denylist and the resolved-path re-check - the layers that refuse
 * `.env`, private keys, `.ssh`, `.aws` and credential files, including through
 * an in-workspace symlink - but NOT the optional project `.spycoreignore`
 * layer, because that needs `await import('globby')` and globby is ESM-only.
 * A user-declared ignore entry therefore does NOT bound these readers.
 * Pinned by `secret-guard-reach.test.ts` so this limit cannot be re-described
 * as closed without a test going red. → .
 */
export function loadSecretGuardSync(cwd: string): SecretGuard {
  return buildGuard(cwd, NO_IGNORE);
}
