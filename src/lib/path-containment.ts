/**
 * THE path-containment mechanism — one implementation, package-wide.
 *
 * A boundary must be decided by where a path RESOLVES, never by how it is
 * SPELLED. A lexical comparison (`relative()` / `startsWith('..')`) answers a
 * question about strings; the filesystem answers a question about inodes, and a
 * symbolic link is precisely where the two disagree.
 *
 * ⭐ WHY THIS FILE EXISTS AT ALL. Before it, the same nearest-existing-ancestor
 * realpath walk was implemented TWICE (`tools.ts realPathInsideCwd`,
 * `secrets.ts realPathOrNull`) and two further boundaries were decided purely
 * lexically with no realpath anywhere (`memory.ts isInside`, which bounds the
 * SPYCODE.md `@import` reader, and `checkpoint.ts pruneEmptyDirs`, which bounds
 * `rmdirSync`). Measured at that state, 5 of 5 symlink probes read file
 * contents from outside the workspace into the model's context, and `rewind`
 * removed a directory outside the workspace entirely.
 *
 * Two mechanisms guarding one property is a bypass surface by construction —
 * that was F-2c-1's single best result, and this finishes the job it started:
 * every containment decision in the package now runs through here.
 *
 * ⭐ UNRESOLVABLE ⇒ `true` IS NOT A PERMISSION. When nothing on the path exists,
 * or the resolve fails, the answer is "no extra information" — exactly what the
 * predecessor returned. The caller's LEXICAL check still governs and nothing is
 * loosened. Every caller keeps its lexical test and ADDS this one; this file
 * can only ever tighten a boundary, never widen one.
 *
 * ⭐ WHAT THIS CANNOT DO, stated so no reader mistakes its reach:
 *   - A HARD LINK is a second real name for one inode. `realpath` cannot tell
 *     it from the first, so no name-based containment sees it. Structural.
 *   - It answers about the filesystem AT THE MOMENT IT IS CALLED. A path
 *     validated here and opened later is a check-then-use pair, and closing
 *     that window needs `openat(2)`, which Node does not expose. Callers that
 *     mutate must re-check immediately before the operation; that narrows the
 *     window to a genuine race but does not remove it.
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

/**
 * How many links deep `canonicalize` will follow by hand before giving up.
 * A symlink cycle is finite only because of this; the value is the usual
 * `SYMLOOP_MAX` and the hand-walk below only runs for links the OS itself
 * refused to resolve, so it is reached by pathological input alone.
 */
const MAX_DANGLING_LINK_HOPS = 32;

/** Does this NAME exist — including a symlink whose target does not? */
function nameExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real path of `abs`, resolving every symbolic link on it. When the target
 * does not exist yet (a file about to be created), the nearest EXISTING
 * ancestor is resolved and the not-yet-existing tail re-joined onto it — so a
 * symlinked parent directory is still seen.
 *
 * Returns `null` when nothing on the path exists or the resolve fails; callers
 * treat that as "no extra information", never as permission.
 *
 * ⭐⭐ F-2c-40 — A DANGLING SYMLINK IS A NAME THAT EXISTS, AND `existsSync` SAYS
 * IT DOES NOT.
 *
 * This walk used to test `existsSync(probe)`, which FOLLOWS links. For a link
 * whose target is missing that returns false, so the walk treated the link's own
 * name as a not-yet-existing TAIL, realpath'd the PARENT — which is inside the
 * workspace — and re-joined the tail LEXICALLY. **The link was never
 * dereferenced**, so `canonicalize('<ws>/link')` returned a path lexically
 * inside the workspace no matter where the link actually pointed, and
 * `isInsideReal` therefore returned TRUE for it.
 *
 * Review 2 filed that as `F-N2d` and judged it "defence-in-depth only", naming
 * four accidents that made it unreachable. All four still hold. What changed is
 * that the fix which closed `F-N4` added a FIFTH sink with none of them — a
 * plain `writeFileSync` on the journal's new `op:'delete'` restore arm — so
 * `spycore rewind` created a file OUTSIDE the workspace with content the agent
 * chose. Measured end to end at review 3, and re-measured here.
 *
 * ⭐ The predicate now decides existence with `lstat` (the NAME, not the
 * target) and, when the OS refuses to resolve a link because its target is
 * missing, DEREFERENCES IT BY HAND and canonicalizes what it points at. So the
 * answer is about where a write would LAND, which is the only question a
 * containment boundary is ever asked.
 *
 * ⭐ It can only ever TIGHTEN: an in-workspace dangling link still resolves
 * inside and is still allowed. What it stops returning is "inside" for a link
 * that names somewhere else.
 */
export function canonicalize(abs: string, hops = 0): string | null {
  if (hops > MAX_DANGLING_LINK_HOPS) return null; // a link cycle — no information
  let probe = abs;
  const tail: string[] = [];
  while (!nameExists(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return null; // reached the root without existing
    tail.unshift(basename(probe));
    probe = parent;
  }
  try {
    const real = realpathSync(probe);
    return tail.length === 0 ? real : join(real, ...tail);
  } catch {
    // `probe` exists as a NAME and does not resolve. A dangling symlink is the
    // ordinary way that happens; follow it ourselves rather than returning "no
    // information", which the caller's lexical test would read as permission.
    try {
      if (lstatSync(probe).isSymbolicLink()) {
        const target = readlinkSync(probe);
        const targetAbs = isAbsolute(target) ? target : join(dirname(probe), target);
        const real = canonicalize(targetAbs, hops + 1);
        if (real === null) return null;
        return tail.length === 0 ? real : join(real, ...tail);
      }
    } catch {
      return null;
    }
    return null;
  }
}

/** The real path of a directory that serves as a boundary; itself when unresolvable. */
export function realRoot(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/**
 * Is `abs` the boundary itself, or inside it, once BOTH sides are resolved?
 *
 * `realBoundary` must already be a resolved root (see `realRoot`) — hoisting
 * that resolve out of a per-file loop is why it is a parameter rather than a
 * second `realpathSync` here: the guard runs once per file in the glob/grep
 * loops, and the realpath of a boundary cannot change under them.
 */
export function isInsideReal(realBoundary: string, abs: string): boolean {
  const real = canonicalize(abs);
  if (real === null) return true; // no extra information — the lexical check governs
  const rel = relative(realBoundary, real);
  return rel === '' || !(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel));
}

/**
 * Bind the containment test to one boundary, resolving that boundary ONCE.
 * Use this wherever the predicate is applied to more than one path.
 */
export function containmentBound(boundary: string): (abs: string) => boolean {
  const real = realRoot(boundary);
  return (abs: string): boolean => isInsideReal(real, abs);
}

/**
 * The complete containment test for a single path against an unresolved
 * boundary: LEXICAL confinement AND resolved confinement, both required.
 *
 * The lexical half is kept deliberately. It is not redundant: it rejects `..`
 * traversal and absolute escapes on their spelling alone, before any
 * filesystem call, and it remains the sole governing test whenever the
 * resolved half returns "no extra information".
 */
export function isContained(boundary: string, abs: string): boolean {
  const lexRel = relative(boundary, abs);
  const lexicallyInside =
    lexRel === '' || !(lexRel === '..' || lexRel.startsWith(`..${sep}`) || isAbsolute(lexRel));
  if (!lexicallyInside) return false;
  return isInsideReal(realRoot(boundary), abs);
}
