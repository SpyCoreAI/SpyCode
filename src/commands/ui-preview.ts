import type { Command } from 'commander';

/**
 * Registers the hidden, dev-only `__ui-preview` command. It is intentionally
 * excluded from `--help` (commander `hidden: true`) and exists only to let us
 * eyeball the terminal design system. It changes no user-facing behavior, and
 * the Ink/React UI is imported lazily so this registration adds no startup
 * cost to any real command.
 */
export function registerUiPreviewCommand(program: Command): void {
  program
    .command('__ui-preview', { hidden: true })
    .description('(dev) Preview the SpyCode terminal UI design system')
    .action(async () => {
      const { runUiPreview } = await import('../ui/preview/run.js');
      await runUiPreview();
    });
}
