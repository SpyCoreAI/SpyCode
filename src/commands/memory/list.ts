import { Command, Option } from 'commander';
import { api } from '../../lib/api.js';
import { parseIntFlag } from '../../lib/numeric-flags.js';
import { formatOption, json, print, resolveFormat } from '../../lib/output.js';
import { relativeTime } from '../../lib/files.js';
import { clipOneLine } from '../../lib/text.js';
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
        const limit = parseIntFlag(opts.limit, 'limit', { min: 1, max: 200, defaultValue: 50 });

        const data = await api.get<ListResp>('/api/memory', {
          apiUrlOverride: parentOpts.apiUrl,
        });
        // Server-shape drift: a non-array `memories` used to pass through
        // and throw on .filter/.map downstream; per-row fields are read
        // through string guards below.
        let memories = (Array.isArray(data.memories) ? data.memories : []).filter(
          (m): m is MemoryItem => !!m && typeof m === 'object',
        );
        if (opts.category) {
          const wanted = opts.category.toUpperCase();
          memories = memories.filter((m) => (typeof m.category === 'string' ? m.category : '').toUpperCase() === wanted);
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

        // Full ids, not shortId: lookups require the exact id (see
        // conversations/list.ts). The column widens to the longest id.
        // Non-string ids render empty (server-shape drift) instead of
        // throwing on .length.
        const strId = (m: MemoryItem): string => (typeof m.id === 'string' ? m.id : '');
        const idCol = Math.max(14, ...memories.map((m) => strId(m).length));
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
            sanitizeForDisplay(strId(m)).padEnd(idCol),
            sanitizeForDisplay(typeof m.category === 'string' ? m.category : '').padEnd(catCol),
            relativeTime(typeof m.createdAt === 'string' ? m.createdAt : '').padEnd(createdCol),
            clipOneLine(sanitizeForDisplay(typeof m.content === 'string' ? m.content : ''), snippetCol),
          ].join('  ');
          print(row);
        }
      },
    );
}
