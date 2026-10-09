/**
 * Ctrl+P command palette (and the `/` inline variant): a filterable list over
 * the SAME registry as slash commands, so one learned surface covers all
 * three. Presentational - TuiApp owns the filter text, selection and keys.
 *
 * List rendering follows the shared picker grammar (`picker-grammar.tsx`):
 * full-width accent selected row, ↑/↓ scroll rail, fixed-height list.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { computePickerViewport, PickerList } from './picker-grammar.js';
import type { TuiCommand } from './commands.js';

export interface CommandPaletteProps {
  commands: readonly TuiCommand[];
  /** Index into the FULL filtered command list (the viewport scrolls to it). */
  selected: number;
  filter: string;
  width: number;
}

const MAX_ROWS = 8;

export function CommandPalette({ commands, selected, filter, width }: CommandPaletteProps): ReactNode {
  const theme = useTheme();
  const { colors, symbols, borderStyle, capabilities } = theme;
  const inner = Math.max(20, width - 4);

  // The filter row is pointer (glyph + space) + filter + a cursor cell;
  // cap the filter so the whole row stays inside the inner width instead of
  // wrapping. Code-point aware - no split surrogate pairs.
  const filterEllipsis = capabilities.unicode ? '…' : '...';
  const filterBudget = Math.max(1, inner - 3);
  const filterCps = [...sanitizeForDisplay(filter)];
  const filterText =
    filterCps.length > filterBudget
      ? `${filterCps.slice(0, filterBudget - [...filterEllipsis].length).join('')}${filterEllipsis}`
      : filterCps.join('');

  // Full row text - PickerList truncates to fit, so callers never measure.
  const rows = commands.map((c) => ({
    key: c.name,
    text: `/${c.name}${c.usage ? ` ${c.usage}` : ''}  -  ${c.summary}`,
  }));
  const viewport = computePickerViewport(rows, selected, MAX_ROWS);

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle={borderStyle}
      borderColor={colors.borderSubtle}
      paddingX={1}
    >
      <Box>
        <Text color={colors.accent} bold>{`${symbols.pointer} `}</Text>
        <Text color={colors.text}>{filterText}</Text>
        <Text inverse> </Text>
      </Box>
      <Box marginTop={1}>
        <PickerList viewport={viewport} theme={theme} width={inner} emptyText="No matching command" />
      </Box>
      <Box marginTop={1}>
        <Text color={colors.muted}>Up/Down move · Enter run · Esc close</Text>
      </Box>
    </Box>
  );
}
