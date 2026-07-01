/**
 * Lazy entry point for the interactive Ink chat session. Free of static
 * React/Ink imports so the chat command only loads Ink when it actually runs
 * the interactive shell (the one-shot path never touches this module).
 */
import { isInteractive } from '../lib/render.js';
import type { ModelSlug } from '../../lib/models.js';
import type { EffortLevel } from '../../lib/effort.js';

export interface ChatSessionConfig {
  model: ModelSlug;
  /** Initial reasoning effort, already clamped to the model's supported set. */
  effort: EffortLevel;
  conversationId: string;
  apiUrl: string | undefined;
  /** Whether color is enabled (from --no-color + TTY). Propagated to the theme. */
  color: boolean;
}

export async function runChatSession(cfg: ChatSessionConfig): Promise<void> {
  // The caller guarantees a TTY, but guard anyway so we never launch full-screen
  // Ink into a non-terminal sink.
  if (!isInteractive()) return;
  // Propagate --no-color into the Ink theme's capability detection.
  if (!cfg.color) process.env.NO_COLOR = process.env.NO_COLOR ?? '1';

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
    }),
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
}
