/**
 * Interactivity guard + a lazy render helper. Ink is imported dynamically so
 * non-UI command paths never load React/Ink/yoga at all.
 */
import type { ReactNode } from 'react';

type InkRender = (typeof import('ink'))['render'];
type InkInstance = ReturnType<InkRender>;

/**
 * True only when stdout is a real TTY. Full-screen / interactive Ink apps must
 * not launch otherwise (piped output, redirected files, CI), where they would
 * emit control codes into a non-terminal sink.
 */
export function isInteractive(stream: { isTTY?: boolean } = process.stdout): boolean {
  return Boolean(stream.isTTY);
}

/**
 * Render an Ink tree only when interactive; returns `null` in non-TTY contexts
 * so callers can fall back to plain text. Ink is imported lazily here.
 */
export async function guardedRender(
  node: ReactNode,
  options?: Parameters<InkRender>[1],
): Promise<InkInstance | null> {
  if (!isInteractive()) return null;
  const { render } = await import('ink');
  return render(node, options);
}
