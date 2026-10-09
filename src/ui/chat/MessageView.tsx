import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme, type ResolvedColor } from '../theme/theme.js';
import { Banner, KeyValue, Notice, Panel } from '../components/index.js';
import { CodeBlock, Markdown, parseMarkdown } from '../markdown/index.js';
import { DiffLineView, GLYPH_TOOL, clamp } from '../agent/shared.js';
import type { DiffLine } from '../../lib/agent/diff.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { EFFORT_DESCRIPTION, type EffortLevel } from '../../lib/effort.js';
import { SLASH_HELP } from '../../lib/slash/registry.js';
import type { NoticeVariant } from '../components/index.js';

/**
 * Rendering flavor for a tool result body. The producer picks the flavor that
 * matches the tool; MessageView renders each flavor with its own visual
 * language so a scan of the scrollback shows what each tool did at a glance.
 */
export type ToolResultVariant = 'diff' | 'code' | 'shell' | 'text' | 'error';

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
      /** Wall-clock duration of the finished turn, in ms. Renders the footer. */
      elapsedMs?: number;
      /** Turn outcome. Defaults to 'ok'; 'canceled' when interrupted. */
      status?: 'ok' | 'canceled' | 'error';
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
  | { kind: 'notice'; id: number; variant: NoticeVariant; text: string }
  | {
      kind: 'toolcall';
      id: number;
      /** Tool name (e.g. "read", "exec"). */
      tool: string;
      /** Short human summary of the call, e.g. the file path or command. */
      label?: string;
    }
  | {
      kind: 'toolresult';
      id: number;
      /** Tool name, matching the preceding `toolcall`. */
      tool: string;
      /** Which visual language to render the result body in. */
      variant: ToolResultVariant;
      /** Whether the tool reported success. Colors the header. */
      ok: boolean;
      /** Body text for the `code` / `shell` / `text` / `error` variants. */
      text?: string;
      /** Language hint for the `code` variant (e.g. "ts", "json"). */
      language?: string;
      /** Pre-computed diff lines for the `diff` variant (rendered per-line). */
      diff?: DiffLine[];
      /** Lines hidden by the producer's own cap; folded into the cap note. */
      hiddenLines?: number;
    };

export interface MessageViewProps {
  item: ChatItem;
  width: number;
  /**
   * Nesting depth for delegated (sub-agent) turns. Each level indents the
   * message with a muted tree glyph (`└`). 0 (default) renders flat.
   */
  depth?: number;
}

/** Max rendered lines for a tool result body before the "…N more lines" cap. */
const TOOL_RESULT_MAX_LINES = 50;

/**
 * A thick colored left rail around message content. Role-colored borders are
 * the message visual language: assistant = primary accent, user = deep
 * malachite, tool traffic = dim gray. Falls back to the ASCII classic style
 * on terminals without Unicode.
 */
function LeftRail({
  color,
  width,
  children,
}: {
  color: ResolvedColor;
  width: number;
  children: ReactNode;
}): ReactNode {
  const { capabilities } = useTheme();
  return (
    <Box
      borderStyle={capabilities.unicode ? 'bold' : 'classic'}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={color}
      paddingLeft={1}
      width={Math.max(1, width)}
    >
      {children}
    </Box>
  );
}

/** Human duration for the assistant footer: "4.2s", "1m 23s". */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${(ms / 1000).toFixed(1)}s`;
  const total = ms / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${Math.round(total % 60)}s`;
}

/** Split text into display lines, capped at `max` with a hidden-line count. */
function cappedTextLines(
  text: string | undefined,
  max: number,
): { lines: string[]; hidden: number } {
  const all = (text ?? '').replace(/\n+$/, '').split('\n');
  return { lines: all.slice(0, max), hidden: Math.max(0, all.length - max) };
}

/** The muted "…N more lines" cap indicator. Renders nothing when `hidden` is 0. */
function MoreLines({ hidden }: { hidden: number }): ReactNode {
  const { colors } = useTheme();
  if (hidden <= 0) return null;
  return <Text color={colors.muted}>{`…${hidden} more line${hidden === 1 ? '' : 's'}`}</Text>;
}

/** Renders the body of a `toolresult` item in its variant's visual language. */
function ToolResultBody({
  item,
  width,
}: {
  item: Extract<ChatItem, { kind: 'toolresult' }>;
  width: number;
}): ReactNode {
  const { colors } = useTheme();
  const innerWidth = Math.max(8, width - 2); // inside the left rail
  const errorTint = item.variant === 'error' || !item.ok;
  const bodyColor = errorTint && item.variant !== 'diff' ? colors.error : undefined;

  if (item.variant === 'diff') {
    const lines = item.diff ?? [];
    const shown = lines.slice(0, TOOL_RESULT_MAX_LINES);
    const hidden = (item.hiddenLines ?? 0) + Math.max(0, lines.length - shown.length);
    return (
      <Box flexDirection="column">
        {shown.map((line, i) => (
          <DiffLineView key={i} line={line} width={innerWidth} />
        ))}
        <MoreLines hidden={hidden} />
      </Box>
    );
  }

  if (item.variant === 'code') {
    const { lines, hidden } = cappedTextLines(item.text, TOOL_RESULT_MAX_LINES);
    return (
      <Box flexDirection="column">
        <CodeBlock
          code={lines.map((l) => sanitizeForDisplay(l)).join('\n')}
          lang={item.language}
          width={innerWidth}
        />
        <MoreLines hidden={hidden + (item.hiddenLines ?? 0)} />
      </Box>
    );
  }

  if (item.variant === 'shell') {
    const { lines, hidden } = cappedTextLines(item.text, TOOL_RESULT_MAX_LINES);
    return (
      <Box flexDirection="column">
        <Box flexDirection="column" backgroundColor={colors.surface} paddingX={1}>
          {lines.map((line, i) => (
            <Text key={i} color={bodyColor ?? colors.text}>
              {clamp(sanitizeForDisplay(line), innerWidth - 2) || ' '}
            </Text>
          ))}
        </Box>
        <MoreLines hidden={hidden + (item.hiddenLines ?? 0)} />
      </Box>
    );
  }

  // 'text' (searches/listings) and 'error': quiet line-per-line text.
  const { lines, hidden } = cappedTextLines(item.text, TOOL_RESULT_MAX_LINES);
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Text key={i} color={bodyColor ?? colors.muted}>
          {clamp(sanitizeForDisplay(line), innerWidth) || ' '}
        </Text>
      ))}
      <MoreLines hidden={hidden + (item.hiddenLines ?? 0)} />
    </Box>
  );
}

/** Renders one committed chat item (no outer spacing - the wrapper adds it). */
function MessageViewBody({ item, width }: MessageViewProps): ReactNode {
  const { colors, symbols } = useTheme();
  const w = Math.max(8, width);

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
        <Panel variant="bordered" title="Commands" titleGlyph={symbols.section}>
          <KeyValue items={SLASH_HELP.map((c) => ({ label: c.command, value: c.summary }))} />
        </Panel>
      );

    case 'effort':
      return (
        <Panel variant="bordered" title={`Effort · ${sanitizeForDisplay(item.model)}`} titleGlyph={symbols.section}>
          <KeyValue
            items={item.levels.map((level) => ({
              label: level === item.current ? `${level} (current)` : level,
              value: EFFORT_DESCRIPTION[level],
            }))}
          />
        </Panel>
      );

    case 'memory':
      return (
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
                <Text key={i} color={colors.muted}>{`! ${sanitizeForDisplay(n)}`}</Text>
              ))}
            </Box>
          )}
        </Panel>
      );

    case 'guide':
      return (
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
      );

    case 'changelog':
      return (
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
                  <Markdown tokens={parseMarkdown(sanitizeForDisplay(item.text))} width={w} />
                </Box>
              ) : null}
            </Box>
          )}
        </Panel>
      );

    case 'user':
      return (
        <LeftRail color={colors.accentSubtle} width={w}>
          <Box flexDirection="row">
            <Text color={colors.accent} bold>{`${symbols.pointer} `}</Text>
            <Box width={Math.max(1, w - 4)}>
              <Text color={colors.text}>{sanitizeForDisplay(item.text)}</Text>
            </Box>
          </Box>
        </LeftRail>
      );

    case 'assistant': {
      const header = `${symbols.diamond} ${sanitizeForDisplay(item.model)}`;
      const skills = item.skills.length > 0 ? `  ${symbols.middot}  skills: ${sanitizeForDisplay(item.skills.join(', '))}` : '';
      const statusWord =
        item.status === 'error'
          ? 'error'
          : item.status === 'canceled' || item.interrupted
            ? 'canceled'
            : undefined;
      const elapsed = item.elapsedMs === undefined ? undefined : formatElapsed(item.elapsedMs);
      const showFooter = elapsed !== undefined || statusWord !== undefined;
      return (
        <LeftRail color={colors.accent} width={w}>
          <Box flexDirection="column">
            <Text color={colors.muted}>
              {header}
              {skills}
              {item.interrupted ? `  ${symbols.middot}  interrupted` : ''}
            </Text>
            <Markdown tokens={parseMarkdown(sanitizeForDisplay(item.content) || '_(no content)_')} width={Math.max(8, w - 2)} />
            {showFooter ? (
              <Box marginTop={1}>
                <Text color={colors.muted}>
                  {`${symbols.diamond} ${item.model}`}
                  {elapsed ? ` ${symbols.middot} ${elapsed}` : ''}
                  {statusWord ? ` ${symbols.middot} ${statusWord}` : ''}
                </Text>
              </Box>
            ) : null}
          </Box>
        </LeftRail>
      );
    }

    case 'error':
      return (
        <Box flexDirection="column">
          <Notice variant="error">{sanitizeForDisplay(item.message)}</Notice>
          {item.hint ? (
            <Box paddingLeft={2}>
              <Text color={colors.muted}>{sanitizeForDisplay(item.hint)}</Text>
            </Box>
          ) : null}
        </Box>
      );

    case 'notice':
      return (
        <Box>
          <Notice variant={item.variant}>{sanitizeForDisplay(item.text)}</Notice>
        </Box>
      );

    case 'toolcall':
      return (
        <LeftRail color={colors.muted} width={w}>
          <Text color={colors.muted}>
            {`${GLYPH_TOOL} ${sanitizeForDisplay(item.tool)}${item.label ? ` ${sanitizeForDisplay(item.label)}` : ''}`}
          </Text>
        </LeftRail>
      );

    case 'toolresult':
      return (
        <LeftRail color={colors.muted} width={w}>
          <Box flexDirection="column">
            <Text color={item.ok ? colors.accent : colors.error}>
              {`${item.ok ? symbols.success : symbols.error} ${sanitizeForDisplay(item.tool)}`}
            </Text>
            <Box marginTop={1}>
              <ToolResultBody item={item} width={w} />
            </Box>
          </Box>
        </LeftRail>
      );

    default:
      return null;
  }
}

/** Muted tree prefix for nested (delegated) messages, e.g. `└ ` or `  └ `. */
function depthPrefix(depth: number, unicode: boolean): string {
  if (depth <= 0) return '';
  return `${'  '.repeat(depth - 1)}${unicode ? '└' : '+'} `;
}

/**
 * Renders one committed chat item with role-colored rails, typed tool results,
 * and optional delegation-depth indentation.
 */
export function MessageView({ item, width, depth = 0 }: MessageViewProps): ReactNode {
  const { colors, capabilities } = useTheme();
  const prefix = depthPrefix(depth, capabilities.unicode);
  const w = Math.max(8, width - prefix.length);

  if (depth > 0) {
    return (
      <Box flexDirection="row" marginTop={1}>
        <Text color={colors.muted}>{prefix}</Text>
        <Box flexDirection="column" width={Math.max(1, w)}>
          <MessageViewBody item={item} width={w} />
        </Box>
      </Box>
    );
  }
  return (
    <Box marginTop={1}>
      <MessageViewBody item={item} width={w} />
    </Box>
  );
}
