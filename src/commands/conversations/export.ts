import { Command, Option } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { api } from '../../lib/api.js';
import { json, success, print } from '../../lib/output.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';

interface Message {
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | string;
  content: string;
  model?: string | null;
  createdAt: string;
}

interface ConversationGetResp {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
}

function toMarkdown(convo: ConversationGetResp): string {
  const lines: string[] = [];
  lines.push(`# ${convo.title || '(untitled)'}`);
  lines.push('');
  lines.push(`*Model:* ${convo.model}  ·  *ID:* \`${convo.id}\``);
  lines.push('');
  lines.push('---');
  lines.push('');
  // Server-shape drift: a response without a messages array used to crash
  // with a raw TypeError on for...of - degrade to an empty history, the
  // same guard handoff.ts already uses.
  const messages = Array.isArray(convo.messages) ? convo.messages : [];
  for (const m of messages) {
    const heading =
      m.role.toLowerCase() === 'user'
        ? '## You'
        : m.role.toLowerCase() === 'assistant'
          ? `## ${m.model ? m.model : 'Assistant'}`
          : `## ${m.role}`;
    lines.push(heading);
    lines.push('');
    lines.push(m.content);
    lines.push('');
  }
  return lines.join('\n');
}

export function registerConversationsExportCommand(program: Command): void {
  program
    .command('export <id>')
    .description('Export a conversation as markdown or JSON')
    .addOption(
      new Option('--format <fmt>', 'Output format')
        .choices(['markdown', 'json'])
        .default('markdown'),
    )
    .addOption(new Option('-o, --output <file>', 'Write to file instead of stdout'))
    .addOption(
      new Option('--force', 'Overwrite the output file if it already exists'),
    )
    .action(
      async (
        id: string,
        opts: { format?: 'markdown' | 'json'; output?: string; force?: boolean },
        cmd: Command,
      ) => {
        const root = cmd.parent?.parent;
        const parentOpts = root?.opts<{ apiUrl?: string }>() ?? {};
        const format = opts.format ?? 'markdown';

        const convo = await api.get<ConversationGetResp>(
          `/conversations/${encodeURIComponent(id)}`,
          { apiUrlOverride: parentOpts.apiUrl },
        );

        const body =
          format === 'json'
            ? `${JSON.stringify(convo, null, 2)}\n`
            : `${toMarkdown(convo)}\n`;

        if (opts.output) {
          // Never silently overwrite: refuse an existing file without
          // --force, and create a missing parent directory instead of
          // failing with a raw fs error.
          if (existsSync(opts.output) && !opts.force) {
            throw new SpycoreCliError(
              `Refusing to overwrite ${opts.output} - it already exists.`,
              EXIT_USER_ERROR,
              'Pass --force to overwrite, or choose a different --output path.',
            );
          }
          // Writing to a FILE, not the terminal - keep the bytes verbatim
          // (the display sanitizer is display-only by contract; sanitizing
          // here would corrupt an exported file).
          try {
            mkdirSync(dirname(opts.output), { recursive: true });
            writeFileSync(opts.output, body, 'utf8');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new SpycoreCliError(
              `Failed to write ${opts.output}: ${msg}`,
              EXIT_USER_ERROR,
            );
          }
          success(`Exported to ${opts.output}`);
          return;
        }

        if (format === 'json') {
          json(convo);
        } else {
          // Markdown to the terminal IS a display boundary - sanitize the
          // server-derived body (title/model/content) first (SEC-013).
          print(sanitizeForDisplay(body));
        }
      },
    );
}
