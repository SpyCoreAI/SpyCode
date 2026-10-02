import { useMemo, type ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { useContentWidth } from '../lib/useContentWidth.js';
import { useThrottledValue } from '../lib/useThrottledValue.js';
import { useBlink } from '../lib/useBlink.js';
import { parseMarkdown } from './parse.js';
import { Markdown } from './Markdown.js';

export interface StreamingMarkdownProps {
  /** The accumulating Markdown source. Parents grow this as tokens arrive. */
  content: string;
  /** True while more content is still arriving (drives throttle + cursor). */
  streaming?: boolean;
  /** Content width (defaults to the capped content width). */
  width?: number;
  /** Re-parse cadence while streaming (ms). */
  throttleMs?: number;
}

/**
 * Progressive Markdown renderer for streamed assistant output.
 *
 * While `streaming`, the re-parse is throttled (so we don't re-lex on every
 * token — flicker-free), and a blinking cursor is appended at the tail. Partial
 * Markdown is handled by marked's lexer (an unclosed ``` fence renders as a
 * code block in progress, a half-written `**bold` renders as literal text until
 * closed) — it never crashes or flashes garbage. When `streaming` ends, the
 * full content is parsed once and the cursor is removed for a clean final.
 */
export function StreamingMarkdown({
  content,
  streaming = false,
  width,
  throttleMs = 50,
}: StreamingMarkdownProps): ReactNode {
  const { capabilities } = useTheme();
  const contentWidth = useContentWidth();
  const w = width ?? contentWidth;

  const throttled = useThrottledValue(content, throttleMs);
  const cursorOn = useBlink(530, streaming);

  // Throttle only while streaming; render the final content immediately on stop.
  const effective = streaming ? throttled : content;
  const cursor = capabilities.unicode ? '▍' : '|';
  const source = streaming && cursorOn ? `${effective}${cursor}` : effective;

  const tokens = useMemo(() => parseMarkdown(source), [source]);
  return <Markdown tokens={tokens} width={w} />;
}
