/**
 * Lazy entry point for the interactive Ink agent session. Free of static
 * React/Ink imports so registering the `agent` command never pulls Ink into
 * the CLI hot path — the heavy UI only loads when an interactive run starts.
 */
import { isInteractive } from '../lib/render.js';
import type { BudgetCaps } from '../../lib/agent/budget.js';
import type { Provider } from '../../lib/providers/types.js';

export interface AgentSessionConfig {
  task: string;
  /** Wire model id: a SpyCore slug, or a BYOK model id ('gpt-4o'). */
  model: string;
  /** Active model-call provider; omitted → the loop's default SpyCore provider. */
  provider?: Provider | undefined;
  maxTurns: number;
  apiUrl: string | undefined;
  cwd: string;
  /** Whether color is enabled (from --no-color + TTY). */
  color: boolean;
  /** --yes: auto-approve all writes without prompting. */
  autoApprove: boolean;
  /** Timeout (ms) for run_command. */
  commandTimeoutMs: number;
  /** Identity-safe routing summary, e.g. "Routing → Styx (coding task)". */
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
    }),
    { exitOnCtrlC: false },
  );
  await instance.waitUntilExit();
}
