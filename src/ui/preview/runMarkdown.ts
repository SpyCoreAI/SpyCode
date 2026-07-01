/**
 * Entry point for the dev-only `__md-preview` command. Free of static
 * React/Ink/marked imports so the markdown layer only loads when previewed.
 */
import { guardedRender, isInteractive } from '../lib/render.js';

const NON_TTY_NOTE = [
  'SpyCode markdown preview is a TTY-only showcase of the rendering layer.',
  'stdout is not a TTY (piped / redirected / CI), so the interactive view was',
  'skipped. Run `spycore __md-preview` directly in an interactive terminal.',
].join('\n');

export async function runMarkdownPreview(): Promise<void> {
  if (!isInteractive()) {
    process.stdout.write(`${NON_TTY_NOTE}\n`);
    return;
  }
  const autoExitMs = process.env.SPYCODE_PREVIEW_ONCE === '1' ? 60 : 4000;
  const [{ createElement }, { MarkdownPreviewApp }] = await Promise.all([
    import('react'),
    import('./MarkdownPreviewApp.js'),
  ]);
  const instance = await guardedRender(createElement(MarkdownPreviewApp, { autoExitMs }));
  if (instance) await instance.waitUntilExit();
}
