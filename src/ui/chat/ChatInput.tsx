import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { splitAtCursor } from '../tui/editing.js';

export interface ChatInputProps {
  value: string;
  cursor: number;
  placeholder: string;
  /** When disabled (a reply is streaming), show a hint instead of the field. */
  disabled: boolean;
}

/**
 * Presentational chat input: a prompt glyph + the current value with a block
 * cursor. All key handling lives in ChatApp's single useInput; this only
 * renders state. Multi-line (pasted) values wrap naturally.
 */
export function ChatInput({ value, cursor, placeholder, disabled }: ChatInputProps): ReactNode {
  const { colors, symbols } = useTheme();
  const prompt = `${symbols.pointer} `;

  if (disabled) {
    return (
      <Box marginTop={1}>
        <Text color={colors.borderSubtle}>{prompt}</Text>
        <Text color={colors.textDim}>streaming… (Ctrl+C to interrupt)</Text>
      </Box>
    );
  }

  if (value.length === 0) {
    return (
      <Box marginTop={1}>
        <Text color={colors.accent} bold>
          {prompt}
        </Text>
        <Text inverse> </Text>
        <Text color={colors.muted}>{` ${placeholder}`}</Text>
      </Box>
    );
  }

  // P6-5: the block cursor takes the whole code point at the cursor
  // (splitAtCursor), never one code unit — a lone surrogate rendered as
  // two U+FFFD glyphs when the cursor sat before an emoji.
  const { before, at, after } = splitAtCursor(value, cursor);
  return (
    <Box marginTop={1}>
      <Text color={colors.accent} bold>
        {prompt}
      </Text>
      <Text color={colors.text}>
        {before}
        <Text inverse>{at}</Text>
        {after}
      </Text>
    </Box>
  );
}
