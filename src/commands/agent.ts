import { Command, Option } from 'commander';
import chalk from 'chalk';
import { sanitizeForDisplay } from '../lib/sanitize-display.js';
import {
  runAgent,
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
import { runVerifyLoop, clampVerifyAttempts, type VerifyEvent, type VerifyOutcome } from '../lib/agent/verify.js';
import { saveSession, type RecordedChange } from '../lib/agent/checkpoint.js';
import { snapshotStructure, finalizeTaskMemory } from '../lib/agent/task-memory.js';
import { buildContextInjection } from '../lib/memory.js';
import {
  createBudget,
  toBudgetCaps,
  formatBudgetBar,
  describeBudgetStop,
  type BudgetCaps,
  type BudgetReason,
} from '../lib/agent/budget.js';
import { isAuthenticated } from '../lib/auth.js';
import { getOutputOptions, json, warn } from '../lib/output.js';
import { isPromptCancelled, readSingleLineInput } from '../lib/prompt.js';
import { EXIT_AUTH_ERROR, EXIT_USER_ERROR, SpycoreCliError } from '../lib/errors.js';

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
}

export function registerAgentCommand(program: Command): void {
  program
    .command('agent <task...>')
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
    .action(async (taskArg: string[], opts: AgentCmdOpts, cmd: Command) => {
      const parentOpts =
        cmd.parent?.opts<{ apiUrl?: string; json?: boolean; color?: boolean }>() ?? {};
      const task = (taskArg ?? []).join(' ').trim();
      if (task.length === 0) {
        throw new SpycoreCliError('Task description is required.', EXIT_USER_ERROR);
      }

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
      const maxTurns = Math.max(
        MIN_TURNS,
        Math.min(MAX_TURNS_CAP, Number(opts.maxTurns ?? DEFAULT_MAX_TURNS) || DEFAULT_MAX_TURNS),
      );
      const cmdTimeoutSec = Math.max(1, Math.min(3600, Number(opts.cmdTimeout ?? 120) || 120));
      const commandTimeoutMs = cmdTimeoutSec * 1000;
      const verifyCommand = (opts.verify ?? '').trim() || undefined;
      const verifyAttempts = clampVerifyAttempts(Number(opts.verifyAttempts ?? 3));
      // Tool-call protocol override (commander .choices already validated it).
      const toolProtocol = (opts.toolProtocol ?? 'auto') as 'auto' | 'native' | 'fenced';

      // Cost/runaway caps (all optional). A turn cap only becomes a whole-run
      // budget when the user EXPLICITLY passes --max-turns (not the default 25),
      // so the built-in per-call iteration guard is unchanged without it.
      const turnsExplicit = cmd.getOptionValueSource('maxTurns') === 'cli';
      const budgetCaps: BudgetCaps = toBudgetCaps({
        maxTokens: opts.maxTokens !== undefined ? Number(opts.maxTokens) : undefined,
        maxTimeMs: opts.maxTime !== undefined ? Number(opts.maxTime) * 1000 : undefined,
        maxTurns: turnsExplicit ? maxTurns : undefined,
      });
      const hasBudget = budgetCaps.maxTokens !== undefined || budgetCaps.maxTimeMs !== undefined || budgetCaps.maxTurns !== undefined;

      // DECOUPLED login: ONLY the SpyCore provider needs a SpyCore account. A
      // BYOK provider runs against the user's own endpoint with no login.
      if (selection.kind === 'spycore' && !(await isAuthenticated())) {
        throw new SpycoreCliError(
          'Not logged in.',
          EXIT_AUTH_ERROR,
          'Run `spycore login` to authenticate.',
        );
      }

      const isJson = getOutputOptions().json;
      const cwd = process.cwd();

      // Resolve the model-call provider + routing line.
      //   • spycore (default): a cheap HERMES triage (+ plan lookup) picks STYX
      //     (workhorse) or CHARON (complex), clamped to the plan; --model skips
      //     triage. Never throws — defaults to STYX. Identity-safe routing line.
      //   • openai (BYOK): NO triage, NO plan-clamp, NO SpyCore default model —
      //     the user's own --model runs against their endpoint, shown verbatim.
      let model: string;
      let routeLine: string;
      let planMode: boolean;
      let planNote: string;
      let provider: Provider | undefined;
      let routedVia: 'override' | 'triage' | 'byok';
      let routingReason: string;
      let providerLabel: string;
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

      // ── Interactive path (Ink session) ──────────────────────────────────
      // A real TTY and not --json: render the rich agent UI. Ink is imported
      // lazily so the hot path stays Ink-free.
      if (process.stdout.isTTY === true && !isJson) {
        const color = parentOpts.color !== false;
        const { runAgentSession } = await import('../ui/agent/run.js');
        await runAgentSession({
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
          provider,
        });
        return;
      }

      // ── Non-interactive / JSON path (plain text) ─────────────────────────
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.once('SIGINT', onSigint);

      if (!isJson) process.stderr.write(`${chalk.dim(routeLine)}\n`);
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
              process.stderr.write(`${chalk.green(glyph)} ${e.tool} ${chalk.dim(`(${stat})`)}\n`);
            } else if (e.kind === 'rejected') {
              process.stderr.write(`${chalk.yellow('⊘')} ${chalk.dim(`rejected ${e.tool}`)}\n`);
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
      // persistence to us because we pass recordChange.
      const sessionChanges: RecordedChange[] = [];
      // Part 3b: structural fingerprint BEFORE the task, so the write-at-end hook
      // can detect new/removed top-level dirs + dep changes by diffing.
      const beforeStructure = snapshotStructure(cwd);
      // One shared budget for the whole run (initial + plan + every verify fix).
      const budget = createBudget(budgetCaps);
      // One session-wide set so a skill loaded in any phase isn't re-injected.
      const loadedSkills = new Set<string>();

      // Read-at-start project context: load SPYCODE.md + CODEBASE_GUIDE.md + the
      // CODEBASE_CHANGELOG.md tail ONCE for the whole task (one disk read,
      // honouring the injectGuide/injectChangelog toggles) and thread the SAME
      // block into every phase's system prompt — mirroring chat's read-at-start
      // injection + "Loaded project context" notice. No memory files → empty
      // block → nothing injected and no notice (silent, like an uninitialised repo).
      const ctxCfg = getConfigStore();
      const contextInjection = buildContextInjection({
        cwd,
        injectGuide: ctxCfg.get('injectGuide') !== false,
        injectChangelog: ctxCfg.get('injectChangelog') !== false,
      });
      const projectContext = contextInjection.block.length > 0 ? contextInjection.block : undefined;
      if (projectContext && !isJson) {
        const names = contextInjection.parts
          .filter((p) => p.status !== 'off' && p.status !== 'dropped')
          .map((p) => p.label)
          .join(', ');
        process.stderr.write(chalk.dim(`✓ Loaded project context: ${names}\n`));
      }
      let budgetStopReason: BudgetReason | null = null;
      const onEvent = (e: AgentEvent): void => {
        if (e.type === 'budget_stop') budgetStopReason = e.reason;
        if (isJson) process.stdout.write(`${JSON.stringify(e)}\n`);
        else renderPlain(e);
      };

      // Workspace-trust prompt for PROJECT-scoped MCP servers (./.spycore/mcp.json).
      // Offered ONLY in an interactive TTY without --yes/--json — a one-time y/N
      // per workspace, persisted on yes. In any non-interactive / --yes / --json
      // run we pass NO resolver, so a cloned repo's project MCP servers are
      // skipped (fail-closed) rather than executed on agent start (clone-and-run
      // RCE). User-global (~/.spycore) servers are unaffected.
      const interactiveTrust =
        process.stdin.isTTY === true &&
        process.stdout.isTTY === true &&
        !isJson &&
        !opts.yes;
      const confirmProjectMcpTrust = interactiveTrust
        ? async ({ servers }: { servers: { name: string }[] }): Promise<boolean> => {
            const names = servers.map((s) => s.name).join(', ');
            const n = servers.length;
            process.stderr.write(
              `${chalk.yellow('⚠')} This workspace defines ${n} local MCP server${n === 1 ? '' : 's'} (${names}) ` +
                `that will run commands on your machine.\n`,
            );
            try {
              const ans = (await readSingleLineInput('Trust this workspace and run them? (y/N): '))
                .trim()
                .toLowerCase();
              return ans === 'y' || ans === 'yes';
            } catch (err) {
              if (isPromptCancelled(err)) return false; // Ctrl+C → no trust
              throw err;
            }
          }
        : undefined;

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
          recordChange: (c) => sessionChanges.push(c),
          budget,
          loadedSkills,
          toolProtocol,
          projectContext,
          onEvent,
          provider,
          ...(confirmProjectMcpTrust ? { confirmProjectMcpTrust } : {}),
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
          process.stderr.write(`${chalk.red('✗')} ${chalk.dim(e.outputTail)}\n`);
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

        const result = await runPhase({ approvedPlan: plan });

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
            onEvent: renderVerify,
          });
        }

        // Persist the whole session once (initial run + verify fix-ups).
        if (sessionChanges.length > 0) {
          saveSession({ cwd, task, changes: sessionChanges });
          // Part 3b write-at-end: log the task to ./CODEBASE_CHANGELOG.md and,
          // on a structural change, refresh ./CODEBASE_GUIDE.md. Fully isolated —
          // a memory-write failure must never break the agent run.
          try {
            const cfg = getConfigStore();
            const mem = await finalizeTaskMemory({
              cwd,
              task,
              changes: sessionChanges,
              before: beforeStructure,
              autoChangelog: cfg.get('autoChangelog') !== false,
              autoRefreshGuide: cfg.get('autoRefreshGuide') !== false,
            });
            if (!isJson && mem.notice) process.stderr.write(`${chalk.dim(mem.notice)}\n`);
          } catch {
            /* write-at-end is best-effort */
          }
        }

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
            changedFiles: sessionChanges.length,
            verify: verify ? { command: verifyCommand, passed: verify.passed, attempts: verify.attempts } : null,
            budget: hasBudget ? { stoppedBy: budgetStopReason, ...budget.snapshot() } : null,
            seconds,
            finalText: result.finalText,
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
          if (sessionChanges.length > 0) {
            process.stderr.write(
              `${chalk.dim(`✎ ${sessionChanges.length} file${sessionChanges.length === 1 ? '' : 's'} changed · run \`spycore rewind\` to undo`)}\n`,
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
      }
    });
}
