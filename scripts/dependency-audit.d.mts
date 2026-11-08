/**
 * Types for the plain `.mjs` instrument (see dependency-audit.mjs).
 * A `.d.mts` — not `.d.ts` — because the implementation is `.mjs`: TS only
 * pairs a `.d.mts` declaration with a `.mjs` module. Without this file a
 * literal import of the script fails `tsc` with TS7016.
 */
export function evaluateAuditReport(data: unknown): {
  scanned: number;
  waived: number;
  blocked: 0;
};
