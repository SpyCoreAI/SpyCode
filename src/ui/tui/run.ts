/**
 * Lazy entry point for the interactive TUI (bare `spycore`). Free of static
 * React/Ink imports so the bare invocation never pulls Ink into the CLI hot
 * path - the heavy UI only loads when the TUI actually starts.
 *
 * Pre-mount sequence (plain terminal, stdin still in cooked mode):
 *   1. theme mode: config `theme` (auto|light|dark); 'auto' probes the
 *      terminal background via OSC 11 with a timeout fallback to dark.
 *   2. lifecycle hooks + command allow/deny rules, with the same
 *      trust/approval-gated project prompts as the chat session (they need
 *      the plain terminal - Ink owns stdin afterwards).
 *   3. auth check, so the TUI can show the graceful not-logged-in notice.
 */
import { isInteractive } from '../lib/render.js';
import { getConfigStore } from '../../lib/config.js';
import { isAuthenticated } from '../../lib/auth.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { readSingleLineInput } from '../../lib/prompt.js';
import { loadHookSession, fireHookEvent } from '../../lib/hooks.js';
import { loadCommandRules, type RuleKind } from '../../lib/agent/command-rules.js';
import type { RunAgentOptions } from '../../lib/agent/loop.js';
import { detectCapabilities } from '../theme/capabilities.js';
import { resolveTheme } from '../theme/theme.js';
import {
  isGalleryThemeId,
  resolveThemeSelection,
} from '../theme/gallery.js';
import {
  probeTerminalBackground,
  resolveThemeMode,
  type ThemeSetting,
} from './theme-detect.js';

export interface TuiSessionConfig {
  /** SpyCore API base override. */
  apiUrl: string | undefined;
  /** Whether color is enabled (from --no-color + TTY). */
  color: boolean;
}

export async function runTuiSession(cfg: TuiSessionConfig): Promise<void> {
  // The caller guarantees a TTY, but guard so we never launch Ink into a sink.
  if (!isInteractive()) return;
  if (!cfg.color) process.env.NO_COLOR = process.env.NO_COLOR ?? '1';

  const cwd = process.cwd();

  // ── theme: 'auto' probes the live terminal, explicit modes apply directly.
  // A persisted gallery selection (set by the /theme picker) wins over the
  // builtin setting so the choice survives restart. resolveThemeSelection
  // falls back to 'auto' semantics for unknown ids, so a stale value can
  // never break startup.
  const setting = (getConfigStore().get('theme') as ThemeSetting) ?? 'auto';
  const galleryId = (getConfigStore().get('themeGallery') as string) || '';
  const probed = setting === 'auto' ? await probeTerminalBackground() : null;
  const theme =
    galleryId !== '' && isGalleryThemeId(galleryId)
      ? resolveThemeSelection(galleryId, detectCapabilities(), probed)
      : resolveTheme(detectCapabilities(), resolveThemeMode(setting, probed));

  // ── lifecycle hooks (mirrors ui/chat/run.ts): project hooks are
  // trust- AND approval-gated before Ink mounts.
  const userNotices: string[] = [];
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
  for (const n of hooks.notices) userNotices.push(`! ${sanitizeForDisplay(n)}`);

  // ── command allow/deny rules (mirrors ui/chat/run.ts).
  const commandRules = await loadCommandRules(cwd, {
    approveProjectEntry: async (e: { kind: RuleKind; entry: string }) => {
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
  for (const n of commandRules.notices) userNotices.push(`! ${sanitizeForDisplay(n)}`);
  for (const n of userNotices) process.stderr.write(`${n}\n`);
  const sessionStart = await fireHookEvent(hooks, 'session-start');
  for (const n of sessionStart.notices) process.stderr.write(`! ${sanitizeForDisplay(n)}\n`);

  const loggedIn = await isAuthenticated().catch(() => false);

  const [{ render }, { createElement }, { TuiApp }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./TuiApp.js'),
  ]);
  const { enableFocusTracking, disableFocusTracking } = await import('./attention.js');
  enableFocusTracking();
  const instance = render(
    createElement(TuiApp, {
      initialTheme: theme,
      probedMode: probed,
      loggedIn,
      apiUrl: cfg.apiUrl,
      commandRules: commandRules.rules as RunAgentOptions['commandRules'],
      hooks,
    }),
    { exitOnCtrlC: false },
  );
  // F-H2: handle SIGTERM/SIGHUP gracefully - restore the terminal instead of
  // leaving it in raw mode with focus-reporting enabled.
  const onTermSignal = (): void => {
    process.removeListener('SIGTERM', onTermSignal);
    process.removeListener('SIGHUP', onTermSignal);
    try {
      disableFocusTracking();
    } catch {
      /* best-effort */
    }
    try {
      instance.unmount();
    } catch {
      /* best-effort */
    }
    process.exit(143); // 128 + 15 (SIGTERM)
  };
  process.once('SIGTERM', onTermSignal);
  process.once('SIGHUP', onTermSignal);
  try {
    await instance.waitUntilExit();
  } finally {
    disableFocusTracking();
    try {
      const end = await fireHookEvent(hooks, 'session-end');
      for (const n of end.notices) process.stderr.write(`! ${sanitizeForDisplay(n)}\n`);
    } catch {
      /* hooks never break shutdown */
    }
  }
}
