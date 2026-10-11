import { Command, Option } from 'commander';
import chalk from 'chalk';
import { api } from '../../lib/api.js';
import { isAuthenticated } from '../../lib/auth.js';
import { getConfigStore } from '../../lib/config.js';
import { EXIT_AUTH_ERROR, EXIT_USER_ERROR, SpycoreCliError, isSpycoreCliError } from '../../lib/errors.js';
import { getOutputOptions, json, warn } from '../../lib/output.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import {
  runAgent,
  CONTINUE_HINT,
  DEFAULT_MAX_TURNS,
  MAX_TURNS_CAP,
  MIN_TURNS,
  type AgentEvent,
  type AgentModelSlug,
} from '../../lib/agent/loop.js';
import { headlessApproval } from '../../lib/agent/approval.js';
import { createBudget, toBudgetCaps, formatBudgetBar, describeBudgetStop } from '../../lib/agent/budget.js';
import { createRunRecorder } from '../../lib/agent/checkpoint.js';
import { currentGitHead, makeRunStateHook } from '../../lib/agent/resume.js';
import { MODEL_DISPLAY } from '../../lib/models.js';
import { loadCommandRules } from '../../lib/agent/command-rules.js';
import { buildContextInjection } from '../../lib/memory.js';

/**
 * Web ↔ CLI handoff (`spycore conversations handoff <id>`).
 *
 * Takes a server-side conversation (e.g. started in web chat) and resumes it
 * as a CLI agent run with its FULL history. The transcript lives server-side,
 * so nothing is replayed or reordered client-side - the handoff opens a NEW
 * AGENT TURN on the EXISTING conversationId through the same
 * conversationId/continueMessage contract `spycore agent --resume` uses.
 *
 * Turn-type semantics (F7):
 * - FRESH: `spycore agent <task>` opens a new conversation; turn 1 carries the
 *   system prompt + task + attachments.
 * - RESUME: `spycore agent --resume` continues an interrupted CLI session on
 *   its own conversation; journaled drift is checked and the conversation's
 *   tool protocol is re-seeded from the checkpoint record.
 * - HANDOFF (this command): a new agent turn on a conversation the CLI did NOT
 *   start (web chat, another device, ...). History above the handoff turn is
 *   preserved COMPLETE and IN ORDER - the agent continues from the last
 *   message's state and must NOT redo completed work. The CLI gain is local
 *   tools (read/write files, run commands) the web surface lacks.
 * - VERIFY FIX-UP: later turns inside one runAgent call (server-side history
 *   for SpyCore, adapter state for BYOK) - carry only the new instruction.
 *
 * Protocol gap (F7-1): the platform API does not expose a conversation's
 * tool protocol or system prompt (GET /conversations/:id returns id, title,
 * model, messages only). A handoff conversation was not started by this CLI,
 * so the provider's per-conversation native-tools capability cannot be
 * seeded - `auto` resolves to FENCED and CONTINUE_HINT is appended, the same
 * wire-safe fallback the loop uses for half-open tool rounds. If the server
 * ever exposes the conversation's protocol, seed it here exactly the way
 * `agent.ts`'s resume path seeds from the checkpoint record.
 *
 * Capability gap (F7-2): a web-started conversation may not be tool-capable
 * server-side. The handoff still sends the turn; if the server ignores tool
 * calls the run ends as plain chat text and the budget/turn guards report it.
 * There is no client-side probe - invented endpoints are forbidden.
 *
 * History guarantee: the fetch below requests the conversation with NO limit -
 * the whole `messages` array is used for verification and reporting, never
 * truncated and never reordered. Display may summarize, but what the agent
 * receives (server-side history + the handoff turn) is the complete thread.
 */

interface Message {
  id: string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | string;
  content: string;
  model?: string | null;
  createdAt: string;
}

interface ConversationGetResp {
  id: string;
  title: string;
  model: string;
  messages: Message[];
}

const HANDOFF_MODELS: readonly AgentModelSlug[] = ['charon', 'styx', 'hermes', 'minos'];

function resolveHandoffModel(conversationModel: string, flag?: string): { model: AgentModelSlug; fromFlag: boolean } {
  if (flag !== undefined) {
    const slug = flag.toLowerCase() as AgentModelSlug;
    if (!(HANDOFF_MODELS as readonly string[]).includes(slug)) {
      throw new SpycoreCliError(`Unknown model: ${flag}`, EXIT_USER_ERROR, `Allowed: ${HANDOFF_MODELS.join(', ')}`);
    }
    return { model: slug, fromFlag: true };
  }
  const convoSlug = (conversationModel ?? '').toLowerCase();
  if ((HANDOFF_MODELS as readonly string[]).includes(convoSlug)) {
    return { model: convoSlug as AgentModelSlug, fromFlag: false };
  }
  // The server's model label is not an agent-callable slug (display name,
  // web-only model, ...). Continue with the CLI workhorse rather than fail;
  // the notice below makes the substitution explicit.
  return { model: 'styx', fromFlag: false };
}

/**
 * The handoff turn: a new agent turn on an existing conversation. States the
 * turn-type contract (new turn, history preserved, continue from last state),
 * carries the user's optional instruction, and appends CONTINUE_HINT because
 * the fenced protocol is the wire-safe fallback for a conversation whose
 * native-tools capability is unknowable (F7-1).
 */
export function buildHandoffContinueMessage(input: {
  instruction?: string;
  lastRole: string;
  messageCount: number;
}): string {
  const parts = [
    'HANDOFF: this conversation started outside the CLI and is now handed off to the CLI coding agent.',
    'This is a NEW AGENT TURN on the EXISTING conversation.',
    `The ${input.messageCount} message${input.messageCount === 1 ? '' : 's'} above are preserved COMPLETE and IN ORDER - do not ask for them again and do NOT redo completed work.`,
    `You are the CLI agent with local tools (read/write files, run commands); continue from the last message's state (last role: ${input.lastRole}).`,
  ];
  if (input.instruction && input.instruction.trim().length > 0) {
    parts.push(`New instruction: ${input.instruction.trim()}`);
  }
  parts.push(CONTINUE_HINT);
  return parts.join(' ');
}

export function registerConversationsHandoffCommand(program: Command): void {
  program
    .command('handoff <id>')
    .description('Hand off a server-side (web) conversation to the CLI agent with full history')
    .addOption(new Option('--task <text>', 'New instruction for the handoff turn (default: continue from the last message state)'))
    .addOption(
      new Option('--model <slug>', `Agent model (${HANDOFF_MODELS.join('|')}); default: the conversation's model when agent-callable, else styx`),
    )
    .addOption(new Option('--max-turns <n>', 'Max agent turns (default 25)').default(String(DEFAULT_MAX_TURNS)))
    .addOption(new Option('--max-tokens <n>', 'Budget cap: total tokens'))
    .addOption(new Option('--max-time <s>', 'Budget cap: wall-clock seconds'))
    .addOption(new Option('--yes', 'Auto-approve writes/commands (headless approval)'))
    .addOption(new Option('--no-web', 'Disable the web_search/fetch_url tools for this run'))
    .action(
      async (
        id: string,
        opts: {
          task?: string;
          model?: string;
          maxTurns?: string;
          maxTokens?: string;
          maxTime?: string;
          yes?: boolean;
          web?: boolean;
        },
        cmd: Command,
      ) => {
        const root = cmd.parent?.parent;
        const parentOpts = root?.opts<{ apiUrl?: string; json?: boolean; color?: boolean }>() ?? {};
        const isJson = getOutputOptions().json;
        const cwd = process.cwd();

        // M5: load command rules, project context, and hooks (like agent.ts
        // does) - handoff runs must respect the user's safety configuration,
        // not silently drop it.
        const commandRules = await loadCommandRules(cwd, {});
        const contextInjection = buildContextInjection({ cwd });
        const projectContext =
          contextInjection && contextInjection.block.length > 0 ? contextInjection.block : undefined;

        // ── Login gate: server-side conversations are always SpyCore-backed. ──
        if (!(await isAuthenticated())) {
          throw new SpycoreCliError('Not logged in.', EXIT_AUTH_ERROR, 'Run `spycore login` to authenticate.');
        }

        // ── Fetch the FULL conversation (no limit - history must be complete). ──
        let convo: ConversationGetResp;
        try {
          convo = await api.get<ConversationGetResp>(`/conversations/${id}`, {
            apiUrlOverride: parentOpts.apiUrl,
          });
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
        const messages = Array.isArray(convo.messages) ? convo.messages : [];
        if (messages.length === 0) {
          throw new SpycoreCliError(
            `Conversation ${id} has no messages - there is no history to hand off.`,
            EXIT_USER_ERROR,
            'Hand off a conversation that already has messages.',
          );
        }
        // Role breakdown for the handoff report (server order is kept as-is).
        const roleCounts = new Map<string, number>();
        for (const m of messages) {
          const r = String(m.role ?? 'unknown').toLowerCase();
          roleCounts.set(r, (roleCounts.get(r) ?? 0) + 1);
        }
        const last = messages[messages.length - 1]!;
        const lastRole = String(last.role ?? 'unknown').toLowerCase();

        // ── Model: flag wins; else the conversation's model when agent-callable. ──
        const { model, fromFlag } = resolveHandoffModel(convo.model, opts.model);
        if (!fromFlag && model !== (convo.model ?? '').toLowerCase()) {
          warn(
            `Conversation model "${sanitizeForDisplay(convo.model)}" is not agent-callable - continuing with ${MODEL_DISPLAY[model]}. Pass --model to override.`,
          );
        }

        const maxTurns = Math.max(MIN_TURNS, Math.min(MAX_TURNS_CAP, Number(opts.maxTurns ?? DEFAULT_MAX_TURNS) || DEFAULT_MAX_TURNS));
        const budgetCaps = toBudgetCaps({
          maxTokens: opts.maxTokens !== undefined ? Number(opts.maxTokens) : undefined,
          maxTimeMs: opts.maxTime !== undefined ? Number(opts.maxTime) * 1000 : undefined,
          maxTurns: opts.maxTurns !== undefined ? maxTurns : undefined,
        });
        const budget = createBudget(budgetCaps, Date.now);
        const config = getConfigStore();
        const webTools = opts.web !== false && config.get('agentWebTools') !== false;
        const observeWorkspace = config.get('agentObserveWorkspace') === true;

        const task = opts.task?.trim() ? opts.task.trim() : `Handoff of conversation ${convo.id}${convo.title ? ` (${convo.title})` : ''}`;
        const recorder = createRunRecorder({
          cwd,
          task,
          initial: {
            providerKind: 'spycore',
            model,
            planMode: false,
            maxTurns,
            budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: budgetCaps },
            gitHead: currentGitHead(cwd),
          },
        });
        const loadedSkills = new Set<string>();

        // ── Banner: what is being handed off (plain; sanitized at the boundary). ──
        const rolesLine = [...roleCounts.entries()].map(([r, n]) => `${n} ${r}`).join(', ');
        if (!isJson) {
          process.stderr.write(`${chalk.dim(`Handing off "${sanitizeForDisplay(convo.title) || '(untitled)'}" (${sanitizeForDisplay(convo.id)})`)}\n`);
          process.stderr.write(
            `${chalk.dim(`History: ${messages.length} message${messages.length === 1 ? '' : 's'} (${rolesLine}) · last: ${sanitizeForDisplay(lastRole)} · model ${MODEL_DISPLAY[model]}${fromFlag ? ' (--model override)' : ''}`)}\n`,
          );
          process.stderr.write(`${chalk.dim('New agent turn on existing conversation - history preserved, not replayed.')}\n`);
        }

        const controller = new AbortController();
        const onSigint = (): void => controller.abort();
        process.once('SIGINT', onSigint);

        // Every model/file-controlled string is sanitized at this display
        // boundary - same rule as `spycore agent` (SEC-013).
        const renderPlain = (e: AgentEvent): void => {
          switch (e.type) {
            case 'narration':
              if (e.text.trim().length > 0) process.stderr.write(`${chalk.dim(sanitizeForDisplay(e.text))}\n`);
              break;
            case 'tool_call':
              process.stderr.write(`${chalk.cyan('⚙')} ${e.tool}${e.arg ? ` ${chalk.dim(sanitizeForDisplay(e.arg))}` : ''}\n`);
              break;
            case 'tool_result': {
              if (e.kind === 'command') {
                const sigil = e.ok ? chalk.green('$') : chalk.red('$');
                process.stderr.write(`${sigil} ${sanitizeForDisplay(e.command ?? e.tool)} ${chalk.dim(`→ ${sanitizeForDisplay(e.summary)}`)}\n`);
                const tail = sanitizeForDisplay((e.outputTail ?? '').trim());
                if (tail.length > 0) process.stderr.write(`${chalk.dim(tail)}\n`);
              } else if (e.kind === 'applied') {
                const glyph = e.tool === 'edit_file' ? '✎' : '✚';
                const stat = (e.removed ?? 0) > 0 ? `+${e.added ?? 0} -${e.removed ?? 0}` : `+${e.added ?? 0}`;
                process.stderr.write(`${chalk.green(glyph)} ${sanitizeForDisplay(e.tool)} ${chalk.dim(`(${stat})`)}\n`);
              } else if (e.kind === 'rejected') {
                process.stderr.write(`${chalk.yellow('⊘')} ${chalk.dim(`rejected ${sanitizeForDisplay(e.tool)}`)}\n`);
              } else {
                process.stderr.write(`  ${e.ok ? chalk.green('→') : chalk.red('✗')} ${chalk.dim(`${e.ok ? '' : 'error: '}${sanitizeForDisplay(e.summary)}`)}\n`);
              }
              break;
            }
            case 'parse_error':
              process.stderr.write(`${chalk.yellow('!')} ${chalk.dim('no valid tool call - retrying')}\n`);
              break;
            case 'budget': {
              const bar = formatBudgetBar(
                { tokensUsed: e.tokensUsed, turnsUsed: e.turnsUsed, elapsedMs: e.elapsedMs },
                budgetCaps,
              );
              if (bar) process.stderr.write(`${chalk.dim(`· ${bar}`)}\n`);
              break;
            }
            case 'budget_stop': {
              const phrase = describeBudgetStop(
                e.reason,
                { tokensUsed: e.tokensUsed, turnsUsed: e.turnsUsed, elapsedMs: e.elapsedMs },
                budgetCaps,
              );
              process.stderr.write(`${chalk.yellow('⚠')} stopped - ${phrase}\n`);
              break;
            }
            case 'final': {
              const finalText = sanitizeForDisplay(e.text);
              process.stdout.write(finalText.endsWith('\n') ? finalText : `${finalText}\n`);
              break;
            }
            case 'assistant_token':
              break;
          }
        };

        try {
          const result = await runAgent({
            task,
            model,
            maxTurns,
            apiUrlOverride: parentOpts.apiUrl,
            signal: controller.signal,
            cwd,
            requestApproval: headlessApproval(Boolean(opts.yes)),
            budget,
            loadedSkills,
            toolProtocol: 'auto',
            webTools,
            observeWorkspace,
            // M5: thread through the user's safety configuration.
            ...(commandRules.hasAny ? { commandRules: commandRules.rules } : {}),
            projectContext,
            // The HANDOFF turn: a new agent turn on the existing conversation.
            conversationId: convo.id,
            continueMessage: buildHandoffContinueMessage({
              instruction: opts.task,
              lastRole,
              messageCount: messages.length,
            }),
            recordChange: (c) => recorder.recordChange(c),
            recordChanges: (cs) => recorder.recordChanges(cs),
            onEvent: renderPlain,
            onRunState: makeRunStateHook({ recorder, budget, cwd, loadedSkills }),
          });

          // The handoff run is itself resumable: `spycore agent --resume`
          // continues this conversation from the handoff's last turn.
          const stoppedShort = result.cancelled || result.budgetStop !== null || result.reachedMaxTurns;
          recorder.finalize(stoppedShort ? 'interrupted' : 'completed');

          if (isJson) {
            json({
              handoff: true,
              conversationId: convo.id,
              title: convo.title,
              messages: messages.length,
              model,
              turns: result.turns,
              toolCalls: result.toolCalls,
              changedFiles: result.changedFiles,
              cancelled: result.cancelled,
              budgetStop: result.budgetStop,
              sessionResumable: stoppedShort,
            });
          } else if (!result.cancelled) {
            process.stderr.write(
              `${chalk.dim(`Done: ${result.turns} turn${result.turns === 1 ? '' : 's'}, ${result.toolCalls} tool call${result.toolCalls === 1 ? '' : 's'}.`)}\n`,
            );
            if (stoppedShort) {
              process.stderr.write(`${chalk.dim(`Resume with \`spycore agent --resume\`.`)}`);
            }
          }
        } catch (err) {
          recorder.abandon();
          throw err;
        } finally {
          process.removeListener('SIGINT', onSigint);
        }
      },
    );
}
