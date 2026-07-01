import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';

export interface BrandProps {
  /** Optional dim subtitle shown to the right of the wordmark. */
  subtitle?: string;
}

/**
 * The SpyCode wordmark: a small brand mark, "Spy" in body text and "Code" in
 * the accent color. ASCII-safe — the mark degrades to "*" on dumb terminals.
 */
export function Brand({ subtitle }: BrandProps): ReactNode {
  const { colors, symbols } = useTheme();
  return (
    <Box>
      <Text color={colors.accent} bold>
        {symbols.diamond}{' '}
      </Text>
      <Text color={colors.text} bold>
        Spy
      </Text>
      <Text color={colors.accent} bold>
        Code
      </Text>
      {subtitle ? <Text color={colors.muted}>{`  ${subtitle}`}</Text> : null}
    </Box>
  );
}
