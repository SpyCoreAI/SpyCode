import { Command, Option } from 'commander';
import chalk from 'chalk';
import { sanitizeForDisplay } from '../lib/sanitize-display.js';
import {
  runAgent,
  CONTINUE_HINT,
  DEFAULT_MAX_TURNS,
  MAX_TURNS_CAP,
  MIN_TURNS,
  type AgentEvent,
  type AgentModelSlug,
} from '../lib/agent/loop.js';
import { headlessApproval } from '../lib/agent/approval.js';
import { routeAgentModel, routingLine, resolvePlanMode } from '../lib/agent/router.js';
import { resolveProviderSelection } from '../lib/providers/byok-config.js';
import { getStoredProviders, getDefaultProviderName, getConfigStore } from '../lib/config.js';
import type { Provider } from '../lib/providers/types.js';
import { SpyCoreProvider } from '../lib/providers/spycore.js';
import { runVerifyLoop, clampVerifyAttempts, type VerifyEvent, type VerifyOutcome } from '../lib/agent/verify.js';
import {
  createRunRecorder,
  reopenRunRecorder,
  type ResumeBudgetState,
  type RunRecorder,
} from '../lib/agent/checkpoint.js';
import {
  buildResumeBanner,
  buildResumeContinueMessage,
  currentGitHead,
  detectWorkspaceDrift,
  makeRunStateHook,
  resolveResumeTarget,
  type ResumeTarget,
  type WorkspaceDrift,
} from '../lib/agent/resume.js';
import { snapshotStructure, finalizeTaskMemory } from '../lib/agent/task-memory.js';
import { buildContextInjection } from '../lib/memory.js';
import {
  createBudget,
  toBudgetCaps,
  formatBudgetBar,
  describeBudgetStop,
  type BudgetCaps,
  type BudgetReason,
  type BudgetSnapshot,
} from '../lib/agent/budget.js';
import { isAuthenticated } from '../lib/auth.js';
import { loadCommandRules, type RuleKind } from '../lib/agent/command-rules.js';
import {
  createAgentHooksBridge,
  fireHookEvent,
  loadHookSession,
} from '../lib/hooks.js';
import { getOutputOptions, json, warn } from '../lib/output.js';
import { readSingleLineInput } from '../lib/prompt.js';
import { EXIT_AUTH_ERROR, EXIT_USER_ERROR, SpycoreCliError } from '../lib/errors.js';
import { MODEL_DISPLAY, isModelSlug } from '../lib/models.js';
import {
  assertAgentTaskFits,
  attachmentChip,
  buildTextAttachmentBlocks,
  collectAttachOption,
  inspectAttachments,
  isVisionModelSlug,
  uploadImageAttachments,
  visionGateError,
  type LocalAttachment,
} from '../lib/attachments.js';

const ALLOWED_AGENT_MODELS = ['charon', 'styx', 'hermes', 'minos'] as const;

interface AgentCmdOpts {
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  maxTurns?: string;
  maxTokens?: string;
  maxTime?: string;
  yes?: boolean;
  cmdTimeout?: string;
  /** tri-state: true=--plan, false=--no-plan, undefined=auto. */
  plan?: boolean;
  verify?: string;
  verifyAttempts?: string;
  toolProtocol?: string;
  /** commander --no-web: false when passed, true otherwise. */
  web?: boolean;
  /** commander --observe / --no-observe: true, false, or undefined when neither is passed. */
  observe?: boolean;
  /** Repeatable --attach <path> (images upload; text files inline into the task). */
  attach?: string[];
  /** --resume [session]: true (bare) | 'latest' | a session id. */
  resume?: string | boolean;
}

/**
 * Resolve whether the agent's web tools (web_search / fetch_url) are offered:
 * the `--no-web` flag wins; otherwise the `agentWebTools` config key (default
 * true). Exported for tests.
 */
export function resolveWebToolsEnabled(
  webFlag: boolean | undefined,
  configValue: unknown,
): boolean {
  if (webFlag === false) return false;
  return configValue !== false;
}

/**
 * Resolve whether the workspace observer runs: an explicit flag wins in EITHER
 * direction; otherwise the `agentObserveWorkspace` config key. Exported for
 * tests.
 *
 * ⭐⭐ `SPY-416` / R-CLI-1 — THE DEFAULT IS THE PRODUCT DECISION, AND IT IS
 * **OFF**. It is expressed as `=== true` rather than as a truthiness test: an
 * absent flag, an absent key, and a key holding anything other than the
 * literal `true` all leave the observer OFF, so nothing is read and nothing is
 * written.
 *
 * ⭐ The reason is not that observation is unsafe — it is that it reads the
 * FULL PLAINTEXT of every file the ignore rules do not hide and stores it in an
 * on-disk journal, and the published `0.6.0` writes nothing of the kind. A user
 * who merely UPDATES must not silently acquire a new on-disk archive of their
 * project. NO CAPABILITY IS REMOVED: `--observe` turns it on for one run and
 * `spycore config set agentObserveWorkspace true` turns it on for good.
 */
export function resolveObserveWorkspaceEnabled(
  observeFlag: boolean | undefined,
  configValue: unknown,
): boolean {
  if (observeFlag === false) return false;
  if (observeFlag === true) return true;
  return configValue === true;
}

/** Everything the two front-ends need to continue an interrupted session. */
interface ResumeRunContext {
  target: ResumeTarget;
  drift: WorkspaceDrift | null;
  conversationId: string;
  continueMessage: string;
  bannerLines: string[];
  budgetInitial: BudgetSnapshot;
  loadedSkills: string[];
}

export function registerAgentCommand(program: Command): void {
  program
    .command('agent [task...]')
    .description('Run an autonomous coding agent in the current directory')
    .addOption(
      new Option(
        '-m, --model <model>',
        `Agent model (${ALLOWED_AGENT_MODELS.join('|')}); omit to auto-route by task complexity. Required for a non-spycore --provider`,
      ),
    )
    .addOption(
      new Option(
        '--provider <name>',
        'Provider to use: a saved name or a built-in type (spycore, openai, anthropic, google). Omit to use your configured default (spycore if unset)',
      ),
    )
    .addOption(
      new Option(
        '--base-url <url>',
        'Base URL for a BYOK provider (defaults to the vendor API per type; repoint at any compatible endpoint)',
      ),
    )
    .addOption(
      new Option(
        '--api-key-env <var>',
        'Env var holding the API key for a BYOK provider (defaults per type; for openai, unset → no auth header)',
      ),
    )
    .addOption(
      new Option('--max-turns <n>', 'Stop after this many model round-trips (1–200; default 25)').default(
        String(DEFAULT_MAX_TURNS),
      ),
    )
    .addOption(new Option('--max-tokens <n>', 'Stop after this many total tokens (across all turns + fixes)'))
    .addOption(new Option('--max-time <sec>', 'Stop after this many seconds of wall-clock time'))
    .addOption(
      new Option('-y, --yes', 'Auto-approve all file writes and commands without prompting (for trusted/CI use)'),
    )
    .addOption(
      new Option('--cmd-timeout <sec>', 'Timeout for each run_command, in seconds').default('120'),
    )
    .addOption(
      new Option('--plan', 'Investigate and propose a plan for approval before executing (auto-on for complex tasks)'),
    )
    .addOption(new Option('--no-plan', 'Skip plan mode and execute directly, even for complex tasks'))
    .addOption(
      new Option('--verify <command>', 'After the task, run this command; on failure the agent fixes it and re-verifies'),
    )
    .addOption(
      new Option('--verify-attempts <n>', 'Max verify→fix cycles before giving up (1–10)').default('3'),
    )
    .addOption(
      new Option(
        '--tool-protocol <mode>',
        'Tool-call wire: auto (native when the server supports it), native (require it), or fenced (force the text protocol)',
      )
        .choices(['auto', 'native', 'fenced'])
        .default('auto'),
    )
    .addOption(
      new Option(
        '--no-web',
        'Disable the web_search / fetch_url tools for this run (default on; persist with `spycore config set agentWebTools false`)',
      ),
    )
    // ⭐⭐ `SPY-416` / R-CLI-1 — BOTH DIRECTIONS EXIST, because the default moved.
    // `--no-observe` is KEPT so no user's existing command line changes meaning,
    // and `--observe` is ADDED so the per-run choice exists in the direction the
    // new default makes useful. Nothing is removed.
    .addOption(
      new Option(
        '--observe',
        'Journal what shell commands, MCP tools and hooks change, so `spycore rewind` can undo them. Reads and stores the text of every file the ignore rules do not hide, so it is OFF by default (persist with `spycore config set agentObserveWorkspace true`)',
      ),
    )
    .addOption(
      new Option(
        '--no-observe',
        'Skip the workspace scan that journals what shell commands, MCP tools and hooks change, so `spycore rewind` cannot undo them (file writes are still journaled; default off; persist with `spycore config set agentObserveWorkspace false`)',
      ),
    )
    .addOption(
      new Option(
        '--attach <path>',
        'Attach a file to the task (repeatable). Images go to vision models; text files are inlined into the task context',
      ).argParser(collectAttachOption),
    )
    .addOption(
      new Option(
        '--resume [session]',
        "Resume an interrupted agent run in this directory: bare/'latest' picks the newest resumable session, or pass a session id from `spycore rewind --list`",
      ),
    )
    .action(async (taskArg: string[], opts: AgentCmdOpts, cmd: Command) => {
      const parentOpts =
        cmd.parent?.opts<{ apiUrl?: string; json?: boolean; color?: boolean }>() ?? {};
      let task = (taskArg ?? []).join(' ').trim();
      const resuming = opts.resume !== undefined;
      if (resuming) {
        // --resume continues the ORIGINAL task with its original conversation;
        // options that only make sense on a run's first turn are rejected
        // loudly instead of being silently ignored.
        if (task.length > 0) {
          throw new SpycoreCliError(
            'Cannot combine --resume with a task description.',
            EXIT_USER_ERROR,
            'Resume continues the original task: run `spycore agent --resume` (optionally with a session id).',
          );
        }
        if (opts.attach?.length) {
          throw new SpycoreCliError(
            '--attach cannot be combined with --resume.',
            EXIT_USER_ERROR,
            'Attachments ride the first turn of a run; the resumed conversation already has its context.',
          );
        }
        if (opts.plan !== undefined) {
          throw new SpycoreCliError(
            '--plan/--no-plan cannot be combined with --resume.',
            EXIT_USER_ERROR,
            'The planning decision was made by the original run.',
          );
        }
        if (opts.provider !== undefined || opts.baseUrl !== undefined || opts.apiKeyEnv !== undefined) {
          throw new SpycoreCliError(
            'Provider options cannot be combined with --resume.',
            EXIT_USER_ERROR,
            'A resumed session always continues on the provider that started it.',
          );
        }
        if (cmd.getOptionValueSource('toolProtocol') === 'cli') {
          throw new SpycoreCliError(
            '--tool-protocol cannot be combined with --resume.',
            EXIT_USER_ERROR,
            "The tool protocol was fixed on the original run's first turn and is restored from the session.",
          );
        }
      } else if (task.length === 0) {
        throw new SpycoreCliError('Task description is required.', EXIT_USER_ERROR);
      }

      const maxTurns = Math.max(
        MIN_TURNS,
        Math.min(MAX_TURNS_CAP, Number(opts.maxTurns ?? DEFAULT_MAX_TURNS) || DEFAULT_MAX_TURNS),
      );
      const cmdTimeoutSec = Math.max(1, Math.min(3600, Number(opts.cmdTimeout ?? 120) || 120));
      const commandTimeoutMs = cmdTimeoutSec * 1000;
      const verifyCommand = (opts.verify ?? '').trim() || undefined;
      const verifyAttempts = clampVerifyAttempts(Number(opts.verifyAttempts ?? 3));
      // Web tools: --no-web wins, else the agentWebTools config key (default on).
      // Deliberately re-resolved from the CURRENT invocation on resume too —
      // the old session's snapshot never overrides current safety config.
      const webTools = resolveWebToolsEnabled(opts.web, getConfigStore().get('agentWebTools'));
      const observeWorkspace = resolveObserveWorkspaceEnabled(
        opts.observe,
        getConfigStore().get('agentObserveWorkspace'),
      );
      const turnsExplicit = cmd.getOptionValueSource('maxTurns') === 'cli';

      const isJson = getOutputOptions().json;
      const cwd = process.cwd();

      let model: string;
      let routeLine: string;
      let planMode: boolean;
      let planNote: string;
      let provider: Provider | undefined;
      let routedVia: 'override' | 'triage' | 'byok' | 'resume';
      let routingReason: string;
      let providerLabel: string;
      let toolProtocol: 'auto' | 'native' | 'fenced';
      let budgetCaps: BudgetCaps;
      let attachmentIds: string[] = [];
      let attachedContext = '';
      let recorder: RunRecorder;
      let resumeRun: ResumeRunContext | null = null;

      if (resuming) {
        // ── Resume an interrupted session ─────────────────────────────────
        // Only SpyCore-backed sessions are resumable (the transcript lives in
        // the server-side conversation), so the login gate always applies.
        if (!(await isAuthenticated())) {
          throw new SpycoreCliError('Not logged in.', EXIT_AUTH_ERROR, 'Run `spycore login` to authenticate.');
        }
        const target = resolveResumeTarget(cwd, opts.resume as string | true);
        const { session, state } = target;
        task = session.task;

        // Model: an explicit --model overrides (stated in the banner);
        // otherwise the session's model keeps the conversation coherent.
        const modelFromFlag = opts.model !== undefined;
        if (modelFromFlag) {
          const slug = String(opts.model).toLowerCase();
          if (!(ALLOWED_AGENT_MODELS as readonly string[]).includes(slug)) {
            throw new SpycoreCliError(
              `Unknown model: ${opts.model}`,
              EXIT_USER_ERROR,
              `Allowed: ${ALLOWED_AGENT_MODELS.join(', ')}`,
            );
          }
          model = slug;
        } else {
          model = state.model;
        }

        // Budgets are CUMULATIVE: consumption always carries over; caps come
        // from the session unless explicitly re-stated on this invocation.
        const flagCaps = toBudgetCaps({
          maxTokens: opts.maxTokens !== undefined ? Number(opts.maxTokens) : undefined,
          maxTimeMs: opts.maxTime !== undefined ? Number(opts.maxTime) * 1000 : undefined,
          maxTurns: turnsExplicit ? maxTurns : undefined,
        });
        budgetCaps = {
          maxTokens: flagCaps.maxTokens ?? state.budget.caps.maxTokens,
          maxTimeMs: flagCaps.maxTimeMs ?? state.budget.caps.maxTimeMs,
          maxTurns: flagCaps.maxTurns ?? state.budget.caps.maxTurns,
        };
        const budgetInitial: BudgetSnapshot = {
          tokensUsed: state.budget.tokensUsed,
          turnsUsed: state.budget.turnsUsed,
          elapsedMs: state.budget.elapsedMs,
        };

        // Stale-workspace guard: drift since the last recorded boundary needs
        // an explicit go-ahead (rewind-first is always offered).
        const drift = detectWorkspaceDrift(target);
        let driftAccepted = false;
        if (drift) {
          const what: string[] = [];
          if (drift.headMoved) what.push('git HEAD moved');
          if (drift.modifiedFiles.length > 0) {
            what.push(`${drift.modifiedFiles.length} file${drift.modifiedFiles.length === 1 ? '' : 's'} modified outside the run`);
          }
          const summary = `Workspace changed since the interrupt (${what.join(', ')}).`;
          if (opts.yes) {
            driftAccepted = true;
            if (!isJson) warn(`${summary} Continuing (--yes).`);
          } else if (process.stdin.isTTY === true && !isJson) {
            warn(summary);
            warn('You can undo the run first with `spycore rewind`.');
            const ans = (await readSingleLineInput('Resume anyway? (y/N): ')).trim().toLowerCase();
            if (ans !== 'y' && ans !== 'yes') {
              warn('Resume cancelled — nothing changed.');
              return;
            }
            driftAccepted = true;
          } else {
            throw new SpycoreCliError(
              summary,
              EXIT_USER_ERROR,
              'Rewind first (`spycore rewind`), re-run with --yes to resume anyway, or resume from an interactive terminal to confirm.',
            );
          }
        }

        const reopened = reopenRunRecorder(session);
        if (!reopened) {
          // resolveResumeTarget already validated the record; treat a race as not-resumable.
          throw new SpycoreCliError(`Session ${session.id} is not resumable.`, EXIT_USER_ERROR);
        }
        recorder = reopened;

        // The conversation's tool protocol was fixed on turn 1 — seed the
        // provider with the recorded capability so 'auto' resolves to exactly
        // the protocol this conversation already speaks.
        const spycore = new SpyCoreProvider();
        spycore.seedCapabilities(state.conversationId!, { nativeTools: state.nativeTools });
        provider = spycore;
        toolProtocol = 'auto';

        planMode = false;
        planNote = '';
        providerLabel = 'spycore';
        routedVia = 'resume';
        routingReason = `session:${session.id}`;
        const label = isModelSlug(model) ? MODEL_DISPLAY[model] : model;
        routeLine = `Resuming ${label} session — approvals prompt fresh`;
        const effectiveBudget: ResumeBudgetState = { ...budgetInitial, caps: budgetCaps };
        resumeRun = {
          target,
          drift,
          conversationId: state.conversationId!,
          continueMessage: buildResumeContinueMessage({
            state,
            driftAccepted,
            protocolHint: state.nativeTools ? '' : CONTINUE_HINT,
          }),
          bannerLines: buildResumeBanner({
            target,
            drift: driftAccepted ? drift : null,
            modelLabel: label,
            modelFromFlag,
            webTools,
            observeWorkspace,
            budget: effectiveBudget,
          }),
          budgetInitial,
          loadedSkills: state.loadedSkills,
        };
      } else {
        // ── Fresh run ──────────────────────────────────────────────────────
        // Resolve which provider this run uses: a saved config NAME, a built-in
        // type (spycore/openai), or — with no flag — the saved default (else
        // spycore). Pure + up front, so an unknown provider or a BYOK-missing-model
        // error surfaces immediately, BEFORE any login gate. Explicit
        // --base-url/--model/--api-key-env override a saved config's fields.
        const selection = resolveProviderSelection({
          providerFlag: opts.provider,
          baseUrl: opts.baseUrl,
          model: opts.model,
          apiKeyEnv: opts.apiKeyEnv,
          env: process.env,
          stored: getStoredProviders(),
          defaultProvider: getDefaultProviderName(),
        });
        // For the SpyCore provider an explicit --model must be a known slug; the
        // BYOK path takes any id (validated inside resolveProviderSelection).
        let explicitModel: AgentModelSlug | undefined;
        if (selection.kind === 'spycore' && opts.model !== undefined) {
          const slug = String(opts.model).toLowerCase();
          if (!(ALLOWED_AGENT_MODELS as readonly string[]).includes(slug)) {
            throw new SpycoreCliError(
              `Unknown model: ${opts.model}`,
              EXIT_USER_ERROR,
              `Allowed: ${ALLOWED_AGENT_MODELS.join(', ')}`,
            );
          }
          explicitModel = slug as AgentModelSlug;
        }
        // Tool-call protocol override (commander .choices already validated it).
        toolProtocol = (opts.toolProtocol ?? 'auto') as 'auto' | 'native' | 'fenced';

        // Attachments: validate locally BEFORE any network call (existence /
        // kind / size / image count), then gate: image attachments need the
        // SpyCore provider (the upload + attachments contract is SpyCore-only)
        // and a vision-capable model. Text files inline into the task context
        // and work on every provider. Nothing is ever silently dropped.
        const attachments: LocalAttachment[] = opts.attach?.length
          ? inspectAttachments(opts.attach, process.cwd())
          : [];
        const imageAttachments = attachments.filter((a) => a.kind === 'image');
        const textAttachments = attachments.filter((a) => a.kind === 'text');
        if (imageAttachments.length > 0 && selection.kind !== 'spycore') {
          throw new SpycoreCliError(
            'Image attachments require the SpyCore provider.',
            EXIT_USER_ERROR,
            'Re-run without --provider, or drop the image attachments.',
          );
        }
        if (imageAttachments.length > 0 && explicitModel && !isVisionModelSlug(explicitModel)) {
          throw visionGateError(explicitModel);
        }
        attachedContext =
          textAttachments.length > 0 ? buildTextAttachmentBlocks(textAttachments) : '';
        // The task + inlined blocks share the first-turn wire message with the
        // agent system prompt — enforce the budget with an actionable error.
        assertAgentTaskFits(task, attachedContext);

        // Cost/runaway caps (all optional). A turn cap only becomes a whole-run
        // budget when the user EXPLICITLY passes --max-turns (not the default 25),
        // so the built-in per-call iteration guard is unchanged without it.
        budgetCaps = toBudgetCaps({
          maxTokens: opts.maxTokens !== undefined ? Number(opts.maxTokens) : undefined,
          maxTimeMs: opts.maxTime !== undefined ? Number(opts.maxTime) * 1000 : undefined,
          maxTurns: turnsExplicit ? maxTurns : undefined,
        });

        // DECOUPLED login: ONLY the SpyCore provider needs a SpyCore account. A
        // BYOK provider runs against the user's own endpoint with no login.
        if (selection.kind === 'spycore' && !(await isAuthenticated())) {
          throw new SpycoreCliError(
            'Not logged in.',
            EXIT_AUTH_ERROR,
            'Run `spycore login` to authenticate.',
          );
        }

        // Resolve the model-call provider + routing line.
        //   • spycore (default): a cheap HERMES triage (+ plan lookup) picks STYX
        //     (workhorse) or CHARON (complex), clamped to the plan; --model skips
        //     triage. Never throws — defaults to STYX. Identity-safe routing line.
        //   • openai (BYOK): NO triage, NO plan-clamp, NO SpyCore default model —
        //     the user's own --model runs against their endpoint, shown verbatim.
        if (selection.kind === 'byok') {
          const cfg = selection.config;
          model = cfg.model;
          routeLine = cfg.routingLine;
          planMode = resolvePlanMode(opts.plan, null);
          planNote = planMode ? 'Plan mode (--plan): proposing a plan before executing' : '';
          // The factory lazy-loads whichever adapter speaks this config's wire
          // (openai-compatible / anthropic / google) — none touch the hot path.
          const { createByokProvider } = await import('../lib/providers/factory.js');
          provider = await createByokProvider(cfg);
          routedVia = 'byok';
          routingReason = selection.sourceName ? `saved:${selection.sourceName}` : 'byok';
          providerLabel = selection.sourceName ?? cfg.type;
        } else {
          const decision = await routeAgentModel({
            explicitModel,
            task,
            apiUrlOverride: parentOpts.apiUrl,
            // Image attachments constrain smart routing to vision-capable
            // models for this run (Minos; free-plan clamp lands on Hermes).
            requireVision: imageAttachments.length > 0,
          });
          model = decision.model;
          routeLine = routingLine(decision);
          planMode = resolvePlanMode(opts.plan, decision.tier);
          planNote =
            planMode && opts.plan === undefined
              ? 'Planning first (complex task) — use --no-plan to skip'
              : planMode
                ? 'Plan mode (--plan): proposing a plan before executing'
                : '';
          provider = undefined; // the loop uses its default SpyCoreProvider
          routedVia = decision.viaOverride ? 'override' : 'triage';
          routingReason = decision.reason;
          providerLabel = 'spycore';
        }

        // Upload image attachments (SpyCore provider only — gated above) through
        // the existing files-upload plumbing; the FILE IDs ride the first turn's
        // `attachments` field. Upload/plan/size errors surface via the plumbing's
        // clean mapping. Chips echo per attachment, sanitized at this display
        // boundary (they scroll above the Ink UI on the interactive path).
        if (imageAttachments.length > 0) {
          attachmentIds = await uploadImageAttachments(imageAttachments, {
            apiUrlOverride: parentOpts.apiUrl,
          });
        }
        if (attachments.length > 0 && !isJson) {
          for (const att of attachments) {
            process.stderr.write(
              `${chalk.dim(`+ attached ${sanitizeForDisplay(attachmentChip(att))}`)}\n`,
            );
          }
        }

        // Step-boundary journal for the whole run: created up front so an
        // interrupt (or crash) at ANY completed turn leaves a resumable record.
        // Nothing touches disk until a conversation binds or a file changes.
        recorder = createRunRecorder({
          cwd,
          task,
          initial: {
            providerKind: selection.kind === 'byok' ? 'byok' : 'spycore',
            model,
            planMode,
            maxTurns,
            budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: budgetCaps },
            gitHead: currentGitHead(cwd),
          },
        });
      }

      const hasBudget =
        budgetCaps.maxTokens !== undefined || budgetCaps.maxTimeMs !== undefined || budgetCaps.maxTurns !== undefined;

      // ── Interactive path (Ink session) ──────────────────────────────────
      // A real TTY and not --json: render the rich agent UI. Ink is imported
      // lazily so the hot path stays Ink-free.
      // ── PHASE-1 1.6: lifecycle hooks ────────────────────────────────────
      // Loaded once per run. Project hooks are double-gated: workspace trust
      // (CL1) AND a per-hook approval keyed to the exact command string; the
      // approval prompt exists only on an interactive TTY — headless skips
      // unapproved project hooks with a warning, never auto-runs them.
      // Hooks are blocking-only: nothing they return reaches any approval.
      const interactiveHookApproval =
        process.stdin.isTTY === true && process.stdout.isTTY === true && !isJson
          ? async (h: { event: string; command: string }): Promise<boolean> => {
              try {
                const answer = await readSingleLineInput(
                  `Project hook wants to run at ${h.event}:\n  ${sanitizeForDisplay(h.command)}\nAllow and remember for this exact command? [y/N] `,
                );
                return /^y(es)?$/i.test(answer.trim());
              } catch {
                return false;
              }
            }
          : undefined;
      const hookSession = await loadHookSession(cwd, {
        ...(interactiveHookApproval ? { approveProjectHook: interactiveHookApproval } : {}),
      });
      const emitHookNotices = (notices: string[]): void => {
        if (isJson) return;
        // Hook notices embed repository-authored config text (labels, event
        // names) — repo-influenced, so they cross the sanitizer (SPY-226).
        for (const n of notices)
          process.stderr.write(`${chalk.yellow('⚑')} ${chalk.dim(sanitizeForDisplay(n))}\n`);
      };
      emitHookNotices(hookSession.notices);
      emitHookNotices((await fireHookEvent(hookSession, 'session-start')).notices);
      const promptGate = await fireHookEvent(hookSession, 'prompt-submit', { prompt: task });
      emitHookNotices(promptGate.notices);
      if (promptGate.blocked) {
        throw new SpycoreCliError(
          `Prompt blocked by a user hook${promptGate.blockReason ? `: ${promptGate.blockReason}` : '.'}`,
          EXIT_USER_ERROR,
        );
      }
      const hooksBridge = createAgentHooksBridge(hookSession);
      const fireSessionEnd = async (): Promise<void> => {
        try {
          emitHookNotices((await fireHookEvent(hookSession, 'session-end')).notices);
        } catch {
          /* hooks never break the session */
        }
      };

      // ── PHASE-1 1.10: command allow/deny rules ──────────────────────────
      // Loaded once per run (global user scope + trust- and approval-gated
      // project scope). The per-entry project approval prompt exists only on
      // an interactive TTY — headless skips unapproved project entries with a
      // warning, never auto-applies them. No rules ⇒ run_command approval is
      // byte-identical to a rule-free build.
      const interactiveRuleApproval =
        process.stdin.isTTY === true && process.stdout.isTTY === true && !isJson
          ? async (e: { kind: RuleKind; entry: string }): Promise<boolean> => {
              try {
                const answer = await readSingleLineInput(
                  `Project command ${e.kind} rule from .spycore/command-rules.json:\n  ${sanitizeForDisplay(e.entry)}\nApply and remember this exact rule? [y/N] `,
                );
                return /^y(es)?$/i.test(answer.trim());
              } catch {
                return false;
              }
            }
          : undefined;
      const commandRules = await loadCommandRules(cwd, {
        ...(interactiveRuleApproval ? { approveProjectEntry: interactiveRuleApproval } : {}),
      });
      emitHookNotices(commandRules.notices);

      if (process.stdout.isTTY === true && !isJson) {
        const color = parentOpts.color !== false;
        const { runAgentSession } = await import('../ui/agent/run.js');
        try {
        await runAgentSession({
          hooks: hooksBridge.hasAny ? hooksBridge : undefined,
          // Always passed (even when empty) so the TUI's "always allow"
          // option can append a live rule mid-run; empty rules evaluate to
          // "ask" for every command — behavior identical to a rule-free run.
          commandRules: commandRules.rules,
          task,
          model,
          maxTurns,
          apiUrl: parentOpts.apiUrl,
          cwd,
          color,
          autoApprove: Boolean(opts.yes),
          commandTimeoutMs,
          routingLine: routeLine,
          planMode,
          verifyCommand,
          verifyAttempts,
          budgetCaps,
          toolProtocol,
          webTools,
          observeWorkspace,
          provider,
          attachments: attachmentIds,
          attachedContext: attachedContext || undefined,
          recorder,
          resume: resumeRun
            ? {
                conversationId: resumeRun.conversationId,
                continueMessage: resumeRun.continueMessage,
                bannerLines: resumeRun.bannerLines,
                loadedSkills: resumeRun.loadedSkills,
                budgetInitial: resumeRun.budgetInitial,
              }
            : undefined,
        });
        } finally {
          await fireSessionEnd();
        }
        return;
      }

      // ── Non-interactive / JSON path (plain text) ─────────────────────────
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.once('SIGINT', onSigint);

      if (!isJson && resumeRun) {
        for (const line of resumeRun.bannerLines) process.stderr.write(`${chalk.dim(line)}\n`);
      }
      if (!isJson && !resumeRun) process.stderr.write(`${chalk.dim(routeLine)}\n`);
      if (!isJson && planNote) process.stderr.write(`${chalk.dim(planNote)}\n`);

      // Every model/file/MCP-controlled string is sanitized at this display
      // boundary (sanitize-display.ts) — control sequences in narration, tool
      // args, command output, or MCP text must never drive the terminal.
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
              process.stderr.write(
                `${sigil} ${sanitizeForDisplay(e.command ?? e.tool)} ${chalk.dim(`→ ${sanitizeForDisplay(e.summary)}`)}\n`,
              );
              const tail = sanitizeForDisplay((e.outputTail ?? '').trim());
              if (tail.length > 0) process.stderr.write(`${chalk.dim(tail)}\n`);
            } else if (e.kind === 'applied') {
              const glyph = e.tool === 'edit_file' ? '✎' : '✚';
              const stat = (e.removed ?? 0) > 0 ? `+${e.added ?? 0} -${e.removed ?? 0}` : `+${e.added ?? 0}`;
              process.stderr.write(
                `${chalk.green(glyph)} ${sanitizeForDisplay(e.tool)} ${chalk.dim(`(${stat})`)}\n`,
              );
            } else if (e.kind === 'rejected') {
              process.stderr.write(
                `${chalk.yellow('⊘')} ${chalk.dim(`rejected ${sanitizeForDisplay(e.tool)}`)}\n`,
              );
            } else {
              process.stderr.write(
                `  ${e.ok ? chalk.green('→') : chalk.red('✗')} ${chalk.dim(`${e.ok ? '' : 'error: '}${sanitizeForDisplay(e.summary)}`)}\n`,
              );
            }
            break;
          }
          case 'parse_error':
            process.stderr.write(`${chalk.yellow('!')} ${chalk.dim('no valid tool call — retrying')}\n`);
            break;
          case 'skills':
            // Server-side skills the backend activated (spycore provider only).
            process.stderr.write(`${chalk.dim(`⚡ skills: ${sanitizeForDisplay(e.skills.join(', '))}`)}\n`);
            break;
          case 'mcp_notice':
            // Connected-MCP-server status: a startup warning or a ready summary.
            process.stderr.write(
              `${e.level === 'warn' ? chalk.yellow('⚠') : chalk.dim('🔌')} ${chalk.dim(sanitizeForDisplay(e.text))}\n`,
            );
            break;
          case 'hook_notice':
            // Lifecycle-hook diagnostics (blocks, warns, timeouts) — 1.6.
            process.stderr.write(
              `${e.level === 'warn' ? chalk.yellow('⚠') : chalk.dim('⚑')} ${chalk.dim(sanitizeForDisplay(e.text))}\n`,
            );
            break;
          case 'rule_notice':
            // Command-rule decisions (allowlist auto-approve / deny) — 1.10.
            process.stderr.write(
              `${e.level === 'warn' ? chalk.yellow('⚠') : chalk.dim('▸')} ${chalk.dim(sanitizeForDisplay(e.text))}\n`,
            );
            break;
          case 'context_clamped':
            // 1.8: the first-turn assembly was cut to fit the wire message
            // cap — explicit markers were left in place, never silent.
            process.stderr.write(
              `${chalk.yellow('⚠')} ${chalk.dim(sanitizeForDisplay(e.text))}\n`,
            );
            break;
          case 'max_turns':
            process.stderr.write(`${chalk.yellow('!')} reached turn limit (${e.turns})\n`);
            break;
          case 'budget': {
            // Running budget indicator — only the dimensions with caps show.
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
            process.stderr.write(`${chalk.yellow('⚠')} stopped — ${phrase}\n`);
            process.stderr.write(`${chalk.dim('The task may be incomplete.')}\n`);
            break;
          }
          case 'final': {
            // The answer goes to stdout so it can be piped/redirected cleanly
            // — sanitized: piping to a terminal is the common case.
            const finalText = sanitizeForDisplay(e.text);
            process.stdout.write(finalText.endsWith('\n') ? finalText : `${finalText}\n`);
            break;
          }
          case 'assistant_token':
            break; // streamed live only in the interactive UI
        }
      };

      // One session journal for the whole run (initial + verify fix-ups) so
      // `spycore rewind` undoes everything together. runAgent defers
      // persistence to us because we pass recordChange; the recorder persists
      // incrementally so an interrupt at any boundary stays resumable.
      // Part 3b: structural fingerprint BEFORE the task, so the write-at-end hook
      // can detect new/removed top-level dirs + dep changes by diffing.
      const beforeStructure = snapshotStructure(cwd);
      // One shared budget for the whole run (initial + plan + every verify fix).
      // On resume the interrupted run's consumption is pre-loaded — CUMULATIVE.
      const budget = createBudget(budgetCaps, Date.now, resumeRun?.budgetInitial);
      // One session-wide set so a skill loaded in any phase isn't re-injected —
      // restored on resume (the bodies already live in the conversation).
      const loadedSkills = new Set<string>(resumeRun?.loadedSkills ?? []);

      // Read-at-start project context: load SPYCODE.md + CODEBASE_GUIDE.md + the
      // CODEBASE_CHANGELOG.md tail ONCE for the whole task (one disk read,
      // honouring the injectGuide/injectChangelog toggles) and thread the SAME
      // block into every phase's system prompt — mirroring chat's read-at-start
      // injection + "Loaded project context" notice. No memory files → empty
      // block → nothing injected and no notice (silent, like an uninitialised repo).
      // A resumed run continues an existing conversation — the context (if any)
      // already rode the original first turn, so it is neither re-read nor noted.
      const ctxCfg = getConfigStore();
      const contextInjection = resumeRun
        ? null
        : buildContextInjection({
            cwd,
            injectGuide: ctxCfg.get('injectGuide') !== false,
            injectChangelog: ctxCfg.get('injectChangelog') !== false,
          });
      const projectContext =
        contextInjection && contextInjection.block.length > 0 ? contextInjection.block : undefined;
      if (projectContext && contextInjection && !isJson) {
        const names = contextInjection.parts
          .filter((p) => p.status !== 'off' && p.status !== 'dropped')
          .map((p) => p.label)
          .join(', ');
        // Part labels derive from repository file names.
        process.stderr.write(
          chalk.dim(`✓ Loaded project context: ${sanitizeForDisplay(names)}\n`),
        );
      }
      let budgetStopReason: BudgetReason | null = null;
      const onEvent = (e: AgentEvent): void => {
        if (e.type === 'budget_stop') budgetStopReason = e.reason;
        if (isJson) process.stdout.write(`${JSON.stringify(e)}\n`);
        else renderPlain(e);
      };

      // PROJECT-scoped MCP servers (./.spycore/mcp.json) run only in a workspace
      // the user has explicitly trusted via `spycore mcp trust` (fail-closed
      // otherwise). We pass NO in-run trust resolver here — a cloned repo's
      // project servers are skipped, with a warning pointing at that command —
      // so a checked-out repo can never execute commands on agent start
      // (clone-and-run RCE). User-global (~/.spycore) servers are unaffected.
      const runPhase = (extra: {
        planMode?: boolean;
        approvedPlan?: string;
        conversationId?: string;
        continueMessage?: string;
        planFeedback?: string;
      }) =>
        runAgent({
          task,
          model,
          maxTurns,
          apiUrlOverride: parentOpts.apiUrl,
          signal: controller.signal,
          cwd,
          commandTimeoutMs,
          // Headless: auto-reject writes/commands (with guidance) unless --yes.
          requestApproval: headlessApproval(Boolean(opts.yes)),
          // 1.10: rules apply identically headless; a deny fires before the
          // approval resolver, so it still denies under --yes.
          ...(commandRules.hasAny ? { commandRules: commandRules.rules } : {}),
          recordChange: (c) => recorder.recordChange(c),
          // F-2c-48 · C-UX45: the observation window's delta arrives as one batch,
          // so a call that changed hundreds of files costs ONE journal commit
          // instead of one per record. Same records, same journal.
          recordChanges: (cs) => recorder.recordChanges(cs),
          budget,
          loadedSkills,
          toolProtocol,
          webTools,
          observeWorkspace,
          projectContext,
          // Attachments apply to the first turn of each FRESH conversation
          // (plan + execute phases); continuations inherit via history.
          attachments: attachmentIds,
          attachedContext: attachedContext || undefined,
          onEvent,
          provider,
          // Lifecycle-hook bridge (pre/post-tool) — blocking-only influence.
          ...(hooksBridge.hasAny ? { hooks: hooksBridge } : {}),
          // Step-boundary journal — execute/verify phases only (planning is
          // read-only and opens its own throwaway conversation).
          ...(extra.planMode ? {} : { onRunState: makeRunStateHook({ recorder, budget, cwd, loadedSkills }) }),
          ...extra,
        });

      const renderVerify = (e: VerifyEvent): void => {
        if (isJson) {
          process.stdout.write(`${JSON.stringify(e)}\n`);
          return;
        }
        if (e.type === 'verify_start') {
          const label = e.attempts > 1 ? ` (attempt ${e.attempt}/${e.attempts})` : '';
          process.stderr.write(`${chalk.cyan('▸')} Verifying${label} → ${chalk.dim(e.command)}\n`);
          return;
        }
        if (e.passed) {
          process.stderr.write(`${chalk.green('✓')} verification passed\n`);
        } else if (e.blocked) {
          // ⭐ This arm printed the verify command's output RAW while the arm
          // three lines below already sanitized the identical field.
          process.stderr.write(`${chalk.red('✗')} ${chalk.dim(sanitizeForDisplay(e.outputTail))}\n`);
        } else {
          process.stderr.write(`${chalk.red('✗')} verification failed (attempt ${e.attempt}/${e.attempts})\n`);
          const tail = sanitizeForDisplay(e.outputTail.trim());
          if (tail.length > 0) process.stderr.write(`${chalk.dim(tail)}\n`);
        }
      };

      const start = Date.now();
      try {
        let plan: string | undefined;
        if (planMode) {
          let planRes = await runPhase({ planMode: true });
          // Empty-plan guard: the backing model occasionally returns an
          // EMPTY plan-phase completion (observed live in the release bench —
          // execution then ran planless). Retry once through the existing
          // plan-revision path; a second empty reply falls through to the
          // unchanged flow.
          if (!planRes.cancelled && planRes.finalText.trim().length === 0) {
            if (!isJson) process.stderr.write(`${chalk.yellow('!')} Empty plan returned — retrying once…\n`);
            planRes = await runPhase({
              planMode: true,
              planFeedback:
                'Your previous reply was EMPTY. Output the one-line summary and the NUMBERED plan now, exactly as instructed.',
            });
          }
          plan = planRes.finalText;
          if (planRes.cancelled) {
            if (isJson) json({ task, model, planMode: true, plan: plan || null, executed: false, cancelled: true });
            else warn('Interrupted.');
            return;
          }
          if (!opts.yes) {
            // No interactive approval here — show the plan and stop.
            if (isJson) json({ task, model, planMode: true, plan, executed: false });
            else process.stderr.write(`${chalk.yellow('!')} Plan only — re-run with --yes to execute it.\n`);
            return;
          }
        }

        if (plan && plan.trim().length > 0) recorder.update({ approvedPlan: plan });
        const result = resumeRun
          ? await runPhase({ conversationId: resumeRun.conversationId, continueMessage: resumeRun.continueMessage })
          : await runPhase({ approvedPlan: plan });

        // ── Self-verify: run the check; on failure feed it back and re-verify. ──
        // A budget stop during the run skips verify entirely; a budget hit
        // mid-verify (via a fix) stops the loop (it shares the same budget).
        let verify: VerifyOutcome | undefined;
        if (verifyCommand && !result.cancelled && !result.budgetStop) {
          verify = await runVerifyLoop(result.conversationId, {
            verifyCommand,
            attempts: verifyAttempts,
            cwd,
            commandTimeoutMs,
            signal: controller.signal,
            continueRun: (cid, msg) => runPhase({ conversationId: cid, continueMessage: msg }),
            budget,
            // The SAME resolver run_command gets: --yes approves, headless
            // without it refuses. Self-verify is no longer the one execution
            // path in the package with no approval control.
            requestApproval: headlessApproval(Boolean(opts.yes)),
            ...(commandRules.hasAny ? { commandRules: commandRules.rules } : {}),
            onEvent: renderVerify,
          });
        }

        // Persist the whole session once (initial run + verify fix-ups). A run
        // that stopped short of a final answer (interrupt, budget, turn limit)
        // finalizes as 'interrupted' — i.e. resumable.
        const stoppedShort =
          result.cancelled || result.budgetStop !== null || result.reachedMaxTurns || verify?.cancelled === true;
        if (recorder.changeCount() > 0) {
          // Part 3b write-at-end: log the task to ./CODEBASE_CHANGELOG.md and,
          // on a structural change, refresh ./CODEBASE_GUIDE.md. Fully isolated —
          // a memory-write failure must never break the agent run.
          //
          // ⭐ THIS RUNS BEFORE `recorder.finalize()`, AND THE ORDER IS THE
          // POINT. These two files are the user's own workspace files and the
          // run modifies them, so "rewind undoes the workspace files the run
          // changed" is false for exactly two files unless they are journaled.
          // The recorder stops persisting once finalized, so a record pushed
          // after that call would sit in memory looking journaled and rewind
          // nothing — which is the failure mode this ordering exists to avoid.
          try {
            const cfg = getConfigStore();
            const mem = await finalizeTaskMemory({
              cwd,
              task,
              changes: recorder.changes(),
              before: beforeStructure,
              autoChangelog: cfg.get('autoChangelog') !== false,
              autoRefreshGuide: cfg.get('autoRefreshGuide') !== false,
              recordChange: (c) => recorder.recordChange(c),
            });
            if (!isJson && mem.notice)
              process.stderr.write(`${chalk.dim(sanitizeForDisplay(mem.notice))}\n`);
          } catch {
            /* write-at-end is best-effort */
          }
        }
        recorder.finalize(stoppedShort ? 'interrupted' : 'completed');

        const seconds = Math.round((Date.now() - start) / 1000);
        if (isJson) {
          json({
            task,
            model,
            provider: providerLabel,
            routedVia,
            routingReason,
            planMode,
            plan: plan ?? null,
            executed: true,
            // Evidence anchor: lets a captured run be correlated with
            // server-side logs/history (debug-bench post-mortems needed this).
            conversationId: result.conversationId,
            turns: result.turns,
            toolCalls: result.toolCalls,
            reachedMaxTurns: result.reachedMaxTurns,
            cancelled: result.cancelled,
            changedFiles: recorder.changeCount(),
            verify: verify ? { command: verifyCommand, passed: verify.passed, attempts: verify.attempts } : null,
            budget: hasBudget ? { stoppedBy: budgetStopReason, ...budget.snapshot() } : null,
            seconds,
            finalText: result.finalText,
            ...(resumeRun ? { resumed: true, sessionId: recorder.id } : {}),
          });
        } else {
          if (result.cancelled) warn('Interrupted.');
          else if (result.reachedMaxTurns) warn(`Reached the turn limit (${maxTurns}).`);
          // A budget stop already printed its own ⚠ line; don't also report the
          // verify loop as "failing" — the real reason is the controlled stop.
          if (verify && !verify.passed && !result.cancelled && !budgetStopReason) {
            process.stderr.write(
              `${chalk.red('✗')} verification still failing after ${verify.attempts} attempt${verify.attempts === 1 ? '' : 's'}\n`,
            );
          }
          if (recorder.changeCount() > 0) {
            process.stderr.write(
              // The third of the three counted-files lines — the audit named two;
              // the population is three. Same scoping as the other two.
              `${chalk.dim(`✎ ${recorder.changeCount()} file${recorder.changeCount() === 1 ? '' : 's'} changed in this workspace · run \`spycore rewind\` to undo`)}\n`,
            );
          }
          const budgetTail = hasBudget ? ` · ${formatBudgetBar(budget.snapshot(), budgetCaps)}` : '';
          process.stderr.write(
            chalk.dim(`(${result.turns} turn${result.turns === 1 ? '' : 's'}, ${result.toolCalls} tool call${result.toolCalls === 1 ? '' : 's'}, ${seconds}s${budgetTail})\n`),
          );
        }

        // Exit code: a budget stop is a CONTROLLED stop (exit 0), distinct from
        // a verify failure (exit 1). Budget takes precedence.
        if (verify && !verify.passed && !budgetStopReason) process.exitCode = 1;
      } finally {
        process.removeListener('SIGINT', onSigint);
        await fireSessionEnd();
        // A thrown provider error (or any path that skipped finalize) still
        // leaves a resumable record of what already happened. No-op if final.
        recorder.abandon();
      }
    });
}
