import { Box } from 'ink';
import type { ReactNode } from 'react';
import { Header } from './Header.js';

export interface SectionProps {
  title: string;
  subtitle?: string;
  glyph?: string;
  children: ReactNode;
  /** Left indent for the section body, in cells. */
  indent?: number;
}

/**
 * A header plus its body, with deliberate vertical rhythm: space above the
 * header and the body indented beneath it. Encapsulates the section nesting so
 * surfaces stay consistently spaced.
 */
export function Section({
  title,
  subtitle,
  glyph,
  children,
  indent = 2,
}: SectionProps): ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Header title={title} subtitle={subtitle} glyph={glyph} />
      <Box flexDirection="column" marginTop={1} paddingLeft={indent}>
        {children}
      </Box>
    </Box>
  );
}
