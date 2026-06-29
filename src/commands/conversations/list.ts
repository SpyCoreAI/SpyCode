import { Command, Option } from 'commander';
import { api } from '../../lib/api.js';
import { formatOption, json, print, resolveFormat, writeFormatted } from '../../lib/output.js';

interface ConvSummary {
  id: string;
  title: string;
  model: string;
  pinned?: boolean;
  archived?: boolean;
  updatedAt: string;
  createdAt: string;
  messages?: Array<{ content: string; role: string; createdAt: string }>;
  _count?: { messages: number };
}

interface ListResp {
  conversations: ConvSummary[];
  /**
   * Un-paginated row count for the current filter. The server sends this
   * (declared in its response schema); we use it to compute whether more
   * pages exist. The server does NOT send `hasMore` — clients derive it.
   */
  total?: number;
  /** Echo of the requested page. */
  page: number;
}

/**
 * Server-side page size on /api/conversations: the API returns 20 rows per
 * page. Pinned here as a named constant so the client's paging math stays
 * correct, and stays traceable if the API's page size ever changes.
 */
const SERVER_PAGE_SIZE = 20;

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

function relTime(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function registerConversationsListCommand(program: Command): void {
  program
    .command('list')
    .description('List your recent conversations')
    .addOption(
      new Option('--page <n>', `Server page number (1-indexed, ${SERVER_PAGE_SIZE} rows per page)`)
        .default('1'),
    )
    .addOption(
      new Option(
        '--limit <n>',
        `Client-side cap on rows printed (1-${SERVER_PAGE_SIZE}; pages are ${SERVER_PAGE_SIZE} rows server-side)`,
      ).default(String(SERVER_PAGE_SIZE)),
    )
    .addOption(formatOption())
    .action(async (opts: { limit?: string; page?: string; format?: string }, cmd: Command) => {
      const root = cmd.parent?.parent;
      const parentOpts = root?.opts<{ apiUrl?: string; json?: boolean }>() ?? {};
      const limit = Math.max(1, Math.min(100, Number(opts.limit ?? SERVER_PAGE_SIZE)));
      const page = Math.max(1, Number(opts.page ?? 1));

      const data = await api.get<ListResp>(
        `/conversations?page=${encodeURIComponent(String(page))}`,
        { apiUrlOverride: parentOpts.apiUrl },
      );
      const items = (data.conversations ?? []).slice(0, limit);
      // The server sends `total` (un-paginated count) but not `hasMore`; it
      // documents the client-side formula `page * 20 < total`. Compute it so
      // both JSON consumers and the text footer can show "more available".
      const hasMore =
        data.total !== undefined
          ? page * SERVER_PAGE_SIZE < data.total
          : undefined;

      const fmt = resolveFormat(opts.format);
      if (fmt === 'json') {
        json({
          conversations: items,
          page: data.page,
          ...(data.total !== undefined ? { total: data.total } : {}),
          ...(hasMore !== undefined ? { hasMore } : {}),
        });
        return;
      }
      if (fmt !== 'text') {
        writeFormatted(items, fmt);
        return;
      }

      if (items.length === 0) {
        if (page > 1) {
          print(`(no conversations on page ${page})`);
        } else {
          print('(no conversations yet)');
        }
        return;
      }

      const idCol = 14;
      const titleCol = Math.max(20, Math.min(40, process.stdout.columns ? process.stdout.columns - 50 : 40));
      const modelCol = 10;

      const header = [
        'ID'.padEnd(idCol),
        'Title'.padEnd(titleCol),
        'Model'.padEnd(modelCol),
        'Updated',
      ].join('  ');
      print(header);
      print('-'.repeat(header.length));
      for (const c of items) {
        const row = [
          shortId(c.id).padEnd(idCol),
          clip(c.title || '(untitled)', titleCol).padEnd(titleCol),
          (c.model || '').padEnd(modelCol),
          relTime(c.updatedAt),
        ].join('  ');
        print(row);
      }

      if (hasMore) {
        print(`(more available — use --page ${page + 1})`);
      }
    });
}
