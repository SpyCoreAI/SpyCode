/**
 * ⭐⭐ F-22 — ONE FOLD, FOR EVERY GUARD THAT COMPARES A NAME THE OS WILL RESOLVE.
 *
 * Three guards decide whether a name is denied — the secret denylist
 * (`agent/secrets.ts`), the catastrophic screen (`agent/tools.ts`) and the
 * user/project deny matcher (`agent/command-rules.ts`). All three were comparing
 * with a fold NARROWER than the filesystem's, so a name the OS resolves to a
 * denied one was judged as a different name and allowed. That is ONE mechanism
 * at three sites, and it lives here exactly once: *two mechanisms guarding one
 * property are a bypass surface by construction.*
 *
 * ⭐⭐ THE TARGET GRAMMAR IS THE FILESYSTEM'S, NOT UNICODE'S AND NOT THE GUARD'S.
 * It was measured, not looked up: 18,288 ASCII-named target fixtures were created
 * in a probe fence and each of 194,526 Unicode scalars was probed by asking the
 * OS which target it served. macOS/APFS folds 37 non-identity spellings — the 26
 * ASCII cases, plus eleven non-ASCII scalars:
 *
 *     ß→ss   ſ→s   ẞ→ss   ﬀ→ff   ﬁ→fi   ﬂ→fl   ﬃ→ffi   ﬄ→ffl   ﬅ→st   ﬆ→st   K→k
 *
 * `toLowerCase()` reproduces only the ASCII cases and U+212A, leaving TEN open.
 *
 * ⭐⭐ WHY NOT NFKC, WHICH IS WHAT THE FILINGS PRESCRIBED. Measured over that same
 * population, `NFKC` + lower **still leaves ß and ẞ open** (NFKC does not
 * decompose the sharp s) **and refuses 1,213 spellings the filesystem never
 * resolves** — `²`, `³`, `¹`, `ª`, `º`, `Ĳ`, `ĳ`, `Ǉ`, `ǈ`, `Ǌ`, … Every one is an
 * ordinary filename, so the prescribed fix would have failed in BOTH directions
 * at once: an under-block class left open and an over-block class 121× larger
 * created. *A prescribed fix is a hypothesis.*
 *
 * ⭐ WHAT THIS IS. Unicode FULL CASE FOLDING is the filesystem's grammar, and JS
 * does not expose it. `toLowerCase → toUpperCase → toLowerCase` reproduces it
 * over the whole population except at ONE scalar, U+0131 `ı` (dotless i), where
 * JS's locale-insensitive `toUpperCase` yields `I` while the filesystem folds `ı`
 * to itself. U+0131 is therefore held out of the fold. Measured result over
 * 194,526 scalars: **0 under-blocks and 0 over-blocks.**
 *
 * ⭐ PLATFORM. Measured on macOS/APFS (darwin 25.6.0). Windows/NTFS folds through
 * its own upcase table, which is a different function and is **UNKNOWN** here —
 * recorded as unknown, never as zero. Case-sensitive Linux filesystems resolve
 * distinct names distinctly, so none of these cells arises there; folding is
 * harmless because the comparison targets are all lower-case ASCII already.
 *
 * ⭐ ALWAYS UNIONED, NEVER SUBSTITUTED. Every call site offers this reading
 * ALONGSIDE its existing one, so a name refused today cannot become allowed.
 */

/**
 * U+0131 LATIN SMALL LETTER DOTLESS I — the one scalar JS case-maps into ASCII
 * that the filesystem does NOT fold. Held out so `ıd_rsa` is not read as
 * `id_rsa`: the OS serves two different files, and refusing the Turkish spelling
 * would refuse a file that does not exist.
 */
const DOTLESS_I = 'ı';

/**
 * Fold a name the way the filesystem folds it, for DENY-side comparison only.
 *
 * Never use this on the ALLOW side: allow matching must stay exact, or a
 * respelled command could auto-approve — strictly worse than the hole this
 * closes.
 */
export function osFold(value: string): string {
  return value
    .split(DOTLESS_I)
    .map((part) => part.toLowerCase().toUpperCase().toLowerCase())
    .join(DOTLESS_I);
}
