/**
 * TUI app-level view components: the welcome screen, the diff views, and the
 * transcript item renderer. Pure presentation - no agent state. Extracted
 * from TuiApp.tsx (M-8); behavior unchanged.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { Banner, Notice } from '../components/index.js';
import { Markdown } from '../markdown/index.js';
import { useTheme } from '../theme/theme.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import {
  DiffLineView,
  ItemView,
  clamp,
} from '../agent/shared.js';
import type { DiffLine } from '../../lib/agent/diff.js';
import { HelpPanel } from './help.js';
import type { TranscriptSearchRender } from './transcript-search.js';
import { parseMarkdown } from '../markdown/index.js';
import type { DiffFile, TuiItem } from './app-types.js';
import { MAX_DIFF_LINES } from './app-types.js';

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function displayCwd(cwd: string): string {
  const home = homedir();
  const rel = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (rel.length <= 40) return rel;
  return `…${rel.slice(-39)}`;
}

/** Turn a unified patch into DiffLine rows (headers dropped, capped). The
 * uncapped `full` list backs Ctrl+O peek - the capped view never hides that
 * more exists (the truncation marker is always rendered). */
export function patchToHunks(
  before: string,
  after: string,
  path: string,
): { hunks: DiffLine[]; truncated: boolean; full: DiffLine[] } {
  const patch = createTwoFilesPatch(path, path, before, after, '', '', { context: 3 });
  const full: DiffLine[] = [];
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('Index') || raw.startsWith('===')) continue;
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('@@')) full.push({ kind: 'hunk', text: raw });
    else if (raw.startsWith('+')) full.push({ kind: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) full.push({ kind: 'del', text: raw.slice(1) });
    else full.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw });
  }
  const truncated = full.length > MAX_DIFF_LINES;
  return { hunks: full.slice(0, MAX_DIFF_LINES), truncated, full };
}

/** Render DiffLines back to unified-diff text (for Ctrl+O peek). */
export function diffLinesToText(lines: DiffLine[]): string {
  return lines
    .map((l) =>
      l.kind === 'hunk' ? l.text : l.kind === 'add' ? `+${l.text}` : l.kind === 'del' ? `-${l.text}` : ` ${l.text}`,
    )
    .join('\n');
}

function WelcomeView({ loggedIn, tip }: { loggedIn: boolean; tip: string }): ReactNode {
  const { colors } = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Banner tagline="interactive" />
      <Box marginTop={1}>
        <Text color={colors.textDim}>{tip}</Text>
      </Box>
      {!loggedIn ? (
        <Box marginTop={1}>
          <Notice variant="warning">
            Not logged in. Run `spycore login` to authenticate, then restart the TUI.
          </Notice>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={colors.muted}>Type a task, or /help for keys &amp; commands.</Text>
      </Box>
    </Box>
  );
}

function TuiDiffView({ files, total, width }: { files: DiffFile[]; total: number; width: number }): ReactNode {
  const { colors, symbols } = useTheme();
  // T2: Use split-view on wide terminals (>= 120 cols), unified otherwise.
  const useSplit = width >= 120;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>
        {`${symbols.section} Diff - ${total} file${total === 1 ? '' : 's'} changed${useSplit ? ' (split view)' : ''}`}
      </Text>
      {files.map((f) => (
        <Box key={f.path} flexDirection="column" marginTop={1}>
          <Text color={f.op === 'delete' ? colors.error : f.op === 'create' ? colors.success : colors.text}>
            {`${f.op === 'create' ? 'new' : f.op === 'delete' ? 'deleted' : 'modified'} ${sanitizeForDisplay(f.path)}`}
          </Text>
          {useSplit ? (
            <TuiDiffSplitView hunks={f.hunks} width={width} truncated={f.truncated} />
          ) : (
            <Box flexDirection="column" paddingLeft={2}>
              {f.hunks.map((h, i) => (
                <DiffLineView key={i} line={h} width={Math.max(8, width - 2)} />
              ))}
              {f.truncated ? <Text color={colors.muted}>… diff truncated</Text> : null}
            </Box>
          )}
        </Box>
      ))}
      {total > files.length ? (
        <Text color={colors.muted}>{`… and ${total - files.length} more file${total - files.length === 1 ? '' : 's'}`}</Text>
      ) : null}
    </Box>
  );
}

/**
 * T2: Split-view diff for wide terminals. Shows old (left) and new (right)
 * side-by-side. Context lines appear in both columns; added lines only on
 * the right; deleted lines only on the left.
 */
function TuiDiffSplitView({ hunks, width, truncated }: { hunks: DiffLine[]; width: number; truncated: boolean }): ReactNode {
  const { colors } = useTheme();
  const colWidth = Math.floor((width - 3) / 2); // 3 for separator " │ "

  // Pair up the hunks into rows: each row has optional left (old) and right (new).
  interface Row { left: string | null; right: string | null; leftKind: string; rightKind: string }
  const rows: Row[] = [];
  let i = 0;
  while (i < hunks.length) {
    const h = hunks[i]!;
    if (h.kind === 'hunk') {
      // Hunk headers span both columns neutrally.
      rows.push({ left: h.text, right: null, leftKind: 'hunk', rightKind: 'empty' });
      i++;
    } else if (h.kind === 'context') {
      rows.push({ left: h.text, right: h.text, leftKind: 'context', rightKind: 'context' });
      i++;
    } else if (h.kind === 'del') {
      // Collect consecutive deletions, then consecutive additions (a changed block).
      const dels: string[] = [];
      while (i < hunks.length && hunks[i]!.kind === 'del') {
        dels.push(hunks[i]!.text);
        i++;
      }
      const adds: string[] = [];
      while (i < hunks.length && hunks[i]!.kind === 'add') {
        adds.push(hunks[i]!.text);
        i++;
      }
      const maxLen = Math.max(dels.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        rows.push({
          left: j < dels.length ? dels[j]! : null,
          right: j < adds.length ? adds[j]! : null,
          leftKind: j < dels.length ? 'del' : 'empty',
          rightKind: j < adds.length ? 'add' : 'empty',
        });
      }
    } else {
      // Standalone additions (no preceding deletions).
      rows.push({ left: null, right: h.text, leftKind: 'empty', rightKind: 'add' });
      i++;
    }
  }

  // Sanitize display text (security - prevent ANSI escape injection).
  // Use Array.from for proper wide-char handling.
  const truncate = (s: string, w: number): string => {
    const clean = sanitizeForDisplay(s);
    const chars = Array.from(clean);
    if (chars.length > w) return chars.slice(0, w - 1).join('') + '…';
    return chars.join('').padEnd(w);
  };

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {rows.map((r, idx) => (
        r.leftKind === 'hunk' ? (
          <Box key={idx} flexDirection="row">
            <Text color={colors.accent}>{truncate(r.left ?? '', width - 4)}</Text>
          </Box>
        ) : (
          <Box key={idx} flexDirection="row">
            <Text
              color={r.leftKind === 'del' ? colors.error : colors.muted}
              wrap="truncate"
            >
              {truncate(r.left ?? '', colWidth)}
            </Text>
            <Text color={colors.borderSubtle}> │ </Text>
            <Text
              color={r.rightKind === 'add' ? colors.success : colors.muted}
              wrap="truncate"
            >
              {truncate(r.right ?? '', colWidth)}
            </Text>
          </Box>
        )
      ))}
      {truncated ? <Text color={colors.muted}>… diff truncated</Text> : null}
    </Box>
  );
}

export function TuiItemView({
  item,
  width,
  search,
}: {
  item: TuiItem;
  width: number;
  search: TranscriptSearchRender | null;
}): ReactNode {
  const { colors } = useTheme();
  // Transcript search: items whose text matched the query get a marker.
  // (Inline segment highlights live in ItemView for the plain-text kinds;
  // Ink never re-renders flushed <Static> items, so this marker - like the
  // search bar's excerpt - is the highlight that always works.)
  const matchMark =
    search && search.query.trim().length > 0 && search.hitIds.has(item.id) ? (
      <Text color={search.currentId === item.id ? colors.accent : colors.muted}>
        {search.currentId === item.id ? '/ current match' : '/ match'}
      </Text>
    ) : null;
  const withMark = (node: ReactNode): ReactNode =>
    matchMark ? (
      <Box flexDirection="column">
        {matchMark}
        {node}
      </Box>
    ) : (
      node
    );
  switch (item.kind) {
    case 'welcome':
      return withMark(<WelcomeView loggedIn={item.loggedIn} tip={item.tip} />);
    case 'help':
      return withMark(<HelpPanel />);
    case 'diff':
      return withMark(<TuiDiffView files={item.files} total={item.total} width={width} />);
    case 'summary':
      return withMark(
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={colors.borderSubtle} paddingX={1}>
          <Text color={colors.accent} bold>
            {`Context compacted - ${item.items} item${item.items === 1 ? '' : 's'} summarized`}
          </Text>
          <Box marginTop={1}>
            <Markdown tokens={parseMarkdown(item.text)} width={Math.max(8, width - 4)} />
          </Box>
        </Box>,
      );
    case 'peek': {
      // The full content behind an elided transcript item (Ctrl+O). Capped at
      // a sane render budget; the label names the source item.
      const lines = item.full.split('\n');
      const shown = lines.slice(0, 500);
      return withMark(
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={colors.borderSubtle} paddingX={1}>
          <Text color={colors.accent} bold>{`Expanded: ${item.label}`}</Text>
          <Box flexDirection="column" marginTop={1}>
            {shown.map((l, i) => (
              <Text key={i} color={colors.textDim}>
                {clamp(sanitizeForDisplay(l), Math.max(8, width - 4)) || ' '}
              </Text>
            ))}
            {lines.length > shown.length ? (
              <Text color={colors.muted}>{`… ${lines.length - shown.length} more lines (still capped for display)`}</Text>
            ) : null}
          </Box>
        </Box>,
      );
    }
    default:
      return withMark(<ItemView item={item} width={width} search={search} />);
  }
}
