import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { useTerminalSize } from '../lib/useTerminalSize.js';
import { lerpHex } from '../lib/gradient.js';
import type { SemanticColorName } from '../theme/tokens.js';

export interface SeparatorProps {
  /** Explicit width (defaults to the terminal width for repeat/fade modes). */
  width?: number;
  /** Color token (the "from" color when fading). */
  token?: SemanticColorName;
  /** Override the repeated character (defaults to the theme line glyph). */
  char?: string;
  /** Subtle left→right color fade (truecolor/256 only; solid otherwise). */
  fade?: boolean;
  /** Fade target color token. */
  toToken?: SemanticColorName;
}

const MAX_FADE_SEGMENTS = 32;

/**
 * A horizontal rule. By default it auto-stretches to its parent's width via a
 * bottom-only border (so it respects padding/indent without width math). With
 * `fade`, it renders a per-segment color interpolation; with an explicit
 * `char`/`width` it repeats a glyph.
 */
export function Separator({
  width,
  token = 'borderSubtle',
  char,
  fade = false,
  toToken = 'borderSubtle',
}: SeparatorProps): ReactNode {
  const { colors, symbols, borderStyle, capabilities } = useTheme();
  const { width: termWidth } = useTerminalSize();
  const glyph = char ?? symbols.line;
  const from = colors[token];
  const to = colors[toToken];
  const canFade =
    capabilities.colorLevel === 'truecolor' || capabilities.colorLevel === 'ansi256';

  // Faded rule: interpolate between two hex colors across N segments.
  if (
    fade &&
    canFade &&
    from !== undefined &&
    to !== undefined &&
    from.startsWith('#') &&
    to.startsWith('#')
  ) {
    const w = Math.max(1, width ?? termWidth);
    const segments = Math.min(w, MAX_FADE_SEGMENTS);
    const base = Math.floor(w / segments);
    const extra = w % segments;
    const parts: ReactNode[] = [];
    for (let i = 0; i < segments; i++) {
      const segW = base + (i < extra ? 1 : 0);
      if (segW <= 0) continue;
      const color = lerpHex(from, to, segments === 1 ? 0 : i / (segments - 1));
      parts.push(
        <Text key={i} color={color}>
          {glyph.repeat(segW)}
        </Text>,
      );
    }
    return <Text>{parts}</Text>;
  }

  // Explicit width or custom glyph → repeat.
  if (char !== undefined || width !== undefined) {
    return <Text color={from}>{glyph.repeat(Math.max(1, width ?? termWidth))}</Text>;
  }

  // Default: auto-width rule that stretches to the parent (respects padding).
  return (
    <Box
      borderStyle={borderStyle}
      borderTop={false}
      borderLeft={false}
      borderRight={false}
      borderBottom
      borderColor={from}
    />
  );
}
