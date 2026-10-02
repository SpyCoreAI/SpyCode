import { Box } from 'ink';
import type { ReactNode } from 'react';
import { useTerminalSize } from '../lib/useTerminalSize.js';
import { MAX_CONTENT_WIDTH } from '../lib/useContentWidth.js';

export interface ContentProps {
  children: ReactNode;
  /** Cap the content width on wide terminals (defaults to 96). */
  maxWidth?: number;
  /** Horizontal padding inside the content column, in cells. */
  paddingX?: number;
  /** Top padding, in cells. */
  paddingTop?: number;
}

/**
 * A left-aligned content column constrained to `maxWidth` on wide terminals
 * (full width when narrower). The shared layout primitive that keeps section
 * rules, panels and headers from stretching edge-to-edge — future screens
 * (chat/agent) wrap their body in this to inherit the same measure.
 */
export function Content({
  children,
  maxWidth = MAX_CONTENT_WIDTH,
  paddingX = 0,
  paddingTop = 0,
}: ContentProps): ReactNode {
  const { width } = useTerminalSize();
  return (
    <Box
      width={Math.min(width, maxWidth)}
      flexDirection="column"
      paddingX={paddingX}
      paddingTop={paddingTop}
    >
      {children}
    </Box>
  );
}
