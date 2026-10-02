import { Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';

export type NoticeVariant = 'success' | 'error' | 'warning' | 'info';

export interface NoticeProps {
  variant: NoticeVariant;
  children: ReactNode;
}

/** A single status row: a themed icon followed by the message. */
export function Notice({ variant, children }: NoticeProps): ReactNode {
  const { colors, symbols } = useTheme();
  // Single Text flow (icon + explicit space + message) so it word-wraps cleanly
  // at narrow widths instead of the icon/message columns squeezing apart.
  return (
    <Text>
      <Text color={colors[variant]} bold>{`${symbols[variant]} `}</Text>
      <Text color={colors.text}>{children}</Text>
    </Text>
  );
}
