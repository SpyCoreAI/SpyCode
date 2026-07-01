import { Command, Option } from 'commander';
import chalk from 'chalk';
import { sanitizeForDisplay } from '../lib/sanitize-display.js';
import { api, streamRequest, type StreamEvent } from '../lib/api.js';
import { ROUTED_EVENT_PUBLIC, ROUTED_EVENT_WIRE } from '../lib/chat-events.js';
import { getConfigStore } from '../lib/config.js';
import { isAuthenticated } from '../lib/auth.js';
import { createMarkdownRenderer } from '../lib/markdown.js';
import { readStdinPipe } from '../lib/prompt.js';
import {
  EXIT_AUTH_ERROR,
  EXIT_USER_ERROR,
  SpycoreCliError,
  isSpycoreCliError,
} from '../lib/errors.js';
import {
  CHAT_MODELS,
  MODEL_DISPLAY,
  resolveModelSlug,
  type ModelSlug,
} from '../lib/models.js';
import {
  clampEffortForModel,
  EFFORT_DESCRIPTION,
  EFFORT_LEVELS,
  isEffortLevel,
  type EffortLevel,
} from '../lib/effort.js';
import { conversationToMarkdown } from '../lib/transcript.js';
import {
  buildContextInjection,
  formatContextInjection,
} from '../lib/memory.js';
import {
  parseSlashInput,
  runSlashCommand,
  SLASH_HELP,
  type InitFileResult,
  type SlashOutcome,
} from '../lib/slash/registry.js';

// Re-export so existing importers (e.g. tests) keep resolving it from here.
export { conversationToMarkdown };

// Model metadata (ALLOWED_MODELS / CHAT_MODELS / MODEL_DISPLAY / resolveModelSlug)
// now lives in ../lib/models.js so the chat command and the Ink session share
// one source of truth. NEVER reference upstream provider names.

interface ConversationCreateResp {
  id: string;
  title: string;
  model: string;
}

interface ConversationGetResp {
  id: string;
  title: string;
  model: string;
}

interface ChatOpts {
  model?: string;
  effort?: string;
  conversation?: string;
  new?: boolean;
  noStream?: boolean;
  stream?: boolean; // commander auto-handles --no-stream
  stdin?: boolean;
  json?: boolean;
  raw?: boolean;
  resume?: boolean;
}

/**
 * Persist the last conversation ID so `--resume` can rehydrate it. Stored
 * via raw conf access (key not in the typed schema) to keep the schema
 * focused on user-tunable settings.
 */
const LAST_CONVO_KEY = 'lastConversationId';
function setLastConversationId(id: string): void {
  ;(getConfigStore() as unknown as { set(k: string, v: string): void }).set(
    LAST_CONVO_KEY,
    id,
  );
}
function getLastConversationId(): string | null {
  const raw = (getConfigStore() as unknown as {
    get(k: string): unknown;
  }).get(LAST_CONVO_KEY);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/** Whether stdout looks like a TTY — drives ANSI / streaming decisions. */
function stdoutIsTTY(): boolean {
  return process.stdout.isTTY === true;
}

/**
 * Context-injection options derived from config, at the real cwd. The
 * injectGuide/injectChangelog booleans let a user trim the GUIDE/CHANGELOG parts;
 * both default true in the config schema.
 */
function contextOptions(): {
  cwd: string;
  injectGuide: boolean;
  injectChangelog: boolean;
} {
  const cfg = getConfigStore();
  return {
    cwd: process.cwd(),
    injectGuide: cfg.get('injectGuide') !== false,
    injectChangelog: cfg.get('injectChangelog') !== false,
  };
}

/**
 * Resolve the requested reasoning effort from the `--effort` flag, falling back
 * to the configured `defaultEffort` and then 'auto'. Throws a friendly
 * SpycoreCliError on an unrecognised level (mirrors resolveModelSlug). The
 * result is the level the user ASKED for — it is clamped to the model's
 * supported set separately, by clampEffortForModel.
 */
function resolveRequestedEffort(input: string | undefined): EffortLevel {
  const raw =
    input && input.trim().length > 0
      ? input.trim()
      : getConfigStore().get('defaultEffort') || 'auto';
  const level = String(raw).toLowerCase();
  if (!isEffortLevel(level)) {
    throw new SpycoreCliError(
      `Unknown effort: ${raw}`,
      EXIT_USER_ERROR,
      `Allowed: ${EFFORT_LEVELS.join(', ')}`,
    );
  }
  return level;
}

/** One-line notice shown when a requested effort was clamped to fit the model. */
function effortClampNotice(
  requested: EffortLevel,
  level: EffortLevel,
  model: ModelSlug,
): string {
  return `Effort '${requested}' isn't supported by ${MODEL_DISPLAY[model]}; using '${level}'.`;
}

interface SendOpts {
  message: string;
  model: ModelSlug;
  /** Reasoning effort, already clamped to the model's supported set. */
  effort: EffortLevel;
  conversationId: string;
  apiUrl: string | undefined;
  noStream: boolean;
  json: boolean;
  raw: boolean;
  color: boolean;
  signal: AbortSignal;
}

/**
 * Send a single user message and consume the SSE stream. Returns the
 * conversation id (so the interactive loop can update its state) and the
 * full assistant text (useful for tests; ignored in production).
 */
async function sendMessage(opts: SendOpts): Promise<{ conversationId: string; assistant: string }> {
  let assistantText = '';
  const renderer = !opts.json && !opts.raw
    ? createMarkdownRenderer({
        color: opts.color,
        wrapWidth: process.stdout.columns ?? undefined,
      })
    : null;

  const writeJsonLine = (obj: unknown) => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  const writeStderr = (msg: string) => {
    if (opts.json) return; // status hints are noise in JSON pipelines
    process.stderr.write(`${msg}\n`);
  };

  const handleEvent = (event: StreamEvent) => {
    if (typeof event.data !== 'object' || event.data === null) return;
    const payload = event.data as { type?: string } & Record<string, unknown>;

    switch (payload.type) {
      case 'text': {
        const content = String(payload.content ?? '');
        assistantText += content;
        if (opts.json) {
          writeJsonLine({ type: 'chunk', content });
        } else if (opts.raw) {
          process.stdout.write(sanitizeForDisplay(content));
        } else if (opts.noStream) {
          // buffer; render at end via renderer.flush in the caller
        } else if (renderer) {
          process.stdout.write(renderer.write(sanitizeForDisplay(content)));
        }
        break;
      }
      case 'thinking': {
        // Emit thinking as dim stderr so it doesn't pollute the
        // primary assistant transcript on stdout. Skipped in JSON
        // mode unless explicitly requested.
        if (opts.json) {
          writeJsonLine({ type: 'thinking', content: String(payload.content ?? '') });
        } else if (!opts.raw) {
          // intentionally swallowed in human mode — too noisy.
        }
        break;
      }
      case 'skills_activated': {
        // Server emits this before the first content token. Surface as a
        // status line on stderr in human mode, or a JSON line in --json.
        const skills = Array.isArray(payload.skills)
          ? (payload.skills as unknown[])
              .filter((s): s is string => typeof s === 'string')
          : [];
        if (opts.json) {
          writeJsonLine({ type: 'skills_activated', skills });
        } else if (skills.length > 0) {
          writeStderr(chalk.dim(`✨ Skills used: ${skills.join(', ')}`));
        }
        break;
      }
      case 'search_started': {
        if (opts.json) writeJsonLine({ type: 'search_started', query: payload.query });
        else writeStderr(chalk.dim('🔍 Searching the web…'));
        break;
      }
      case 'search_completed': {
        const count = Number(payload.count ?? 0);
        if (opts.json)
          writeJsonLine({ type: 'search_completed', count, sources: payload.sources });
        else writeStderr(chalk.dim(`✓ Found ${count} source${count === 1 ? '' : 's'}`));
        break;
      }
      case 'search_failed': {
        if (opts.json) writeJsonLine({ type: 'search_failed' });
        else writeStderr(chalk.yellow('! Search returned no results'));
        break;
      }
      case ROUTED_EVENT_WIRE: {
        // resolvedModel is a brand label (HERMES/MINOS/...); never an
        // upstream provider name. Surfaced under the neutral public name.
        const resolved = String(payload.resolvedModel ?? '').toUpperCase();
        if (opts.json) writeJsonLine({ type: ROUTED_EVENT_PUBLIC, model: resolved });
        else if (resolved) writeStderr(chalk.dim(`↪ Routed to ${resolved}`));
        break;
      }
      case 'auto_switched': {
        if (opts.json)
          writeJsonLine({
            type: 'auto_switched',
            from: payload.from,
            to: payload.to,
            reason: payload.reason,
          });
        else
          writeStderr(
            chalk.yellow(
              `! Switched ${String(payload.from)} → ${String(payload.to)}: ${String(payload.reason ?? '')}`,
            ),
          );
        break;
      }
      case 'memory_created': {
        if (opts.json) writeJsonLine({ type: 'memory_created' });
        else writeStderr(chalk.dim('✓ Memory saved'));
        break;
      }
      case 'usage': {
        if (opts.json)
          writeJsonLine({
            type: 'usage',
            input: payload.input,
            output: payload.output,
          });
        else {
          const inTok = Number(payload.input ?? 0);
          const outTok = Number(payload.output ?? 0);
          writeStderr(chalk.dim(`(${inTok} in / ${outTok} out tokens)`));
        }
        break;
      }
      case 'title': {
        if (opts.json) writeJsonLine({ type: 'title', content: payload.content });
        // Skip in human mode — title is metadata, not user-facing.
        break;
      }
      case 'finish_reason': {
        if (opts.json) writeJsonLine({ type: 'finish_reason', reason: payload.reason });
        else if (payload.reason === 'length')
          writeStderr(chalk.yellow('! Response truncated (max tokens hit)'));
        break;
      }
      case 'error': {
        const message = String(payload.message ?? 'Unknown error');
        if (opts.json) writeJsonLine({ type: 'error', message });
        // Map known structured error reasons to friendly hints. The
        // server uses the same vocabulary for plan/quota/throttle so the
        // mapping is just a soft pattern match — keep it simple.
        const lower = message.toLowerCase();
        if (lower.includes('plan') || lower.includes('upgrade')) {
          throw new SpycoreCliError(
            `Stream error: ${message}`,
            EXIT_USER_ERROR,
            'Upgrade at https://spycore.ai/pricing.',
          );
        }
        if (lower.includes('quota') || lower.includes('limit')) {
          throw new SpycoreCliError(
            `Stream error: ${message}`,
            EXIT_USER_ERROR,
            'See your usage at https://spycore.ai/usage.',
          );
        }
        throw new SpycoreCliError(`Stream error: ${message}`);
      }
      case 'done': {
        if (opts.json) writeJsonLine({ type: 'done' });
        break;
      }
      default:
        // Unknown event type — pass through in JSON mode for forward-compat.
        if (opts.json) writeJsonLine(payload);
        break;
    }
  };

  try {
    for await (const event of streamRequest(
      '/api/chat/stream',
      {
        conversationId: opts.conversationId,
        message: opts.message,
        model: opts.model.toUpperCase(),
        // Graduated reasoning effort (already clamped per model). 'auto' is
        // wire-identical to omitting it — the backend defaults to 'auto'.
        effort: opts.effort,
      },
      { apiUrlOverride: opts.apiUrl, signal: opts.signal },
    )) {
      handleEvent(event);
    }
  } catch (err) {
    if (renderer) {
      // Flush any buffered markdown so we don't leave a dangling fence on screen.
      process.stdout.write(renderer.flush());
    }
    throw err;
  }

  if (opts.noStream && renderer && !opts.json && !opts.raw) {
    // In --no-stream mode we deferred rendering; do it once at the end.
    process.stdout.write(renderer.write(sanitizeForDisplay(assistantText)));
    process.stdout.write(renderer.flush());
  } else if (renderer && !opts.json && !opts.raw) {
    process.stdout.write(renderer.flush());
    if (assistantText.length > 0 && !assistantText.endsWith('\n')) {
      process.stdout.write('\n');
    }
  } else if (opts.raw && assistantText.length > 0 && !assistantText.endsWith('\n')) {
    process.stdout.write('\n');
  }

  return { conversationId: opts.conversationId, assistant: assistantText };
}

/**
 * Resolve the conversation we should append to:
 *   1. --conversation <id> + must exist
 *   2. --resume + lastConversationId in config
 *   3. otherwise: create a new conversation and remember its id
 */
async function resolveConversationId(
  opts: ChatOpts,
  apiUrl: string | undefined,
  model: ModelSlug,
): Promise<string> {
  if (opts.conversation) {
    try {
      // The GET endpoint returns { conversation: {...}, messages: [...] }
      // wrapped in the standard envelope.
      const fetched = await api.get<{ id: string } | ConversationGetResp>(
        `/conversations/${opts.conversation}`,
        { apiUrlOverride: apiUrl },
      );
      const id = (fetched as { id?: string }).id ?? opts.conversation;
      return id;
    } catch (err) {
      if (isSpycoreCliError(err) && err.code === EXIT_USER_ERROR) {
        throw new SpycoreCliError(
          `Conversation not found: ${opts.conversation}`,
          EXIT_USER_ERROR,
          'List recent conversations with `spycore conversations list`.',
        );
      }
      throw err;
    }
  }
  if (opts.resume) {
    const last = getLastConversationId();
    if (!last) {
      throw new SpycoreCliError(
        'No previous conversation to resume.',
        EXIT_USER_ERROR,
        'Start one with `spycore chat "your message"`.',
      );
    }
    return last;
  }
  const created = await api.post<ConversationCreateResp>('/conversations', {
    apiUrlOverride: apiUrl,
    body: { model: model.toUpperCase() },
  });
  setLastConversationId(created.id);
  return created.id;
}

export function registerChatCommand(program: Command): void {
  program
    .command('chat [message...]')
    .description('Send a message and stream the assistant reply')
    .addOption(
      new Option(
        '-m, --model <model>',
        `Model to use (${CHAT_MODELS.join('|')})`,
      ),
    )
    .addOption(
      new Option(
        '--effort <level>',
        `Reasoning effort (${EFFORT_LEVELS.join('|')}) — clamped to the model`,
      ),
    )
    .addOption(new Option('-c, --conversation <id>', 'Continue an existing conversation'))
    .addOption(new Option('--new', 'Force a new conversation (default when no --conversation/--resume)'))
    .addOption(new Option('--resume', 'Continue the most recent conversation from this device'))
    .addOption(new Option('--no-stream', 'Buffer the full reply before printing (no progressive output)'))
    .addOption(new Option('--stdin', 'Read message body from stdin (for piping)'))
    .addOption(new Option('--raw', 'Skip markdown rendering — output plain assistant text'))
    .action(async (messageParts: string[], opts: ChatOpts, cmd: Command) => {
      const parentOpts = cmd.parent?.opts<{
        apiUrl?: string;
        json?: boolean;
        color?: boolean;
      }>() ?? {};

      if (!(await isAuthenticated())) {
        throw new SpycoreCliError(
          'Not logged in.',
          EXIT_AUTH_ERROR,
          'Run `spycore login` to authenticate.',
        );
      }

      const model = resolveModelSlug(opts.model);
      if (model === 'hephaestus') {
        throw new SpycoreCliError(
          'Chat does not support image generation.',
          EXIT_USER_ERROR,
          'Use `spycore image <prompt>` for image generation.',
        );
      }

      // Decide whether stdout is colour-friendly. --no-color flips
      // chalk.level to 0 globally inside index.ts; here we just need a
      // boolean for the markdown renderer.
      const color = parentOpts.color !== false && stdoutIsTTY();
      const json = Boolean(parentOpts.json);

      // Resolve + clamp the reasoning effort up front so both the one-shot and
      // interactive paths start from the model's supported set. A clamp prints a
      // one-line notice (suppressed in --json so machine output stays clean).
      const requestedEffort = resolveRequestedEffort(opts.effort);
      const { level: effort, clamped: effortClamped } = clampEffortForModel(
        model,
        requestedEffort,
      );
      if (effortClamped && !json) {
        process.stderr.write(
          `${chalk.yellow('!')} ${effortClampNotice(requestedEffort, effort, model)}\n`,
        );
      }

      const conversationId = await resolveConversationId(
        opts,
        parentOpts.apiUrl,
        model,
      );
      setLastConversationId(conversationId);

      const inlineMessage = messageParts.join(' ').trim();
      const oneShot = Boolean(opts.stdin) || inlineMessage.length > 0;

      // ── One-shot / non-interactive path (UNCHANGED) ──────────────────────
      // A message argument, --stdin, --json, --raw and --no-stream all render
      // as plain text via the existing renderer. This path never loads Ink and
      // is the only one available when stdout is not a TTY.
      if (oneShot) {
        const controller = new AbortController();
        const onSigint = () => {
          controller.abort();
          if (!json) process.stderr.write(chalk.red('\n✗ Cancelled\n'));
          // Conventional SIGINT exit code so shell users get the expected behaviour.
          process.exit(130);
        };
        process.on('SIGINT', onSigint);
        try {
          const body = opts.stdin ? (await readStdinPipe()).trim() : inlineMessage;
          if (opts.stdin && !body) {
            throw new SpycoreCliError(
              'No input received on stdin.',
              EXIT_USER_ERROR,
              'Pipe text in: `echo "..." | spycore chat --stdin`.',
            );
          }
          // Project context (SPYCODE.md memory + the generated CODEBASE_GUIDE.md
          // + the latest CODEBASE_CHANGELOG.md entries) is injected as a prefix at
          // the HEAD of a fresh conversation — server-side history then carries it,
          // exactly where a project-context preamble belongs (after the server
          // identity prompt, never overriding it). Re-read from disk each run.
          // A resumed/continued conversation already has it from when it began.
          const isNewConversation = !opts.conversation && !opts.resume;
          let wireMessage = body;
          if (isNewConversation) {
            const injection = buildContextInjection(contextOptions());
            if (injection.block.length > 0) {
              wireMessage = `${injection.block}\n\n${body}`;
              if (!json) {
                const names = injection.parts
                  .filter((p) => p.status !== 'off' && p.status !== 'dropped')
                  .map((p) => p.label)
                  .join(', ');
                process.stderr.write(
                  chalk.dim(`✓ Loaded project context: ${names}\n`),
                );
              }
            }
          }
          await sendMessage({
            message: wireMessage,
            model,
            effort,
            conversationId,
            apiUrl: parentOpts.apiUrl,
            noStream: opts.stream === false,
            json,
            raw: Boolean(opts.raw),
            color,
            signal: controller.signal,
          });
        } finally {
          process.off('SIGINT', onSigint);
        }
        return;
      }

      // ── Interactive path (Ink session) ───────────────────────────────────
      // Requires an interactive terminal; not meaningful in --json. The Ink
      // session is imported lazily so Ink/React never enter the hot path for
      // one-shot or non-interactive invocations.
      if (!stdoutIsTTY() || json) {
        throw new SpycoreCliError(
          'No message provided.',
          EXIT_USER_ERROR,
          'Pass a message argument, use --stdin, or run from a terminal for interactive mode.',
        );
      }

      const { runChatSession } = await import('../ui/chat/run.js');
      await runChatSession({
        model,
        effort,
        conversationId,
        apiUrl: parentOpts.apiUrl,
        color,
      });
    });
}

/**
 * Slash commands available inside the interactive loop. Returns a flag
 * indicating whether the input was consumed; the caller skips the API call when
 * consumed=true.
 *
 * This is now a THIN renderer over the shared, unit-tested slash core
 * (`lib/slash/registry.ts`): it parses the input, runs the command's LOGIC
 * through `runSlashCommand`, and renders the structured `SlashOutcome` to
 * stderr/stdout exactly as before. The Ink session renders the SAME core to
 * message items, so both surfaces can no longer drift.
 */
interface SlashResult {
  consumed: boolean;
  exit?: boolean;
  newModel?: string;
  newEffort?: EffortLevel;
  newConvo?: boolean;
}

/** Format the shared command list as the one-shot's padded help text. */
function formatHelpText(): string {
  return `${SLASH_HELP.map((e) => `${e.command.padEnd(22)} ${e.summary}`).join('\n')}\n`;
}

/** Render one /init file row in the one-shot's wording (unchanged from before). */
function formatInitRow(r: InitFileResult): string {
  if (r.file === 'spycode') {
    if (r.error) return `! /init (SPYCODE.md) failed: ${r.error}\n`;
    return r.created
      ? `✓ Created ${r.path}\n  Review and fill in the generated sections, then it loads automatically.\n`
      : `! SPYCODE.md already exists at ${r.path} — leaving it untouched.\n`;
  }
  if (r.file === 'guide') {
    if (r.error) return `! /init (CODEBASE_GUIDE.md) failed: ${r.error}\n`;
    return r.created
      ? `✓ Created ${r.path}\n  A generated architecture reference — regenerate it any time with /guide refresh.\n`
      : `! CODEBASE_GUIDE.md already exists at ${r.path} — run /guide refresh to regenerate it.\n`;
  }
  if (r.error) return `! /init (CODEBASE_CHANGELOG.md) failed: ${r.error}\n`;
  return r.created
    ? `✓ Created ${r.path}\n  SpyCode records notable changes here (newest first) — view them with /changelog.\n`
    : `! CODEBASE_CHANGELOG.md already exists at ${r.path} — leaving it untouched.\n`;
}

/**
 * Render a `SlashOutcome` to stderr/stdout the way the one-shot loop always has,
 * and map it to the `SlashResult` the caller acts on (exit / model / effort /
 * new-conversation). `/help` and the `/effort` listing stay suppressed under
 * --json so machine pipelines aren't polluted.
 */
function renderOneShot(outcome: SlashOutcome, json: boolean): SlashResult {
  switch (outcome.kind) {
    case 'help':
      if (!json) process.stderr.write(formatHelpText());
      return { consumed: true };
    case 'model-prompt':
      process.stderr.write('Usage: /model <hermes|minos|styx|styx_max|charon>\n');
      return { consumed: true };
    case 'model-changed':
      process.stderr.write(`✓ Model set to ${outcome.model}\n`);
      return { consumed: true, newModel: outcome.model };
    case 'model-unknown':
      process.stderr.write(`! ${outcome.message}\n`);
      return { consumed: true };
    case 'effort-info':
      if (!json) {
        const rows = outcome.levels.map((l) => `  ${l.padEnd(7)}${EFFORT_DESCRIPTION[l]}`);
        process.stderr.write(
          [`Effort levels for ${MODEL_DISPLAY[outcome.model]}:`, ...rows, ''].join('\n'),
        );
      }
      return { consumed: true };
    case 'effort-changed':
      if (outcome.clamped) {
        process.stderr.write(
          `${effortClampNotice(outcome.requested, outcome.level, outcome.model)}\n`,
        );
      } else {
        process.stderr.write(`✓ Effort set to ${outcome.level}\n`);
      }
      return { consumed: true, newEffort: outcome.level };
    case 'effort-unknown':
      process.stderr.write(
        `! Unknown effort: ${outcome.input}. Allowed: ${EFFORT_LEVELS.join(', ')}\n`,
      );
      return { consumed: true };
    case 'init':
      for (const r of outcome.results) process.stderr.write(formatInitRow(r));
      return { consumed: true };
    case 'memory':
      process.stderr.write(`${formatContextInjection(outcome.injection)}\n`);
      return { consumed: true };
    case 'remember':
      process.stderr.write(
        `✓ ${outcome.created ? 'Created' : 'Updated'} ${outcome.path}\n  It will load on your next new conversation.\n`,
      );
      return { consumed: true };
    case 'remember-usage':
      process.stderr.write('Usage: /remember <note>\n');
      return { consumed: true };
    case 'remember-error':
      process.stderr.write(`! /remember failed: ${outcome.message}\n`);
      return { consumed: true };
    case 'guide-status':
      if (outcome.exists) {
        process.stderr.write(
          `CODEBASE_GUIDE.md — ${outcome.path}\n  ${outcome.lines} line${
            outcome.lines === 1 ? '' : 's'
          }. Regenerate from a fresh scan with /guide refresh.\n`,
        );
      } else {
        process.stderr.write(
          'No CODEBASE_GUIDE.md in this project.\n  Generate one with /init, or /guide refresh.\n',
        );
      }
      return { consumed: true };
    case 'guide-refreshed':
      process.stderr.write(
        `✓ Regenerated CODEBASE_GUIDE.md at ${outcome.path}\n${
          outcome.preservedNotes ? '  Your "## Notes (manual)" section was preserved.\n' : ''
        }`,
      );
      return { consumed: true };
    case 'guide-refresh-error':
      process.stderr.write(`! /guide refresh failed: ${outcome.message}\n`);
      return { consumed: true };
    case 'guide-unknown-sub':
      process.stderr.write(
        `! Unknown /guide subcommand: ${outcome.sub}. Try /guide or /guide refresh.\n`,
      );
      return { consumed: true };
    case 'changelog': {
      if (!outcome.exists) {
        process.stderr.write(
          'No CODEBASE_CHANGELOG.md in this project.\n  Generate one with /init.\n',
        );
        return { consumed: true };
      }
      const counts =
        outcome.entryCount === 0
          ? 'no entries yet'
          : `${outcome.shownEntryCount} most recent of ${outcome.entryCount} entr${
              outcome.entryCount === 1 ? 'y' : 'ies'
            }`;
      process.stderr.write(
        `CODEBASE_CHANGELOG.md — ${outcome.path}\n  ${outcome.lines} line${
          outcome.lines === 1 ? '' : 's'
        }, ${counts}:\n\n${outcome.text}\n`,
      );
      return { consumed: true };
    }
    case 'new-conversation':
      process.stderr.write('✓ Starting a new conversation…\n');
      return { consumed: true, newConvo: true };
    case 'save-usage':
      process.stderr.write('Usage: /save <file>\n');
      return { consumed: true };
    case 'saved':
      process.stderr.write(`✓ Saved to ${outcome.path}\n`);
      return { consumed: true };
    case 'save-error':
      process.stderr.write(`! Save failed: ${outcome.message}\n`);
      return { consumed: true };
    case 'clear':
      process.stdout.write('\x1b[2J\x1b[H');
      return { consumed: true };
    case 'exit':
      return { consumed: true, exit: true };
    case 'unknown-command':
      process.stderr.write(`Unknown command: /${outcome.name}. Try /help.\n`);
      return { consumed: true };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export async function handleSlashCommand(
  raw: string,
  ctx: {
    json: boolean;
    color: boolean;
    currentConvo: string;
    apiUrl: string | undefined;
    /** Active model — used to clamp /effort. Defaults to the configured model. */
    model?: ModelSlug;
    /** Active effort — clamped against the new model on /model. Defaults to auto. */
    effort?: EffortLevel;
  },
): Promise<SlashResult> {
  if (!raw.startsWith('/')) return { consumed: false };
  const { name, args } = parseSlashInput(raw);
  const cfg = getConfigStore();
  const outcome = await runSlashCommand(name, args, {
    cwd: process.cwd(),
    model: ctx.model ?? resolveModelSlug(undefined),
    effort: ctx.effort ?? 'auto',
    conversationId: ctx.currentConvo,
    apiUrl: ctx.apiUrl,
    injectGuide: cfg.get('injectGuide') !== false,
    injectChangelog: cfg.get('injectChangelog') !== false,
  });
  return renderOneShot(outcome, ctx.json);
}
