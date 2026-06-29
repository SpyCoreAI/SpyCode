/**
 * The single, render-agnostic slash-command CORE.
 *
 * SpyCode's interactive chat has two front-ends: the one-shot/non-TTY renderer
 * (`commands/chat.ts` → stderr/stdout) and the interactive Ink session
 * (`ui/chat/ChatApp.tsx` → pushed message items). Historically each had its OWN
 * slash dispatch, so the commands users actually hit in the Ink session ran
 * through logic that no test exercised and could silently drift from the
 * unit-tested one-shot handler.
 *
 * This module is the convergence point: ONE dispatcher that performs each
 * command's LOGIC (file ops, model/effort resolution, context building, save)
 * and returns a STRUCTURED, discriminated-union result. It contains NO Ink /
 * React and writes NOTHING to stdout/stderr — both front-ends are thin renderers
 * over the same `SlashOutcome`, so the shipping path is now the tested path.
 *
 * The genuinely surface-specific bits stay in the renderers (they cannot be made
 * render-agnostic):
 *  - /model DISPATCH — the one-shot resolves a name argument; the Ink session
 *    opens an interactive picker. The model-change LOGIC (resolve + effort
 *    clamp) IS shared here (`model-changed`); only how a model is *chosen* differs.
 *  - /new — each surface owns its conversation lifecycle (the one-shot defers
 *    creation to its caller via a flag; the Ink session creates it inline and
 *    updates its React state). The core only signals `new-conversation`.
 *  - /clear, /exit — pure view/loop control; the core only recognises them.
 */
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { resolveModelSlug, type ModelSlug } from '../models.js';
import {
  clampEffortForModel,
  isEffortLevel,
  supportedEffortFor,
  type EffortLevel,
} from '../effort.js';
import {
  appendMemoryNote,
  buildContextInjection,
  initMemoryFile,
  type ContextInjection,
} from '../memory.js';
import {
  guideStatus,
  initCodebaseGuide,
  refreshCodebaseGuide,
} from '../codebase-guide.js';
import {
  changelogStatus,
  initChangelogFile,
  readRecentChangelog,
} from '../codebase-changelog.js';
import { api } from '../api.js';
import { conversationToMarkdown, type ConversationExportResp } from '../transcript.js';

/** Number of newest CODEBASE_CHANGELOG.md entries `/changelog` shows. */
export const CHANGELOG_VIEW_ENTRIES = 5;

/** One canonical command-reference row — the single source for /help on both surfaces. */
export interface SlashHelpEntry {
  /** The command + its argument shape, e.g. `/remember <note>`. */
  command: string;
  /** One-line description. */
  summary: string;
}

/**
 * The single help list. The one-shot renders it as padded text; the Ink session
 * renders it as a bordered panel. Previously each surface hard-coded its own list
 * and the two had already drifted (model/effort/clear/save wording + ordering).
 */
export const SLASH_HELP: readonly SlashHelpEntry[] = [
  { command: '/help', summary: 'show this help' },
  { command: '/model', summary: 'switch the active model (Hermes / Minos / Styx / Styx Max / Charon)' },
  { command: '/effort [level]', summary: 'show or set reasoning effort (auto / low / medium / high / max)' },
  { command: '/init', summary: 'generate SPYCODE.md + CODEBASE_GUIDE.md + CODEBASE_CHANGELOG.md' },
  { command: '/memory', summary: 'show ALL project context loaded into this session' },
  { command: '/remember <note>', summary: 'append a note to the nearest SPYCODE.md' },
  { command: '/guide [refresh]', summary: 'show or regenerate the generated CODEBASE_GUIDE.md' },
  { command: '/changelog', summary: 'show the most recent CODEBASE_CHANGELOG.md entries' },
  { command: '/new', summary: 'start a new conversation' },
  { command: '/save <file>', summary: 'export this conversation as Markdown' },
  { command: '/clear', summary: 'clear the visible session' },
  { command: '/exit', summary: 'quit the chat session' },
];

/** Which living-memory file an /init row reports on. */
export type InitFileKind = 'spycode' | 'guide' | 'changelog';

/** The outcome of generating one of the three /init files. */
export interface InitFileResult {
  file: InitFileKind;
  /** Present on success: whether a new file was written (vs already-present). */
  created?: boolean;
  /** Present on success: the file's absolute path. */
  path?: string;
  /** Present when the generator threw (the other files are still attempted). */
  error?: string;
}

/**
 * The render-agnostic result of one slash command. Each front-end switches on
 * `kind` and presents it in its own idiom; no display text is baked in here for
 * commands whose wording differs between surfaces.
 */
export type SlashOutcome =
  | { kind: 'help' }
  // /model — the change LOGIC; dispatch (arg vs picker) is surface-specific.
  | { kind: 'model-prompt' }
  | {
      kind: 'model-changed';
      model: ModelSlug;
      /** The active effort after clamping to the new model's supported set. */
      effort: EffortLevel;
      effortClamped: boolean;
      requestedEffort: EffortLevel;
    }
  | { kind: 'model-unknown'; input: string; message: string }
  // /effort
  | { kind: 'effort-info'; model: ModelSlug; current: EffortLevel; levels: EffortLevel[] }
  | { kind: 'effort-changed'; model: ModelSlug; level: EffortLevel; clamped: boolean; requested: EffortLevel }
  | { kind: 'effort-unknown'; input: string }
  // /init
  | { kind: 'init'; results: InitFileResult[] }
  // /memory
  | { kind: 'memory'; injection: ContextInjection }
  // /remember
  | { kind: 'remember'; created: boolean; path: string }
  | { kind: 'remember-usage' }
  | { kind: 'remember-error'; message: string }
  // /guide
  | { kind: 'guide-status'; exists: boolean; path: string; lines: number }
  | { kind: 'guide-refreshed'; path: string; preservedNotes: boolean }
  | { kind: 'guide-refresh-error'; message: string }
  | { kind: 'guide-unknown-sub'; sub: string }
  // /changelog
  | {
      kind: 'changelog';
      exists: boolean;
      path: string;
      lines: number;
      entryCount: number;
      shownEntryCount: number;
      text: string;
    }
  // /new — control signal; each surface owns conversation creation.
  | { kind: 'new-conversation' }
  // /save
  | { kind: 'save-usage' }
  | { kind: 'saved'; path: string }
  | { kind: 'save-error'; message: string }
  // /clear, /exit — control signals.
  | { kind: 'clear' }
  | { kind: 'exit' }
  | { kind: 'unknown-command'; name: string };

/** Render-agnostic inputs every command may need. */
export interface SlashContext {
  /** Project root the file commands operate at (usually process.cwd()). */
  cwd: string;
  /** Active model — drives /effort listing/clamp and /model effort-clamp. */
  model: ModelSlug;
  /** Active effort — clamped against the new model on /model. */
  effort: EffortLevel;
  /** Current conversation id — for /save. */
  conversationId: string;
  /** SpyCore API base override (tests / self-hosting); undefined → default. */
  apiUrl: string | undefined;
  /** Context-injection toggle: include CODEBASE_GUIDE.md (config-derived). */
  injectGuide: boolean;
  /** Context-injection toggle: include the CODEBASE_CHANGELOG.md tail. */
  injectChangelog: boolean;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Split a raw `/command arg…` string into its name + argument tokens. */
export function parseSlashInput(raw: string): { name: string; args: string[] } {
  const [name, ...args] = raw.replace(/^\//, '').split(/\s+/);
  return { name: name ?? '', args };
}

/**
 * Run one slash command's LOGIC and return a structured result. Pure of any
 * rendering — callers turn the `SlashOutcome` into stderr text or Ink items.
 * The only side effects are the ones the command IS (writing SPYCODE.md, saving
 * a transcript, …); never any terminal output.
 */
export async function runSlashCommand(
  name: string,
  args: string[],
  ctx: SlashContext,
): Promise<SlashOutcome> {
  switch (name) {
    case 'help':
      return { kind: 'help' };

    case 'model': {
      const target = args[0];
      if (!target) return { kind: 'model-prompt' };
      let slug: ModelSlug;
      try {
        slug = resolveModelSlug(target);
      } catch (err) {
        return { kind: 'model-unknown', input: target, message: errMessage(err) };
      }
      const clamped = clampEffortForModel(slug, ctx.effort);
      return {
        kind: 'model-changed',
        model: slug,
        effort: clamped.level,
        effortClamped: clamped.clamped,
        requestedEffort: clamped.requested,
      };
    }

    case 'effort': {
      const target = args[0];
      if (!target) {
        return {
          kind: 'effort-info',
          model: ctx.model,
          current: ctx.effort,
          levels: [...supportedEffortFor(ctx.model)],
        };
      }
      const level = target.toLowerCase();
      if (!isEffortLevel(level)) return { kind: 'effort-unknown', input: target };
      const clamped = clampEffortForModel(ctx.model, level);
      return {
        kind: 'effort-changed',
        model: ctx.model,
        level: clamped.level,
        clamped: clamped.clamped,
        requested: clamped.requested,
      };
    }

    case 'init': {
      // The three living-memory files are generated INDEPENDENTLY: one existing
      // (or failing) file must never block the others.
      const results: InitFileResult[] = [];
      try {
        const r = await initMemoryFile(ctx.cwd);
        results.push({ file: 'spycode', created: r.created, path: r.path });
      } catch (err) {
        results.push({ file: 'spycode', error: errMessage(err) });
      }
      try {
        const g = await initCodebaseGuide(ctx.cwd);
        results.push({ file: 'guide', created: g.created, path: g.path });
      } catch (err) {
        results.push({ file: 'guide', error: errMessage(err) });
      }
      try {
        const c = initChangelogFile(ctx.cwd);
        results.push({ file: 'changelog', created: c.created, path: c.path });
      } catch (err) {
        results.push({ file: 'changelog', error: errMessage(err) });
      }
      return { kind: 'init', results };
    }

    case 'memory': {
      const injection = buildContextInjection({
        cwd: ctx.cwd,
        injectGuide: ctx.injectGuide,
        injectChangelog: ctx.injectChangelog,
      });
      return { kind: 'memory', injection };
    }

    case 'remember': {
      const note = args.join(' ').trim();
      if (!note) return { kind: 'remember-usage' };
      try {
        const r = appendMemoryNote(ctx.cwd, note);
        return { kind: 'remember', created: r.created, path: r.path };
      } catch (err) {
        return { kind: 'remember-error', message: errMessage(err) };
      }
    }

    case 'guide': {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub === 'refresh') {
        try {
          const r = await refreshCodebaseGuide(ctx.cwd);
          return { kind: 'guide-refreshed', path: r.path, preservedNotes: r.preservedNotes };
        } catch (err) {
          return { kind: 'guide-refresh-error', message: errMessage(err) };
        }
      }
      if (sub.length > 0) return { kind: 'guide-unknown-sub', sub };
      const status = guideStatus(ctx.cwd);
      return { kind: 'guide-status', exists: status.exists, path: status.path, lines: status.lines };
    }

    case 'changelog': {
      const recent = readRecentChangelog(ctx.cwd, { maxEntries: CHANGELOG_VIEW_ENTRIES });
      const status = changelogStatus(ctx.cwd);
      return {
        kind: 'changelog',
        exists: recent.exists,
        path: status.path,
        lines: status.lines,
        entryCount: recent.entryCount,
        shownEntryCount: recent.shownEntryCount,
        text: recent.text,
      };
    }

    case 'new':
      return { kind: 'new-conversation' };

    case 'save': {
      const file = args[0];
      if (!file) return { kind: 'save-usage' };
      try {
        const convo = await api.get<ConversationExportResp>(
          `/conversations/${ctx.conversationId}`,
          { apiUrlOverride: ctx.apiUrl },
        );
        const path = resolvePath(file);
        writeFileSync(path, conversationToMarkdown(convo), 'utf8');
        return { kind: 'saved', path };
      } catch (err) {
        return { kind: 'save-error', message: errMessage(err) };
      }
    }

    case 'clear':
      return { kind: 'clear' };

    case 'exit':
    case 'quit':
      return { kind: 'exit' };

    default:
      return { kind: 'unknown-command', name };
  }
}
