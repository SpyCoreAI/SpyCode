import { Command, Option } from 'commander';
import { api } from '../../lib/api.js';
import { formatOption, json, print, resolveFormat, writeFormatted } from '../../lib/output.js';
import {
  bucketByRecency,
  formatFileSize,
  relativeTime,
  shortMimeLabel,
} from '../../lib/files.js';

interface FileItem {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  // category/status are not declared on the server's fileSchema and are
  // therefore stripped before reaching the client; kept optional for
  // forward-compat with no runtime expectation.
  category?: string;
  status?: string;
  createdAt: string;
  expiresAt?: string | null;
}

interface ListResp {
  files: FileItem[];
  total: number;
  page: number;
  pageSize: number;
  totalBytes?: number;
}

const FILTER_TO_CATEGORY: Record<string, string | undefined> = {
  image: 'CHAT_IMAGE',
  pdf: 'CHAT_PDF',
  text: 'CHAT_OTHER',
  generated: 'GENERATED_IMAGE',
  all: undefined,
};

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 12)}…` : id;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function registerFilesListCommand(program: Command): void {
  program
    .command('list')
    .description('List your uploaded files')
    .addOption(
      new Option('--page <n>', 'Server page number (1-indexed)').default('1'),
    )
    .addOption(new Option('--limit <n>', 'How many to fetch (1-200)').default('50'))
    .addOption(
      new Option('--filter <type>', 'Filter by type')
        .choices(['image', 'pdf', 'text', 'generated', 'all'])
        .default('all'),
    )
    .addOption(formatOption())
    .action(
      async (
        opts: {
          limit?: string;
          page?: string;
          filter?: keyof typeof FILTER_TO_CATEGORY;
          format?: string;
        },
        cmd: Command,
      ) => {
        const root = cmd.parent?.parent;
        const parentOpts = root?.opts<{ apiUrl?: string; json?: boolean }>() ?? {};
        const limit = Math.max(1, Math.min(200, Number(opts.limit ?? 50)));
        const page = Math.max(1, Number(opts.page ?? 1));
        const category = opts.filter ? FILTER_TO_CATEGORY[opts.filter] : undefined;

        const params = new URLSearchParams({
          page: String(page),
          pageSize: String(limit),
        });
        if (category) params.set('category', category);

        const data = await api.get<ListResp>(`/api/files?${params.toString()}`, {
          apiUrlOverride: parentOpts.apiUrl,
        });
        const items = data.files ?? [];
        // Server returns total + page + pageSize but not `hasMore`; derive it
        // the same way conversations does (page * pageSize < total).
        const hasMore =
          data.pageSize > 0 ? page * data.pageSize < data.total : undefined;

        const fmt = resolveFormat(opts.format);
        if (fmt === 'json') {
          json({
            files: items,
            total: data.total,
            page: data.page,
            pageSize: data.pageSize,
            ...(hasMore !== undefined ? { hasMore } : {}),
          });
          return;
        }
        if (fmt !== 'text') {
          writeFormatted(items, fmt);
          return;
        }

        if (items.length === 0) {
          print('(no files yet)');
          return;
        }

        const idCol = 14;
        const nameCol = Math.max(
          18,
          Math.min(36, process.stdout.columns ? process.stdout.columns - 56 : 32),
        );
        const typeCol = 8;
        const sizeCol = 10;

        const renderHeader = () => {
          const header = [
            'ID'.padEnd(idCol),
            'Name'.padEnd(nameCol),
            'Type'.padEnd(typeCol),
            'Size'.padEnd(sizeCol),
            'Uploaded',
          ].join('  ');
          print(header);
          print('-'.repeat(header.length));
        };

        const renderRow = (f: FileItem) => {
          const row = [
            shortId(f.id).padEnd(idCol),
            clip(f.filename || '(unnamed)', nameCol).padEnd(nameCol),
            shortMimeLabel(f.mimeType, f.filename).padEnd(typeCol),
            formatFileSize(f.size ?? 0).padEnd(sizeCol),
            relativeTime(f.createdAt),
          ].join('  ');
          print(row);
        };

        const groups = bucketByRecency(items);
        if (groups.length <= 1) {
          renderHeader();
          for (const it of items) renderRow(it);
        } else {
          for (const group of groups) {
            print('');
            print(group.label);
            renderHeader();
            for (const it of group.items) renderRow(it);
          }
        }

        if (hasMore) {
          print(`(more available — use --page ${page + 1})`);
        }
      },
    );
}
