import { Command } from 'commander';
import { api } from '../../lib/api.js';
import { getOutputOptions, json, print } from '../../lib/output.js';
import { relativeTime } from '../../lib/files.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
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

interface MemoryListResp {
  memories?: MemoryItem[];
}

export function registerMemoryShowCommand(program: Command): void {
  program
    .command('show <id>')
    .description('Show a memory')
    .action(async (id: string, _opts: unknown, cmd: Command) => {
      const root = cmd.parent?.parent;
      const parentOpts = root?.opts<{ apiUrl?: string; json?: boolean }>() ?? {};

      // The server doesn't expose GET /api/memory/:id, but list is cheap
      // and returns the full record set. Find by id locally.
      const data = await api.get<MemoryListResp>('/api/memory', {
        apiUrlOverride: parentOpts.apiUrl,
      });
      // Server-shape drift: a non-array `memories` used to throw on .find,
      // and a non-object entry would throw on .id.
      const memories = (Array.isArray(data.memories) ? data.memories : []).filter(
        (m): m is MemoryItem => !!m && typeof m === 'object',
      );
      const found = memories.find((m) => m.id === id);
      if (!found) {
        throw new SpycoreCliError(
          `Memory not found: ${id}`,
          EXIT_USER_ERROR,
          'Run `spycore memory list` to see available IDs.',
        );
      }
      if (getOutputOptions().json) {
        json(found);
        return;
      }
      // Server-returned record fields reaching the terminal - sanitized here,
      // never on the json() path above. Non-string fields render empty
      // (server-shape drift) instead of throwing.
      print(`ID:        ${sanitizeForDisplay(typeof found.id === 'string' ? found.id : '')}`);
      print(`Category:  ${sanitizeForDisplay(typeof found.category === 'string' ? found.category : '')}`);
      if (typeof found.source === 'string' && found.source) print(`Source:    ${sanitizeForDisplay(found.source)}`);
      if (typeof found.confidence === 'number') {
        print(`Confidence: ${found.confidence.toFixed(2)}`);
      }
      print(`Created:   ${relativeTime(typeof found.createdAt === 'string' ? found.createdAt : '')}`);
      if (typeof found.expiresAt === 'string' && found.expiresAt) print(`Expires:   ${relativeTime(found.expiresAt)}`);
      print('');
      print(sanitizeForDisplay(typeof found.content === 'string' ? found.content : ''));
    });
}
