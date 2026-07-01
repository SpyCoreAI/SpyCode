import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { highlight, supportsLanguage } from 'cli-highlight';
import { useTheme } from '../theme/theme.js';
import { useContentWidth } from '../lib/useContentWidth.js';

export interface CodeBlockProps {
  code: string;
  /** Language hint for syntax highlighting (e.g. "ts", "python"). */
  lang?: string;
  /** Width to constrain the block to (defaults to the content width). */
  width?: number;
}

/**
 * A fenced code block in a quiet bordered container with a dim language label.
 * Syntax highlighting comes from cli-highlight (its ANSI renders fine inside an
 * Ink <Text>); falls back to plain themed text when color is off or the
 * language is unknown. No window chrome, no traffic-light dots, no gradient.
 */
export function CodeBlock({ code, lang, width }: CodeBlockProps): ReactNode {
  const { colors, borderStyle, capabilities } = useTheme();
  const fallbackWidth = useContentWidth();
  const w = width ?? fallbackWidth;
  const useColor = capabilities.colorLevel !== 'none';

  let body = code;
  if (useColor) {
    // Only invoke the highlighter for a language it actually knows. Asking
    // highlight.js for an unregistered language (e.g. a pseudo-language like
    // `spycore:tool`, or anything with a colon) makes it log
    // "Could not find the language …" to the console AND throw — the throw is
    // caught below, but the log still floods the screen on every streaming
    // re-render. A missing language is fine: we let it auto-detect.
    const lc = lang?.trim();
    const canHighlight = !lc || (!lc.includes(':') && supportsLanguage(lc));
    if (canHighlight) {
      try {
        body = highlight(code, { language: lc || undefined, ignoreIllegals: true });
      } catch {
        body = code;
      }
    }
  }
  const lines = body.replace(/\n+$/, '').split('\n');

  return (
    <Box
      flexDirection="column"
      width={w}
      borderStyle={borderStyle}
      borderColor={colors.borderSubtle}
      paddingX={1}
    >
      {lang ? <Text color={colors.muted}>{lang}</Text> : null}
      {lines.map((line, i) =>
        useColor ? (
          <Text key={i}>{line.length > 0 ? line : ' '}</Text>
        ) : (
          <Text key={i} color={colors.text}>
            {line.length > 0 ? line : ' '}
          </Text>
        ),
      )}
    </Box>
  );
}
