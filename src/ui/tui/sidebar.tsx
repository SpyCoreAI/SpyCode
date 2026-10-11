/**
 * Wave 1-F · D-F: the TUI's toggleable session sidebar.
 *
 * A right-hand panel (~30% of the terminal, allocated by TuiApp): the session
 * title, the files the agent changed this session, and the language-server
 * section.
 *
 * MODIFIED-FILES DATA SOURCE: the agent's checkpoint journal
 * (`src/lib/agent/checkpoint.ts`). Every run's `RunRecorder` journal
 * (`RecordedChange`: absolute path + `before`/`after` contents + op) is
 * folded into per-file +added/−removed stats by `mergeSessionChanges`.
 * Stats are computed ONCE at merge time and summed per path, so React state
 * holds numbers, never file contents, and renders never re-diff. Summing is
 * an approximation for files touched by several runs (a later edit can
 * overlap an earlier one's lines), which the sidebar's summary role
 * tolerates. Re-merging a resumed run's reopened journal (it carries its old
 * records) is idempotent via per-record fingerprints. The sidebar never
 * touches the disk journal itself; TuiApp feeds it the already-loaded
 * session changes.
 *
 * The language-server section is deliberately an empty-state stub: the LSP
 * integration arrives in a later wave. `TuiSessionSidebarProps.languageServers`
 * already carries the shape that wave will populate, so no component change
 * is needed when servers become real.
 */
import { Box, Text } from 'ink';
import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { diffLines } from 'diff';
import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { useTheme } from '../theme/theme.js';
import type { RecordedChange } from '../../lib/agent/checkpoint.js';

/** Max file rows before the list collapses behind an "…and M more" row. */
const MAX_SIDEBAR_FILES = 30;

/**
 * One file's accumulated +added/−removed line counts this TUI session. Stats
 * only - no file contents are kept in React state.
 */
export interface SessionFileStat {
  /** Absolute path (journal records are absolute). */
  path: string;
  /** Added lines summed across this session's journaled changes. */
  added: number;
  /** Removed lines summed across this session's journaled changes. */
  removed: number;
  /**
   * sha256 fingerprints of the journal records already folded in. Internal:
   * keeps re-merging a resumed run's journal idempotent. Hashes, not
   * contents - nothing renderable is stored.
   */
  seen: readonly string[];
}

function cpLen(s: string): number {
  return [...s].length;
}

/** Truncate to a column width, keeping an ellipsis for the dropped tail. Pure. */
export function truncateToWidth(s: string, width: number): string {
  if (cpLen(s) <= width) return s;
  if (width <= 1) return '…'.slice(0, Math.max(0, width));
  return `${[...s].slice(0, width - 1).join('')}…`;
}

/** Display path: relative to cwd when it stays inside it, else absolute. Pure. */
export function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel === '' || rel.startsWith(`..${sep}`) || rel === '..' ? path : rel;
}

/** +added/−removed line counts for one before→after pair. Pure. */
function countDiffLines(before: string, after: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(before, after)) {
    const n = part.count ?? 0;
    if (part.added) added += n;
    else if (part.removed) removed += n;
  }
  return { added, removed };
}

/** Fingerprint of one journal record, for idempotent re-merges. Pure. */
function recordFingerprint(c: RecordedChange): string {
  return createHash('sha256')
    .update(c.path, 'utf8')
    .update('\0')
    .update(c.op, 'utf8')
    .update('\0')
    .update(c.before ?? '', 'utf8')
    .update('\0')
    .update(c.after, 'utf8')
    .digest('hex');
}

/**
 * Fold one run's journaled changes into the TUI-session accumulator.
 *
 * Each record's line stats are computed ONCE here and summed per path, so the
 * component never re-diffs on render and state never holds file contents.
 * Sorted alphabetically by absolute path (all journal paths share the cwd
 * prefix, so this matches the displayed relative order). Pure.
 */
export function mergeSessionChanges(
  prev: readonly SessionFileStat[],
  changes: readonly RecordedChange[],
): SessionFileStat[] {
  const acc = new Map<string, { stat: SessionFileStat; seen: Set<string> }>();
  for (const f of prev) {
    acc.set(f.path, { stat: { ...f, seen: [...f.seen] }, seen: new Set(f.seen) });
  }
  for (const c of changes) {
    const key = recordFingerprint(c);
    let entry = acc.get(c.path);
    if (!entry) {
      entry = { stat: { path: c.path, added: 0, removed: 0, seen: [] }, seen: new Set() };
      acc.set(c.path, entry);
    }
    if (entry.seen.has(key)) continue;
    entry.seen.add(key);
    const { added, removed } = countDiffLines(c.before ?? '', c.after);
    entry.stat.added += added;
    entry.stat.removed += removed;
    entry.stat.seen = [...entry.seen];
  }
  return [...acc.values()]
    .map((e) => e.stat)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export interface TuiSessionSidebarProps {
  /** Session title (the first task's text); falls back to "Session". */
  title: string;
  /** Accumulated per-file line stats for this TUI session (from `mergeSessionChanges`). */
  files: readonly SessionFileStat[];
  /** Used to shorten absolute paths for display. */
  cwd: string;
  /** Columns allocated by the layout (~30% of the terminal). */
  width: number;
  /** Language servers to list; the LSP wave populates this (empty → placeholder). */
  languageServers?: readonly LanguageServerInfo[] | undefined;
}

/**
 * Shape the later LSP wave will populate. Kept here so the sidebar's
 * language-server section needs no redesign when servers become real.
 */
export interface LanguageServerInfo {
  name: string;
  status: 'running' | 'starting' | 'error';
  languages: string[];
}

function serverStatusColor(status: LanguageServerInfo['status']): 'success' | 'warning' | 'error' {
  switch (status) {
    case 'running':
      return 'success';
    case 'starting':
      return 'warning';
    default:
      return 'error';
  }
}

export function TuiSessionSidebar({
  title,
  files,
  cwd,
  width,
  languageServers = [],
}: TuiSessionSidebarProps): ReactNode {
  const { colors, symbols } = useTheme();
  // Border (2) + paddingX (2) leave this for content.
  const inner = Math.max(8, width - 4);
  // Already sorted by mergeSessionChanges; memoize the capped slice so
  // render stays O(visible rows) no matter how long the session gets.
  const visibleFiles = useMemo(() => files.slice(0, MAX_SIDEBAR_FILES), [files]);
  const hiddenCount = files.length - visibleFiles.length;

  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      borderStyle="round"
      borderColor={colors.borderSubtle}
      paddingX={1}
    >
      {/* 1 · session title (sanitized: the title is the user's raw task text) */}
      <Text color={colors.accent} bold>
        {truncateToWidth(sanitizeForDisplay(title.trim() === '' ? 'Session' : title), inner)}
      </Text>

      {/* 2 · files changed this session (stats accumulated by mergeSessionChanges) */}
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.textDim}>
          {symbols.section} Modified files{files.length > 0 ? ` (${files.length})` : ''}
        </Text>
        {files.length === 0 ? (
          <Text color={colors.muted}>No files changed yet.</Text>
        ) : (
          <>
            {visibleFiles.map((f) => {
              const counts = ` +${f.added} -${f.removed}`;
              return (
                <Box key={f.path}>
                  <Text color={colors.text}>
                    {truncateToWidth(
                      sanitizeForDisplay(displayPath(f.path, cwd)),
                      Math.max(4, inner - cpLen(counts)),
                    )}
                  </Text>
                  <Text color={colors.success}>{` +${f.added}`}</Text>
                  <Text color={colors.error}>{` -${f.removed}`}</Text>
                </Box>
              );
            })}
            {hiddenCount > 0 ? <Text color={colors.muted}>…and {hiddenCount} more</Text> : null}
          </>
        )}
      </Box>

      {/* 3 · language servers (LSP lands in a later wave - placeholder for now) */}
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.textDim}>{symbols.section} Language servers</Text>
        {languageServers.length === 0 ? (
          <Text color={colors.muted}>None connected.</Text>
        ) : (
          languageServers.map((s) => {
            const nameCap = Math.max(4, inner - 4);
            const langs = s.languages.join(', ');
            const langsCap = Math.max(4, inner - 3 - Math.min(cpLen(s.name), nameCap));
            return (
              <Box key={s.name}>
                <Text color={colors[serverStatusColor(s.status)]}>{symbols.bullet} </Text>
                <Text color={colors.text}>{truncateToWidth(s.name, nameCap)}</Text>
                <Text color={colors.muted}>
                  {langs === '' ? '' : ` ${truncateToWidth(langs, langsCap)}`}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
