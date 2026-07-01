import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { Banner, KeyValue, Notice, Panel } from '../components/index.js';
import { Markdown, parseMarkdown } from '../markdown/index.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { EFFORT_DESCRIPTION, type EffortLevel } from '../../lib/effort.js';
import { SLASH_HELP } from '../../lib/slash/registry.js';
import type { NoticeVariant } from '../components/index.js';

/** A committed history item. Completed items commit to <Static> scrollback. */
export type ChatItem =
  | { kind: 'banner'; id: number }
  | { kind: 'help'; id: number }
  | {
      kind: 'effort';
      id: number;
      /** Display name of the model the levels apply to. */
      model: string;
      /** The currently-selected effort level. */
      current: EffortLevel;
      /** The levels this model supports, in ladder order. */
      levels: EffortLevel[];
    }
  | { kind: 'user'; id: number; text: string }
  | {
      kind: 'assistant';
      id: number;
      content: string;
      model: string;
      skills: string[];
      interrupted?: boolean;
    }
  | {
      kind: 'memory';
      id: number;
      /** One row per injected context part (memory files + guide + changelog). */
      parts: Array<{ label: string; detail: string }>;
      /** Total characters injected into context. */
      totalChars: number;
      /** Notes (dropped/truncated parts, skipped imports). */
      notices: string[];
    }
  | {
      kind: 'guide';
      id: number;
      /** Whether CODEBASE_GUIDE.md exists at the project root. */
      exists: boolean;
      /** Absolute path it lives at (or would live at). */
      path: string;
      /** Line count of the file (0 when absent). */
      lines: number;
    }
  | {
      kind: 'changelog';
      id: number;
      /** Whether CODEBASE_CHANGELOG.md exists at the project root. */
      exists: boolean;
      /** Absolute path it lives at (or would live at). */
      path: string;
      /** Line count of the file (0 when absent). */
      lines: number;
      /** Total entries in the file. */
      entryCount: number;
      /** Entries shown in `text`. */
      shownEntryCount: number;
      /** The most-recent entries rendered as markdown. */
      text: string;
    }
  | { kind: 'error'; id: number; message: string; hint?: string | undefined }
  | { kind: 'notice'; id: number; variant: NoticeVariant; text: string };

export interface MessageViewProps {
  item: ChatItem;
  width: number;
}

/** Renders one committed chat item. */
export function MessageView({ item, width }: MessageViewProps): ReactNode {
  const { colors, symbols } = useTheme();

  switch (item.kind) {
    case 'banner':
      return (
        <Box flexDirection="column">
          <Banner tagline="interactive session" />
          <Box marginTop={1}>
            <Text color={colors.muted}>
              {`Type a message and press Enter  ${symbols.middot}  /help for commands  ${symbols.middot}  Ctrl+C to exit`}
            </Text>
          </Box>
        </Box>
      );

    case 'help':
      return (
        <Box marginTop={1}>
          <Panel variant="bordered" title="Commands" titleGlyph={symbols.section}>
            <KeyValue items={SLASH_HELP.map((c) => ({ label: c.command, value: c.summary }))} />
          </Panel>
        </Box>
      );

    case 'effort':
      return (
        <Box marginTop={1}>
          <Panel
            variant="bordered"
            title={`Effort · ${item.model}`}
            titleGlyph={symbols.section}
          >
            <KeyValue
              items={item.levels.map((level) => ({
                label: level === item.current ? `${level} (current)` : level,
                value: EFFORT_DESCRIPTION[level],
              }))}
            />
          </Panel>
        </Box>
      );

    case 'memory':
      return (
        <Box marginTop={1}>
          <Panel variant="bordered" title="Project context" titleGlyph={symbols.section}>
            {item.parts.length === 0 ? (
              <Text color={colors.muted}>
                No project context loaded · /init to generate SPYCODE.md, CODEBASE_GUIDE.md and CODEBASE_CHANGELOG.md
              </Text>
            ) : (
              <Box flexDirection="column">
                <KeyValue
                  items={item.parts.map((p) => ({ label: p.label, value: p.detail }))}
                />
                <Text color={colors.muted}>{`Total injected: ${item.totalChars} chars`}</Text>
                {item.notices.map((n, i) => (
                  <Text key={i} color={colors.muted}>{`! ${n}`}</Text>
                ))}
              </Box>
            )}
          </Panel>
        </Box>
      );

    case 'guide':
      return (
        <Box marginTop={1}>
          <Panel variant="bordered" title="Codebase guide" titleGlyph={symbols.section}>
            {item.exists ? (
              <Box flexDirection="column">
                <KeyValue
                  items={[
                    {
                      label: item.path,
                      value: `${item.lines} line${item.lines === 1 ? '' : 's'}`,
                    },
                  ]}
                />
                <Text color={colors.muted}>Regenerate from a fresh scan with /guide refresh</Text>
              </Box>
            ) : (
              <Text color={colors.muted}>
                No CODEBASE_GUIDE.md · /init to generate one, /guide refresh to (re)create it
              </Text>
            )}
          </Panel>
        </Box>
      );

    case 'changelog':
      return (
        <Box marginTop={1}>
          <Panel variant="bordered" title="Recent changes" titleGlyph={symbols.section}>
            {!item.exists ? (
              <Text color={colors.muted}>
                No CODEBASE_CHANGELOG.md · /init to generate one
              </Text>
            ) : (
              <Box flexDirection="column">
                <Text color={colors.muted}>
                  {`${item.path} · ${item.lines} line${item.lines === 1 ? '' : 's'} · ${
                    item.entryCount === 0
                      ? 'no entries yet'
                      : `${item.shownEntryCount} most recent of ${item.entryCount} entr${item.entryCount === 1 ? 'y' : 'ies'}`
                  }`}
                </Text>
                {item.text.trim().length > 0 ? (
                  <Box marginTop={1}>
                    <Markdown tokens={parseMarkdown(sanitizeForDisplay(item.text))} width={width} />
                  </Box>
                ) : null}
              </Box>
            )}
          </Panel>
        </Box>
      );

    case 'user':
      return (
        <Box marginTop={1}>
          <Text color={colors.accent} bold>{`${symbols.pointer} `}</Text>
          <Box width={Math.max(1, width - 2)}>
            <Text color={colors.text}>{item.text}</Text>
          </Box>
        </Box>
      );

    case 'assistant': {
      const header = `${symbols.diamond} ${item.model}`;
      const skills = item.skills.length > 0 ? `  ${symbols.middot}  skills: ${item.skills.join(', ')}` : '';
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.muted}>
            {header}
            {skills}
            {item.interrupted ? `  ${symbols.middot}  interrupted` : ''}
          </Text>
          <Markdown tokens={parseMarkdown(sanitizeForDisplay(item.content) || '_(no content)_')} width={width} />
        </Box>
      );
    }

    case 'error':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Notice variant="error">{item.message}</Notice>
          {item.hint ? (
            <Box paddingLeft={2}>
              <Text color={colors.muted}>{item.hint}</Text>
            </Box>
          ) : null}
        </Box>
      );

    case 'notice':
      return (
        <Box marginTop={1}>
          <Notice variant={item.variant}>{item.text}</Notice>
        </Box>
      );
  }
}
