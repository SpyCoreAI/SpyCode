/**
 * Picker interaction grammar (D-C) - the ONE shared picker language for the
 * TUI. Every list in the product (command palette today; model picker and
 * file picker tomorrow) imports from here so selecting, scrolling and scroll
 * indication behave identically everywhere.
 *
 * The grammar:
 *  1. Selected row: full-width accent background, contrasting text.
 *  2. Scroll indicators: ↑/↓ glyphs appear while the list scrolls; ←/→ are
 *     rendered for future 2D pickers (no 2D picker exists yet).
 *  3. Fixed-height lists: the viewport is always padded to `maxRows` rows so
 *     the surrounding dialog never jumps or resizes while scrolling.
 *
 * Pure layout math (`computePickerViewport`, `scrollGlyphs`) is unit-testable
 * without Ink; `PickerList` is the presentational component. All colors come
 * from the theme - no literals here.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { Theme } from '../theme/theme.js';

/**
 * Width in cells reserved by `PickerList`'s permanent scroll rail (1-cell
 * left margin + 1-cell glyph column).
 */
export const PICKER_SCROLL_RAIL_WIDTH = 2;

/** Cells per row consumed by the selection gutter (`❯ ` / two spaces). */
export const PICKER_GUTTER_WIDTH = 2;

/**
 * Usable row-text width inside a list container of `containerWidth` cells:
 * the container minus the scroll rail and the selection gutter. `PickerList`
 * truncates rows to this width itself so rows never wrap and the fixed list
 * height holds.
 */
export function pickerTextWidth(containerWidth: number): number {
  return Math.max(1, containerWidth - PICKER_SCROLL_RAIL_WIDTH - PICKER_GUTTER_WIDTH);
}

/**
 * One row of a picker list. `text` is the full row content - `PickerList`
 * truncates it to the visible width, so callers never measure.
 */
export interface PickerRow {
  /** Stable unique key for the row (used as the React key). */
  key: string;
  /** Full row content; `PickerList` truncates it to the visible width. */
  text: string;
}

/** A row inside the visible viewport; `row` is null for padding rows. */
export interface PickerViewportRow {
  row: PickerRow | null;
  selected: boolean;
}

export interface PickerViewport {
  /** Exactly `height` entries: visible rows followed by padding rows. */
  rows: PickerViewportRow[];
  /** Index into the full row list of the first visible row. */
  offset: number;
  /** True when rows exist above the viewport (list is scrolled down). */
  hasAbove: boolean;
  /** True when rows exist below the viewport (list is scrolled up). */
  hasBelow: boolean;
  /** Fixed row count the list occupies, including padding. */
  height: number;
}

/**
 * Slice a scroll window over `rows` that keeps `selected` visible.
 * Pure: no Ink, no theme.
 *
 * - `selected` is an index into the FULL row list (not the window).
 * - When the list is shorter than `maxRows`, the viewport is the whole list
 *   plus padding rows; `hasAbove`/`hasBelow` are false.
 * - When longer, the window is centered on the selection where possible and
 *   clamped to the list edges.
 */
export function computePickerViewport(
  rows: readonly PickerRow[],
  selected: number,
  maxRows: number,
): PickerViewport {
  const height = Math.max(1, Math.floor(maxRows));
  const total = rows.length;
  const clamped = total === 0 ? 0 : Math.min(Math.max(0, Math.floor(selected)), total - 1);

  let offset = 0;
  if (total > height) {
    const half = Math.floor(height / 2);
    offset = Math.min(Math.max(0, clamped - half), total - height);
  }

  const viewportRows: PickerViewportRow[] = [];
  for (let i = 0; i < height; i++) {
    const row = i < total - offset ? rows[offset + i] ?? null : null;
    viewportRows.push({ row, selected: row !== null && offset + i === clamped });
  }

  return {
    rows: viewportRows,
    offset,
    hasAbove: offset > 0,
    hasBelow: offset + height < total,
    height,
  };
}

/** Scroll-indicator glyphs for both axes (2D pickers use left/right). */
export interface ScrollGlyphs {
  up: string;
  down: string;
  left: string;
  right: string;
}

/** Unicode arrows where the terminal renders them, ASCII fallbacks otherwise. Pure. */
export function scrollGlyphs(unicode: boolean): ScrollGlyphs {
  return unicode
    ? { up: '↑', down: '↓', left: '←', right: '→' }
    : { up: '^', down: 'v', left: '<', right: '>' };
}

/** Horizontal scroll state for future 2D pickers. Omit for 1D lists. */
export interface PickerHorizontalScroll {
  hasLeft: boolean;
  hasRight: boolean;
}

export interface PickerListProps {
  /** Viewport from `computePickerViewport()` - always renders `height` rows. */
  viewport: PickerViewport;
  /** Theme from `useTheme()`; supplies colors, the pointer glyph and capabilities. */
  theme: Theme;
  /**
   * Content width in cells available for the list. Rows are truncated to fit
   * (via `pickerTextWidth`); must match the actual container width or rows
   * will wrap and break the fixed list height.
   */
  width: number;
  /** Optional horizontal scroll state (2D pickers). Renders a ←/→ rail. */
  horizontal?: PickerHorizontalScroll;
  /** Muted placeholder shown on the first row when the list is empty. */
  emptyText?: string;
}

/**
 * The grammar's list rendering: fixed-height column, full-width accent
 * background on the selected row, a permanent scroll rail (glyphs appear only
 * while scrolling, so the width never shifts), and padding rows that keep the
 * dialog's height constant in every state. Row text is truncated internally
 * to `pickerTextWidth(width)` - callers pass full text.
 */
export function PickerList({ viewport, theme, width, horizontal, emptyText }: PickerListProps): ReactNode {
  const { colors, symbols } = theme;
  const glyphs = scrollGlyphs(theme.capabilities.unicode);
  const isEmpty = viewport.rows.every((r) => r.row === null);
  const textWidth = pickerTextWidth(width);
  // Code-point aware truncation: [...s] splits on code points, never on
  // surrogate pairs, so an emoji at the cut point survives intact.
  const fit = (s: string): string => {
    const cps = [...s];
    return cps.length > textWidth ? `${cps.slice(0, textWidth - 1).join('')}…` : s;
  };

  const railCells: string[] = Array.from({ length: viewport.height }, () => ' ');
  if (viewport.hasAbove) railCells[0] = glyphs.up;
  if (viewport.hasBelow) railCells[viewport.height - 1] = glyphs.down;

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="row" width="100%">
        <Box flexDirection="column" flexGrow={1}>
          {viewport.rows.map((r, i) => {
            if (r.row === null) {
              // First padding row doubles as the empty-state line.
              return i === 0 && isEmpty && emptyText ? (
                <Text key="empty" color={colors.muted}>
                  {emptyText}
                </Text>
              ) : (
                <Text key={`pad-${i}`}> </Text>
              );
            }
            return r.selected ? (
              <Box key={r.row.key} width="100%" backgroundColor={colors.accent}>
                <Text color={colors.text} bold>
                  {`${symbols.pointer} ${fit(r.row.text)}`}
                </Text>
              </Box>
            ) : (
              <Text key={r.row.key} color={colors.textDim}>
                {`  ${fit(r.row.text)}`}
              </Text>
            );
          })}
        </Box>
        {/* Permanent rail: constant width, glyphs only while scrolling. */}
        <Box flexDirection="column" marginLeft={1}>
          {railCells.map((c, i) => (
            <Text key={i} color={colors.muted}>
              {c}
            </Text>
          ))}
        </Box>
      </Box>
      {horizontal !== undefined && (
        <Box flexDirection="row" width="100%" justifyContent="space-between">
          <Text color={colors.muted}>{horizontal.hasLeft ? glyphs.left : ' '}</Text>
          <Text color={colors.muted}>{horizontal.hasRight ? glyphs.right : ' '}</Text>
        </Box>
      )}
    </Box>
  );
}
