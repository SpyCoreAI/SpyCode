/**
 * `/compact`: real summarization (summary-based).
 *
 * The visible transcript is serialized to plain text, sent to the model in a
 * single no-tools turn, and the transcript is replaced by the summary. Each
 * agent task in the TUI runs as an independent `runAgent` call, so this is
 * the transcript-level context compression the proposal asks for.
 */

/** Minimal structural shape the serializer needs (TuiApp's items satisfy it). */
export interface SummarizableItem {
  kind: string;
  task?: string;
  fullTask?: string;
  text?: string;
  tool?: string;
  arg?: string;
  summary?: string;
  command?: string;
  info?: { statusLabel?: string };
  total?: number;
  label?: string;
  full?: string;
}

/** Cap per-item text so one giant reply can't dominate the summary input. */
const MAX_ITEM_CHARS = 2000;
/** Cap the whole serialized transcript (~30k chars keeps the summary call sane). */
export const MAX_SERIAL_CHARS = 30_000;

function cap(s: string | undefined, max = MAX_ITEM_CHARS): string {
  if (!s) return '';
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * Serialize transcript items to plain text for the summarizer. Pure and
 * total - the model call itself lives in TuiApp.
 */
export function serializeTranscriptForSummary(items: readonly SummarizableItem[]): { text: string; count: number } {
  const lines: string[] = [];
  let count = 0;
  for (const it of items) {
    let line = '';
    switch (it.kind) {
      case 'task':
        line = `Task: ${cap(it.fullTask ?? it.task)}`;
        break;
      case 'assistant':
        line = `Assistant: ${cap(it.text)}`;
        break;
      case 'tool':
        line = `Tool ${it.tool ?? ''}${it.arg ? ` ${it.arg}` : ''}: ${cap(it.summary, 300)}`;
        break;
      case 'command':
        line = `$ ${cap(it.command, 300)} -> ${cap(it.info?.statusLabel, 120)}`;
        break;
      case 'notice':
        line = `Note: ${cap(it.text, 300)}`;
        break;
      case 'diff':
        line = `Diff: ${it.total ?? 0} file(s) changed`;
        break;
      case 'summary':
        line = `Earlier summary: ${cap(it.text)}`;
        break;
      default:
        continue; // welcome/help/peek/skills carry no summarizable content
    }
    if (line.trim().length === 0) continue;
    lines.push(line);
    count++;
    if (lines.join('\n').length > MAX_SERIAL_CHARS) break;
  }
  return { text: lines.join('\n'), count };
}

/** The summarizer prompt: dense, structured, no preamble. */
export function buildSummaryPrompt(transcript: string): string {
  return (
    'Summarize this coding-agent session transcript for context compaction. ' +
    'Write a dense, structured summary covering: (1) the user\'s goals and tasks, ' +
    '(2) key decisions and approaches taken, (3) files created or modified and why, ' +
    '(4) current state and any unresolved items. Be specific - keep file paths and ' +
    'important names. No preamble, no fluff.\n\n' +
    '--- transcript ---\n' +
    transcript
  );
}

export const SUMMARY_SYSTEM_PROMPT =
  'You are a precise technical summarizer. Output only the summary, plainly structured.';
