import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import type { SemanticColorName } from '../theme/tokens.js';

/** bordered = rounded box border; accent = left vertical accent bar (callout). */
export type PanelVariant = 'bordered' | 'accent';

export interface PanelProps {
  title?: string;
  children: ReactNode;
  variant?: PanelVariant;
  /** Border color token for the bordered variant. */
  borderToken?: SemanticColorName;
  /** Bar color token for the accent variant. */
  accentToken?: SemanticColorName;
  /** Horizontal padding inside the panel, in cells. */
  paddingX?: number;
  /** Optional small glyph before the title. */
  titleGlyph?: string;
}

/**
 * A container with two looks: `bordered` (rounded box) and `accent` (a heavy
 * left vertical bar — a modern callout). Both carry an optional accent title.
 * The accent bar uses a bold border-left (┃) and degrades to classic (|).
 */
export function Panel({
  title,
  children,
  variant = 'bordered',
  borderToken = 'borderStrong',
  accentToken = 'accent',
  paddingX = 1,
  titleGlyph,
}: PanelProps): ReactNode {
  const { colors, borderStyle } = useTheme();

  const titleNode = title ? (
    <Box marginBottom={1}>
      <Text color={colors.accent} bold>
        {titleGlyph ? `${titleGlyph} ${title}` : title}
      </Text>
    </Box>
  ) : null;

  if (variant === 'accent') {
    const barStyle = borderStyle === 'round' ? 'bold' : 'classic';
    return (
      <Box
        flexDirection="column"
        borderStyle={barStyle}
        borderColor={colors[accentToken]}
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        paddingLeft={paddingX + 1}
      >
        {titleNode}
        <Box flexDirection="column">{children}</Box>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle={borderStyle}
      borderColor={colors[borderToken]}
      paddingX={paddingX}
    >
      {titleNode}
      <Box flexDirection="column">{children}</Box>
    </Box>
  );
}
