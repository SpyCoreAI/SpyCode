/**
 * Entry point for the dev-only `__ui-preview` command. Kept free of static
 * React/Ink imports so it (and the whole UI subtree) only loads when the
 * preview actually runs.
 */
import { guardedRender, isInteractive } from '../lib/render.js';

const NON_TTY_NOTE = [
  'SpyCode UI preview is a TTY-only showcase of the terminal design system.',
  'stdout is not a TTY (piped / redirected / CI), so the interactive view was',
  'skipped. Run `spycore __ui-preview` directly in an interactive terminal to',
  'see the brand header, panels, badges, notices, spinner and status bar.',
].join('\n');

export async function runUiPreview(): Promise<void> {
  if (!isInteractive()) {
    process.stdout.write(`${NON_TTY_NOTE}\n`);
    return;
  }
  // Lazily load React + the showcase only in the interactive path.
  const [{ createElement }, { PreviewApp }] = await Promise.all([
    import('react'),
    import('./PreviewApp.js'),
  ]);
  // Short auto-exit for single-frame capture under a pty (before the spinner's
  // first ~80ms tick); a comfortable default otherwise so it is visibly animated.
  const autoExitMs = process.env.SPYCODE_PREVIEW_ONCE === '1' ? 60 : 2000;
  const instance = await guardedRender(createElement(PreviewApp, { autoExitMs }));
  if (instance) await instance.waitUntilExit();
}
