/**
 * Small text helpers that kept getting re-implemented per file. One copy
 * each, here; behaviour is byte-identical to the originals they replace.
 */

/** True for plain JSON-ish objects (not null, not an array). */
export function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Shorten a long id for column display: ids longer than 14 chars become
 * the first 12 chars plus an ellipsis.
 */
export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

/**
 * Cut `s` to at most `max` UTF-16 code units WITHOUT splitting a surrogate
 * pair: when the cut would land between a high surrogate and its low half,
 * the cut backs off by one, so the result never carries a lone surrogate
 * (which renders as U+FFFD). Lengths are code units, so a capped string
 * still fits the budget it was capped to - the `[...s].slice(...)` form
 * counts code points instead and can exceed a char budget.
 *
 * This is the one definition of the cut: the same back-off `capSkillBody`
 * and `capText` already used. Every truncation site that slices free text
 * (model output, server text, file content, user input) goes through here.
 */
export function truncateSafe(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max);
  if (end > 0) {
    const last = s.charCodeAt(end - 1);
    const next = s.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
  }
  return s.slice(0, end);
}

/**
 * Keep the LAST `max` UTF-16 code units of `s` - the front-cut twin of
 * {@link truncateSafe}, for tails (`tailLines`). When the cut would split a
 * surrogate pair, the cut moves FORWARD by one (dropping the orphaned low
 * half) instead of back, so the kept tail starts on a whole character.
 */
export function truncateSafeTail(s: string, max: number): string {
  if (s.length <= max) return s;
  let start = s.length - Math.max(0, max);
  const prev = s.charCodeAt(start - 1);
  const first = s.charCodeAt(start);
  if (prev >= 0xd800 && prev <= 0xdbff && first >= 0xdc00 && first <= 0xdfff) start += 1;
  return s.slice(start);
}

/**
 * Clip a string to `max` chars, reserving one slot for the ellipsis.
 * The text is otherwise untouched (no whitespace collapsing).
 */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return truncateSafe(s, Math.max(0, max - 1)) + '…';
}

/**
 * Decode a byte-capped PREFIX of a file (the first `buf.length` bytes) as
 * UTF-8 without splitting a multi-byte sequence at the cut: when the buffer
 * ends mid-character, the incomplete trailing bytes are dropped, so the
 * result never carries a U+FFFD replacement character. The naive
 * `buf.toString('utf8')` inserts U+FFFD for the split sequence.
 */
export function decodeUtf8Prefix(buf: Buffer): string {
  return buf.subarray(0, utf8PrefixLength(buf)).toString('utf8');
}

/** Length of `buf` with any incomplete trailing UTF-8 sequence removed. */
function utf8PrefixLength(buf: Buffer): number {
  let i = buf.length - 1;
  let continuations = 0;
  while (i >= 0 && buf[i] !== undefined && buf[i]! >= 0x80 && buf[i]! < 0xc0) {
    continuations += 1;
    i -= 1;
    if (continuations >= 3) break;
  }
  if (i < 0) return 0; // all continuation bytes: no complete char at all
  const lead = buf[i]!;
  if (lead < 0x80) return buf.length; // ends on ASCII: nothing split
  // Expected sequence length from the lead byte (2/3/4-byte forms).
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
  // Bytes present for this char = continuations + 1 (the lead itself).
  return continuations + 1 < expected ? i : buf.length;
}

/**
 * Decode a byte-capped SUFFIX of a file (the last `buf.length` bytes) as
 * UTF-8 without splitting a multi-byte sequence at the START: when the
 * buffer begins mid-character, the orphaned leading continuation bytes are
 * dropped, so the result never starts with a U+FFFD replacement character.
 * (The tail is the file's own end, so it is always complete.)
 */
export function decodeUtf8Suffix(buf: Buffer): string {
  let start = 0;
  while (
    start < buf.length &&
    buf[start] !== undefined &&
    buf[start]! >= 0x80 &&
    buf[start]! < 0xc0
  ) {
    start += 1;
  }
  return buf.subarray(start).toString('utf8');
}

/**
 * Collapse all whitespace to single spaces, trim, then clip to `max` chars
 * like {@link clip}. For single-line column display of multi-line text.
 */
export function clipOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return truncateSafe(flat, Math.max(0, max - 1)) + '…';
}
