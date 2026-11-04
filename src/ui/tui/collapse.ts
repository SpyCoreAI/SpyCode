/**
 * Collapse budgets - the transcript never floods.
 *
 * Hard rule: collapsing NEVER hides safety-critical facts (which files were
 * touched, which command ran). These helpers only trim VOLUME (long output
 * tails, pasted blobs); the one-line summary rows always keep their names.
 */

/** Split capped output into shown lines + a hidden count. Pure. */
export function collapseLines(
  lines: string[],
  maxLines: number,
): { shown: string[]; hidden: number } {
  if (lines.length <= maxLines) return { shown: lines, hidden: 0 };
  return { shown: lines.slice(0, maxLines), hidden: lines.length - maxLines };
}

/**
 * The transcript echo for a submitted task. Short tasks echo verbatim; long
 * ones (a paste) echo as one clamped line + an explicit remainder count. The
 * FULL text is still sent to the agent - only the echo is collapsed.
 */
export function echoForTranscript(
  text: string,
  maxLines = 3,
  maxChars = 150,
): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines && text.length <= maxChars) return text;
  const first = lines[0]!.trim();
  const head = first.length > maxChars ? `${first.slice(0, maxChars - 1)}…` : first;
  const extra = lines.length - 1;
  return `${head}  [+${extra} more line${extra === 1 ? '' : 's'} - full text sent]`;
}

/**
 * Cap shell (`!`) output before it reaches the transcript: head-truncated at
 * maxLines with an explicit omission marker. A runaway `cat` cannot blow up
 * the UI.
 */
export function capShellOutput(
  output: string,
  maxLines = 100,
  maxChars = 20_000,
): { text: string; truncated: boolean } {
  let text = output;
  let truncated = false;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  const lines = text.split('\n');
  if (lines.length > maxLines) {
    return {
      text: [...lines.slice(0, maxLines), `… ${lines.length - maxLines} more lines omitted`].join('\n'),
      truncated: true,
    };
  }
  return { text, truncated };
}

/** The trailing marker for a collapsed tool-output block. States the omission
 * plainly; v1 shows capped tails inline (no interactive expander yet). */
export function hiddenMarker(hidden: number): string {
  return `… +${hidden} more line${hidden === 1 ? '' : 's'}`;
}
