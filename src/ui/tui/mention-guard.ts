/**
 * The @-mention / paste file check, shared by TuiApp's `resolveMentions` and
 * `handlePaste`.
 *
 * The old checks were spelling-only: containment via `relative(cwd, abs)`
 * and a dotfile skip over the lexical path segments, then `statSync` /
 * `readFileSync` FOLLOWED symlinks. A repo-supplied `notes.md -> .env` sailed
 * through - rel `notes.md`, no dot part, `isFile()` true - and the `.env`
 * contents were read into the prompt context, defeating the D4 secret
 * protection that `read_file` enforces via `safeResolve` + the realpath-based
 * secret guard.
 *
 * This helper judges the RESOLVED path: `lstatSync` to see the link, then
 * `realpathSync`, containment of the resolved path under the resolved cwd,
 * a dotfile check over the resolved segments, and the sync secret guard
 * (built-in denylist + `.spycoreignore`) over the resolved target. A
 * non-symlink file goes through the same guard. The caller reads the
 * RESOLVED target, never the lexical spelling.
 */
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { loadSecretGuardSync, type SecretGuard } from '../../lib/agent/secrets.js';

/** A mention target that passed every check: read `realAbs`, not `abs`. */
export interface MentionTarget {
  /** The path as typed (lexical spelling under cwd). */
  abs: string;
  /** The resolved path to read. */
  realAbs: string;
  /** Size of the resolved file, in bytes. */
  size: number;
}

export interface MentionGuardOpts {
  /** Maximum file size, in bytes. */
  maxBytes: number;
  /**
   * Secret guard for the workspace. Built once per resolveMentions call and
   * shared across its tokens; omit it to build one per call (paste path).
   */
  guard?: SecretGuard | undefined;
}

/** True when any segment of `rel` is a dotfile/dotdir. */
function hasDotPart(rel: string): boolean {
  return rel.split(sep).some((part) => part.startsWith('.'));
}

/**
 * Resolve `abs` (already lexically under `cwd`) to a readable mention
 * target, or null when it must not be attached. Never throws.
 */
export function resolveMentionTarget(
  cwd: string,
  abs: string,
  opts: MentionGuardOpts,
): MentionTarget | null {
  try {
    const rel = relative(cwd, abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
    if (hasDotPart(rel)) return null;
    const lst = lstatSync(abs);
    let realAbs = abs;
    if (lst.isSymbolicLink()) {
      let realCwd: string;
      try {
        realCwd = realpathSync(cwd);
      } catch {
        realCwd = cwd;
      }
      try {
        realAbs = realpathSync(abs);
      } catch {
        return null; // dangling link - nothing to read
      }
      const realRel = relative(realCwd, realAbs);
      if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) return null;
      if (hasDotPart(realRel)) return null;
    }
    // The secret guard judges the resolved path too (denylist + ignore
    // layer), so a link to a denylisted or ignored file is refused even
    // when its spelling looks innocent.
    const guard = opts.guard ?? loadSecretGuardSync(cwd);
    if (guard(realAbs)) return null;
    const st = statSync(realAbs);
    if (!st.isFile() || st.size > opts.maxBytes) return null;
    return { abs, realAbs, size: st.size };
  } catch {
    return null;
  }
}
