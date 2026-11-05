/**
 * Minimal type declarations for `node:sqlite` (built into Node 22.5+; the
 * repo pins @types/node 20, which predates it). Only the surface
 * session-search.ts uses is declared - enough for typecheck, nothing more.
 * Verified against the real Node 24 runtime (not better-sqlite3's API).
 */
declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path?: string | undefined, options?: { open?: boolean; readOnly?: boolean } | undefined);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
