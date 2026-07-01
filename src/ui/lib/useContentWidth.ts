/**
 * Max content width. On terminals wider than this, screens constrain their
 * content (left-aligned) instead of stretching edge-to-edge, which reads as
 * far more "designed". Narrower terminals use their full width.
 */
import { useTerminalSize } from './useTerminalSize.js';

export const MAX_CONTENT_WIDTH = 96;

/** Effective content width: the terminal width capped at `maxWidth`. */
export function useContentWidth(maxWidth: number = MAX_CONTENT_WIDTH): number {
  const { width } = useTerminalSize();
  return Math.min(width, maxWidth);
}
