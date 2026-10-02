/**
 * The ONE place the server's wire cap lives, plus the truncation primitives
 * that must respect it. A zero-import leaf on purpose: `tools.ts` needs the
 * cap but must NOT pull in `attachments.ts` (which statically imports undici
 * via `upload.ts` — the web tools deliberately lazy-load that).
 *
 * FIX BATCH 2 / B2: the agent's per-tool-result cap and this cap used to be
 * independent numbers (32 * 1024 vs 32_000) that silently disagreed, and the
 * marker `capContent` appends pushed a capped result to 32,799 chars — over
 * the server's `z.string().max(32000)` on BOTH `message` and
 * `toolResults[].content`. Every budget in the CLI is now DERIVED from
 * WIRE_MESSAGE_MAX_CHARS so the two can never drift apart again.
 *
 * The unit is CHARS — `String.length` (UTF-16 code units) — because that is
 * what Zod's `.string().max()` measures on the server. Fastify's ajv
 * `maxLength` counts code points, which is always ≤ `.length`, so honoring
 * `.length` satisfies both validators.
 */

/**
 * The server's hard cap on the stream `message` field AND on each
 * `toolResults[].content` (server/src/routes/chat/stream.ts — `z.string()
 * .max(32000)` plus the Fastify schema's `maxLength: 32000`). This is a
 * CONTRACT: align to it, never widen it.
 */
export const WIRE_MESSAGE_MAX_CHARS = 32_000;

/** The marker `capContent` appends when it cuts a tool result. */
export function resultTruncMarker(maxChars: number): string {
  return `\n\n[result truncated to ${maxChars} characters]`;
}

/**
 * Upper bound on `resultTruncMarker(n).length` for every n ≤
 * WIRE_MESSAGE_MAX_CHARS: 32,000 has 5 decimal digits, and no smaller n has
 * more, so the widest marker is the one for the cap itself.
 */
export const RESULT_TRUNC_MARKER_MAX_CHARS = resultTruncMarker(WIRE_MESSAGE_MAX_CHARS).length;

/**
 * Hard ceiling: the returned string is GUARANTEED ≤ `maxChars`, marker
 * included (unlike `capContent`, whose `maxChars` budgets the body and lets
 * the marker ride on top). Byte-identical pass-through when already within
 * budget. Used as defense-in-depth on the wire itself, where an over-cap
 * string is a 400 rather than a truncation.
 */
export function clampToWireMax(text: string, maxChars: number = WIRE_MESSAGE_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const marker = resultTruncMarker(maxChars);
  const keep = maxChars - marker.length;
  if (keep <= 0) return text.slice(0, maxChars);
  return `${text.slice(0, keep)}${marker}`;
}
