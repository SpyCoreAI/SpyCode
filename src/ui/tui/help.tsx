/**
 * /help as a transcript item: the keybinding table rendered from the single
 * source of truth (keybindings.ts), so documented keys and implemented keys
 * cannot drift.
 *
 * Layout (D-I): shortcuts flow as a multi-column grid - bold key, muted
 * description - with as many columns as the width fits; duplicate bindings
 * (same key in several contexts) merge into one cell. Sized to fit an 80x24
 * terminal with no scrolling.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { useContentWidth } from '../lib/useContentWidth.js';
import { getEffectiveKeybindings } from '../../lib/config.js';
import { TUI_COMMANDS } from './commands.js';

/** One grid cell: a unique key label plus its (possibly merged) description. */
export interface HelpEntry {
  key: string;
  desc: string;
}

/**
 * Compact merged descriptions for keys bound in several contexts. Everything
 * else renders its registry action verbatim.
 */
const MERGED_DESCRIPTIONS: Record<string, string> = {
  Enter: 'send · run',
  '↑/↓': 'history at edges, move line otherwise · move',
  'Ctrl+O': 'expand elided output',
  'Ctrl+B': 'toggle sidebar',
  Esc: 'stash draft · interrupt run · reject · close · cancel',
  'Ctrl+C': 'abort run · reject + abort run · double-press to quit',
};

/**
 * Deduplicated help entries from the RESOLVED keybindings: each key label
 * appears exactly once, in registry order, with its actions merged.
 * Reads the global config store via getEffectiveKeybindings() so user
 * rebindings are reflected here (not pure - the "Pure." claim was wrong).
 */
export function helpEntries(): HelpEntry[] {
  const { bindings } = getEffectiveKeybindings();
  const actionsByKey = new Map<string, string[]>();
  for (const b of bindings) {
    const actions = actionsByKey.get(b.label);
    if (actions) {
      if (!actions.includes(b.action)) actions.push(b.action);
    } else {
      actionsByKey.set(b.label, [b.action]);
    }
  }
  return [...actionsByKey.entries()].map(([key, actions]) => ({
    key,
    desc: MERGED_DESCRIPTIONS[key] ?? actions.join(' · '),
  }));
}

const CELL_SEP = '  ';
const COLUMN_GUTTER = 2;

function cellWidth(cell: HelpEntry): number {
  return cell.key.length + CELL_SEP.length + cell.desc.length;
}

/**
 * Flow cells into as many column-major columns as fit `innerWidth`.
 * Each column is as wide as its widest cell; columns are added until the
 * width is filled. Falls back to a single column on narrow screens. Pure.
 */
export function layoutHelpColumns(cells: HelpEntry[], innerWidth: number): HelpEntry[][] {
  if (cells.length === 0) return [];
  const widths = cells.map(cellWidth);
  const minWidth = Math.min(...widths);
  const maxCols = Math.min(
    cells.length,
    Math.max(1, Math.floor((innerWidth + COLUMN_GUTTER) / (minWidth + COLUMN_GUTTER))),
  );
  for (let cols = maxCols; cols >= 1; cols--) {
    const rows = Math.ceil(cells.length / cols);
    let total = 0;
    for (let c = 0; c < cols; c++) {
      let colWidth = 0;
      for (let r = 0; r < rows; r++) {
        const i = c * rows + r;
        if (i < cells.length) colWidth = Math.max(colWidth, widths[i] ?? 0);
      }
      total += colWidth;
    }
    total += COLUMN_GUTTER * (cols - 1);
    if (total <= innerWidth) {
      const columns: HelpEntry[][] = [];
      for (let c = 0; c < cols; c++) {
        const column: HelpEntry[] = [];
        for (let r = 0; r < rows; r++) {
          const i = c * rows + r;
          if (i < cells.length) column.push(cells[i] as HelpEntry);
        }
        columns.push(column);
      }
      return columns;
    }
  }
  return [cells];
}

/** Greedy word-wrap for the command list. Pure. */
export function wrapHelpCommands(labels: string[], width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const label of labels) {
    const next = current === '' ? label : `${current} ${label}`;
    if (next.length > width && current !== '') {
      lines.push(current);
      current = label;
    } else {
      current = next;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** Truncate a cell's description so the cell fits `maxWidth`. Pure. */
function truncateCell(cell: HelpEntry, maxWidth: number): HelpEntry {
  if (cellWidth(cell) <= maxWidth) return cell;
  const keep = Math.max(0, maxWidth - cell.key.length - CELL_SEP.length - 1);
  return { key: cell.key, desc: `${cell.desc.slice(0, keep)}…` };
}

export function HelpPanel(): ReactNode {
  const { colors, borderStyle } = useTheme();
  const width = useContentWidth();
  const inner = Math.max(20, width - 4);

  const entries = helpEntries().map((e) => truncateCell(e, inner));
  const columns = layoutHelpColumns(entries, inner);
  const colWidths = columns.map((col) => Math.max(...col.map(cellWidth)));
  const rowCount = Math.max(...columns.map((col) => col.length));

  const commandLabels = TUI_COMMANDS.map((c) => `/${c.name}${c.usage ? ` ${c.usage}` : ''}`);
  const commandLines = wrapHelpCommands(commandLabels, inner - 2);

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle={borderStyle}
      borderColor={colors.borderSubtle}
      paddingX={1}
    >
      <Text color={colors.accent} bold>
        SpyCode TUI - keys & commands
      </Text>
      <Text color={colors.muted}>! shell · @ mention a file · / command</Text>
      <Box flexDirection="column" marginTop={1}>
        {Array.from({ length: rowCount }).map((_, r) => (
          <Text key={r}>
            {columns.map((col, ci) => {
              const cell = col[r];
              if (!cell) return null;
              const pad = ' '.repeat(Math.max(0, (colWidths[ci] ?? 0) - cellWidth(cell)));
              const gutter = ci < columns.length - 1 ? ' '.repeat(COLUMN_GUTTER) : '';
              return (
                <Text key={ci}>
                  <Text bold color={colors.text}>
                    {cell.key}
                  </Text>
                  <Text color={colors.muted}>{`${CELL_SEP}${cell.desc}${pad}${gutter}`}</Text>
                </Text>
              );
            })}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.accent}>COMMANDS</Text>
        {commandLines.map((l, i) => (
          <Text key={i} color={colors.textDim}>
            {`  ${l}`}
          </Text>
        ))}
        <Text color={colors.muted}>  /resume restores SpyCore sessions only</Text>
      </Box>
    </Box>
  );
}
