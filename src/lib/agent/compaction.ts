/**
 * H-9 - two-stage compaction. Upgrades the auto-compact path (`context_full`
 * → /compact): instead of sending the whole transcript to the model at once,
 *
 *   STAGE 1 (pure, no LLM): deterministically prune the transcript - old
 *   tool/command outputs collapse to one-line stubs (tool name + status),
 *   old notices drop, long assistant messages cap. Instant and free.
 *
 *   STAGE 2 (cheap model): the pruned transcript is summarized in a single
 *   no-tools turn with the pinned auxiliary model (see auxiliary-routing.ts
 *   'compaction-summary'), and the transcript is replaced by the summary,
 *   in place.
 *
 * Stage 1 is pure and pinned by tests; stage 2's model call lives in the
 * TUI's runCompact (it owns the provider + transcript state).
 */

/**
 * Minimal structural shape stage 1 needs. TuiApp's transcript items satisfy
 * it structurally (same fields as ui/tui/compact.ts's SummarizableItem) -
 * defined here so lib/ never imports from ui/.
 */
export interface PrunableItem {
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
  final?: boolean;
}

/** Recent tool/command items kept whole; older ones collapse to stubs. */
export const COMPACT_KEEP_RECENT_TOOLS = 8;
/** Cap for a non-final assistant message surviving stage 1. */
export const COMPACT_ASSISTANT_CAP = 800;
/** Recent notices kept; older ones are dropped in stage 1. */
export const COMPACT_KEEP_RECENT_NOTICES = 3;

export interface PruneResult {
  items: PrunableItem[];
  /** How many items were pruned or dropped. */
  pruned: number;
}

/**
 * Stage 1: deterministically shrink a transcript without any model call.
 * - tool/command items older than the most recent K collapse to
 *   `name + summary` stubs (the full output tail is what costs);
 * - non-final assistant messages cap at COMPACT_ASSISTANT_CAP chars;
 * - notices older than the most recent few are dropped;
 * - task/diff/summary/skills items pass through untouched.
 * Pure - pinned by tests.
 */
export function pruneTranscriptItems(
  items: readonly PrunableItem[],
  opts: { keepRecentTools?: number; keepRecentNotices?: number } = {},
): PruneResult {
  const keepTools = opts.keepRecentTools ?? COMPACT_KEEP_RECENT_TOOLS;
  const keepNotices = opts.keepRecentNotices ?? COMPACT_KEEP_RECENT_NOTICES;
  // Indices of tool/command items, newest-first, to find the keep window.
  const toolIdx: number[] = [];
  const noticeIdx: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const k = items[i]?.kind;
    if (k === 'tool' || k === 'command') toolIdx.push(i);
    else if (k === 'notice') noticeIdx.push(i);
  }
  const keepToolSet = new Set(toolIdx.slice(-keepTools));
  const keepNoticeSet = new Set(noticeIdx.slice(-keepNotices));
  const out: PrunableItem[] = [];
  let pruned = 0;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i] as PrunableItem;
    if (it.kind === 'tool' || it.kind === 'command') {
      if (keepToolSet.has(i)) {
        out.push(it);
        continue;
      }
      // Collapse to a stub: the tool/command name + its one-line status.
      // The stub keeps the SAME kind so the serializer still counts it.
      pruned += 1;
      if (it.kind === 'tool') {
        out.push({ kind: 'tool', tool: it.tool, summary: it.summary });
      } else {
        out.push({
          kind: 'command',
          command: it.command,
          info: { statusLabel: it.info?.statusLabel },
        });
      }
      continue;
    }
    if (it.kind === 'notice') {
      if (keepNoticeSet.has(i)) out.push(it);
      else pruned += 1;
      continue;
    }
    if (it.kind === 'assistant' && !it.final && typeof it.text === 'string' && it.text.length > COMPACT_ASSISTANT_CAP) {
      pruned += 1;
      out.push({ ...it, text: `${it.text.slice(0, COMPACT_ASSISTANT_CAP)}… [pruned]` });
      continue;
    }
    out.push(it);
  }
  return { items: out, pruned };
}
