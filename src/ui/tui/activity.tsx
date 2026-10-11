/**
 * The TUI's single "alive" signal: one breathing diamond + plain words.
 *
 * While a run is in flight this renders `◆ Working… 12s` with the glyph
 * cycling accent → subtle → muted → subtle (a calm cosine-like pulse, never
 * a jittery spinner farm). Finished work never shows this - it commits a
 * static transcript row instead, so layout never shifts.
 *
 * Reduced motion (SPYCORE_REDUCED_MOTION=1): a static accent diamond, no
 * interval, no pulse. Every animation in the TUI has this off-ramp.
 */
import { Box, Text } from 'ink';
import { useEffect, useState, type ReactNode } from 'react';
import { useTheme } from '../theme/theme.js';
import { detectReducedMotion } from './theme-detect.js';
import { formatTokenCount } from './statusbar.js';

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export interface ActivityIndicatorProps {
  /** e.g. 'Working'. Plain words only - never playful verbs. */
  label: string;
  /** Epoch ms the run started; drives the elapsed readout. */
  startedAt: number;
  /**
   * Live token total for the session (session totals + current run).
   * Read on every tick so the readout tracks the run (`Working… 12s · ↑ 1.2k`).
   */
  getLiveTokens?: (() => number) | undefined;
}

export function ActivityIndicator({ label, startedAt, getLiveTokens }: ActivityIndicatorProps): ReactNode {
  const { colors, symbols, capabilities } = useTheme();
  const reduced = detectReducedMotion();
  const [tick, setTick] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => {
      setTick((x) => (x + 1) % 4);
      setNow(Date.now());
    }, 500);
    return () => clearInterval(t);
  }, [reduced]);

  const glyph = capabilities.unicode ? symbols.diamond : '*';
  // Breathing cycle: accent → subtle → muted → subtle → …
  const shades = [colors.accent, colors.accentSubtle, colors.muted, colors.accentSubtle];
  const color = reduced ? colors.accent : shades[tick % shades.length];
  const liveTokens = getLiveTokens ? getLiveTokens() : 0;

  return (
    <Box gap={1} marginTop={1}>
      <Text color={color}>{glyph}</Text>
      <Text color={colors.textDim}>
        {label}… {formatElapsed(now - startedAt)}
        {liveTokens > 0 ? ` · ↑ ${formatTokenCount(liveTokens)}` : ''}
      </Text>
    </Box>
  );
}
