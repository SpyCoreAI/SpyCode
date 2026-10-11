import { Box, Text } from 'ink';
import { Spinner as InkSpinner } from '@inkjs/ui';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';

export interface SpinnerProps {
  label?: string;
}

/** A themed wrapper over the @inkjs/ui spinner: animated frames + a dim label. */
export function Spinner({ label }: SpinnerProps): ReactNode {
  const { colors, capabilities } = useTheme();
  // Braille 'dots' when Unicode is available; ascii 'line' (-\|/) otherwise so
  // the spinner never renders as a missing-glyph box.
  return (
    <Box gap={1}>
      <InkSpinner type={capabilities.unicode ? 'dots' : 'line'} />
      {label ? <Text color={colors.textDim}>{label}</Text> : null}
    </Box>
  );
}
