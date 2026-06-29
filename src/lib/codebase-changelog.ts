/**
 * CODEBASE_CHANGELOG.md — Part 3 of SpyCode's living-memory system.
 *
 * The third file of the trio (alongside SPYCODE.md and CODEBASE_GUIDE.md) at the
 * END-USER's project root: a SpyCode-maintained, newest-first log of notable
 * changes. This module (Part 3a) is the READ side — seeding the file via `/init`,
 * reading its most-recent tail for context injection + the `/changelog` viewer.
 * The auto-APPEND (write-at-end of an agent run) is Part 3b and lives elsewhere.
 *
 * Like CODEBASE_GUIDE.md this is a per-user, per-repo file written wherever the
 * `spycore` CLI runs — it always lives at the end-user's project root, and
 * nothing here ever writes into the CLI's own source tree.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The newest-first changelog at the user's project root. */
export const CHANGELOG_FILE = 'CODEBASE_CHANGELOG.md';

/** Default number of (most-recent) entries surfaced by `/changelog` + context. */
export const DEFAULT_CHANGELOG_ENTRIES = 10;

/** ISO `yyyy-mm-dd` for a date (UTC). Defaults to now. */
export function todayISO(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Seed content for a fresh CODEBASE_CHANGELOG.md: a SpyCore-branded header that
 * states the newest-first ordering + a single initialisation entry. Pure (the
 * date is passed in) so it is deterministic to test.
 */
export function generateInitialChangelog(date: string): string {
  const lines = [
    '# Codebase Changelog',
    '',
    '> **Maintained by SpyCore — newest entries first.**',
    '> SpyCode records notable changes here as work lands; the newest entry sits at',
    '> the top. View the most recent entries with `/changelog`.',
    '',
    `## ${date}`,
    '- Initialized project memory.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export interface ChangelogInitResult {
  /** True when a new file was written; false when one already existed. */
  created: boolean;
  /** Absolute path of the (existing or written) CODEBASE_CHANGELOG.md. */
  path: string;
}

/**
 * Create `<cwd>/CODEBASE_CHANGELOG.md` seeded with an initial entry. Like the
 * other `/init` files it NEVER overwrites — an existing file is left untouched.
 */
export function initChangelogFile(cwd: string, date: string = todayISO()): ChangelogInitResult {
  const path = join(resolve(cwd), CHANGELOG_FILE);
  if (existsSync(path)) return { created: false, path };
  writeFileSync(path, generateInitialChangelog(date), 'utf8');
  return { created: true, path };
}

/** One parsed changelog entry: a `## ` heading plus the lines beneath it. */
export interface ChangelogEntry {
  heading: string;
  body: string;
}

/**
 * Split raw changelog content into a leading preamble (the title/header lines
 * before the first entry) and the `## `-headed entries, in file order. Because
 * the file is newest-first, `entries[0]` is the most recent.
 */
export function parseChangelogEntries(content: string): {
  preamble: string;
  entries: ChangelogEntry[];
} {
  const preamble: string[] = [];
  const entries: ChangelogEntry[] = [];
  let cur: { heading: string; body: string[] } | null = null;
  for (const line of content.split('\n')) {
    if (/^##\s+/.test(line)) {
      if (cur) entries.push({ heading: cur.heading, body: cur.body.join('\n').replace(/\s+$/, '') });
      cur = { heading: line.trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (cur) entries.push({ heading: cur.heading, body: cur.body.join('\n').replace(/\s+$/, '') });
  return { preamble: preamble.join('\n').replace(/\s+$/, ''), entries };
}

// ──────────────────── Part 3b: write-at-end append helpers ─────────────────

/** `yyyy-mm-dd hh:mm UTC` for a changelog entry heading. Defaults to now. */
export function nowStamp(d: Date = new Date()): string {
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export interface ChangelogEntryInput {
  /** Heading stamp (date, or date+time). */
  stamp: string;
  /** One-line task summary (the user's request); blank → heading is the stamp only. */
  summary: string;
  /** Relative paths created / modified / deleted by the task. */
  created: string[];
  modified: string[];
  deleted: string[];
  /** Extra trailing note lines (e.g. a structural-change / guide-refresh note). */
  notes?: string[] | undefined;
}

/** Cap on the summary baked into the heading. */
const ENTRY_SUMMARY_CAP = 120;

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Render ONE newest-first changelog entry block (no surrounding blank lines):
 * a `## <stamp> — <summary>` heading, the files-touched grouped by kind, a
 * one-line action summary, then any extra notes. Pure + deterministic.
 */
export function formatChangelogEntry(input: ChangelogEntryInput): string {
  const summary = oneLine(input.summary);
  const trimmed =
    summary.length > ENTRY_SUMMARY_CAP ? `${summary.slice(0, ENTRY_SUMMARY_CAP - 1).trimEnd()}…` : summary;
  const heading = trimmed.length > 0 ? `## ${input.stamp} — ${trimmed}` : `## ${input.stamp}`;
  const lines: string[] = [heading, ''];
  const group = (label: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`**${label}**`);
    for (const it of items) lines.push(`- \`${it}\``);
    lines.push('');
  };
  group('Created', input.created);
  group('Modified', input.modified);
  group('Deleted', input.deleted);
  const counts: string[] = [];
  if (input.created.length) counts.push(`${input.created.length} created`);
  if (input.modified.length) counts.push(`${input.modified.length} modified`);
  if (input.deleted.length) counts.push(`${input.deleted.length} deleted`);
  lines.push(counts.length > 0 ? `${counts.join(', ')}.` : 'No files recorded.');
  for (const note of input.notes ?? []) {
    if (note.trim().length === 0) continue;
    lines.push('');
    lines.push(note.trim());
  }
  return lines.join('\n').replace(/\s+$/, '');
}

export interface ChangelogAppendResult {
  /** True when an entry was prepended; false when the file was absent/unreadable. */
  appended: boolean;
  path: string;
}

/**
 * PREPEND a pre-formatted entry to CODEBASE_CHANGELOG.md, newest-first: under
 * the preamble (title/header) and ABOVE existing entries, which are preserved in
 * order. Does NOT create the file — when it is absent this is a no-op, because
 * the write-at-end lifecycle only logs once `/init` has set the file up. Never
 * throws.
 */
export function appendChangelogEntry(cwd: string, entryBlock: string): ChangelogAppendResult {
  const path = join(resolve(cwd), CHANGELOG_FILE);
  if (!existsSync(path)) return { appended: false, path };
  let content = '';
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return { appended: false, path };
  }
  try {
    const { preamble, entries } = parseChangelogEntries(content);
    const existing = entries
      .map((e) => `${e.heading}\n${e.body}`.replace(/\s+$/, ''))
      .join('\n\n');
    const blocks = [preamble.trim(), entryBlock.trim(), existing].filter((s) => s.length > 0);
    writeFileSync(path, `${blocks.join('\n\n')}\n`, 'utf8');
    return { appended: true, path };
  } catch {
    return { appended: false, path };
  }
}

export interface RecentChangelog {
  /** True when CODEBASE_CHANGELOG.md exists at the project root. */
  exists: boolean;
  /** Absolute path it lives at (or would). */
  path: string;
  /** The most-recent entries (newest first), capped by entry count then chars. */
  text: string;
  /** Total entries in the file. */
  entryCount: number;
  /** Entries actually included in `text`. */
  shownEntryCount: number;
  /** True when the char cap trimmed the rendered text. */
  truncated: boolean;
}

export interface RecentChangelogOptions {
  /** Most-recent entries to include (default DEFAULT_CHANGELOG_ENTRIES). */
  maxEntries?: number | undefined;
  /** Optional char cap on the rendered text. */
  maxChars?: number | undefined;
}

/**
 * Read the TAIL of the (newest-first) changelog — i.e. the top N entries — for
 * the `/changelog` viewer and context injection. Never throws; an absent or
 * unreadable file yields `exists`/empty defaults.
 */
export function readRecentChangelog(cwd: string, opts: RecentChangelogOptions = {}): RecentChangelog {
  const path = join(resolve(cwd), CHANGELOG_FILE);
  if (!existsSync(path)) {
    return { exists: false, path, text: '', entryCount: 0, shownEntryCount: 0, truncated: false };
  }
  let content = '';
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return { exists: true, path, text: '', entryCount: 0, shownEntryCount: 0, truncated: false };
  }
  const { entries } = parseChangelogEntries(content);
  const maxEntries = opts.maxEntries ?? DEFAULT_CHANGELOG_ENTRIES;
  const shown = entries.slice(0, Math.max(0, maxEntries)); // newest first
  let text = shown
    .map((e) => `${e.heading}\n${e.body}`.replace(/\s+$/, ''))
    .join('\n\n')
    .trim();
  let truncated = false;
  if (opts.maxChars !== undefined && text.length > opts.maxChars) {
    const marker = '\n\n<!-- … older entries trimmed to fit -->';
    const room = Math.max(0, opts.maxChars - marker.length);
    text = `${text.slice(0, room).replace(/\s+$/, '')}${marker}`;
    truncated = true;
  }
  return {
    exists: true,
    path,
    text,
    entryCount: entries.length,
    shownEntryCount: shown.length,
    truncated,
  };
}

export interface ChangelogStatus {
  /** True when CODEBASE_CHANGELOG.md exists at the project root. */
  exists: boolean;
  /** Absolute path it lives at (or would). */
  path: string;
  /** Line count of the file (0 when absent). */
  lines: number;
}

/** Presence + line count of `<cwd>/CODEBASE_CHANGELOG.md`, for `/changelog`. */
export function changelogStatus(cwd: string): ChangelogStatus {
  const path = join(resolve(cwd), CHANGELOG_FILE);
  if (!existsSync(path)) return { exists: false, path, lines: 0 };
  let lines = 0;
  try {
    const content = readFileSync(path, 'utf8');
    lines = content.length === 0 ? 0 : content.replace(/\n$/, '').split('\n').length;
  } catch {
    /* leave lines at 0 */
  }
  return { exists: true, path, lines };
}
