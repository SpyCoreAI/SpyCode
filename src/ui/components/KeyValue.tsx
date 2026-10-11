import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';

export interface KeyValueItem {
  label: string;
  value: ReactNode;
}
export interface KeyValueProps {
  items: KeyValueItem[];
  /** Cells of padding between the label column and the values. */
  gap?: number;
}

/**
 * Aligned "label   value" rows. The label column is sized to the widest label
 * so values line up cleanly.
 */
export function KeyValue({ items, gap = 2 }: KeyValueProps): ReactNode {
  const { colors } = useTheme();
  const labelWidth =
    items.reduce((max, item) => Math.max(max, item.label.length), 0) + gap;
  return (
    <Box flexDirection="column">
      {items.map((item) => (
        <Box key={item.label}>
          <Box width={labelWidth}>
            <Text color={colors.muted}>{item.label}</Text>
          </Box>
          {typeof item.value === 'string' ? (
            <Text color={colors.text}>{item.value}</Text>
          ) : (
            item.value
          )}
        </Box>
      ))}
    </Box>
  );
}
