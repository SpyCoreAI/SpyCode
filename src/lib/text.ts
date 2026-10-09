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
 * Clip a string to `max` chars, reserving one slot for the ellipsis.
 * The text is otherwise untouched (no whitespace collapsing).
 */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Collapse all whitespace to single spaces, trim, then clip to `max` chars
 * like {@link clip}. For single-line column display of multi-line text.
 */
export function clipOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)) + '…';
}
