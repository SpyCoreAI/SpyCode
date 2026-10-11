/**
 * H-8 - FTS5 session search: indexing is chunked and idempotent, search
 * ranks tasks above transcript noise, and the FTS5 query builder cannot be
 * injected through (quotes neutralize FTS5 operators).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  __closeSessionIndexForTests,
  chunkText,
  indexRun,
  indexedRunCount,
  searchSessions,
  toFts5Query,
  unindexRun,
} from '../src/lib/agent/session-search.js';

let dir = '';

afterEach(() => {
  __closeSessionIndexForTests();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = '';
  }
});

function freshDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'spycode-ssearch-'));
  return dir;
}

const RUN = {
  id: 'run_abc123def456',
  task: 'migrate the billing cron to bullmq',
  cwd: '/tmp/proj',
  status: 'done',
  startedAt: '2026-10-10T10:00:00.000Z',
  logFile: '/tmp/proj/run.log',
};

describe('chunkText / toFts5Query', () => {
  test('chunks long multi-line text under the cap', () => {
    const chunks = chunkText('alpha\nbeta\ngamma\ndelta', 11);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 11)).toBe(true);
    expect(chunks.join('\n')).toBe('alpha\nbeta\ngamma\ndelta');
  });

  test('operators are neutralized by quoting (no FTS5 syntax injection)', () => {
    // Every token - even operators and wildcards - becomes a quoted phrase,
    // so a hostile query cannot break out of the MATCH expression.
    expect(toFts5Query('billing OR 1=1 *')).toBe('"billing" "OR" "1=1" "*"');
    expect(toFts5Query('say "hi"')).toBe('"say" """hi"""');
    expect(toFts5Query('   ')).toBe('""');
  });
});

describe('indexRun / searchSessions', () => {
  test('a task is findable by keyword', () => {
    const d = freshDir();
    indexRun({ ...RUN, logFile: '' }, join(d, 'idx.db'));
    const hits = searchSessions('bullmq', { limit: 10, path: join(d, 'idx.db') });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.runId).toBe(RUN.id);
    expect(hits[0]!.task).toBe(RUN.task);
    expect(hits[0]!.snippet.length).toBeGreaterThan(0);
  });

  test('indexing is idempotent (re-index replaces)', () => {
    const d = freshDir();
    const p = join(d, 'idx.db');
    indexRun({ ...RUN, logFile: '' }, p);
    indexRun({ ...RUN, task: 'renamed task', logFile: '' }, p);
    expect(indexedRunCount(p)).toBe(1);
    const hits = searchSessions('renamed', { limit: 10, path: p });
    expect(hits).toHaveLength(1);
  });

  test('unindexRun removes the session', () => {
    const d = freshDir();
    const p = join(d, 'idx.db');
    indexRun({ ...RUN, logFile: '' }, p);
    unindexRun(RUN.id, p);
    expect(indexedRunCount(p)).toBe(0);
    expect(searchSessions('bullmq', { limit: 10, path: p })).toEqual([]);
  });

  test('empty query returns nothing (no full-table dump)', () => {
    const d = freshDir();
    const p = join(d, 'idx.db');
    indexRun({ ...RUN, logFile: '' }, p);
    expect(searchSessions('   ', { limit: 10, path: p })).toEqual([]);
  });

  test('the log transcript is indexed too', () => {
    const d = freshDir();
    const p = join(d, 'idx.db');
    const log = join(d, 'run.log');
    writeFileSync(log, 'tool result: created subscriptions table\n', 'utf8');
    indexRun({ ...RUN, task: 'unrelated wording here', logFile: log }, p);
    const hits = searchSessions('subscriptions', { limit: 10, path: p });
    expect(hits).toHaveLength(1);
  });
});
