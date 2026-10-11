/**
 * Drop-shadow utility for floating dialogs (D-K).
 *
 * Renders a subtle, one-cell-offset shadow under a dialog using dithered
 * block characters (░▒▓) in the theme's muted `shadow` token, so floating
 * panels (command palette, help, confirmations) read as elevated above the
 * chat scrollback.
 *
 * Layout contract (Ink has no absolute positioning): the shadow is built from
 * two strips placed in the normal flow -
 *   - a right-hand column, `offset` rows below the dialog's top edge,
 *   - a bottom row, `offset` cells right of the dialog's left edge.
 * Light comes from the top-left, so there is no shadow on the top/left edges.
 *
 * `WithShadow` wraps a dialog node with both strips; `ShadowRow` /
 * `ShadowColumn` are the low-level strips for callers with custom layouts.
 * Dialog components opt in explicitly - nothing gets a shadow by default.
 *
 * On terminals without Unicode the dither glyphs degrade to solid cells
 * rendered with `backgroundColor` (the ascii symbol set has no half-block
 * equivalent); on NO_COLOR terminals the strips resolve to uncolored glyphs
 * and still read as a quiet offset edge.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';

/** Shadow glyph density. `light` (░) is the default - subtle depth. */
export type ShadowDensity = 'light' | 'medium' | 'dense';

const densityGlyph: Record<ShadowDensity, string> = {
  light: '░',
  medium: '▒',
  dense: '▓',
};

export interface ShadowStyleProps {
  /** Cells/rows to offset the shadow from the dialog edge. Default 1. */
  offset?: number;
  /** Glyph density: 'light' | 'medium' | 'dense'. Default 'light'. */
  density?: ShadowDensity;
  /**
   * Explicit shadow color. Defaults to the theme's resolved `shadow` token
   * (falling back to `muted` when the token is unavailable).
   */
  color?: string;
}

function useShadowColor(explicit?: string): string | undefined {
  const { colors } = useTheme();
  return explicit ?? colors.shadow ?? colors.muted;
}

export interface ShadowRowProps extends ShadowStyleProps {
  /** Width of the dialog (including borders), in cells. */
  width: number;
}

/**
 * The bottom shadow strip. Render it directly under the dialog (in the same
 * column Box) with the dialog's width; it shifts itself right by `offset`.
 * The strip is clamped to fit inside `width` - on narrow terminals an
 * over-wide strip wraps onto extra lines and breaks the layout.
 */
export function ShadowRow({ width, offset = 1, density = 'light', color }: ShadowRowProps): ReactNode {
  const shadowColor = useShadowColor(color);
  const { capabilities } = useTheme();
  const marginLeft = Math.max(0, Math.floor(offset));
  const cells = Math.max(0, Math.floor(width) - marginLeft);
  if (cells === 0) return null;
  if (capabilities.unicode) {
    return (
      <Box marginLeft={marginLeft}>
        <Text color={shadowColor}>{densityGlyph[density].repeat(cells)}</Text>
      </Box>
    );
  }
  // No Unicode: solid cells via background color read as a soft edge.
  return (
    <Box marginLeft={marginLeft}>
      <Text backgroundColor={shadowColor}>{' '.repeat(cells)}</Text>
    </Box>
  );
}

export interface ShadowColumnProps extends ShadowStyleProps {
  /** Height of the dialog (including borders), in rows. */
  height: number;
}

/**
 * The right-hand shadow strip. Render it in a row Box beside the dialog with
 * the dialog's height; it shifts itself down by `offset`.
 */
export function ShadowColumn({ height, offset = 1, density = 'light', color }: ShadowColumnProps): ReactNode {
  const shadowColor = useShadowColor(color);
  const { capabilities } = useTheme();
  const rows = Math.max(0, Math.floor(height));
  if (rows === 0) return null;
  const marginTop = Math.max(0, Math.floor(offset));
  const cell = (key: number): ReactNode =>
    capabilities.unicode ? (
      <Text key={key} color={shadowColor}>
        {densityGlyph[density]}
      </Text>
    ) : (
      <Text key={key} backgroundColor={shadowColor}>
        {' '}
      </Text>
    );
  return (
    <Box flexDirection="column" marginTop={marginTop}>
      {Array.from({ length: rows }, (_, i) => cell(i))}
    </Box>
  );
}

export interface WithShadowProps extends ShadowStyleProps {
  /** Width of the dialog (including borders), in cells. */
  width: number;
  /** Height of the dialog (including borders), in rows. */
  height: number;
  children: ReactNode;
}

/**
 * Wraps a dialog node with its drop shadow.
 *
 * Note on sizing: the wrapper adds `offset + 1` cells to the total rendered
 * width and `offset` rows to the total height, so callers must pass the
 * dialog's own explicit `width`/`height` (the values they sized the dialog
 * Box with) - it cannot measure content for you.
 *
 * Example:
 *   <WithShadow width={40} height={10}>
 *     <Box width={40} height={10} borderStyle="round">…</Box>
 *   </WithShadow>
 */
export function WithShadow({
  children,
  width,
  height,
  offset = 1,
  density = 'light',
  color,
}: WithShadowProps): ReactNode {
  return (
    <Box flexDirection="row">
      <Box flexDirection="column">
        {children}
        <ShadowRow width={width} offset={offset} density={density} color={color} />
      </Box>
      <ShadowColumn height={height} offset={offset} density={density} color={color} />
    </Box>
  );
}
