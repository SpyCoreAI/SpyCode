import { Command, Option } from 'commander';
import { api } from '../../lib/api.js';
import { getOutputOptions, json, print } from '../../lib/output.js';
import { relativeTime } from '../../lib/files.js';

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

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, Math.max(0, max - 1)) + '…';
}

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
    .action(
      async (
        opts: { category?: string; limit?: string },
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

        if (getOutputOptions().json) {
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
          const row = [
            shortId(m.id).padEnd(idCol),
            (m.category || '').padEnd(catCol),
            relativeTime(m.createdAt).padEnd(createdCol),
            clip(m.content || '', snippetCol),
          ].join('  ');
          print(row);
        }
      },
    );
}
