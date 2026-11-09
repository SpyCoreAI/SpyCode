/**
 * Types for the plain `.mjs` instrument (see gen-third-party-licenses.mjs).
 * A `.d.mts` — not `.d.ts` — because the implementation is `.mjs`: TS only
 * pairs a `.d.mts` declaration with a `.mjs` module. Without this file a
 * literal import of the script fails `tsc` with TS7016.
 *
 * R4-2 (phase 5 pass 4): the generator used to run its whole body at module
 * scope, so importing it rewrote THIRD-PARTY-LICENSES. The CLI body now runs
 * only behind isMain(); these pure helpers are exported so they can be
 * unit-tested without executing the generator.
 */

export function spdx(pkg: {
  license?: string | { type?: string };
  licenses?: Array<string | { type?: string }>;
}): string;

export function isDisjunctive(license: string): boolean;

export function findLicenseTexts(dir: string): Array<{ file: string; text: string }>;

export function resolveDepDir(fromDir: string, dep: string): string | null;

export function homepageOf(pkg: {
  homepage?: string;
  repository?: string | { url?: string };
}): string;
