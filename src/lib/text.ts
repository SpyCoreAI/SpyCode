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
 * Collapse all whitespace to single spaces, trim, then clip to `max` chars
 * like {@link clip}. For single-line column display of multi-line text.
 */
export function clipOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return truncateSafe(flat, Math.max(0, max - 1)) + '…';
}
