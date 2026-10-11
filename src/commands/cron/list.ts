import { Command } from 'commander';
import { formatOption, json, print, resolveFormat, writeFormatted } from '../../lib/output.js';
import { clip, shortId } from '../../lib/text.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { loadCronEntries, type CronEntry } from './store.js';

export function registerCronListCommand(program: Command): void {
  program
    .command('list')
    .description('List scheduled prompts')
    .addOption(formatOption())
    .action(async (opts: { format?: string }) => {
      const entries = loadCronEntries();
      const sorted = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      const fmt = resolveFormat(opts.format);
      if (fmt === 'json') {
        json({ prompts: sorted });
        return;
      }
      if (fmt !== 'text') {
        writeFormatted(sorted, fmt);
        return;
      }

      if (sorted.length === 0) {
        print('(no scheduled prompts)');
        return;
      }

      const idCol = 14;
      const schedCol = 20;
      const modelCol = 10;
      const promptCol = Math.max(
        20,
        Math.min(60, process.stdout.columns ? process.stdout.columns - (idCol + schedCol + modelCol + 8) : 60),
      );

      const header = ['ID'.padEnd(idCol), 'Schedule'.padEnd(schedCol), 'Model'.padEnd(modelCol), 'Prompt'].join(
        '  ',
      );
      print(header);
      print('-'.repeat(header.length));
      for (const e of sorted) {
        // Sanitize BEFORE clip()/padEnd() - see conversations/list.ts.
        const row = [
          sanitizeForDisplay(shortId(e.id)).padEnd(idCol),
          sanitizeForDisplay(e.schedule).padEnd(schedCol),
          sanitizeForDisplay(e.model ?? '').padEnd(modelCol),
          clip(sanitizeForDisplay(e.prompt), promptCol),
        ].join('  ');
        print(row);
      }
    });
}

/** Re-exported for the unit tests so they assert against the real type. */
export type { CronEntry };
