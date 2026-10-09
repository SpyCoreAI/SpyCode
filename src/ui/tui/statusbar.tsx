/**
 * The TUI's bottom status bar: `model · tasks · turns · cwd`, plus a
 * context-warning pill and a transient toast row.
 *
 * Graceful degradation (the 80-column rule): usage segments drop from the
 * right as the terminal narrows - turns first, then tasks, then tokens; the
 * model chip is the LAST thing to go and is truncated rather than dropped.
 * Truecolor/256 → a quiet filled bar; 16-color/no-color → a ruled bar.
 *
 * Context warning: when the caller passes `contextPct` at or above the
 * context-meter's 80% threshold, the token segment flips to the theme's
 * warning color with a ⚠ glyph and the percentage (e.g. `⚠ ↑ 110K · 82%`).
 *
 * Toasts: any component can call `toast('text', 'warning')`; the latest toast
 * renders as a full-width colored row above the bar and auto-clears after
 * `TOAST_DURATION_MS` (default 4s).
 */
import { Box, Text } from 'ink';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { useTerminalSize } from '../lib/useTerminalSize.js';
import { Separator } from '../components/Separator.js';
import { palette } from '../theme/tokens.js';
import { CONTEXT_WARN_PCT } from '../../lib/context-meter.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';

export type HintState = 'idle' | 'running' | 'approval';

/** Default lifetime of a toast, in milliseconds. */
export const TOAST_DURATION_MS = 4000;

/** Toast severity - maps onto the theme's info/warning/error tokens. */
export type ToastKind = 'info' | 'warning' | 'error';

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  text: string;
}

type ToastListener = (toast: ToastMessage | null) => void;

const toastListeners = new Set<ToastListener>();
let toastSeq = 0;
let currentToast: ToastMessage | null = null;

function emitToast(): void {
  for (const listener of [...toastListeners]) listener(currentToast);
}

/**
 * Show a transient toast in the status-bar toast row. The latest toast wins;
 * it auto-clears after `timeoutMs` (default 4s). Pass `timeoutMs <= 0` for a
 * sticky toast (cleared by the next `toast()` call or `clearToast()`).
 *
 * Other components call this directly - no props need to be threaded through.
 */
export function toast(
  text: string,
  kind: ToastKind = 'info',
  timeoutMs: number = TOAST_DURATION_MS,
): void {
  const message: ToastMessage = { id: ++toastSeq, kind, text };
  currentToast = message;
  emitToast();
  if (timeoutMs > 0) {
    const id = message.id;
    const timer = setTimeout(() => {
      if (currentToast?.id === id) {
        currentToast = null;
        emitToast();
      }
    }, timeoutMs);
    // Never keep the process alive just for a toast.
    (timer as unknown as { unref?: () => void }).unref?.();
  }
}

/** Dismiss the active toast immediately. */
export function clearToast(): void {
  currentToast = null;
  emitToast();
}

/**
 * Subscribe the status bar (or anything else) to the toast bus. Returns the
 * latest toast, or null when none is active.
 */
export function useToast(): ToastMessage | null {
  const [active, setActive] = useState<ToastMessage | null>(() => currentToast);
  useEffect(() => {
    toastListeners.add(setActive);
    setActive(currentToast);
    return () => {
      toastListeners.delete(setActive);
    };
  }, []);
  return active;
}

function cpLen(s: string): number {
  return [...s].length;
}

/**
 * Compact token count for the status bar (e.g. 999, 1.2k, 12.4k).
 * Manual grouping - locale-independent, deterministic output.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return `${Math.round(n)}`;
  const s = (n / 1000).toFixed(1);
  return `${s.endsWith('.0') ? s.slice(0, -2) : s}k`;
}

/**
 * Uppercase human-compact count for the token/cost pill (e.g. 999, 110K,
 * 1.2M). Used by the context-warning segment; `formatTokenCount` stays
 * untouched for its existing callers.
 */
export function formatCompactCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return `${Math.round(n)}`;
  const trim = (v: number): string => {
    const s = v >= 100 ? `${Math.round(v)}` : v.toFixed(1);
    return s.endsWith('.0') ? s.slice(0, -2) : s;
  };
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  // Rounding can push K into 4 digits (999999 -> "1000K"); promote to M.
  if (Math.round(n / 1000) >= 1000) return `${trim(n / 1_000_000)}M`;
  return `${trim(n / 1000)}K`;
}

/**
 * Join hint segments with middots, dropping from the END until the row fits
 * the width. Pure - the collapse policy is unit-tested, not eyeballed.
 */
export function visibleHints(hints: string[], width: number, middot = '·'): string[] {
  const out = [...hints];
  const joined = (hs: string[]): string => hs.join(` ${middot} `);
  while (out.length > 1 && cpLen(joined(out)) > width) out.pop();
  if (out.length === 1 && cpLen(joined(out)) > width) return [];
  return out;
}

export function hintsForState(state: HintState, rebind?: { paletteLabel: string }): string[] {
  switch (state) {
    case 'running':
      return ['Esc interrupt', 'Ctrl+C abort'];
    case 'approval':
      return ['a accept', 'A accept all', 'r reject'];
    default:
      // M1: the palette key is rebindable - the caller passes the resolved
      // label so the bar never advertises a dead key.
      return ['Enter send', '/ command', `${rebind?.paletteLabel ?? 'Ctrl+P'} palette`, 'Ctrl+C ×2 quit'];
  }
}

/** One usage segment of the bar. `warn` marks the context-warning pill. */
interface BarSegment {
  text: string;
  warn: boolean;
}

export interface TuiStatusBarProps {
  model: string;
  tasks: number;
  turns: number;
  /** Session token total (0 hides the segment). */
  tokens: number;
  /**
   * Context usage as a percentage of the model's window, or null when
   * unknown. At/above the context-meter's 80% threshold the token segment
   * becomes the warning pill. Compute with `contextPercent(tokens, slug)`.
   */
  contextPct?: number | null;
  cwd: string;
  width?: number;
}

export function TuiStatusBar({
  model,
  tasks,
  turns,
  tokens,
  contextPct = null,
  cwd,
  width: widthProp,
}: TuiStatusBarProps): ReactNode {
  const { colors, symbols, capabilities } = useTheme();
  const { width: termWidth } = useTerminalSize();
  const width = widthProp ?? termWidth;
  const filled =
    capabilities.colorLevel === 'truecolor' || capabilities.colorLevel === 'ansi256';
  const mid = ` ${symbols.middot} `;
  const ellipsis = capabilities.unicode ? '…' : '~';
  const activeToast = useToast();

  // The model chip always survives narrowing: it is truncated as a last
  // resort, never dropped.
  let chipText = `  ${model}  `;
  if (cpLen(chipText) > width) {
    const cps = [...chipText];
    chipText =
      width <= 1
        ? cps.slice(0, Math.max(0, width)).join('')
        : `${cps.slice(0, width - 1).join('')}${ellipsis}`;
  }
  const chipLen = cpLen(chipText);

  // Context-warning pill: the token segment flips to the theme's warning
  // color with a ⚠ glyph and the percentage past ~80% of the window.
  const warned = contextPct !== null && contextPct >= CONTEXT_WARN_PCT;
  const tokenText = warned
    ? `${symbols.warning} ↑ ${formatCompactCount(tokens)} ${symbols.middot} ${contextPct}%`
    : `↑ ${formatCompactCount(tokens)}`;

  // Narrowing cascade: usage segments drop from the right until model + cwd
  // fit. Tokens survive longest (most valuable); turns drop first.
  const segments: BarSegment[] = [
    ...(tokens > 0 ? [{ text: tokenText, warn: warned }] : []),
    { text: `${tasks} task${tasks === 1 ? '' : 's'}`, warn: false },
    { text: `${turns} turn${turns === 1 ? '' : 's'}`, warn: false },
  ];
  const barWidth = (): number =>
    chipLen +
    cpLen('  SpyCode') +
    segments.reduce((acc, s) => acc + cpLen(mid) + cpLen(s.text), 0) +
    cpLen(mid) +
    cpLen(`${cwd}  `);
  while (segments.length > 0 && barWidth() > width) {
    segments.pop();
  }
  const usage = segments.length > 0 ? `${mid}${segments.map((s) => s.text).join(mid)}` : '';

  // Toast row: a full-width colored segment above the bar, auto-cleared by
  // the toast bus timer.
  let toastRow: ReactNode = null;
  if (activeToast) {
    const toastGlyph =
      activeToast.kind === 'warning'
        ? symbols.warning
        : activeToast.kind === 'error'
          ? symbols.error
          : symbols.info;
    // Sanitize at the display boundary; sanitizeForDisplay preserves \n, so
    // flatten newlines to spaces to keep the toast a single row.
    const line = ` ${toastGlyph} ${sanitizeForDisplay(activeToast.text).replace(/\n/g, ' ')} `;
    const trimmed =
      cpLen(line) > width
        ? `${[...line].slice(0, Math.max(0, width - 1)).join('')}${ellipsis}`
        : `${line}${' '.repeat(Math.max(0, width - cpLen(line)))}`;
    toastRow = filled ? (
      <Box>
        <Text backgroundColor={colors[activeToast.kind]} color={palette.bgDark} bold>
          {trimmed}
        </Text>
      </Box>
    ) : (
      <Box>
        <Text color={colors[activeToast.kind]} bold>
          {trimmed.trimEnd()}
        </Text>
      </Box>
    );
  }

  if (!filled) {
    return (
      <Box flexDirection="column">
        {toastRow}
        <Separator token="borderSubtle" />
        <Box>
          <Text color={colors.accent} bold>
            {chipText.trim()}
          </Text>
          <Text color={colors.borderSubtle}>{mid}</Text>
          <Text color={colors.textDim}>SpyCode</Text>
          {segments.map((s, i) => (
            <Fragment key={i}>
              <Text color={colors.borderSubtle}>{mid}</Text>
              <Text color={s.warn ? colors.warning : colors.textDim} bold={s.warn}>
                {s.text}
              </Text>
            </Fragment>
          ))}
          <Text color={colors.borderSubtle}>{mid}</Text>
          <Text color={colors.textDim}>{cwd}</Text>
        </Box>
      </Box>
    );
  }

  const leftText = `  SpyCode${usage}${mid}`;
  const rightText = `${cwd}  `;
  const leftLen = cpLen(leftText);
  let leftNodes: ReactNode = (
    <>
      <Text backgroundColor={colors.surface} color={colors.textDim}>
        {'  SpyCode'}
      </Text>
      {segments.map((s, i) => (
        <Fragment key={i}>
          <Text backgroundColor={colors.surface} color={colors.borderSubtle}>
            {mid}
          </Text>
          <Text
            backgroundColor={colors.surface}
            color={s.warn ? colors.warning : colors.textDim}
            bold={s.warn}
          >
            {s.text}
          </Text>
        </Fragment>
      ))}
      <Text backgroundColor={colors.surface} color={colors.borderSubtle}>
        {mid}
      </Text>
    </>
  );
  let right = rightText;
  const total = chipLen + leftLen + cpLen(rightText);
  let spacer = '';
  if (total <= width) {
    spacer = ' '.repeat(width - total);
  } else if (chipLen + leftLen + 1 <= width) {
    right = '';
    spacer = ' '.repeat(Math.max(0, width - chipLen - leftLen));
  } else {
    // Model chip has already survived narrowing; only the left usage area
    // gets truncated here (or dropped entirely when the chip fills the row).
    right = '';
    const keep = Math.max(0, width - chipLen);
    if (keep <= 0) {
      leftNodes = null;
    } else if (leftLen > keep) {
      leftNodes = (
        <Text backgroundColor={colors.surface} color={colors.textDim}>
          {`${[...leftText].slice(0, Math.max(0, keep - 1)).join('')}${ellipsis}`}
        </Text>
      );
    }
    const keptLen = keep <= 0 ? 0 : Math.min(leftLen, keep);
    spacer = ' '.repeat(Math.max(0, width - chipLen - keptLen));
  }

  return (
    <Box flexDirection="column">
      {toastRow}
      <Box>
        <Text backgroundColor={colors.accent} color={palette.bgDark} bold>
          {chipText}
        </Text>
        {leftNodes}
        {spacer ? <Text backgroundColor={colors.surface}>{spacer}</Text> : null}
        {right ? (
          <Text backgroundColor={colors.surface} color={colors.textDim}>
            {right}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
