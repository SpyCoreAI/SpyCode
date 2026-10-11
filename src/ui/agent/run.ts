/**
 * Lazy entry point for the interactive Ink agent session. Free of static
 * React/Ink imports so registering the `agent` command never pulls Ink into
 * the CLI hot path - the heavy UI only loads when an interactive run starts.
 */
import { isInteractive } from '../lib/render.js';
import type { BudgetCaps, BudgetSnapshot } from '../../lib/agent/budget.js';
import type { RunRecorder } from '../../lib/agent/checkpoint.js';
import type { RunAgentOptions } from '../../lib/agent/loop.js';
import type { Provider } from '../../lib/providers/types.js';

/** Resume mode: continue an interrupted session's conversation instead of starting fresh. */
export interface AgentResumeConfig {
  conversationId: string;
  continueMessage: string;
  /** Pre-built, sanitized banner lines describing what was restored. */
  bannerLines: string[];
  /** Skill names already injected into the conversation (load_skill dedup). */
  loadedSkills: string[];
  /** Consumption carried over from the interrupted run - budgets are CUMULATIVE. */
  budgetInitial: BudgetSnapshot;
}

export interface AgentSessionConfig {
  task: string;
  /** Wire model id: a SpyCore slug, or a BYOK model id ('gpt-4o'). */
  model: string;
  /** Active model-call provider; omitted → the loop's default SpyCore provider. */
  provider?: Provider | undefined;
  maxTurns: number;
  /** Max tool calls dispatched per turn (loop default when omitted). */
  maxToolCallsPerTurn: number;
  apiUrl: string | undefined;
  cwd: string;
  /** Whether color is enabled (from --no-color + TTY). */
  color: boolean;
  /** --yes: auto-approve all writes without prompting. */
  autoApprove: boolean;
  /** Timeout (ms) for run_command. */
  commandTimeoutMs: number;
  /** Routing summary, e.g. "Routing → Styx (coding task)". */
  routingLine: string;
  /** Plan mode: investigate + propose a plan for approval before executing. */
  planMode: boolean;
  /** Optional self-verify command; on failure the agent fixes it and re-verifies. */
  verifyCommand: string | undefined;
  /** Max verify→fix cycles (1–10). */
  verifyAttempts: number;
  /** Optional cost/runaway caps (tokens/time/turns). */
  budgetCaps: BudgetCaps;
  /** Tool-call wire protocol: auto | native | fenced. */
  toolProtocol: 'auto' | 'native' | 'fenced';
  /** Web tools (web_search / fetch_url); false removes them entirely. */
  webTools: boolean;
  observeWorkspace: boolean;
  /** Uploaded image FILE IDs - ride the first turn's `attachments` field. */
  attachments?: string[] | undefined;
  /** Inlined text-attachment blocks appended to the TASK message. */
  attachedContext?: string | undefined;
  /** Step-boundary journal (checkpoint + resume state); omitted → legacy end-of-run save. */
  recorder?: RunRecorder | undefined;
  /** Present when this session RESUMES an interrupted run. */
  resume?: AgentResumeConfig | undefined;
  /** PHASE-1 1.6: lifecycle-hook bridge (pre/post-tool) - blocking-only. */
  hooks?: RunAgentOptions['hooks'] | undefined;
  /** PHASE-1 1.10: live command allow/deny rules - the same object is handed
   *  to runAgent, so the TUI's "always allow" option can append mid-run. */
  commandRules?: RunAgentOptions['commandRules'] | undefined;
}

export async function runAgentSession(cfg: AgentSessionConfig): Promise<void> {
  // The caller guarantees a TTY, but guard so we never launch Ink into a sink.
  if (!isInteractive()) return;
  if (!cfg.color) process.env.NO_COLOR = process.env.NO_COLOR ?? '1';

  const [{ render }, { createElement }, { AgentApp }] = await Promise.all([
    import('ink'),
    import('react'),
    import('./AgentApp.js'),
  ]);
  const instance = render(
    createElement(AgentApp, {
      task: cfg.task,
      model: cfg.model,
      provider: cfg.provider,
      maxTurns: cfg.maxTurns,
      maxToolCallsPerTurn: cfg.maxToolCallsPerTurn,
      apiUrl: cfg.apiUrl,
      cwd: cfg.cwd,
      autoApprove: cfg.autoApprove,
      commandTimeoutMs: cfg.commandTimeoutMs,
      routingLine: cfg.routingLine,
      planMode: cfg.planMode,
      verifyCommand: cfg.verifyCommand,
      verifyAttempts: cfg.verifyAttempts,
      budgetCaps: cfg.budgetCaps,
      toolProtocol: cfg.toolProtocol,
      webTools: cfg.webTools,
      observeWorkspace: cfg.observeWorkspace,
      attachments: cfg.attachments,
      attachedContext: cfg.attachedContext,
      recorder: cfg.recorder,
      resume: cfg.resume,
      hooks: cfg.hooks,
      commandRules: cfg.commandRules,
    }),
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
}
