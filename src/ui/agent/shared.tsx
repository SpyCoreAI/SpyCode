/**
 * Shared presentational pieces for the agent-family TUIs.
 *
 * Extracted VERBATIM from `AgentApp.tsx` so the one-shot `spycore agent`
 * session and the interactive TUI render approvals, diffs and transcript
 * items identically. `AgentApp.tsx` keeps its plan-mode views (PlanView /
 * PlanInputView) and its run orchestration; everything here is plan-agnostic.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { Banner, Notice, type NoticeVariant } from '../components/index.js';
import { Markdown, parseMarkdown } from '../markdown/index.js';
import { useTheme } from '../theme/theme.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { splitHighlight, type TranscriptSearchRender } from '../tui/transcript-search.js';
import type { DiffLine } from '../../lib/agent/diff.js';
import type {
  ApprovalRequest,
  MutationOutcome,
} from '../../lib/agent/approval.js';
import { MODEL_DISPLAY, isModelSlug } from '../../lib/models.js';
import { SpycoreCliError } from '../../lib/errors.js';

export interface MutationInfo {
  outcome: MutationOutcome;
  added: number;
  removed: number;
  isNew: boolean;
}

export interface CommandInfo {
  outcome: 'ran' | 'rejected' | 'blocked';
  ok: boolean;
  /** e.g. "exit 0 (1.2s)" or "timed out after 120s (120.0s)". */
  statusLabel: string;
  /** Capped output tail. */
  tail: string;
}

/** Items committed to <Static> scrollback (each rendered exactly once). */
export type AgentUiItem =
  | { kind: 'banner'; id: number }
  | { kind: 'task'; id: number; task: string; routingLine: string; fullTask?: string }
  | { kind: 'assistant'; id: number; text: string; final: boolean; depth?: number }
  | { kind: 'tool'; id: number; tool: string; arg: string; ok: boolean; summary: string; mutation?: MutationInfo; depth?: number }
  | { kind: 'command'; id: number; command: string; info: CommandInfo; depth?: number }
  | { kind: 'notice'; id: number; variant: NoticeVariant; text: string }
  /** Server-side skills the backend activated (spycore provider only) - a dim one-liner. */
  | { kind: 'skills'; id: number; skills: string[]; depth?: number };

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export const GLYPH_TOOL = '⚙';
export const GLYPH_WRITE = '✚';
export const GLYPH_EDIT = '✎';
export const GLYPH_BLOCK = '⊘';

export function modelLabel(slug: string): string {
  const lc = slug.toLowerCase();
  return isModelSlug(lc) ? MODEL_DISPLAY[lc] : slug;
}

export function errMessage(err: unknown): string {
  if (err instanceof SpycoreCliError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function statLabel(added: number, removed: number): string {
  return removed > 0 ? `+${added} -${removed}` : `+${added}`;
}

/** Clamp a single display line to the content width. */
export function clamp(s: string, width: number): string {
  const max = Math.max(8, width);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One diff line, marker-prefixed and width-clamped, colored by kind. The
 * line text is FILE/MODEL-controlled - sanitized so an escape sequence in a
 * diff can never restyle or overwrite the approval prompt around it. */
export function DiffLineView({ line, width }: { line: DiffLine; width: number }): ReactNode {
  const { colors } = useTheme();
  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'hunk' ? '' : ' ';
  const text = clamp(sanitizeForDisplay(line.kind === 'hunk' ? line.text : `${marker}${line.text}`), width);
  const color =
    line.kind === 'add'
      ? colors.success
      : line.kind === 'del'
        ? colors.error
        : line.kind === 'hunk'
          ? colors.accent
          : colors.muted;
  return <Text color={color}>{text.length > 0 ? text : ' '}</Text>;
}

/** The a/A/r prompt row, shared by write, command, and MCP approvals. Esc also
 * rejects (default-deny); the permanent-allow `[w]` key renders only when the
 * caller supplies an allowlist entry via `always` AND the app allows permanent
 * entries (`allowPermanent`). Today only command approvals derive an
 * allowlist entry (the one-shot agent does; the interactive TUI is
 * session-scope only per the TUI proposal) - MCP and write approvals never
 * receive one, so `[w]` is intentionally not offered for those kinds. */
export function ApprovalPrompt({
  always,
  allowPermanent = false,
}: {
  always?: boolean;
  allowPermanent?: boolean;
}): ReactNode {
  const { colors } = useTheme();
  return (
    <Box marginTop={1}>
      <Text color={colors.accent} bold>[a]</Text>
      <Text color={colors.muted}> accept </Text>
      <Text color={colors.accent} bold>[A]</Text>
      <Text color={colors.muted}> accept all </Text>
      {always && allowPermanent ? (
        <>
          <Text color={colors.accent} bold>[w]</Text>
          <Text color={colors.muted}> always allow </Text>
        </>
      ) : null}
      <Text color={colors.accent} bold>[r]</Text>
      <Text color={colors.muted}> reject </Text>
      <Text color={colors.accent} bold>[Esc]</Text>
      <Text color={colors.muted}> reject (Ctrl+C aborts)</Text>
    </Box>
  );
}

/** Caps for MCP args display serialization - malformed or hostile model output
 * must not bloat memory before the 20-line display truncation. Display-only;
 * approval semantics are unchanged. */
const MCP_ARGS_MAX_DEPTH = 4;
const MCP_ARGS_MAX_STRING = 4000;

/** Depth/length-cap an unknown value for JSON.stringify display. Objects and
 * arrays nested deeper than MCP_ARGS_MAX_DEPTH become a placeholder; strings
 * longer than MCP_ARGS_MAX_STRING are cut with a visible marker. */
function capArgsValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return value.length > MCP_ARGS_MAX_STRING ? `${value.slice(0, MCP_ARGS_MAX_STRING)}…[truncated]` : value;
  }
  if (depth >= MCP_ARGS_MAX_DEPTH) {
    if (Array.isArray(value)) return '[…]';
    if (value !== null && typeof value === 'object') return '{…}';
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => capArgsValue(v, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = capArgsValue(v, depth + 1);
    return out;
  }
  return value;
}

/** The interactive approval block: a write diff, a command, or an MCP call + a/A/r prompt. */
export function ApprovalView({
  req,
  width,
  alwaysEntry,
  confirmingEntry,
  allowPermanent = false,
  expandMcpArgs = false,
}: {
  req: ApprovalRequest;
  width: number;
  /** 1.10: the derived user-allowlist pattern, or null when not offerable.
   * Currently derived for command approvals only; MCP and write approvals
   * never receive one, so `[w]` is intentionally not offered for those kinds. */
  alwaysEntry?: string | null;
  /** 1.10: set while the "always allow" save is awaiting y/n confirmation. */
  confirmingEntry?: string | null;
  /**
   * Whether the permanent-allow `[w]` key is offered. The interactive TUI
   * leaves this off (session scope only); the one-shot agent passes it.
   */
  allowPermanent?: boolean;
  /**
   * MCP approvals: show the full argument list instead of the first 20
   * lines. Wired to the `e` key in the approval context.
   */
  expandMcpArgs?: boolean;
}): ReactNode {
  const { colors } = useTheme();
  if (req.kind === 'command') {
    // The command is rendered IN FULL (ink wraps long lines - no truncation
    // at the approval gate) and sanitized so embedded \r/escapes are visible
    // instead of rewriting the prompt. What's approved is what runs.
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.accent} bold>{'run command'}</Text>
        <Box>
          <Text color={colors.accent} bold>{'$ '}</Text>
          <Text color={colors.text}>{sanitizeForDisplay(req.command)}</Text>
        </Box>
        {confirmingEntry ? (
          // 1.10 confirm step: show EXACTLY what will be written before saving.
          <Box flexDirection="column" marginTop={1}>
            <Text color={colors.text}>
              {`Save to your user allowlist: ${sanitizeForDisplay(confirmingEntry)}`}
            </Text>
            <Text color={colors.muted}>
              {'Future commands matching this literal prefix will run without prompting.'}
            </Text>
            <Box>
              <Text color={colors.accent} bold>[y]</Text>
              <Text color={colors.muted}> save & run </Text>
              <Text color={colors.accent} bold>[n]</Text>
              <Text color={colors.muted}> back</Text>
            </Box>
          </Box>
        ) : (
          <ApprovalPrompt always={alwaysEntry != null} allowPermanent={allowPermanent} />
        )}
      </Box>
    );
  }
  if (req.kind === 'mcp') {
    const argsJson = Object.keys(req.args).length > 0 ? JSON.stringify(capArgsValue(req.args, 0), null, 2) : '(no arguments)';
    const allArgLines = sanitizeForDisplay(argsJson).split('\n');
    const argLines = expandMcpArgs ? allArgLines : allArgLines.slice(0, 20);
    const hiddenArgLines = allArgLines.length - argLines.length;
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.accent} bold>{`MCP tool · ${sanitizeForDisplay(req.server)}`}</Text>
        <Box>
          <Text color={colors.accent} bold>{`${sanitizeForDisplay(req.tool)} `}</Text>
          <Text color={colors.muted}>{`(${sanitizeForDisplay(req.fullName)})`}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {argLines.map((l, i) => (
            <Text key={i} color={colors.muted}>{clamp(l, width) || ' '}</Text>
          ))}
          {hiddenArgLines > 0 ? (
            <Text color={colors.muted}>{`… +${hiddenArgLines} more argument line${hiddenArgLines === 1 ? '' : 's'} [e] expand`}</Text>
          ) : expandMcpArgs && allArgLines.length > 20 ? (
            <Text color={colors.muted}>{'[e] collapse'}</Text>
          ) : null}
        </Box>
        <ApprovalPrompt always={alwaysEntry != null} allowPermanent={allowPermanent} />
      </Box>
    );
  }
  const glyph = req.tool === 'edit_file' ? GLYPH_EDIT : GLYPH_WRITE;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>
        {`${glyph} ${req.tool} ${sanitizeForDisplay(req.path)}${req.isNew ? '  (new file)' : ''}  (${statLabel(req.added, req.removed)})`}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {req.diff.map((line, i) => (
          <DiffLineView key={i} line={line} width={width} />
        ))}
        {req.truncated ? (
          <Text color={colors.muted}>{`… +${req.hiddenLines} more diff line${req.hiddenLines === 1 ? '' : 's'}`}</Text>
        ) : null}
      </Box>
      <ApprovalPrompt always={alwaysEntry != null} allowPermanent={allowPermanent} />
    </Box>
  );
}

export function ItemView({
  item,
  width,
  search,
}: {
  item: AgentUiItem;
  width: number;
  /** Transcript search (Ctrl+F): when set, matching text is highlighted inline. */
  search?: TranscriptSearchRender | null | undefined;
}): ReactNode {
  const { colors, symbols } = useTheme();
  /**
   * Inline search-match highlighting for a plain-text field. The CURRENT hit
   * gets an accent background (bold); other hits a subtle surface. A no-op
   * when the item is not a hit (or no search is open), so non-search renders
   * are untouched.
   */
  const hi = (text: string, color?: string): ReactNode => {
    if (!search || search.query.trim().length === 0 || !search.hitIds.has(item.id)) {
      return <Text color={color}>{text}</Text>;
    }
    const current = search.currentId === item.id;
    return (
      <Text color={color}>
        {splitHighlight(text, search.query).map((seg, i) =>
          seg.match ? (
            <Text key={i} backgroundColor={current ? colors.accent : colors.surface} bold={current}>
              {seg.text}
            </Text>
          ) : (
            <Text key={i}>{seg.text}</Text>
          ),
        )}
      </Text>
    );
  };
  // M3: delegation depth indentation. Sub-agent (depth >= 1) items render
  // with a tree prefix (└ ) so nested runs are visually distinct.
  const depthOf = (d?: number): number => Math.max(0, d ?? 0);
  const depthPrefix = (d?: number): string => {
    const n = depthOf(d);
    if (n <= 0) return '';
    // Tree branch glyph: use └ for unicode, + for ASCII fallback.
    const branch = symbols.arrow === '→' ? '└' : '+';
    return `${'  '.repeat(n - 1)}${branch} `;
  };
  switch (item.kind) {
    case 'banner':
      return <Banner tagline="agent session" />;
    case 'task':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.accent} bold>{`${symbols.pointer} Task`}</Text>
          <Box width={Math.max(1, width - 2)}>{hi(item.task, colors.text)}</Box>
          <Text color={colors.muted}>{`${item.routingLine}  ${symbols.middot}  Ctrl+C to stop`}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column" marginTop={1}>
          {item.final ? <Text color={colors.muted}>{`${depthPrefix(item.depth)}${symbols.success} Result`}</Text> : null}
          <Box paddingLeft={depthOf(item.depth) > 0 ? depthOf(item.depth) * 2 : 0}>
            <Markdown tokens={parseMarkdown(item.text || '_(no content)_')} width={Math.max(8, width - depthOf(item.depth) * 2)} />
          </Box>
        </Box>
      );
    case 'tool': {
      const dp = depthPrefix(item.depth);
      if (item.mutation) {
        const m = item.mutation;
        if (m.outcome === 'applied') {
          const glyph = item.tool === 'edit_file' ? GLYPH_EDIT : GLYPH_WRITE;
          return (
            <Box marginTop={1}>
              <Text color={colors.success}>{`${dp}${glyph} `}</Text>
              <Text color={colors.text}>{item.tool}</Text>
              {item.arg ? <Text color={colors.muted}>{` ${item.arg}`}</Text> : null}
              <Text color={colors.muted}>{`  (${statLabel(m.added, m.removed)})`}</Text>
            </Box>
          );
        }
        const blocked = m.outcome === 'blocked';
        return (
          <Box marginTop={1}>
            <Text color={blocked ? colors.error : colors.warning}>{`${dp}${GLYPH_BLOCK} `}</Text>
            <Text color={colors.muted}>{`${blocked ? 'blocked' : 'rejected'} ${item.tool}${item.arg ? ` ${item.arg}` : ''}`}</Text>
          </Box>
        );
      }
      return (
        <Box marginTop={1}>
          <Text color={item.ok ? colors.accent : colors.error}>{`${dp}${GLYPH_TOOL} `}</Text>
          {hi(item.tool, colors.text)}
          {item.arg ? hi(` ${item.arg}`, colors.muted) : null}
          {hi(`  ${symbols.arrow} ${item.ok ? '' : 'error: '}${item.summary}`, colors.muted)}
        </Box>
      );
    }
    case 'command': {
      const { info } = item;
      const dp = depthPrefix(item.depth);
      const sigilColor =
        info.outcome === 'ran' ? (info.ok ? colors.success : colors.error)
          : info.outcome === 'blocked' ? colors.error
            : colors.warning;
      const status =
        info.outcome === 'rejected' ? 'rejected'
          : info.outcome === 'blocked' ? `blocked (${info.statusLabel})`
            : info.statusLabel;
      const tailLines = info.tail.trim().length > 0 ? info.tail.split('\n').slice(-40) : [];
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={sigilColor} bold>{`${dp}$ `}</Text>
            {/* M3: the clamp must account for the dp tree prefix above, or
                delegated command rows overflow and break tree alignment. */}
            {hi(clamp(item.command, Math.max(8, width - 12 - depthOf(item.depth) * 2)), colors.text)}
            <Text color={colors.muted}>{`  ${symbols.arrow} ${status}`}</Text>
          </Box>
          {tailLines.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2 + depthOf(item.depth) * 2}>
              {tailLines.map((l, i) => (
                // M3: the clamp must account for the depth padding above, or
                // delegated tail lines overflow the padded box and break
                // tree alignment.
                <Box key={i}>{hi(clamp(l, Math.max(8, width - 2 - depthOf(item.depth) * 2)) || ' ', colors.muted)}</Box>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'notice':
      return (
        <Box marginTop={1}>
          <Notice variant={item.variant}>{hi(item.text)}</Notice>
        </Box>
      );
    case 'skills':
      return (
        <Box marginTop={1}>{hi(`${depthPrefix(item.depth)}⚡ skills: ${item.skills.join(', ')}`, colors.muted)}</Box>
      );
  }
}
