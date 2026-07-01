import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { palette } from '../theme/tokens.js';
import { useTerminalSize } from '../lib/useTerminalSize.js';
import { gradient } from '../lib/gradient.js';

export interface BannerProps {
  /** Muted one-line tagline beneath the wordmark. */
  tagline?: string;
}

/**
 * 6px-tall pixel glyphs ('#' on, '.' off), 5px wide. Rendered via the
 * half-block technique — two vertical pixels per text row (▀ top, ▄ bottom,
 * █ both) — so the wordmark is higher-resolution and crisper than full-block
 * letterforms. Degrades to one '#' per pixel when Unicode is unavailable.
 */
const GLYPHS: Record<string, readonly string[]> = {
  S: ['.####', '#....', '.###.', '....#', '....#', '####.'],
  P: ['####.', '#...#', '####.', '#....', '#....', '#....'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..'],
  C: ['.###.', '#...#', '#....', '#....', '#...#', '.###.'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '####.', '#....', '#....', '#####'],
};
const WORD = ['S', 'P', 'Y', 'C', 'O', 'D', 'E'] as const;
const GLYPH_ROWS = 6;
/** Below this width the full block banner is replaced by a compact one-liner. */
const COMPACT_WIDTH = 64;

/** Brand gradient stops: Deep Malachite → bright teal. */
function brandStops(): string[] {
  return [palette.malachite, palette.teal];
}

/** Concatenate the word's pixel rows with a 1-column gutter between glyphs. */
function wordPixelRows(): string[] {
  const rows: string[] = [];
  for (let y = 0; y < GLYPH_ROWS; y++) {
    rows.push(WORD.map((ch) => GLYPHS[ch]![y]!).join(' '));
  }
  return rows;
}

/** Two pixel rows → one half-block row (▀ top, ▄ bottom, █ both, ' ' neither). */
function toHalfBlocks(pixelRows: string[]): string[] {
  const width = pixelRows[0]?.length ?? 0;
  const out: string[] = [];
  for (let y = 0; y < pixelRows.length; y += 2) {
    const top = pixelRows[y] ?? '';
    const bottom = pixelRows[y + 1] ?? '';
    let line = '';
    for (let x = 0; x < width; x++) {
      const t = top[x] === '#';
      const b = bottom[x] === '#';
      line += t && b ? '█' : t ? '▀' : b ? '▄' : ' ';
    }
    out.push(line);
  }
  return out;
}

/** One '#' per filled pixel — ascii-safe fallback form. */
function toAsciiBlocks(pixelRows: string[]): string[] {
  return pixelRows.map((row) => [...row].map((c) => (c === '#' ? '#' : ' ')).join(''));
}

export function Banner({ tagline = 'The agentic coding CLI' }: BannerProps): ReactNode {
  const { colors, symbols, capabilities } = useTheme();
  const { width } = useTerminalSize();
  const truecolor = capabilities.colorLevel === 'truecolor';
  // Solid fallback color when not interpolating: bright teal at 256/16, none → undefined.
  const solid = capabilities.colorLevel === 'none' ? undefined : colors.accent;

  const taglineNode = (
    <Box marginTop={1}>
      <Text color={colors.muted}>{tagline}</Text>
    </Box>
  );

  // Compact one-liner for narrow terminals.
  if (width < COMPACT_WIDTH) {
    const word = 'SpyCode';
    const grad = truecolor ? gradient(brandStops(), word.length) : null;
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={grad ? grad[0] : solid} bold>{`${symbols.diamond} `}</Text>
          {grad ? (
            <Text>
              {[...word].map((ch, i) => (
                <Text key={i} color={grad[i]} bold>
                  {ch}
                </Text>
              ))}
            </Text>
          ) : (
            <Text color={solid} bold>
              {word}
            </Text>
          )}
        </Box>
        {taglineNode}
      </Box>
    );
  }

  const pixels = wordPixelRows();
  const lines = capabilities.unicode ? toHalfBlocks(pixels) : toAsciiBlocks(pixels);
  const totalWidth = lines[0]?.length ?? 0;
  const grad = truecolor ? gradient(brandStops(), totalWidth) : null;

  return (
    <Box flexDirection="column">
      {lines.map((line, r) =>
        grad ? (
          <Text key={r}>
            {[...line].map((ch, c) => (
              <Text key={c} color={grad[c]} bold>
                {ch}
              </Text>
            ))}
          </Text>
        ) : (
          <Text key={r} color={solid} bold>
            {line}
          </Text>
        ),
      )}
      {taglineNode}
    </Box>
  );
}
