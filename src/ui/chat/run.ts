/**
 * Lazy entry point for the interactive Ink chat session. Free of static
 * React/Ink imports so the chat command only loads Ink when it actually runs
 * the interactive shell (the one-shot path never touches this module).
 */
import { isInteractive } from '../lib/render.js';
import type { ModelSlug } from '../../lib/models.js';
import type { EffortLevel } from '../../lib/effort.js';
import type { LocalAttachment } from '../../lib/attachments.js';
import { loadUserCommands } from '../../lib/slash/user-commands.js';
import { fireHookEvent, loadHookSession } from '../../lib/hooks.js';
import { loadCommandRules } from '../../lib/agent/command-rules.js';
import { readSingleLineInput } from '../../lib/prompt.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';

export interface ChatSessionConfig {
  model: ModelSlug;
  /** Initial reasoning effort, already clamped to the model's supported set. */
  effort: EffortLevel;
  conversationId: string;
  apiUrl: string | undefined;
  /** Whether color is enabled (from --no-color + TTY). Propagated to the theme. */
  color: boolean;
  /** --attach seeds: validated attachments queued for the session's FIRST message. */
  initialAttachments?: LocalAttachment[] | undefined;
}

export async function runChatSession(cfg: ChatSessionConfig): Promise<void> {
  // The caller guarantees a TTY, but guard anyway so we never launch full-screen
  // Ink into a non-terminal sink.
  if (!isInteractive()) return;
  // Propagate --no-color into the Ink theme's capability detection.
  if (!cfg.color) process.env.NO_COLOR = process.env.NO_COLOR ?? '1';

  // ── PHASE-1 1.6: user commands + lifecycle hooks, loaded once, BEFORE Ink
  // mounts (the project-hook approval prompt needs the plain terminal).
  // Loading never throws; diagnostics print as plain stderr lines.
  const cwd = process.cwd();
  const userCommands = loadUserCommands(cwd);
  // Notices embed repository-authored text (file labels, entry names, hook
  // output). Measured, the PRODUCERS are inconsistent: hooks.ts shortCmd() and
  // command-rules.ts shortEntry() already sanitize at construction, while the
  // user-command scanner did not. Applying it HERE, at the sink, makes the
  // property hold whichever producer is added later — and is safe only because
  // the sanitizer is idempotent, which the suite pins rather than assumes.
  for (const n of userCommands.notices) process.stderr.write(`! ${sanitizeForDisplay(n)}\n`);
  const hooks = await loadHookSession(cwd, {
    approveProjectHook: async (h) => {
      try {
        const answer = await readSingleLineInput(
          `Project hook wants to run at ${h.event}:\n  ${sanitizeForDisplay(h.command)}\nAllow and remember for this exact command? [y/N] `,
        );
        return /^y(es)?$/i.test(answer.trim());
      } catch {
        return false;
      }
    },
  });
  for (const n of hooks.notices) process.stderr.write(`! ${sanitizeForDisplay(n)}\n`);
  // ── PHASE-1 1.10: command allow/deny rules for agent-mode runs, loaded once
  // BEFORE Ink mounts (the per-entry project approval prompt needs the plain
  // terminal). Project entries are trust- AND approval-gated, like hooks.
  const commandRules = await loadCommandRules(cwd, {
    approveProjectEntry: async (e) => {
      try {
        const answer = await readSingleLineInput(
          `Project command ${e.kind} rule from .spycore/command-rules.json:\n  ${sanitizeForDisplay(e.entry)}\nApply and remember this exact rule? [y/N] `,
        );
        return /^y(es)?$/i.test(answer.trim());
      } catch {
        return false;
      }
    },
  });
  for (const n of commandRules.notices) process.stderr.write(`! ${sanitizeForDisplay(n)}\n`);
  const sessionStart = await fireHookEvent(hooks, 'session-start');
  for (const n of sessionStart.notices) process.stderr.write(`! ${sanitizeForDisplay(n)}\n`);

  const [{ render }, { createElement }, { ChatApp }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./ChatApp.js'),
  ]);
  const instance = render(
    createElement(ChatApp, {
      model: cfg.model,
      effort: cfg.effort,
      conversationId: cfg.conversationId,
      apiUrl: cfg.apiUrl,
      initialAttachments: cfg.initialAttachments,
      userCommands: userCommands.commands,
      hooks,
      commandRules: commandRules.hasAny ? commandRules.rules : undefined,
    }),
    { exitOnCtrlC: false },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    // session-end fires even when the session throws; failures are isolated.
    try {
      const end = await fireHookEvent(hooks, 'session-end');
      for (const n of end.notices) process.stderr.write(`! ${sanitizeForDisplay(n)}\n`);
    } catch {
      /* hooks never break shutdown */
    }
  }
}
