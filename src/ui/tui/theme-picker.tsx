/**
 * Theme picker dialog (Wave 3-D, F10): the gallery + the three built-in
 * settings in one picker. Presentational - the owner (TuiApp) holds the
 * selection index, the active theme id, and the keys, exactly like
 * `CommandPalette` in `palette.tsx`.
 *
 * List rendering follows the shared picker grammar (`picker-grammar.tsx`):
 * full-width accent selected row, ↑/↓ scroll rail, fixed-height list.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { computePickerViewport, PickerList, type PickerRow } from './picker-grammar.js';
import type { ThemeOption } from '../theme/gallery.js';

export interface ThemePickerProps {
  /** Ordered options from `listThemeOptions()` (built-ins first, then gallery). */
  options: readonly ThemeOption[];
  /** Index into the FULL option list (the viewport scrolls to it). */
  selected: number;
  /** Id of the currently active theme ('auto' | 'light' | 'dark' | gallery id). */
  currentId: string;
  width: number;
}

const MAX_ROWS = 8;

/**
 * Picker rows for the theme options. The active theme carries an `(active)`
 * marker; everything else is `Name  —  blurb`. Pure: unit-testable without Ink.
 */
export function themePickerRows(
  options: readonly ThemeOption[],
  currentId: string,
): PickerRow[] {
  return options.map((o) => ({
    key: o.id,
    text: `${o.name}  —  ${o.blurb}${o.id === currentId ? '  (active)' : ''}`,
  }));
}

export function ThemePicker({ options, selected, currentId, width }: ThemePickerProps): ReactNode {
  const theme = useTheme();
  const { colors, borderStyle } = theme;
  const inner = Math.max(24, width - 4);

  const rows = themePickerRows(options, currentId);
  const viewport = computePickerViewport(rows, selected, MAX_ROWS);
  const clamped = Math.min(Math.max(0, selected), options.length - 1);
  const highlighted = options[clamped];

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle={borderStyle}
      borderColor={colors.borderSubtle}
      paddingX={1}
    >
      <Text bold color={colors.text}>
        Theme
      </Text>
      <Box marginTop={1}>
        <PickerList viewport={viewport} theme={theme} width={inner} emptyText="No themes" />
      </Box>
      <Box marginTop={1}>
        {highlighted?.swatch ? (
          <Text color={colors.muted}>
            Preview <Text color={highlighted.swatch}>■■■</Text> {highlighted.name}
          </Text>
        ) : (
          <Text color={colors.muted}>
            Preview: terminal default{highlighted ? ` (${highlighted.name})` : ''}
          </Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={colors.muted}>↑/↓ move · Enter apply · Esc close</Text>
      </Box>
    </Box>
  );
}
