/**
 * The single assembly-time wire clamp - PHASE-1 1.8, closing the 1.2 latent
 * finding: the context-injection READ budget (~80K chars) could exceed the
 * server's hard 32,000-char `message` cap on its own, so an oversized
 * injection block HARD-BRICKED every chat send in that workspace and could
 * 400 an agent run at start.
 *
 * ONE invariant, enforced here for BOTH the chat and agent assembly paths:
 * the assembled wire message NEVER exceeds the cap, and nothing is EVER
 * silently dropped - every cut leaves an explicit in-band marker and the
 * caller surfaces a one-line warning naming the trimmed part.
 *
 * Trim priority (what gets cut FIRST when over budget):
 *   injection (project context, from its tail) → attachment blocks → user
 *   content (last resort only, so a send is never bricked).
 * Parts marked 'fixed' (the agent's core system prompt) are only touched by
 * the mathematical last-resort tail cut, which is unreachable in practice.
 *
 * DEFAULT_CONTEXT_BUDGET_CHARS stays the READ budget for what is loaded from
 * disk; this clamp fits the assembled result to the WIRE.
 */
import { WIRE_MESSAGE_MAX_CHARS } from './attachments.js';

/** How a part may be cut when the assembly is over budget. */
export type WirePartKind = 'fixed' | 'user' | 'attachments' | 'injection';

export interface WirePart {
  /** Leading joiner/header (e.g. `\n\n[Attached files]\n`). Never trimmed. */
  pre?: string;
  /** The part's content - the only text the clamp may cut. */
  body: string;
  /** Trailing joiner. Never trimmed. */
  post?: string;
  kind: WirePartKind;
  /** Names the part in markers + the warning (e.g. 'project context'). */
  label: string;
}

export interface ClampedWire {
  /** Finalized text per input part, in order; `wire` is their concatenation. */
  texts: string[];
  /** The assembled wire message - GUARANTEED ≤ maxChars. */
  wire: string;
  /** True when anything was cut. */
  clamped: boolean;
  /** One-line warning naming the trimmed part(s); null when nothing was cut. */
  warning: string | null;
}

function truncMarker(label: string): string {
  return `\n[${label} truncated to fit the message limit]`;
}
function omitMarker(label: string): string {
  return `[${label} omitted to fit the message limit]`;
}

/** Trim order: lowest-priority kinds first; within a kind, later parts first. */
const TRIM_ORDER: readonly WirePartKind[] = ['injection', 'attachments', 'user'];

/**
 * Fit the ordered parts into `maxChars`. Returns the finalized per-part texts
 * (so callers that split the wire across fields - the agent's system/message
 * seam - can reassemble exactly) plus the joined wire.
 */
export function clampWireAssembly(
  parts: WirePart[],
  maxChars: number = WIRE_MESSAGE_MAX_CHARS,
): ClampedWire {
  const texts = parts.map((p) => `${p.pre ?? ''}${p.body}${p.post ?? ''}`);
  let total = texts.reduce((n, t) => n + t.length, 0);
  if (total <= maxChars) {
    return { texts, wire: texts.join(''), clamped: false, warning: null };
  }

  const trimmed: string[] = [];
  for (const kind of TRIM_ORDER) {
    if (total <= maxChars) break;
    for (let i = parts.length - 1; i >= 0 && total > maxChars; i -= 1) {
      const p = parts[i]!;
      if (p.kind !== kind || p.body.length === 0) continue;
      const pre = p.pre ?? '';
      const post = p.post ?? '';
      const need = total - maxChars;
      const tMarker = truncMarker(p.label);
      // Keeping `keep` chars of body costs pre+keep+marker+post.
      const keep = p.body.length - need - tMarker.length;
      if (keep > 0) {
        const next = `${pre}${p.body.slice(0, keep)}${tMarker}${post}`;
        total -= texts[i]!.length - next.length;
        texts[i] = next;
      } else {
        // Not enough room for a useful stub - replace the body with an
        // explicit omission marker (the joiners keep the wire well-formed).
        // A body already smaller than its marker can't save anything: skip.
        const next = `${pre}${omitMarker(p.label)}${post}`;
        if (next.length >= texts[i]!.length) continue;
        total -= texts[i]!.length - next.length;
        texts[i] = next;
      }
      trimmed.push(p.label);
    }
  }

  // Mathematical last resort (fixed parts alone above the cap - unreachable
  // in practice): tail-cut the final texts so the invariant NEVER breaks.
  if (total > maxChars) {
    for (let i = parts.length - 1; i >= 0 && total > maxChars; i -= 1) {
      const over = total - maxChars;
      const t = texts[i]!;
      const p = parts[i]!;
      const marker = truncMarker(p.label);
      const keep = t.length - over - marker.length;
      const next = keep > 0 ? `${t.slice(0, keep)}${marker}` : '';
      total -= t.length - next.length;
      texts[i] = next;
      if (next !== t) trimmed.push(p.label);
    }
  }

  const labels = [...new Set(trimmed)];
  const warning =
    labels.length > 0
      ? `Trimmed to fit the ${maxChars.toLocaleString('en-US')}-character message limit: ${labels.join(', ')}. Nothing was dropped silently - each cut is marked in the message.`
      : null;
  return { texts, wire: texts.join(''), clamped: labels.length > 0, warning };
}
