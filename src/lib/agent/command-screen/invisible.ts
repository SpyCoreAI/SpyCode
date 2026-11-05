/**
 * H-15 - invisible-unicode detection for `run_command` (homoglyph defense).
 *
 * An approval prompt is meaningless if what the user SEES is not what the
 * shell RUNS. Zero-width and bidi-control characters do exactly that: they
 * are invisible in the prompt while changing (or reordering) the executed
 * text. This module finds the first such character; the caller surfaces it
 * as an approval notice - a flag, not a hard block, because the screen's
 * hard blocks are reserved for the obviously catastrophic.
 *
 * Out of scope by design: full confusable-script detection (Cyrillic "а"
 * vs Latin "a") - a far bigger table with real over-block risk. The bidi
 * overrides below are the reordering vector; the zero-width set is the
 * hiding vector.
 */

/** One invisible/format character found in a command. */
export interface InvisibleHit {
  /** Offset in UTF-16 code units in the command string. */
  index: number;
  /** The character itself (for display, escaped by the caller). */
  char: string;
  /** Human name, e.g. "zero-width space". */
  name: string;
}

/**
 * Bidi control ranges that reorder display: U+202A-U+202E (embeddings,
 * overrides, pop) and U+2066-U+2069 (isolates, pop).
 */
function bidiName(cp: number): string | null {
  switch (cp) {
    case 0x202a: return 'left-to-right embedding';
    case 0x202b: return 'right-to-left embedding';
    case 0x202c: return 'pop directional formatting';
    case 0x202d: return 'left-to-right override';
    case 0x202e: return 'right-to-left override';
    case 0x2066: return 'left-to-right isolate';
    case 0x2067: return 'right-to-left isolate';
    case 0x2068: return 'first strong isolate';
    case 0x2069: return 'pop directional isolate';
    default: return null;
  }
}

const ZERO_WIDTH_NAMES: Record<number, string> = {
  0x200b: 'zero-width space',
  0x200c: 'zero-width non-joiner',
  0x200d: 'zero-width joiner',
  0xfeff: 'byte-order mark',
  0x00ad: 'soft hyphen',
  0x180e: 'mongolian vowel separator',
  0x3164: 'hangul filler',
};

/**
 * Find the first invisible/format unicode character in `command`.
 * Returns null when the command is clean.
 */
export function findInvisibleUnicode(command: string): InvisibleHit | null {
  let i = 0;
  for (const char of command) {
    const cp = char.codePointAt(0) as number;
    const zeroWidthName = ZERO_WIDTH_NAMES[cp];
    if (zeroWidthName !== undefined) {
      return { index: i, char, name: zeroWidthName };
    }
    const bidi = bidiName(cp);
    if (bidi !== null) return { index: i, char, name: bidi };
    // Variation selectors (U+FE00-U+FE0F) and supplements (U+E0100-U+E01EF).
    if ((cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef)) {
      return { index: i, char, name: 'variation selector' };
    }
    i += char.length;
  }
  return null;
}

/**
 * The approval notice for a hit: names the character and its offset so the
 * user knows the displayed command is not the whole story.
 */
export function invisibleUnicodeNotice(hit: InvisibleHit): string {
  const cp = (hit.char.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0');
  return (
    `Invisible unicode in this command: ${hit.name} (U+${cp}) at position ${hit.index}. ` +
    'What you see may not be what runs - inspect the exact bytes before approving.'
  );
}
