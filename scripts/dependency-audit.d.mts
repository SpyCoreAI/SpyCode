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

/** Bound on the `pnpm audit` spawn (R4-5) - matches the sibling instrument's 300 s. */
export const AUDIT_TIMEOUT_MS: number;

export interface PnpmResolveOverrides {
  platform?: NodeJS.Platform;
  /** PATH value to search (win32 only). Defaults to `process.env.PATH`. */
  pathEnv?: string;
  /** PATHEXT value (win32 only). Defaults to `process.env.PATHEXT`. */
  pathext?: string;
}

export function resolvePnpmCommand(overrides?: PnpmResolveOverrides): string | null;

export function buildCmdCommandLine(tokens: string[]): string;

export interface PnpmSpawnTarget {
  file: string;
  argv: string[];
  windowsVerbatimArguments: boolean;
}

export function buildPnpmSpawn(
  pnpm: string,
  args: string[],
  platform?: NodeJS.Platform,
): PnpmSpawnTarget;
