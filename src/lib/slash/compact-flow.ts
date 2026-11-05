/**
 * The TUI `/compact` flow - PHASE-1 1.8, on the 1.6 interact primitive
 * (the /commit pattern): render-agnostic core, IO supplied by the surface.
 *
 * /compact condenses the CURRENT conversation IN PLACE through the existing
 * `POST /api/conversations/:id/summarize` endpoint (uncharged, gated):
 * the server rolls ~80% of the messages (its default ratio) into a summary
 * message and flags the originals `archived: true`. NOTHING IS DELETED -
 * archived flag only, same conversation id, recoverable. The stream's
 * context builder excludes archived messages, so the next turn reads the
 * summary instead of the archived originals and the meter drops after it.
 *
 * The flow is confirm-gated: a preview notice states exactly what happens,
 * and anything but an explicit yes cancels with ZERO server calls. Errors
 * never throw out of the flow (an Ink session must survive) - they land as
 * `notify('error', …)`, state unchanged. TUI-only in v1; the one-shot
 * renderer prints a pointer here.
 */
import { api } from '../api.js';
import { isSpycoreCliError } from '../errors.js';
import { sanitizeForDisplay } from '../sanitize-display.js';

export interface CompactFlowIo {
  /** Session-idiom notice (the Ink session pushes a Notice item). */
  notify(kind: 'info' | 'success' | 'warning' | 'error', text: string): void;
  /** One-line answer to the confirm question (y/N idiom). */
  ask(question: string): Promise<string>;
}

export interface CompactFlowOpts {
  conversationId: string;
  apiUrlOverride?: string | undefined;
  io: CompactFlowIo;
}

export interface CompactFlowResult {
  compacted: boolean;
  archivedCount?: number;
}

interface SummarizeResp {
  summaryMessageId: string;
  summary: string;
  archivedCount: number;
}

/** Cap on the summary snippet echoed after a successful compact. */
const SUMMARY_SNIPPET_CAP = 280;

/** The confirm-gated preview copy - states the rewritten invariant verbatim. */
export const COMPACT_PREVIEW_TEXT =
  'Compact rolls ~80% of this conversation into a summary. Nothing is deleted - the original messages are archived (kept and recoverable) and the conversation continues in place with the same id.';

export async function runCompactFlow(opts: CompactFlowOpts): Promise<CompactFlowResult> {
  const { io } = opts;

  io.notify('info', COMPACT_PREVIEW_TEXT);
  const answer = (await io.ask('Compact this conversation? [y]es / [n]o: '))
    .trim()
    .toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    io.notify('info', 'Compact cancelled - nothing changed.');
    return { compacted: false };
  }

  let resp: SummarizeResp;
  try {
    // Empty body → the server's default ratio (0.8). The endpoint is
    // uncharged; consuming it adds no charge.
    resp = await api.post<SummarizeResp>(
      `/conversations/${opts.conversationId}/summarize`,
      { apiUrlOverride: opts.apiUrlOverride, body: {} },
    );
  } catch (err) {
    // 400 "too short" / 403 / 429 rate-limit / 5xx / network - the api layer
    // already maps each to a clean, scrubbed error; state is unchanged.
    const message = isSpycoreCliError(err)
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
    io.notify('error', `Compact failed: ${message}`);
    return { compacted: false };
  }

  const snippet = sanitizeForDisplay(resp.summary ?? '').trim();
  const capped =
    snippet.length > SUMMARY_SNIPPET_CAP ? `${snippet.slice(0, SUMMARY_SNIPPET_CAP)}…` : snippet;
  io.notify(
    'success',
    `Compacted - ${resp.archivedCount} message${resp.archivedCount === 1 ? '' : 's'} archived (recoverable); the conversation continues in place.${capped ? `\nSummary: ${capped}` : ''}`,
  );
  return { compacted: true, archivedCount: resp.archivedCount };
}
