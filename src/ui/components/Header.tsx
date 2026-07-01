import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { Separator } from './Separator.js';

export interface HeaderProps {
  title: string;
  /** Muted description shown after the title. */
  subtitle?: string;
  /** Leading glyph; defaults to the theme section marker (▸ / >). */
  glyph?: string;
}

/**
 * A refined section header: a leading accent glyph, the title in the accent
 * color, an optional muted description, and a subtle full-width hairline rule
 * beneath that stretches to the available width.
 */
export function Header({ title, subtitle, glyph }: HeaderProps): ReactNode {
  const { colors, symbols } = useTheme();
  const lead = glyph ?? symbols.section;
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={colors.accent} bold>{`${lead} ${title}`}</Text>
        {subtitle ? <Text color={colors.muted}>{`   ${subtitle}`}</Text> : null}
      </Text>
      <Separator token="borderSubtle" />
    </Box>
  );
}
