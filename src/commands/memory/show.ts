import { Command } from 'commander';
import { api } from '../../lib/api.js';
import { getOutputOptions, json, print } from '../../lib/output.js';
import { relativeTime } from '../../lib/files.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';

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
      const found = (data.memories ?? []).find((m) => m.id === id);
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
      print(`ID:        ${found.id}`);
      print(`Category:  ${found.category}`);
      if (found.source) print(`Source:    ${found.source}`);
      if (typeof found.confidence === 'number') {
        print(`Confidence: ${found.confidence.toFixed(2)}`);
      }
      print(`Created:   ${relativeTime(found.createdAt)}`);
      if (found.expiresAt) print(`Expires:   ${relativeTime(found.expiresAt)}`);
      print('');
      print(found.content);
    });
}
