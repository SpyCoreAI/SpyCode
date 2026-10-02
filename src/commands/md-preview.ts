import type { Command } from 'commander';

/**
 * Registers the hidden, dev-only `__md-preview` command — excluded from
 * `--help` (commander `hidden: true`). Showcases the Markdown rendering layer
 * (static sample doc + simulated streaming). The rendering layer is imported
 * lazily so this adds no startup cost to any real command.
 */
export function registerMdPreviewCommand(program: Command): void {
  program
    .command('__md-preview', { hidden: true })
    .description('(dev) Preview the Markdown rendering layer (static + streaming)')
    .action(async () => {
      const { runMarkdownPreview } = await import('../ui/preview/runMarkdown.js');
      await runMarkdownPreview();
    });
}
