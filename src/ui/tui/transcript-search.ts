/**
 * Transcript search (Ctrl+F): pure helpers behind the search bar.
 *
 * The search walks the committed transcript items and matches a
 * case-insensitive substring against each item's searchable text. All
 * matching/highlight math lives here so it is unit-testable; `TuiApp.tsx`
 * owns the open/query/navigate state and the rendering.
 *
 * NOTE on <Static>: Ink flushes static items to the terminal once and never
 * re-renders them, so inline highlights only appear on items rendered while
 * the search is open. The search bar's live hit count + current-match
 * excerpt is the navigation feedback that works regardless.
 */

/** The fields of a transcript item that searching needs. Structural, not the full item type. */
export interface SearchableItem {
  id: number;
  kind: string;
  [key: string]: unknown;
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The text a transcript item contributes to search: the prose for text
 * kinds, tool name + arg + summary for tool calls, command + tail for shell
 * output, file paths + hunk text for diffs. Unknown kinds and non-string
 * fields contribute nothing (never throw on a shape we don't know).
 */
export function itemSearchText(item: SearchableItem): string {
  switch (item.kind) {
    case 'assistant':
    case 'notice':
    case 'summary':
      return asText(item.text);
    case 'task':
      return [asText(item.task), asText(item.routingLine)].filter(Boolean).join(' ');
    case 'tool':
      return [asText(item.tool), asText(item.arg), asText(item.summary)].filter(Boolean).join(' ');
    case 'command': {
      const info = (item.info ?? {}) as { tail?: unknown; statusLabel?: unknown };
      return [asText(item.command), asText(info.tail), asText(info.statusLabel)]
        .filter(Boolean)
        .join('\n');
    }
    case 'diff': {
      const files = Array.isArray(item.files) ? item.files : [];
      const parts: string[] = [];
      for (const f of files) {
        const file = f as { path?: unknown; hunks?: Array<{ text?: unknown }> };
        parts.push(asText(file.path));
        for (const h of file.hunks ?? []) parts.push(asText(h.text));
      }
      return parts.filter(Boolean).join('\n');
    }
    case 'skills': {
      const skills = Array.isArray(item.skills) ? item.skills : [];
      return skills.map(asText).filter(Boolean).join(', ');
    }
    case 'peek':
      return [asText(item.label), asText(item.full)].filter(Boolean).join('\n');
    case 'welcome':
      return asText(item.tip);
    default:
      return '';
  }
}

/**
 * Ids of the items whose searchable text contains the query
 * (case-insensitive substring), in transcript order. A blank query matches
 * nothing - the bar then reads as a prompt, not as "everything matches".
 */
export function findTranscriptHits(items: readonly SearchableItem[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const hits: number[] = [];
  for (const item of items) {
    if (itemSearchText(item).toLowerCase().includes(q)) hits.push(item.id);
  }
  return hits;
}

/** One run of plain text or one matched run, for inline highlighting. */
export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split `text` around every non-overlapping case-insensitive occurrence of
 * `query`, preserving the original casing. A blank query (or no match) is
 * one plain segment - the caller's highlight is then a no-op.
 */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0 || text.length === 0) return [{ text, match: false }];
  const segs: HighlightSegment[] = [];
  const lower = text.toLowerCase();
  let at = 0;
  let found = lower.indexOf(q);
  if (found === -1) return [{ text, match: false }];
  while (found !== -1) {
    if (found > at) segs.push({ text: text.slice(at, found), match: false });
    segs.push({ text: text.slice(found, found + q.length), match: true });
    at = found + q.length;
    found = lower.indexOf(q, at);
  }
  if (at < text.length) segs.push({ text: text.slice(at), match: false });
  return segs;
}

/**
 * Clamp a hit index after the hit list changed (query edited, new items
 * arrived): stays on the same hit when it still exists, else the nearest
 * valid one, else -1 (no hits).
 */
export function clampHitIndex(index: number, hits: number[]): number {
  if (hits.length === 0) return -1;
  if (index < 0) return 0;
  return Math.min(index, hits.length - 1);
}

/**
 * Excerpt of `text` around the first case-insensitive occurrence of `query`,
 * for the search bar's "current match" line. Returns null when there is no
 * match. The `match` slice preserves the original casing for display.
 */
export function matchExcerpt(
  text: string,
  query: string,
  radius = 48,
): { before: string; match: string; after: string } | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0 || text.length === 0) return null;
  const at = text.toLowerCase().indexOf(q);
  if (at === -1) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + q.length + radius);
  return {
    before: `${start > 0 ? '…' : ''}${text.slice(start, at)}`,
    match: text.slice(at, at + q.length),
    after: `${text.slice(at + q.length, end)}${end < text.length ? '…' : ''}`,
  };
}

/**
 * The render-time view of an active search, threaded into the transcript
 * item views so hits can be highlighted. `currentId` is the hit the
 * Enter/Shift+Enter navigation is sitting on (null when there are no hits).
 */
export interface TranscriptSearchRender {
  query: string;
  hitIds: ReadonlySet<number>;
  currentId: number | null;
}
