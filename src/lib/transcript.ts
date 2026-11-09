/**
 * Conversation → Markdown transcript export. Shared by the `chat` command's
 * `/save` slash command (both the legacy readline handler and the new Ink
 * session). Pure string formatting - no I/O, no provider names.
 *
 * Message content is passed through redactFreeText() so pasted
 * credentials / API keys never land on disk unscrubbed.
 */
import { redactFreeText } from './redact.js';
import { truncateSafe } from './text.js';
export interface ConversationExportResp {
  id: string;
  title: string;
  model: string;
  messages: Array<{
    role: string;
    content: string;
    model?: string | null;
    createdAt: string;
  }>;
}

/** Max chars for one server-controlled header field in the export. */
const EXPORT_FIELD_MAX_CHARS = 200;

/**
 * Sanitize a server-controlled header field (title / model / id / role)
 * before it lands raw in the exported file: flatten newlines and control
 * chars (a crafted title could otherwise inject markdown headings or
 * break out of the file's structure), strip backticks (they would break
 * the `` `id` `` code span), and cap the length. Message CONTENT already
 * goes through redactFreeText below; these fields never did.
 */
function sanitizeExportField(value: unknown): string {
  // Server-controlled fields are typed as strings, but the live export has
  // been seen without a title/model (and the /save test fixture omits them);
  // a missing field renders empty instead of throwing inside the exporter.
  const text = typeof value === 'string' ? value : '';
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[`\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > EXPORT_FIELD_MAX_CHARS
    ? `${truncateSafe(flat, EXPORT_FIELD_MAX_CHARS - 1).trimEnd()}…`
    : flat;
}

export function conversationToMarkdown(c: ConversationExportResp): string {
  const lines: string[] = [];
  // R3-11: the title is server-generated from the first user message, so
  // a secret pasted there can surface in the title - redact it (and the
  // model) like share.ts already does, matching the message-content
  // guarantee. sanitizeExportField flattens/caps; redaction runs first so
  // a secret is scrubbed before it is shaped for the file.
  lines.push(`# ${sanitizeExportField(redactFreeText(typeof c.title === 'string' ? c.title : '')) || '(untitled)'}`);
  lines.push('');
  lines.push(`*Model:* ${sanitizeExportField(redactFreeText(typeof c.model === 'string' ? c.model : ''))}  ·  *ID:* \`${sanitizeExportField(c.id)}\``);
  lines.push('');
  lines.push('---');
  lines.push('');
  // Server-shape drift: a response without a messages array used to crash
  // on for...of, and a non-string content used to crash inside
  // redactFreeText (.replace on a non-string). Degrade to an empty history
  // and empty content instead of a raw TypeError surfacing as save-error.
  const messages = (Array.isArray(c.messages) ? c.messages : []).filter(
    (m): m is ConversationExportResp['messages'][number] => !!m && typeof m === 'object',
  );
  for (const m of messages) {
    const role = sanitizeExportField(m.role);
    const heading =
      role.toLowerCase() === 'user'
        ? '## You'
        : role.toLowerCase() === 'assistant'
          ? `## ${m.model ? sanitizeExportField(redactFreeText(typeof m.model === 'string' ? m.model : '')) : 'Assistant'}`
          : `## ${role}`;
    lines.push(heading);
    lines.push('');
    lines.push(redactFreeText(typeof m.content === 'string' ? m.content : ''));
    lines.push('');
  }
  return lines.join('\n') + '\n';
}
