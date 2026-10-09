import { Command, Option } from 'commander';
import { api } from '../../lib/api.js';
import { formatOption, json, print, resolveFormat } from '../../lib/output.js';
import { relativeTime } from '../../lib/files.js';
import { clipOneLine, shortId } from '../../lib/text.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';

interface MemoryItem {
  id: string;
  category: string;
  content: string;
  pinned?: boolean;
  source?: string;
  confidence?: number;
  expiresAt?: string | null;
  createdAt: string;
  updatedAt?: string;
}

interface ListResp {
  memories?: MemoryItem[];
  // The server also returns grouped/stats/settings/query but we don't need
  // those for the simple flat-table view.
}

const ALLOWED_CATEGORIES = [
  'profile',
  'preferences',
  'context',
  'knowledge',
  'style',
  'custom',
];

export function registerMemoryListCommand(program: Command): void {
  program
    .command('list')
    .description('List your memories')
    .addOption(
      new Option('--category <cat>', 'Filter by memory category').choices(
        ALLOWED_CATEGORIES,
      ),
    )
    .addOption(new Option('--limit <n>', 'Max rows to print (1-200)').default('50'))
    .addOption(formatOption())
    .action(
      async (
        opts: { category?: string; limit?: string; format?: string },
        cmd: Command,
      ) => {
        const root = cmd.parent?.parent;
        const parentOpts = root?.opts<{ apiUrl?: string; json?: boolean }>() ?? {};
        const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));

        const data = await api.get<ListResp>('/api/memory', {
          apiUrlOverride: parentOpts.apiUrl,
        });
        let memories = data.memories ?? [];
        if (opts.category) {
          const wanted = opts.category.toUpperCase();
          memories = memories.filter((m) => (m.category || '').toUpperCase() === wanted);
        }
        memories = memories.slice(0, limit);

        if (resolveFormat(opts.format) === 'json') {
          json({ memories });
          return;
        }

        if (memories.length === 0) {
          print('(no memories yet)');
          return;
        }

        const idCol = 14;
        const catCol = 12;
        const createdCol = 10;
        const snippetCol = Math.max(
          20,
          (process.stdout.columns ?? 80) - idCol - catCol - createdCol - 8,
        );

        const header = [
          'ID'.padEnd(idCol),
          'Category'.padEnd(catCol),
          'Created'.padEnd(createdCol),
          'Snippet',
        ].join('  ');
        print(header);
        print('-'.repeat(header.length));
        for (const m of memories) {
          // Sanitize BEFORE clip()/padEnd(): those slice by JS length and would
          // otherwise cut an escape sequence in half, and column widths must be
          // computed on the bytes that actually render.
          const row = [
            sanitizeForDisplay(shortId(m.id)).padEnd(idCol),
            sanitizeForDisplay(m.category || '').padEnd(catCol),
            relativeTime(m.createdAt).padEnd(createdCol),
            clipOneLine(sanitizeForDisplay(m.content || ''), snippetCol),
          ].join('  ');
          print(row);
        }
      },
    );
}
