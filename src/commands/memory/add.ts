import { Command, Option } from 'commander';
import { api } from '../../lib/api.js';
import { getOutputOptions, json, success } from '../../lib/output.js';
import { readMultilineInput, readStdinPipe } from '../../lib/prompt.js';
import {
  EXIT_USER_ERROR,
  SpycoreCliError,
} from '../../lib/errors.js';

const ALLOWED_CATEGORIES = [
  'PROFILE',
  'PREFERENCES',
  'CONTEXT',
  'KNOWLEDGE',
  'STYLE',
  'CUSTOM',
];

interface MemoryItem {
  id: string;
  category: string;
  content: string;
  pinned?: boolean;
  createdAt: string;
}

export function registerMemoryAddCommand(program: Command): void {
  program
    .command('add [text...]')
    .description('Add a memory')
    .addOption(
      new Option('-c, --category <category>', 'Memory category')
        .choices(ALLOWED_CATEGORIES.map((c) => c.toLowerCase()))
        .default('context'),
    )
    .addOption(new Option('--pinned', 'Pin the memory so it always loads in context'))
    .action(
      async (
        textArg: string[] | undefined,
        opts: { category?: string; pinned?: boolean },
        cmd: Command,
      ) => {
        const root = cmd.parent?.parent;
        const parentOpts = root?.opts<{ apiUrl?: string }>() ?? {};

        let text = (textArg ?? []).join(' ').trim();
        if (text.length === 0) {
          if (process.stdin.isTTY === true) {
            text = (await readMultilineInput({ prompt: '> ' })).trim();
          } else {
            text = (await readStdinPipe()).trim();
          }
        }
        if (text.length < 2) {
          throw new SpycoreCliError(
            'Memory content is too short.',
            EXIT_USER_ERROR,
            'Provide at least 2 characters of content.',
          );
        }
        if (text.length > 500) {
          throw new SpycoreCliError(
            `Memory exceeds 500 char limit (got ${text.length}).`,
            EXIT_USER_ERROR,
          );
        }

        const category = (opts.category ?? 'context').toUpperCase();

        const created = await api.post<MemoryItem>('/api/memory', {
          apiUrlOverride: parentOpts.apiUrl,
          body: {
            category,
            content: text,
            pinned: Boolean(opts.pinned),
          },
        });

        if (getOutputOptions().json) {
          json(created);
          return;
        }
        success(`Added memory ${created.id}`);
      },
    );
}
