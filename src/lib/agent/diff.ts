/**
 * Unified-diff computation for the agent's approval gate.
 *
 * Uses the `diff` package's `structuredPatch` (3 lines of context) so a small
 * edit in a large file shows only the changed hunks, not the whole file. The
 * `diff` package is imported lazily so it never enters the CLI hot path — only
 * a mutating tool ever calls this.
 */

export type DiffLineKind = 'add' | 'del' | 'context' | 'hunk';

export interface DiffLine {
  kind: DiffLineKind;
  /** The line text WITHOUT the leading +/-/space marker. */
  text: string;
}

export interface FileDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** True when more than `maxLines` diff lines exist and were capped. */
  truncated: boolean;
  /** How many diff lines were hidden by the cap. */
  hiddenLines: number;
}

const DEFAULT_MAX_LINES = 200;

/** Compute a capped unified-diff view between old and new text. */
export async function computeFileDiff(
  oldText: string,
  newText: string,
  opts: { maxLines?: number } = {},
): Promise<FileDiff> {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_LINES;
  const { structuredPatch } = await import('diff');
  const patch = structuredPatch('a', 'b', oldText, newText, '', '', { context: 3 });

  let added = 0;
  let removed = 0;
  const all: DiffLine[] = [];
  for (const hunk of patch.hunks) {
    all.push({
      kind: 'hunk',
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });
    for (const raw of hunk.lines) {
      const marker = raw.charAt(0);
      const text = raw.slice(1);
      if (marker === '+') {
        added += 1;
        all.push({ kind: 'add', text });
      } else if (marker === '-') {
        removed += 1;
        all.push({ kind: 'del', text });
      } else if (marker === '\\') {
        // "\ No newline at end of file" — informational, skip.
      } else {
        all.push({ kind: 'context', text });
      }
    }
  }

  const truncated = all.length > maxLines;
  return {
    lines: truncated ? all.slice(0, maxLines) : all,
    added,
    removed,
    truncated,
    hiddenLines: truncated ? all.length - maxLines : 0,
  };
}
