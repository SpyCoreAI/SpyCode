/**
 * Shared constants for the chat SSE event vocabulary.
 *
 * The SpyCore backend's auto-routing notification arrives on the wire under an
 * internal `type` that the CLI must match verbatim to parse it. That internal
 * name is NEVER surfaced: every consumer maps it to the neutral, public-facing
 * `routed` event (and the "Routed to …" display label). Keeping the literal in
 * ONE place — instead of as a bare magic string at each parse site — makes that
 * mapping explicit and keeps the public name the only thing a reader of the
 * `--json` output, the `schema` dump, or the UI ever sees.
 */

/** Wire `type` for the backend's auto-routing notification. Matched, never printed. */
export const ROUTED_EVENT_WIRE = 'auto_routed';

/** Public, neutral name the CLI emits/surfaces for a routing decision. */
export const ROUTED_EVENT_PUBLIC = 'routed';
