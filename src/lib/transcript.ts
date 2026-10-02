/**
 * Conversation → Markdown transcript export. Shared by the `chat` command's
 * `/save` slash command (both the legacy readline handler and the new Ink
 * session). Pure string formatting — no I/O, no provider names.
 */
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

export function conversationToMarkdown(c: ConversationExportResp): string {
  const lines: string[] = [];
  lines.push(`# ${c.title || '(untitled)'}`);
  lines.push('');
  lines.push(`*Model:* ${c.model}  ·  *ID:* \`${c.id}\``);
  lines.push('');
  lines.push('---');
  lines.push('');
  for (const m of c.messages) {
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
  return lines.join('\n') + '\n';
}
