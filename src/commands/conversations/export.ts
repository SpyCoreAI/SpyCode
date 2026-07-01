import { Command, Option } from 'commander';
import { writeFileSync } from 'node:fs';
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
  for (const m of convo.messages) {
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
    .action(
      async (
        id: string,
        opts: { format?: 'markdown' | 'json'; output?: string },
        cmd: Command,
      ) => {
        const root = cmd.parent?.parent;
        const parentOpts = root?.opts<{ apiUrl?: string }>() ?? {};
        const format = opts.format ?? 'markdown';

        const convo = await api.get<ConversationGetResp>(
          `/conversations/${id}`,
          { apiUrlOverride: parentOpts.apiUrl },
        );

        const body =
          format === 'json'
            ? `${JSON.stringify(convo, null, 2)}\n`
            : `${toMarkdown(convo)}\n`;

        if (opts.output) {
          // Writing to a FILE, not the terminal — keep the bytes verbatim
          // (the display sanitizer is display-only by contract; sanitizing
          // here would corrupt an exported file).
          try {
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
          // Markdown to the terminal IS a display boundary — sanitize the
          // server-derived body (title/model/content) first (SEC-013).
          print(sanitizeForDisplay(body));
        }
      },
    );
}
