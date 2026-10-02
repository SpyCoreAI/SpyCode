/**
 * ⭐⭐ F-22 — THE OS-FOLD CORPUS: the class of names the FILESYSTEM resolves to a
 * denylisted spelling and the guards do not.
 *
 * ⭐ THE TABLE BELOW IS MEASURED, NOT DERIVED. Every entry was obtained by asking
 * the operating system: 18,288 ASCII-named target fixtures (every 1-, 2- and
 * 3-character lower-case combination) were created inside a probe fence, and each
 * of 194,526 Unicode scalars was probed by asking the OS to open `f<scalar>` and
 * reading back which target it served. No JS folding function — not
 * `toLowerCase`, not `normalize`, not the function this corpus exists to
 * falsify — took any part in building it.
 *
 * ⭐⭐ THAT PROVENANCE IS THE WHOLE POINT. *A corpus derived from — or unable to
 * reach — the thing it exists to falsify cannot falsify it, and it may CERTIFY A
 * FALSE ANSWER.* F-20's census of this same class asked Unicode rather than the
 * filesystem and could only express 1→1 folds, so it reported "exactly one gap"
 * over a population that structurally could not contain the other nine.
 *
 * ⭐ PLATFORM. Every row is macOS/APFS (darwin 25.6.0), which is case-insensitive
 * AND normalisation-insensitive. Windows/NTFS uses its own upcase table and is
 * **UNKNOWN** — recorded as unknown, never as zero. Case-sensitive Linux cannot
 * reach any of these cells at all.
 */

/** One scalar the OS folds to an ASCII string, and the string it folds to. */
export interface OsFold {
  readonly scalar: string;
  readonly hex: string;
  readonly foldsTo: string;
  /** Does a plain `toLowerCase()` already reproduce this fold? */
  readonly coveredByToLowerCase: boolean;
}

/**
 * The NON-ASCII members of the measured fold class. The 26 ASCII-case folds are
 * omitted here and covered by {@link ASCII_CASE_CONTROL} — they are a separate
 * dimension (SPY-389's) and mixing them would hide which half a failure came from.
 *
 * ⭐ U+212A is the CONTROL, not padding: it is folded by the OS *and* already
 * reproduced by `toLowerCase()`, so it must stay blocked both before and after
 * the fix. A corpus whose every row moves together cannot tell a real fix from a
 * blanket refusal.
 */
export const OS_FOLD_SCALARS: readonly OsFold[] = [
  { scalar: 'ß', hex: 'U+00DF', foldsTo: 'ss', coveredByToLowerCase: false },
  { scalar: 'ſ', hex: 'U+017F', foldsTo: 's', coveredByToLowerCase: false },
  { scalar: 'ẞ', hex: 'U+1E9E', foldsTo: 'ss', coveredByToLowerCase: false },
  { scalar: 'ﬀ', hex: 'U+FB00', foldsTo: 'ff', coveredByToLowerCase: false },
  { scalar: 'ﬁ', hex: 'U+FB01', foldsTo: 'fi', coveredByToLowerCase: false },
  { scalar: 'ﬂ', hex: 'U+FB02', foldsTo: 'fl', coveredByToLowerCase: false },
  { scalar: 'ﬃ', hex: 'U+FB03', foldsTo: 'ffi', coveredByToLowerCase: false },
  { scalar: 'ﬄ', hex: 'U+FB04', foldsTo: 'ffl', coveredByToLowerCase: false },
  { scalar: 'ﬅ', hex: 'U+FB05', foldsTo: 'st', coveredByToLowerCase: false },
  { scalar: 'ﬆ', hex: 'U+FB06', foldsTo: 'st', coveredByToLowerCase: false },
  { scalar: 'K', hex: 'U+212A', foldsTo: 'k', coveredByToLowerCase: true },
];

/** The ten the guards MISS. The eleventh (U+212A) is the discriminating control. */
export const OS_FOLD_MISSED = OS_FOLD_SCALARS.filter((f) => !f.coveredByToLowerCase);

/** ⭐ The one scalar JS case-maps to ASCII that the FILESYSTEM does NOT fold. */
export const DOTLESS_I = 'ı';

/**
 * Scalars that a **compatibility** normalisation (NFKC) folds to ASCII while the
 * filesystem does not resolve them at all. Refusing any of these is a NEW
 * OVER-BLOCK on an ordinary filename — the cost the prescribed fix would impose.
 * A representative, measured subset of the 1,213 found.
 */
export const NFKC_ONLY_SCALARS: readonly string[] = ['²', '³', '¹', 'ª', 'º', 'Ĳ', 'ĳ', 'Ǉ', 'ǈ', 'Ǌ', 'ǋ', 'ǌ'];

/**
 * ⭐⭐ THE CELLS THAT MAKE THE PRESCRIBED FIX'S COST **OBSERVABLE THROUGH THE
 * GUARD**, rather than only at the fold.
 *
 * The `NFKC_ONLY_SCALARS` above fold to ASCII that lands on nothing — `²notes.md`
 * becomes `2notes.md`, which is not a denylist entry, so no verdict changes and
 * the over-block is invisible to a guard-level assertion. That is a corpus that
 * cannot reach the class it exists to falsify, and the mutation arm for the
 * prescribed fix reddened only ONCE because of it.
 *
 * These three DO land: NFKC maps fullwidth Latin exactly onto `.env`, `.pgpass`
 * and `secrets.json`. Each was proved a VALID, distinct, creatable file whose
 * bytes the OS does **not** serve for the ASCII spelling (ENOENT against a real
 * `.env` fixture), so refusing one refuses a file that does not exist. This is
 * the same measurement `secrets.ts` already cited for fullwidth Latin, now
 * carried as executable cells instead of a comment.
 */
export const FULLWIDTH_BENIGN_NAMES: readonly string[] = ['.ｅｎｖ', '.ｐｇｐａｓｓ', 'ｓｅｃｒｅｔｓ.json'];

/** Denylisted names, in their ordinary ASCII spelling. */
export const SECRET_BASE_NAMES: readonly string[] = [
  '.ssh/id_rsa',
  '.ssh/known_hosts',
  '.aws/credentials',
  'secrets.json',
  '.pgpass',
  'app.keystore',
  '.netrc',
  '.npmrc',
  '.dockercfg',
  '.htpasswd',
  'credentials.json',
];

/** Catastrophic commands, in their ordinary ASCII spelling. */
export const SCREEN_BASE_COMMANDS: readonly string[] = [
  'rm -rf /usr',
  'rm -rf /Users',
  'rm -rf /System',
  'rm -rf /var',
  'rm -rf /etc',
  'echo x > /etc/passwd',
  'echo x > /etc/shadow',
  'chmod -R 777 /usr',
];

/**
 * Deny-rule entries and the commands that must match them.
 *
 * ⭐⭐ THE REACHABLE CLASS IS NOT THE SAME AT ALL THREE SITES, AND THIS SITE IS
 * THE WIDEST. Measured against the shipped vocabularies: the built-in secret
 * denylist can be attacked with only 6 of the 11 scalars and the catastrophic
 * screen with only 5, because no built-in token contains the substrings `ff`,
 * `fi`, `fl`, `ffi` or `ffl` for the ligatures to replace. Deny-rule tokens are
 * **user-supplied**, so this site is bounded by nothing and is exposed to the
 * WHOLE class, always.
 *
 * ⭐ The entries below are therefore chosen to make every fold length reachable —
 * `office` (ffi), `shuffle` (ffl), `ffmpeg` (ff), `find` (fi), `flutter` (fl),
 * `passwd` (ss), `systemctl` (st) — and every one is an ordinary thing to deny.
 * *Extend the corpus until it can reach the class, then measure.*
 */
export const RULE_BASE_CELLS: readonly { readonly entry: string; readonly command: string }[] = [
  { entry: 'curl', command: 'curl http://example.test' },
  { entry: 'shutdown', command: 'shutdown -h now' },
  { entry: 'git push', command: 'git push origin main' },
  { entry: 'npm publish', command: 'npm publish' },
  { entry: 'docker', command: 'docker rm -f box' },
  { entry: 'kubectl', command: 'kubectl delete ns prod' },
  { entry: 'office', command: 'office --purge-all' },
  { entry: 'shuffle', command: 'shuffle --wipe' },
  { entry: 'ffmpeg', command: 'ffmpeg -y -i in.mp4 out.mp4' },
  { entry: 'find', command: 'find . -delete' },
  { entry: 'flutter', command: 'flutter clean' },
  { entry: 'systemctl', command: 'systemctl stop nginx' },
];

/**
 * Rewrite every occurrence of `fold.foldsTo` in `text` with the folding scalar.
 *
 * ⭐⭐ F-21's LESSON, APPLIED: a generator must be PROVED to generate what it
 * claims. Two chained replaces made 81 cells inert last batch. This is a SINGLE
 * pass over a split, so no output of one substitution can be re-read as the input
 * of another. `occurrence` selects WHICH occurrence is rewritten, which is how the
 * corpus varies POSITION rather than shipping one shape N times.
 *
 * Returns `null` when the requested occurrence does not exist, so a caller can
 * never mistake "nothing was substituted" for a valid cell.
 */
export function foldedSpelling(text: string, fold: OsFold, occurrence: number): string | null {
  const parts = text.split(fold.foldsTo);
  if (parts.length - 1 <= occurrence) return null;
  const head = parts.slice(0, occurrence + 1).join(fold.foldsTo);
  const tail = parts.slice(occurrence + 1).join(fold.foldsTo);
  return `${head}${fold.scalar}${tail}`;
}

/** One generated hostile cell, carrying everything needed to judge it. */
export interface FoldCell {
  readonly base: string;
  readonly spelled: string;
  readonly hex: string;
  readonly foldsTo: string;
  readonly occurrence: number;
}

/**
 * Generate every (base × scalar × occurrence) cell that actually substitutes.
 * ⭐ The defect-relevant dimensions are VARIED, not fixed: the scalar, the fold
 * LENGTH (1→1, 1→2 and 1→3 are all represented), and the POSITION of the
 * substitution within the name.
 */
export function foldCells(bases: readonly string[], folds: readonly OsFold[]): FoldCell[] {
  const cells: FoldCell[] = [];
  for (const base of bases) {
    for (const fold of folds) {
      for (let occurrence = 0; occurrence < 4; occurrence++) {
        const spelled = foldedSpelling(base, fold, occurrence);
        if (spelled === null) break;
        cells.push({ base, spelled, hex: fold.hex, foldsTo: fold.foldsTo, occurrence });
      }
    }
  }
  return cells;
}

/**
 * ⭐ THE LEGITIMATE SET, ENUMERATED FROM THE FILESYSTEM'S OWN GRAMMAR AND PROVED
 * BEFORE ANY VERDICT COUNTED. A legitimate filename is any UTF-8 name the OS
 * accepts that is not a secret — non-ASCII names are ORDINARY, not exotic.
 *
 * Three groups, each load-bearing for a different reason:
 *   1. ordinary names, ASCII and non-ASCII;
 *   2. ⭐ THE TRAP SET — words built from the very scalars the fix now folds
 *      (`straße`, `ﬁlter`, `ﬅyle`), which fold to ordinary words and must stay
 *      allowed;
 *   3. ⭐ THE PRESCRIBED-FIX COST — names the NFKC candidate refuses and the
 *      filesystem never resolves (`²power`, `Ĳsselmeer`), plus the two U+0131
 *      names that a fold without the dotless-i exclusion would refuse.
 */
export const FOLD_BENIGN_NAMES: readonly string[] = [
  'README.md',
  'package.json',
  'src/index.ts',
  'build.log',
  'keystore.md',
  '.envelope',
  'café.txt',
  'naïve.md',
  'résumé.pdf',
  'Übersicht.md',
  '日本語.txt',
  'привет.txt',
  'Ωmega.txt',
  'straße.txt',
  'Straße.md',
  'ﬁlter.js',
  'ﬂow.ts',
  'ﬅyle.css',
  'ﬆop.txt',
  'eﬀect.js',
  'ﬃx.md',
  'waﬄe.txt',
  'ıstanbul.txt',
  'ırmak.md',
  '²power.txt',
  '³cube.txt',
  '¹first.md',
  'ªordinal.txt',
  'ºdegree.md',
  'Ĳsselmeer.txt',
  'ĳssel.md',
  'Ǉubljana.txt',
  'ǌmegen.txt',
  'presecrets.json',
  'my.env.example.md',
];

/** Ordinary commands that must never be refused by the screen. */
export const FOLD_BENIGN_COMMANDS: readonly string[] = [
  'ls -la',
  'echo hello',
  'git status',
  'npm run build',
  'rm -rf ./build',
  'rm -rf node_modules',
  'cat straße.txt',
  'cat ﬁlter.js',
  'cat ıstanbul.txt',
  'grep -r pattern src',
];
