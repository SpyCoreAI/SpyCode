/**
 * Presentational composer: a prompt glyph + the draft with a block cursor.
 * All key handling lives in TuiApp's single useInput (the ChatInput idiom);
 * this only renders state. Multiline: the value's `\n`s become rows, the
 * prompt glyph sits on the first row, continuation rows are indented.
 *
 * D-G (v0.9.0): the anchored completion sheet. Pass `suggestions` (fed from
 * the EXISTING completion logic in TuiApp - nothing about how suggestions are
 * computed lives here, per the item's "do not rewrite completion logic"
 * constraint) and the sheet renders DIRECTLY above the input: sized to
 * `sheetWidth`, bordered ONLY on its top edge, so it reads as a sheet
 * growing out of the input.
 *
 * D-H (v0.9.0): attachment pills. Pass `attachments` (the pending queue, e.g.
 * `LocalAttachment`s mapped to display-path + kind) and each file renders as
 * a small rounded pill in the composer preview area below the draft: a
 * document glyph + the truncated filename. Pass `attachmentSelectMode` when
 * the delete/navigation layer is armed - every pill then shows its index
 * number and `attachmentSelectIndex` marks the armed pill. Removal itself
 * stays with the owning keybinding layer; this only renders state.
 *
 * WIRING (for the worker owning TuiApp.tsx): feed `suggestions` from the
 * existing `suggestions` list and `sheetWidth={contentWidth}`; feed
 * `attachments` from `PendingAttachments.snapshot()`. When the new props are
 * absent the composer renders exactly as before.
 */
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import type { Theme } from '../theme/theme.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { locateCursor } from './editing.js';

export type ComposerMode = 'normal' | 'shell';

/** One row of the completion sheet (an @-mention file or a /command). */
export interface CompletionSuggestion {
  /** Row text, e.g. `@src/ui/tui/composer.tsx` or `/attach - attach a file`. */
  text: string;
  /** The highlighted candidate - the row Tab would accept. */
  selected?: boolean | undefined;
}

/** A pending attachment, as rendered in the composer preview area. */
export interface AttachmentPill {
  /** Display path (`LocalAttachment.displayPath`): relative-to-cwd, or basename. */
  displayPath: string;
  kind: 'image' | 'text';
}

export interface TuiComposerProps {
  value: string;
  cursor: number;
  placeholder: string;
  mode: ComposerMode;
  /** While a run is in flight the composer is read-only. */
  disabled: boolean;
  /** Shown in place of the field while disabled. */
  disabledHint: string;
  /** D-G: completion rows; when present the sheet anchors above the input. */
  suggestions?: CompletionSuggestion[] | undefined;
  /** D-G: input width the sheet is sized to. */
  sheetWidth?: number | undefined;
  /** D-G: dim hint rendered inside the sheet, just above the input. */
  sheetHint?: string | undefined;
  /** D-H: pending attachments rendered as pills below the draft. */
  attachments?: AttachmentPill[] | undefined;
  /** D-H: delete/navigation mode - every pill shows its index number. */
  attachmentSelectMode?: boolean | undefined;
  /** D-H: the armed pill in select mode (null/undefined = none). */
  attachmentSelectIndex?: number | null | undefined;
}

/** Document glyph for attachment pills (Unicode where supported). */
const DOCUMENT_GLYPH_UNICODE = '🗎';
const DOCUMENT_GLYPH_ASCII = 'doc';

/** Max filename chars inside a pill before middle-truncation kicks in. */
const MAX_PILL_FILENAME_CHARS = 28;

/**
 * Middle-truncate a filename so the extension stays visible:
 * `very-long-component-name.tsx` -> `very-long-compon…e.tsx`.
 * Code-point aware: never splits a surrogate pair.
 */
function truncateFilename(name: string, max: number, ellipsis: string): string {
  const cps = [...name];
  if (cps.length <= max) return name;
  const ellLen = [...ellipsis].length;
  const tail = Math.floor((max - ellLen) / 3);
  const head = max - ellLen - tail;
  return `${cps.slice(0, head).join('')}${ellipsis}${cps.slice(cps.length - tail).join('')}`;
}

/** Hard cap on completion-sheet rows so the sheet never pushes the input away. */
const MAX_SHEET_ROWS = 8;

/**
 * Truncate one sheet row to the sheet width. Code-point aware; no-op when
 * the sheet width is unknown (the caller did not pass `sheetWidth`).
 */
function fitSheetRow(text: string, maxWidth: number | undefined, ellipsis: string): string {
  const clean = sanitizeForDisplay(text);
  if (maxWidth === undefined) return clean;
  const cps = [...clean];
  const ellLen = [...ellipsis].length;
  return cps.length > maxWidth
    ? `${cps.slice(0, Math.max(0, maxWidth - ellLen)).join('')}${ellipsis}`
    : clean;
}

interface SheetProps {
  theme: Theme;
  suggestions: CompletionSuggestion[];
  width: number | undefined;
  hint: string | undefined;
}

/**
 * D-G: the anchored completion sheet. Sized to the input width, bordered
 * ONLY on its top edge (Ink per-side borders) in `borderStrong` - every other
 * side is explicitly off, so the sheet reads as growing out of the input.
 * The selected row fills the sheet width on `surface` with an accent pointer.
 */
function CompletionSheet({ theme, suggestions, width, hint }: SheetProps): ReactNode {
  const { colors, symbols, borderStyle, capabilities } = theme;
  const ellipsis = capabilities.unicode ? '…' : '...';
  // The sheet is capped at MAX_SHEET_ROWS; each row's text is truncated to
  // the sheet width minus the pointer gutter (glyph + space).
  const textWidth = width === undefined ? undefined : Math.max(1, width - 2);
  return (
    <Box width={width} marginTop={1}>
      <Box
        flexDirection="column"
        width={width}
        borderStyle={borderStyle}
        borderTop
        borderBottom={false}
        borderLeft={false}
        borderRight={false}
        borderColor={colors.borderStrong}
      >
        {suggestions.slice(0, MAX_SHEET_ROWS).map((s, i) => (
          <Box key={`${i}:${s.text}`} width="100%">
            {s.selected ? (
              <Box width="100%" backgroundColor={colors.surface}>
                <Text color={colors.accent} bold>
                  {`${symbols.pointer} `}
                </Text>
                <Text color={colors.text} bold>
                  {fitSheetRow(s.text, textWidth, ellipsis)}
                </Text>
              </Box>
            ) : (
              <Text color={colors.muted}>{`  ${fitSheetRow(s.text, textWidth, ellipsis)}`}</Text>
            )}
          </Box>
        ))}
        {hint ? <Text color={colors.textDim}>{`  ${fitSheetRow(hint, textWidth, ellipsis)}`}</Text> : null}
      </Box>
    </Box>
  );
}

interface PillsProps {
  theme: Theme;
  attachments: AttachmentPill[];
  selectMode: boolean;
  selectedIndex: number | null | undefined;
}

/**
 * D-H: attachment pills. One line of rounded pills (parentheses in
 * `borderSubtle`), each a document glyph + the sanitized, middle-truncated
 * filename. In select mode every pill is prefixed with its 1-based index in
 * accent; the armed pill is bold on `surface`.
 */
function AttachmentPills({ theme, attachments, selectMode, selectedIndex }: PillsProps): ReactNode {
  const { colors, capabilities } = theme;
  const unicode = capabilities.unicode;
  const glyph = unicode ? DOCUMENT_GLYPH_UNICODE : DOCUMENT_GLYPH_ASCII;
  const ellipsis = unicode ? '…' : '...';
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
      {attachments.map((att, i) => {
        const armed = selectMode && selectedIndex === i;
        const name = truncateFilename(
          sanitizeForDisplay(att.displayPath),
          MAX_PILL_FILENAME_CHARS,
          ellipsis,
        );
        return (
          <Text key={`${i}:${att.displayPath}`} backgroundColor={armed ? colors.surface : undefined}>
            <Text color={colors.borderSubtle}>(</Text>
            {selectMode ? (
              <Text color={armed ? colors.accent : colors.muted} bold={armed}>
                {` ${i + 1} `}
              </Text>
            ) : null}
            <Text color={armed ? colors.accent : colors.textDim}>{`${glyph} `}</Text>
            <Text color={armed ? colors.text : colors.textDim} bold={armed}>
              {name}
            </Text>
            <Text color={colors.borderSubtle}>)</Text>
          </Text>
        );
      })}
    </Box>
  );
}

export function TuiComposer({
  value,
  cursor,
  placeholder,
  mode,
  disabled,
  disabledHint,
  suggestions,
  sheetWidth,
  sheetHint,
  attachments,
  attachmentSelectMode,
  attachmentSelectIndex,
}: TuiComposerProps): ReactNode {
  const theme = useTheme();
  const { colors, symbols } = theme;
  const prompt = mode === 'shell' ? '$ ' : `${symbols.pointer} `;
  const promptColor = mode === 'shell' ? colors.warning : colors.accent;

  const showSheet = (suggestions?.length ?? 0) > 0;
  const showPills = (attachments?.length ?? 0) > 0;
  // The sheet floats DIRECTLY above the input: no gap between sheet and
  // field, so the field drops its own top margin while the sheet is up.
  const fieldMarginTop = showSheet ? 0 : 1;

  let field: ReactNode;
  if (disabled) {
    field = (
      <Box marginTop={fieldMarginTop}>
        <Text color={colors.borderSubtle}>{prompt}</Text>
        <Text color={colors.textDim}>{disabledHint}</Text>
      </Box>
    );
  } else if (value.length === 0) {
    field = (
      <Box marginTop={fieldMarginTop}>
        <Text color={promptColor} bold>
          {prompt}
        </Text>
        <Text inverse> </Text>
        <Text color={colors.muted}>{` ${placeholder}`}</Text>
      </Box>
    );
  } else {
    const lines = value.split('\n');
    const { line: cursorLine, col: cursorCol } = locateCursor(value, cursor);
    field = (
      <Box flexDirection="column" marginTop={fieldMarginTop}>
        {lines.map((line, i) => {
          const isCursorLine = i === cursorLine;
          const before = isCursorLine ? line.slice(0, cursorCol) : line;
          const at = isCursorLine ? line.slice(cursorCol, cursorCol + 1) || ' ' : null;
          const after = isCursorLine ? line.slice(cursorCol + 1) : null;
          return (
            <Box key={i}>
              {i === 0 ? (
                <Text color={promptColor} bold>
                  {prompt}
                </Text>
              ) : (
                <Text>{' '.repeat(prompt.length)}</Text>
              )}
              {isCursorLine ? (
                <Text color={colors.text}>
                  {before}
                  <Text inverse>{at}</Text>
                  {after}
                </Text>
              ) : (
                <Text color={colors.text}>{line.length > 0 ? line : ' '}</Text>
              )}
            </Box>
          );
        })}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {showSheet ? (
        <CompletionSheet
          theme={theme}
          suggestions={suggestions ?? []}
          width={sheetWidth}
          hint={sheetHint}
        />
      ) : null}
      {field}
      {showPills ? (
        <AttachmentPills
          theme={theme}
          attachments={attachments ?? []}
          selectMode={attachmentSelectMode ?? false}
          selectedIndex={attachmentSelectIndex ?? null}
        />
      ) : null}
    </Box>
  );
}
