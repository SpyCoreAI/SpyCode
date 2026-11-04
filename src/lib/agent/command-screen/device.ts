import { stripExpansions } from '../shell-parse.js';
import { osFold } from '../../os-fold.js';
import {
  DATA_CONTAINER,
  DISK_IDENTIFIER,
  INSTALL_CONTAINER,
  LEADING_EXPANSION,
  ROOT_OR_TILDE,
  SAFE_DEVICES,
  SAFE_DEVICE_ROLES,
  SAFE_DEVICE_TERMINALS,
  SENSITIVE_FILE,
  SYSTEM_DIR,
  type DeviceWriteVerb,
} from './constants.js';

/**
 * Device / sensitive-path targeting (M-8 split of command-screen.ts).
 * `export` here means "used by the screen engine", not public API.
 */

/**
 * The `/dev/` spelling of a target, for verbs whose own grammar also accepts the
 * bare identifier. For every other verb the target is returned untouched, which
 * is what keeps `cp ./disk9 /tmp/backup` allowed.
 */
export function deviceSpelling(v: DeviceWriteVerb | undefined, target: string): string {
  if (v?.bareIdentifiers !== true) return target;
  return DISK_IDENTIFIER.test(target) ? `/dev/${target}` : target;
}

/** Writing here destroys a disk: anything under /dev/ that is not known-safe. */
export function isRawDevice(target: string): boolean {
  // NORMALISE FIRST - A PREFIX FAMILY IS A PATH, AND A PATH CAN BE WALKED
  // OUT OF. Measured before this change: `echo x > /dev/fd/../sda` was ALLOWED
  // by HEAD *and* by the published 0.6.0, because the `/dev/fd/` family was
  // matched on the raw string. Adding three more families without the clamp
  // would have multiplied a hole rather than closed one. `normalizeTarget` is
  // the same `..` clamp `dangerousTarget` uses; this is its third anchored site.
  // F-11 / D1-1 - THE THIRD SITE OF THE ANCHOR CLASS, AND IT WAS MISSED
  // TWICE. F-2c-43 established that a reading produced by DELETING a leading
  // expansion is not entitled to conclude an absolute path - it does not reveal
  // the anchor, it INVENTS one - and closed that at `dangerousTarget` and at
  // `sensitiveTarget`. This predicate has the identical shape and was never
  // brought along, so `"$OUT/dev/tool.sh"` stripped to `/dev/tool.sh` and was
  // refused as a raw block device, with NO override of any kind: not `--yes`,
  // not a session accept-all, not an allow rule. The published 0.6.0 allows it.
  //
  // AND THE CORPUS COULD NOT SEE IT, FOR A REASON WORTH KEEPING. The benign
  // anchor dimension generated `${anchor}/${segment}` and stopped - `$OUT/dev`
  // strips to `/dev`, which does not start with `/dev/`, so the ONE depth it
  // produced was the ONE depth that passes. A corpus that generates only the
  // passing depth cannot see the failing one. `anchoredDepthReach()` now floors
  // that dimension on depth, the way the recursion dimension is floored on
  // `MAX_SCREEN_DEPTH`.
  //
  // Two readings, exactly as `dangerousTarget`: the word AS WRITTEN always
  // counts, and the stripped reading counts only when the word's own text fixes
  // where it starts. Priced over 43,401 cells: 882 ordinary commands stop being
  // refused, and ZERO of the raw-device cells move.
  const readings = anchorIsInText(target) ? [target, stripExpansions(target)] : [target];
  for (const base of readings) {
    const p = normalizeTarget(base).toLowerCase().replace(/\/+$/, '');
    if (!p.startsWith('/dev/')) continue;
    if (SAFE_DEVICES.has(p)) continue;
    if (SAFE_DEVICE_TERMINALS.test(p)) continue;
    if (SAFE_DEVICE_ROLES.some((prefix) => p.startsWith(prefix))) continue;
    return true;
  }
  return false;
}

/**
 * Does this word's own text fix where it starts?
 *
 * THIS PREDICATE IS SMALLER THAN THE FIX THAT FIRST CARRIED IT, AND THE
 * MUTATION HARNESS IS WHY. The first spelling also classified `$HOME`/`~` as a
 * third, KNOWN anchor and rewrote `$HOME` onto `~` so `normalizeTarget`'s `~`
 * arm would resolve the `..` segments. It read well and it did nothing: the
 * mutation that deleted that rewrite left the whole suite GREEN. The `..` clamp
 * added alongside it already closes every `$HOME` shape - `$HOME/../..` strips
 * to `/../..`, which clamps to `/` - so the rewrite was decoration on a working
 * mechanism. A component no mutation can make matter is not a mechanism, and
 * this arc's own standard is that it comes out.
 *
 * The two spellings are therefore closed by two DIFFERENT mechanisms (`~` by
 * `normalizeTarget`'s arm, `$HOME` by the clamp), which is exactly the shape
 * that produced the defect in the first place - so the class is held together
 * by a pin that asserts the spellings AGREE shape by shape, and that pin is
 * mutation-proved to bind.
 */
function anchorIsInText(v: string): boolean {
  return !LEADING_EXPANSION.test(v);
}

/**
 * F-2c-25 - PATH SPELLINGS THAT NAME THE SAME PLACE.
 *
 * `//`, `//*`, `~//` and `~/./*` are the filesystem root and HOME under other
 * names - a shell resolves them identically. The published 0.6.0 blocked all
 * four because its regex matched characters rather than a set; the word-axis
 * screen compared the operand against a literal SET and missed every spelling
 * not in it. Measured: **84 shapes** on this cause.
 *
 * It also resolves `..` LEXICALLY. That closes a gap BOTH nets had - measured,
 * `rm -rf /tmp/../etc` was missed by the published 0.6.0 and by HEAD - and it
 * is safe in the benign direction because a `..` is only ever removed together
 * with the named segment before it (`build/../dist` → `dist`).
 */
function normalizeTarget(v: string): string {
  let s = v.replace(/\/{2,}/g, '/');
  while (s.includes('/./')) s = s.replace(/\/\.\//g, '/');
  s = s.replace(/\/\.$/, '/');
  if (!s.includes('..')) return s;
  const absolute = s.startsWith('/');
  const trailing = s.endsWith('/');
  const parts = s.split('/').filter((p) => p.length > 0);
  const stack: string[] = [];
  for (const p of parts) {
    const top = stack[stack.length - 1];
    // F-2c-43 - POSIX CLAMPS `..` AT THE ROOT: `/..` IS `/`, not a place
    // above it. Without this the stack simply accumulated the extra `..` and
    // `rm -rf /tmp/../..` - which every shell resolves to `/` - normalised to
    // the string `/..`, matched nothing, and was allowed by HEAD *and* by the
    // published 0.6.0. A gap at both versions, found by walking the `..` axis
    // rather than by reading the rule.
    if (p === '..' && absolute && stack.length === 0) continue;
    if (p === '..' && top !== undefined && top !== '..' && top !== '.' && !(stack.length === 1 && top === '~')) {
      stack.pop();
      continue;
    }
    if (p === '..' && stack.length === 1 && stack[0] === '~') {
      // `~/..` is the parent of HOME - treat it as HOME rather than inventing a
      // path, so the ROOT_OR_TILDE test still recognises it.
      continue;
    }
    stack.push(p);
  }
  const joined = stack.join('/');
  return (absolute ? '/' : '') + joined + (trailing && joined.length > 0 ? '/' : '');
}

/**
 * F-2c-43 - THE SECOND SITE OF THE ANCHOR CLASS.
 *
 * `SENSITIVE_FILE`'s `/etc/(passwd|shadow|sudoers)` alternative is anchored at
 * `^/` exactly as `SYSTEM_DIR` was, and it was tested against
 * `stripExpansions(target)` in the same way - so `echo x > "$OUT/etc/passwd"`
 * fabricated the same absolute anchor and was refused. Measured before this
 * fix: 5 of 6 spellings refused at HEAD, 0 of 6 at the published 0.6.0.
 *
 * Fixing `dangerousTarget` alone would have closed the class AT ONE SITE, and
 * this arc has now recorded four separate occasions on which that was mistaken
 * for closing it. One predicate, both call sites - the redirect loop and `tee`,
 * which previously disagreed with each other anyway (`tee` tested only the raw
 * text, so it MISSED `tee "/etc/$(echo)passwd"` that the redirect loop caught).
 */
export function sensitiveTarget(value: string): boolean {
  // F-22 - the `/i` flag folds ASCII case ONLY. `osFold` adds the
  // spellings the FILESYSTEM folds (`/etc/paſſwd`, `/etc/paßwd`). Offered
  // ALONGSIDE the raw reading, so this can only ever add refusals.
  if (SENSITIVE_FILE.test(value) || SENSITIVE_FILE.test(osFold(value))) return true;
  // The stripped reading may only conclude an absolute path when the word's own
  // text says where it starts. `~`/`$HOME` spellings are matched above, raw.
  if (!anchorIsInText(value)) return false;
  const stripped = stripExpansions(value);
  return SENSITIVE_FILE.test(stripped) || SENSITIVE_FILE.test(osFold(stripped));
}

/**
 * '' when the operand is ordinary; otherwise the reason it is catastrophic.
 *
 * F-2c-43 - every reading now carries whether it is entitled to conclude that
 * the path is INSIDE a protected tree. A reading produced by deleting a leading
 * expansion is not: it knows the word ends in `/lib`, and it does not know what
 * that `lib` hangs off. It may still conclude the word names the anchor ITSELF
 * (`$X/` is the whole of `$X`, and `/` when `$X` is empty), which is why the
 * root test runs for every reading and only the tree tests are gated.
 */
export function dangerousTarget(value: string): string | null {
  /** Each reading, with whether it may conclude "inside a protected tree". */
  const readings: Array<[string, boolean]> = [
    [value, true],
    [stripExpansions(value), anchorIsInText(value)],
  ];

  const seen = new Set<string>();
  for (const [base, mayConcludeTree] of readings) {
    for (const candidate of [base, normalizeTarget(base)]) {
      // F-22 - TWO foldings, offered together and deduped by
      // `seen`: `toLowerCase` as before, and `osFold`, which additionally
      // reproduces the ten scalars the FILESYSTEM folds and `toLowerCase`
      // does not (`/uſr`, `/Uſerſ`, `/Syﬆem`). Adding a reading can only
      // ever ADD refusals - no target refused today becomes allowed.
      for (const lc of [candidate.toLowerCase(), osFold(candidate)]) {
        const key = `${mayConcludeTree ? '1' : '0'} ${lc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (ROOT_OR_TILDE.has(lc)) return 'on / ~ or $HOME';
        if (/^\$\{?home\}?(\/\*?)?$/.test(lc)) return 'on / ~ or $HOME';
        // m1: ~user expansion (e.g. ~root) - tilde followed by username
        if (/^~[a-z_][a-z0-9_-]*(\/.*)?$/.test(lc)) return 'on / ~ or $HOME';
        if (!mayConcludeTree) continue;
        if (SYSTEM_DIR.test(lc)) return 'on a system directory';
        if (DATA_CONTAINER.test(lc)) return 'on a user home directory or mounted volume';
        if (INSTALL_CONTAINER.test(lc)) return 'on the system applications/library directory';
      }
    }
  }
  return null;
}
