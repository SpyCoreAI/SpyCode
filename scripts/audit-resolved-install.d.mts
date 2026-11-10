/**
 * Types for the plain `.mjs` instrument (see audit-resolved-install.mjs).
 * A `.d.mts` — not `.d.ts` — because the implementation is `.mjs`: TS only
 * pairs a `.d.mts` declaration with a `.mjs` module. Without this file a
 * literal import of the script fails `tsc` with TS7016.
 */
export function verdictFrom(payload: unknown): {
  ok: boolean;
  reason: string | null;
  findings: Array<{ name: string; severity: string; titles: string[] }>;
};

export function publishedManifest(cliPkg: {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}): {
  name: string;
  version: string;
  private: true;
  dependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
};
