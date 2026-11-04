/**
 * Shared constants for the chat SSE event vocabulary.
 *
 * The routing notification arrives with a `type` value that the CLI must match
 * verbatim to parse it. Every consumer maps it to the `routed` event (and the
 * "Routed to …" display label). Keeping the literal in ONE place - instead of
 * as a bare magic string at each parse site - makes that mapping explicit and
 * keeps the display label the only thing a reader of the `--json` output, the
 * `schema` dump, or the UI ever sees.
 */

/** `type` value for the routing notification. Matched, never printed. */
export const ROUTED_EVENT_TYPE = 'auto_routed';

/** Public, neutral name the CLI emits/surfaces for a routing decision. */
export const ROUTED_EVENT_PUBLIC = 'routed';
