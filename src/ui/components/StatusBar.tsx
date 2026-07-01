import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { useTerminalSize } from '../lib/useTerminalSize.js';
import { Separator } from './Separator.js';
import { palette } from '../theme/tokens.js';

export interface StatusBarProps {
  /** SpyCore model display name. */
  model?: string;
  /** Service label — brand-safe; never an upstream provider name. */
  service?: string;
  /** Current reasoning-effort label (e.g. "high"). Omitted when not meaningful. */
  effort?: string;
  /** Usage summary (e.g. token count). */
  usage?: string;
  /** Right-aligned segment — the chat passes the conversation title here. */
  branch?: string;
  /** Cap the bar width (defaults to the full terminal width). */
  width?: number;
}

function cpLen(s: string): number {
  return [...s].length;
}
function truncate(s: string, max: number, ellipsis: string): string {
  if (max <= 0) return '';
  const cps = [...s];
  if (cps.length <= max) return s;
  if (max <= ellipsis.length) return cps.slice(0, max).join('');
  return cps.slice(0, max - ellipsis.length).join('') + ellipsis;
}

/**
 * Full-width status bar: model • service • usage • branch.
 *
 * Truecolor/256 → a filled bar (accent model chip on a quiet surface fill,
 * justified across the full terminal width, truncating gracefully when narrow).
 * 16-color/no-color → a ruled bar (top hairline + plain text, no fill).
 *
 * The chat TUI passes live model, usage and title values; the defaults below are
 * fallbacks. `service` is the SpyCore brand and is never an upstream provider name.
 */
export function StatusBar({
  model = 'Charon',
  service = 'SpyCore',
  effort,
  usage = '0 tokens',
  branch = 'main',
  width: widthProp,
}: StatusBarProps): ReactNode {
  const { colors, symbols, capabilities } = useTheme();
  const { width: termWidth } = useTerminalSize();
  const width = widthProp ?? termWidth;
  const filled =
    capabilities.colorLevel === 'truecolor' || capabilities.colorLevel === 'ansi256';
  const mid = ` ${symbols.middot} `;
  const ellipsis = capabilities.unicode ? '…' : '~';
  const branchSeg = `${symbols.branch} ${branch}`;
  const effortSeg = effort ? `effort: ${effort}` : '';

  if (!filled) {
    // Ruled bar: top hairline + plain text segments, no background fill.
    return (
      <Box flexDirection="column">
        <Separator token="borderSubtle" />
        <Box>
          <Text color={colors.accent} bold>
            {model}
          </Text>
          <Text color={colors.borderSubtle}>{mid}</Text>
          <Text color={colors.textDim}>{service}</Text>
          <Text color={colors.borderSubtle}>{mid}</Text>
          <Text color={colors.textDim}>{usage}</Text>
          {effortSeg ? (
            <>
              <Text color={colors.borderSubtle}>{mid}</Text>
              <Text color={colors.textDim}>{effortSeg}</Text>
            </>
          ) : null}
          <Text color={colors.borderSubtle}>{mid}</Text>
          <Text color={colors.textDim}>{branchSeg}</Text>
        </Box>
      </Box>
    );
  }

  // Filled bar — compose explicit-width spans so the surface fill spans exactly
  // the terminal width (model chip left, branch right, fill between).
  const chipText = `  ${model}  `;
  const leftText = `  ${service}${mid}${usage}${effortSeg ? `${mid}${effortSeg}` : ''}`;
  const rightText = `${branchSeg}  `;
  const chipLen = cpLen(chipText);

  let left = leftText;
  let right = rightText;
  let spacer = '';
  const total = chipLen + cpLen(leftText) + cpLen(rightText);
  if (total <= width) {
    spacer = ' '.repeat(width - total);
  } else if (chipLen + cpLen(leftText) + 1 <= width) {
    right = '';
    spacer = ' '.repeat(Math.max(0, width - chipLen - cpLen(leftText)));
  } else {
    right = '';
    left = truncate(leftText, Math.max(0, width - chipLen), ellipsis);
    spacer = ' '.repeat(Math.max(0, width - chipLen - cpLen(left)));
  }

  return (
    <Box>
      <Text backgroundColor={colors.accent} color={palette.bgDark} bold>
        {chipText}
      </Text>
      <Text backgroundColor={colors.surface} color={colors.textDim}>
        {left}
      </Text>
      {spacer ? <Text backgroundColor={colors.surface}>{spacer}</Text> : null}
      {right ? (
        <Text backgroundColor={colors.surface} color={colors.textDim}>
          {right}
        </Text>
      ) : null}
    </Box>
  );
}
