import { Box, useApp } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';
import { Banner, Content, MAX_CONTENT_WIDTH, useContentWidth } from '../components/index.js';
import { Markdown, StreamingMarkdown, parseMarkdown } from '../markdown/index.js';

const CONTENT_PADDING = 2;

const STATIC_DOC = [
  '# SpyCode rendering',
  '',
  'A **bold** idea, some *italic*, a bit of ~~struck~~ text, and `inline code` — plus a [link](https://spycore.ai/spycode).',
  '',
  '## Lists',
  '',
  '- First item',
  '- Second item',
  '  - Nested one',
  '  - Nested two',
  '- Third item',
  '',
  '1. Step one',
  '2. Step two',
  '',
  '### Tasks',
  '',
  '- [x] Wire the lexer',
  '- [ ] Stream the tokens',
  '',
  '> A blockquote callout: restrained, muted, on-brand.',
  '',
  '## Table',
  '',
  '| Model  | Tier  | Speed |',
  '|:-------|:-----:|------:|',
  '| Hermes | free  | fast  |',
  '| Charon | elite | deep  |',
  '',
  '---',
  '',
  '```ts',
  'export function greet(name: string): string {',
  '  return `Hello, ${name}`;',
  '}',
  '```',
  '',
].join('\n');

const STREAM_DOC = [
  '## Streaming demo',
  '',
  'Tokens arrive **progressively** and render as `Markdown` live:',
  '',
  '- parse is throttled (~50ms)',
  '- the cursor blinks at the tail',
  '',
  '```js',
  'const streaming = true;',
  'render(tokens);',
  '```',
  '',
].join('\n');

type Mode = 'static' | 'stream';

export interface MarkdownPreviewAppProps {
  autoExitMs: number;
}

/**
 * Showcase for the rendering layer. Mode is env-driven so captures are
 * deterministic:
 *   SPYCODE_MD_MODE=static (default) → full sample doc (every element)
 *   SPYCODE_MD_MODE=stream           → streaming replay; animates live, or
 *     snapshots at SPYCODE_MD_AT=<chars> for a single-frame capture.
 */
export function MarkdownPreviewApp({ autoExitMs }: MarkdownPreviewAppProps): ReactNode {
  const { exit } = useApp();
  const contentWidth = useContentWidth();
  const innerWidth = Math.max(1, contentWidth - CONTENT_PADDING * 2);

  const mode: Mode = process.env.SPYCODE_MD_MODE === 'stream' ? 'stream' : 'static';
  const atEnv = process.env.SPYCODE_MD_AT;
  const snapshotAt = atEnv !== undefined ? Math.max(0, Number.parseInt(atEnv, 10) || 0) : undefined;
  const animate = mode === 'stream' && snapshotAt === undefined;

  const [revealed, setRevealed] = useState<number>(
    snapshotAt ?? (mode === 'stream' ? 0 : STREAM_DOC.length),
  );
  const [streaming, setStreaming] = useState<boolean>(
    mode === 'stream' && (snapshotAt === undefined || snapshotAt < STREAM_DOC.length),
  );

  useEffect(() => {
    if (!animate) return;
    const id = setInterval(() => {
      setRevealed((r) => {
        const next = Math.min(STREAM_DOC.length, r + 5);
        if (next >= STREAM_DOC.length) {
          clearInterval(id);
          setStreaming(false);
        }
        return next;
      });
    }, 40);
    return () => clearInterval(id);
  }, [animate]);

  useEffect(() => {
    if (animate && streaming) return; // wait for the stream to finish first
    const delay = animate ? 1200 : autoExitMs;
    const t = setTimeout(() => exit(), delay);
    return () => clearTimeout(t);
  }, [animate, streaming, autoExitMs, exit]);

  return (
    <Box flexDirection="column" alignItems="flex-start">
      <Content maxWidth={MAX_CONTENT_WIDTH} paddingX={CONTENT_PADDING} paddingTop={1}>
        <Banner tagline="markdown rendering layer" />
        <Box marginTop={1} flexDirection="column">
          {mode === 'static' ? (
            <Markdown tokens={parseMarkdown(STATIC_DOC)} width={innerWidth} />
          ) : (
            <StreamingMarkdown
              content={STREAM_DOC.slice(0, revealed)}
              streaming={streaming}
              width={innerWidth}
            />
          )}
        </Box>
      </Content>
    </Box>
  );
}
