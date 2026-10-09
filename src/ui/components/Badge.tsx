import { Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { palette } from '../theme/tokens.js';

export type BadgeVariant =
  | 'accent'
  | 'success'
  | 'error'
  | 'warning'
  | 'info'
  | 'muted';

/** solid = filled emphasis chip; subtle = quiet outline-style secondary chip. */
export type BadgeTier = 'solid' | 'subtle';

export interface BadgeProps {
  children: string;
  variant?: BadgeVariant;
  tier?: BadgeTier;
}

/**
 * A pill chip. Solid tier is a filled chip in the variant color; subtle tier is
 * a quiet surface chip with variant-colored text. Half-block end-caps (▐ ▌)
 * give a soft pill feel and are colored to the chip so the ends round into the
 * background. Degrades: unicode-off → square chip (no caps); no-color → [label].
 */
export function Badge({
  children,
  variant = 'accent',
  tier = 'solid',
}: BadgeProps): ReactNode {
  const { colors, capabilities } = useTheme();
  const variantColor = colors[variant];

  // No-color: bracket fallback keeps the label legible without any styling.
  if (!variantColor) {
    return <Text>{`[${children}]`}</Text>;
  }

  // Uniform single-space padding across every variant/tier for consistent chips.
  const label = ` ${children} `;
  const unicode = capabilities.unicode;

  if (tier === 'solid') {
    const fg = capabilities.colorLevel === 'ansi16' ? 'black' : palette.bgDark;
    const chip = (
      <Text backgroundColor={variantColor} color={fg} bold>
        {label}
      </Text>
    );
    if (!unicode) return chip;
    return (
      <Text>
        <Text color={variantColor}>▐</Text>
        {chip}
        <Text color={variantColor}>▌</Text>
      </Text>
    );
  }

  // Subtle tier: variant-colored text on a quiet elevated surface.
  const surface = colors.surface;
  if (!surface) {
    return (
      <Text color={variantColor} bold>{`[${children}]`}</Text>
    );
  }
  const chip = (
    <Text backgroundColor={surface} color={variantColor} bold>
      {label}
    </Text>
  );
  if (!unicode) return chip;
  return (
    <Text>
      <Text color={surface}>▐</Text>
      {chip}
      <Text color={surface}>▌</Text>
    </Text>
  );
}
