import { Command, Option } from 'commander';
import chalk from 'chalk';
import { api } from '../../lib/api.js';
import { createMarkdownRenderer } from '../../lib/markdown.js';
import { parseIntFlag } from '../../lib/numeric-flags.js';
import { getOutputOptions, json, print } from '../../lib/output.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { EXIT_USER_ERROR, SpycoreCliError, isSpycoreCliError } from '../../lib/errors.js';

interface Message {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | string;
  content: string;
  model?: string | null;
  createdAt: string;
}

interface ConversationGetResp {
  id: string;
  title: string;
  model: string;
  messages: Message[];
}

function roleLabel(role: unknown): string {
  // Server-shape drift: a non-string role used to crash on .toLowerCase().
  const r = typeof role === 'string' ? role : '';
  if (r.toLowerCase() === 'user') return 'You';
  if (r.toLowerCase() === 'assistant') return 'Assistant';
  if (r.toLowerCase() === 'system') return 'System';
  return r;
}

/** Lower-cased role for comparisons; '' for a non-string role. */
function roleLower(role: unknown): string {
  return typeof role === 'string' ? role.toLowerCase() : '';
}

export function registerConversationsShowCommand(program: Command): void {
  program
    .command('show <id>')
    .description('Print the message history of a conversation')
    .addOption(new Option('--limit <n>', 'Max messages to print (most recent N)').default('50'))
    .addOption(new Option('--raw', 'Skip markdown rendering - print plain text'))
    .action(
      async (
        id: string,
        opts: { limit?: string; raw?: boolean },
        cmd: Command,
      ) => {
        const root = cmd.parent?.parent;
        const parentOpts = root?.opts<{
          apiUrl?: string;
          json?: boolean;
          color?: boolean;
        }>() ?? {};
        const limit = parseIntFlag(opts.limit, 'limit', { min: 1, max: 500, defaultValue: 50 });

        let convo: ConversationGetResp;
        try {
          convo = await api.get<ConversationGetResp>(`/conversations/${encodeURIComponent(id)}`, {
            apiUrlOverride: parentOpts.apiUrl,
          });
        } catch (err) {
          if (isSpycoreCliError(err) && err.code === EXIT_USER_ERROR) {
            throw new SpycoreCliError(
              `Conversation not found: ${id}`,
              EXIT_USER_ERROR,
              'Run `spycore conversations list` to see available IDs.',
            );
          }
          throw err;
        }

        // Server-shape drift: a response without a messages array used to
        // crash with a raw TypeError on .slice - degrade to an empty
        // history, the same guard handoff.ts already uses. Non-object
        // entries are dropped too (a null entry would throw on .role).
        const messages = (Array.isArray(convo.messages) ? convo.messages : []).filter(
          (m): m is Message => !!m && typeof m === 'object',
        );
        const tail = messages.slice(-limit);

        if (getOutputOptions().json) {
          json({ id: convo.id, title: convo.title, model: convo.model, messages: tail });
          return;
        }

        const color = parentOpts.color !== false && process.stdout.isTTY === true;
        // Every server-controlled string crosses the display sanitizer before
        // the terminal (title, model, id, role label, and message content) -
        // the same boundary the chat/agent renderers use (SEC-013).
        print(chalk.bold(`# ${sanitizeForDisplay(convo.title) || '(untitled)'}`));
        print(chalk.dim(`  ${sanitizeForDisplay(convo.model)} · ${sanitizeForDisplay(convo.id)}`));
        print('');

        for (const m of tail) {
          const safeLabel = `[${sanitizeForDisplay(roleLabel(m.role))}]`;
          const label =
            roleLower(m.role) === 'assistant' ? chalk.cyan(safeLabel) : chalk.green(safeLabel);
          print(label);
          const content = typeof m.content === 'string' ? m.content : '';
          if (opts.raw || roleLower(m.role) === 'user') {
            print(sanitizeForDisplay(content));
          } else {
            const renderer = createMarkdownRenderer({
              color,
              wrapWidth: process.stdout.columns ?? undefined,
            });
            const safeContent = sanitizeForDisplay(content);
            process.stdout.write(renderer.write(safeContent));
            process.stdout.write(renderer.flush());
            if (!safeContent.endsWith('\n')) process.stdout.write('\n');
          }
          print('');
        }
      },
    );
}
