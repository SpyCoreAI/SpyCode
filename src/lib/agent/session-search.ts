/**
 * H-8 - FTS5 session search (`session_search`): cheap cross-session recall
 * without embeddings; complements the H-7 durable memory.
 *
 * The index lives in the CLI config dir (`session-index.db`, built on
 * `node:sqlite` - no new dependency, FTS5 included). It indexes the local
 * detached-run records (`spycore runs`): each run's task + its log-file
 * transcript, chunked, in an FTS5 table ranked by BM25.
 *
 * Indexing is explicit and cheap: `indexRun` upserts one run (called when a
 * detached run is recorded), `indexAllRuns` re-syncs from the runs dir.
 * `searchSessions` answers MATCH queries with one snippet per run.
 *
 * This module self-registers the read-only `session_search` agent tool on
 * import (H-6). Like everything else that touches the model, the query is a
 * parameterised FTS5 MATCH - user text is never interpolated into SQL.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { getConfigPath } from '../config.js';
import { sanitizeForDisplay } from '../sanitize-display.js';
import { optInt, registerTool, reqString, type ToolContext } from './tool-core.js';

/**
 * `node:sqlite` is loaded through `createRequire`, not a static import:
 * the bundler rewrites a static `node:sqlite` specifier to `sqlite`
 * (unresolvable - only the `node:`-prefixed core module exists), while a
 * require() call passes through untouched. The `typeof import(...)` is
 * type-only and erased at build; runtime types come from
 * `src/types/node-sqlite.d.ts`.
 */
const sqliteModule = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const { DatabaseSync } = sqliteModule;
/** The instance type (the const above is value-only after the require). */
type DatabaseSyncInstance = InstanceType<typeof sqliteModule.DatabaseSync>;

/** File name of the session index inside the CLI config dir. */
export const SESSION_INDEX_FILENAME = 'session-index.db';

/**
 * Run `fn` inside a transaction. node:sqlite has no createTransaction
 * (that is better-sqlite3's API) - BEGIN/COMMIT it explicitly.
 */
function transact(db: DatabaseSyncInstance, fn: () => void): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* the original error is what matters */
    }
    throw err;
  }
}
/** Transcript chunk size for the FTS5 table (chars). */
export const SESSION_CHUNK_CHARS = 2000;
/** Cap on transcript bytes indexed per run - a runaway log cannot bloat the index. */
export const SESSION_INDEX_MAX_BYTES = 500_000;
/** Default result cap for one search. */
export const SESSION_SEARCH_DEFAULT_LIMIT = 10;
/** Hard result cap for one search. */
export const SESSION_SEARCH_MAX_LIMIT = 25;

/** Path of the session index (created on first open, never on mere import). */
export function sessionIndexPath(configDir?: string): string {
  const base = configDir ?? dirname(getConfigPath());
  return join(base, SESSION_INDEX_FILENAME);
}

/** One indexed run. */
export interface IndexedRun {
  id: string;
  task: string;
  cwd: string;
  status: string;
  startedAt: string;
  logFile: string;
}

export interface SessionSearchHit {
  runId: string;
  task: string;
  cwd: string;
  status: string;
  startedAt: string;
  /** One FTS5 snippet (matched text highlighted with << >>). */
  snippet: string;
}

let db: DatabaseSyncInstance | null = null;
let dbPath: string | null = null;

/** Open (creating) the index at `path`; idempotent per path. Test hook: pass `path`. */
export function openSessionIndex(path?: string): DatabaseSyncInstance {
  const p = path ?? sessionIndexPath();
  if (db && dbPath === p) return db;
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;
    dbPath = null;
  }
  mkdirSync(dirname(p), { recursive: true });
  db = new DatabaseSync(p);
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL DEFAULT '',
      cwd TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT ''
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS session_text USING fts5(
      run_id UNINDEXED,
      text,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  dbPath = p;
  return db;
}

/** Test hook: close + forget the cached handle (the next open re-reads the path). */
export function __closeSessionIndexForTests(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  db = null;
  dbPath = null;
}

/** Split text into ~SESSION_CHUNK_CHARS chunks on line boundaries. */
export function chunkText(text: string, chunkChars = SESSION_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > chunkChars && current.length > 0) {
      chunks.push(current);
      current = '';
    }
    current += (current.length > 0 ? '\n' : '') + line;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Quote free text into a safe FTS5 MATCH expression: one double-quoted
 * phrase per whitespace-separated token, joined with AND semantics by
 * listing them (FTS5 treats space as AND). Embedded quotes are doubled.
 * Never interpolates raw syntax - a hostile query cannot break out.
 */
export function toFts5Query(query: string): string {
  const tokens = query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return '""';
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/**
 * Index (or re-index) one run: upsert the record row, replace its text
 * chunks. The transcript is read from `logFile` when it exists (bounded);
 * the task text is always indexed. Never throws - indexing is best-effort.
 */
export function indexRun(run: IndexedRun, path?: string): { chunks: number } {
  const handle = openSessionIndex(path);
  let transcript = '';
  try {
    if (run.logFile && existsSync(run.logFile)) {
      const buf = readFileSync(run.logFile);
      transcript = buf.includes(0)
        ? ''
        : buf.toString('utf8').slice(0, SESSION_INDEX_MAX_BYTES);
    }
  } catch {
    transcript = '';
  }
  const chunks = chunkText(`${run.task}\n${transcript}`.trim());
  const upsert = handle.prepare(
    'INSERT INTO runs (id, task, cwd, status, started_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET task=excluded.task, cwd=excluded.cwd, status=excluded.status, started_at=excluded.started_at',
  );
  const del = handle.prepare('DELETE FROM session_text WHERE run_id = ?');
  const ins = handle.prepare('INSERT INTO session_text (run_id, text) VALUES (?, ?)');
  const txn = () =>
    transact(handle, () => {
      upsert.run(run.id, run.task, run.cwd, run.status, run.startedAt);
      del.run(run.id);
      for (const c of chunks) ins.run(run.id, c);
    });
  txn();
  return { chunks: chunks.length };
}

/** Remove one run from the index (record + chunks). */
export function unindexRun(runId: string, path?: string): void {
  const handle = openSessionIndex(path);
  transact(handle, () => {
    handle.prepare('DELETE FROM session_text WHERE run_id = ?').run(runId);
    handle.prepare('DELETE FROM runs WHERE id = ?').run(runId);
  });
}

/** How many runs are indexed. */
export function indexedRunCount(path?: string): number {
  const handle = openSessionIndex(path);
  const row = handle.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number };
  return row.n;
}

/**
 * Full-text search across indexed sessions. Returns at most `limit` hits,
 * one snippet per run, BM25-ranked. Empty query ⇒ no hits.
 */
export function searchSessions(
  query: string,
  opts: { limit?: number; path?: string } = {},
): SessionSearchHit[] {
  const q = query.trim();
  if (q.length === 0) return [];
  const limit = Math.max(1, Math.min(SESSION_SEARCH_MAX_LIMIT, opts.limit ?? SESSION_SEARCH_DEFAULT_LIMIT));
  const handle = openSessionIndex(opts.path);
  const stmt = handle.prepare(`
    SELECT r.id AS runId, r.task AS task, r.cwd AS cwd, r.status AS status,
           r.started_at AS startedAt,
           snippet(session_text, 1, '<<', '>>', '…', 24) AS snippet
    FROM session_text
    JOIN runs r ON r.id = session_text.run_id
    WHERE session_text MATCH ?
    ORDER BY rank
    LIMIT ?
  `);
  const rows = stmt.all(toFts5Query(q), limit) as Array<{
    runId: string;
    task: string;
    cwd: string;
    status: string;
    startedAt: string;
    snippet: string;
  }>;
  return rows.map((r) => ({
    runId: r.runId,
    task: r.task,
    cwd: r.cwd,
    status: r.status,
    startedAt: r.startedAt,
    snippet: sanitizeForDisplay(r.snippet ?? ''),
  }));
}

// ─────────────────────── the `session_search` tool ───────────────────────

registerTool({
  name: 'session_search',
  description:
    'Full-text search across your past agent sessions (task text + transcripts), ranked by relevance. ' +
    'Cheap cross-session recall without embeddings - complements the durable memory. ' +
    'Returns one highlighted snippet per matching session with its run id, task, and status. Read-only.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search words, e.g. "postgres migration failed"' },
      limit: { type: 'integer', description: 'Max sessions to return (default 10, max 25)' },
    },
    required: ['query'],
  },
  async execute(args, _ctx: ToolContext) {
    const query = reqString(args, 'query').trim();
    if (query.length === 0) throw new Error('query must not be empty');
    const limit = optInt(args, 'limit');
    const hits = searchSessions(query, limit !== undefined ? { limit } : {});
    if (hits.length === 0) {
      return {
        ok: true,
        summary: 'no matching sessions',
        content:
          'No past sessions matched. (Only detached runs recorded by this CLI are indexed - ' +
          'run `spycore runs list` to see what exists, and reindex with `spycore runs search --reindex`.)',
      };
    }
    const lines = hits.map(
      (h, i) =>
        `${i + 1}. [${h.status}] ${h.task} (run ${h.runId}, ${h.startedAt.slice(0, 10)})\n   …${h.snippet}…`,
    );
    return {
      ok: true,
      summary: `${hits.length} matching session${hits.length === 1 ? '' : 's'}`,
      content: lines.join('\n'),
    };
  },
});
