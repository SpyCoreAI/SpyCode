import { Command, Option } from 'commander';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { api } from '../../lib/api.js';
import { json, success, print } from '../../lib/output.js';
import { redactFreeText } from '../../lib/redact.js';
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
  // R3-11: the title is server-generated from the first user message, so
  // a secret pasted there can surface in the title - redact it (and the
  // model) like share.ts already does, not just the message content.
  const title =
    typeof convo.title === 'string' && convo.title
      ? redactFreeText(convo.title)
      : '(untitled)';
  const model = typeof convo.model === 'string' ? redactFreeText(convo.model) : '';
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`*Model:* ${model}  ·  *ID:* \`${typeof convo.id === 'string' ? convo.id : ''}\``);
  lines.push('');
  lines.push('---');
  lines.push('');
  // Server-shape drift: a response without a messages array used to crash
  // with a raw TypeError on for...of - degrade to an empty history, the
  // same guard handoff.ts already uses. Non-object entries are dropped,
  // and per-message fields are read through string guards.
  const messages = (Array.isArray(convo.messages) ? convo.messages : []).filter(
    (m): m is Message => !!m && typeof m === 'object',
  );
  for (const m of messages) {
    const role = typeof m.role === 'string' ? m.role : '';
    const roleLower = role.toLowerCase();
    const model = typeof m.model === 'string' ? m.model : '';
    const heading =
      roleLower === 'user'
        ? '## You'
        : roleLower === 'assistant'
          ? `## ${model ? model : 'Assistant'}`
          : `## ${role}`;
    lines.push(heading);
    lines.push('');
    // Message content is secret-redacted before it lands on disk/stdout,
    // the same guarantee /save and share already make: an export is the
    // file a user is most likely to hand to someone else.
    lines.push(redactFreeText(typeof m.content === 'string' ? m.content : ''));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * The exportable conversation with every message's content redacted.
 * The JSON path dumps the whole object, so the redaction has to happen
 * on the copy, not only in the markdown renderer.
 */
export function redactedExport(convo: ConversationGetResp): ConversationGetResp {
  const messages = (Array.isArray(convo.messages) ? convo.messages : []).filter(
    (m): m is Message => !!m && typeof m === 'object',
  );
  return {
    ...convo,
    // R3-11: the JSON path dumps the whole object, so the title/model need
    // the same redaction as the message content (the title derives from
    // the first user message and can carry a pasted secret).
    title: redactFreeText(typeof convo.title === 'string' ? convo.title : ''),
    model: redactFreeText(typeof convo.model === 'string' ? convo.model : ''),
    messages: messages.map((m) => ({
      ...m,
      content: redactFreeText(typeof m.content === 'string' ? m.content : ''),
    })),
  };
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

        // Redact message content in BOTH formats before anything is
        // written or printed (L8): the JSON path used to dump the whole
        // raw object, secrets included.
        const redacted = redactedExport(convo);
        const body =
          format === 'json'
            ? `${JSON.stringify(redacted, null, 2)}\n`
            : `${toMarkdown(redacted)}\n`;

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
          // here would corrupt an exported file). R3-15: atomic
          // tmp+rename, so a crash mid-write cannot leave a truncated
          // export behind.
          try {
            mkdirSync(dirname(opts.output), { recursive: true });
            writeExportAtomic(opts.output, body);
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
          json(redacted);
        } else {
          // Markdown to the terminal IS a display boundary - sanitize the
          // server-derived body (title/model/content) first (SEC-013).
          print(sanitizeForDisplay(body));
        }
      },
    );
}

/** Write `content` to `abs` atomically: temp file in the same dir + rename. */
function writeExportAtomic(abs: string, content: string): void {
  // tmp+rename replaces the PATH, not the file it points at: a symlinked
  // output must keep being written THROUGH the link (the old direct write
  // did), and a dangling link must still fail ENOENT instead of silently
  // becoming a regular file.
  const dest = resolveWriteTarget(abs);
  const tmp = `${dest}.spycore-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, dest);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/** Resolve a write target through a symlink; absent paths pass through. */
function resolveWriteTarget(abs: string): string {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return abs; // absent: the atomic write creates it
  }
  if (!st.isSymbolicLink()) return abs;
  return realpathSync(abs); // throws ENOENT for a dangling link, ELOOP for a loop
}
