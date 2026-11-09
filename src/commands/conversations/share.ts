import { Command, Option } from 'commander';
import { api } from '../../lib/api.js';
import { fail, getOutputOptions, json, print, success } from '../../lib/output.js';
import { redactFreeText } from '../../lib/redact.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { EXIT_USER_ERROR, SpycoreCliError, isSpycoreCliError } from '../../lib/errors.js';

interface ShareMessage {
  role: string;
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
  messages: ShareMessage[];
}

/** The publishable snapshot: ONLY redacted content ever leaves the CLI. */
export interface ShareBody {
  title: string;
  model: string;
  messages: ShareMessage[];
}

interface ShareCreateResp {
  url?: string;
  shareId?: string;
  expiresAt?: string | null;
}

/**
 * Build the share payload for a conversation, redacting EVERY free-text
 * field first. This is the F9 guarantee: the server receives the redacted
 * snapshot and publishes exactly what it was given, so even a server-side
 * share implementation can never leak a secret the CLI saw in the session.
 * Nothing unredacted crosses the wire - the raw conversation is fetched,
 * redacted in memory, and only the redacted body is POSTed.
 */
export function buildShareBody(convo: ConversationGetResp): ShareBody {
  // Server-shape drift: a response without a messages array used to crash
  // with a raw TypeError on .map - degrade to an empty history, the same
  // guard handoff.ts already uses. Per-message fields are read through
  // string guards (redactFreeText throws on a non-string content).
  const messages = (Array.isArray(convo.messages) ? convo.messages : []).filter(
    (m): m is ShareMessage => !!m && typeof m === 'object',
  );
  return {
    title: redactFreeText(typeof convo.title === 'string' && convo.title ? convo.title : '(untitled)'),
    model: typeof convo.model === 'string' ? convo.model : '',
    messages: messages.map((m) => ({
      role: typeof m.role === 'string' ? m.role : '',
      content: redactFreeText(typeof m.content === 'string' ? m.content : ''),
      model: typeof m.model === 'string' ? m.model : null,
      createdAt: typeof m.createdAt === 'string' ? m.createdAt : '',
    })),
  };
}

/**
 * `spycore conversations share <id>` - generate a publishable share link for
 * a session, redacted BEFORE upload.
 *
 * Revocation: `share <id> --revoke` issues DELETE on the share. Whether the
 * link actually stops resolving depends on the platform implementing the
 * share endpoint - if the server 404s the share routes, the CLI says so
 * plainly and points at `conversations export` as the offline fallback.
 * Platform share support is NOT assumed: every share/revoke failure that
 * looks like "route does not exist" is reported as unsupported, never as a
 * silent success.
 */
export function registerConversationsShareCommand(program: Command): void {
  program
    .command('share <id>')
    .description(
      'Generate a publishable share link for a conversation (content is secret-redacted before upload)',
    )
    .addOption(
      new Option('--revoke', 'Revoke the active share link for this conversation'),
    )
    .action(
      async (id: string, opts: { revoke?: boolean }, cmd: Command) => {
        const root = cmd.parent?.parent;
        const parentOpts = root?.opts<{ apiUrl?: string }>() ?? {};
        const apiOpts = { apiUrlOverride: parentOpts.apiUrl };

        if (opts.revoke) {
          // A 404 on the DELETE conflates two different facts: "no such
          // conversation" and "the platform has no share routes". Check
          // the conversation exists first so each maps to its own error.
          try {
            await api.get(`/conversations/${encodeURIComponent(id)}`, apiOpts);
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
          try {
            await api.delete(`/conversations/${encodeURIComponent(id)}/share`, apiOpts);
          } catch (err) {
            fail(shareUnsupportedError(err, id));
          }
          success(`Share link revoked for ${id}`);
          return;
        }

        const convo = await api.get<ConversationGetResp>(
          `/conversations/${encodeURIComponent(id)}`,
          apiOpts,
        );

        // Redact FIRST, in memory. The POST below carries only this body.
        const body = buildShareBody(convo);

        let created: ShareCreateResp;
        try {
          created = await api.post<ShareCreateResp>(`/conversations/${encodeURIComponent(id)}/share`, {
            ...apiOpts,
            body,
          });
        } catch (err) {
          fail(shareUnsupportedError(err, id));
        }

        if (!created || typeof created.url !== 'string' || created.url.length === 0) {
          fail(
            new SpycoreCliError(
              'The server did not return a share URL.',
              EXIT_USER_ERROR,
              'The platform may not support share links yet.',
            ),
          );
        }

        if (getOutputOptions().json) {
          json({
            id,
            url: created.url,
            shareId: created.shareId ?? null,
            expiresAt: created.expiresAt ?? null,
            redacted: true,
          });
          return;
        }
        print(sanitizeForDisplay(`Share link: ${created.url as string}`));
        // shareId is wire-origin (server-generated) - sanitize like every
        // other server-derived value before it reaches the terminal (SEC-013).
        if (created.shareId) print(sanitizeForDisplay(`Share ID: ${created.shareId}`));
        print(
          'Content was secret-redacted before upload. ' +
            `Revoke anytime: spycore conversations share ${id} --revoke`,
        );
        success('Shared.');
      },
    );
}

/**
 * Map a failed share/revoke request to an honest error. A 404 on the share
 * routes means the platform does not implement share links (yet) - that is
 * a DOCUMENTED platform limitation, not a CLI bug, so the message says
 * exactly that and offers the local-export fallback.
 */
function shareUnsupportedError(err: unknown, id: string): SpycoreCliError {
  if (err instanceof SpycoreCliError && /not found/i.test(err.message)) {
    return new SpycoreCliError(
      `The platform does not support share links for conversations (share endpoint not found). Nothing was published for ${id}.`,
      EXIT_USER_ERROR,
      `Use \`spycore conversations export ${id}\` to share a local file instead.`,
    );
  }
  return err instanceof SpycoreCliError
    ? err
    : new SpycoreCliError(String(err), EXIT_USER_ERROR);
}
