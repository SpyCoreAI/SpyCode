/**
 * The per-run tool context for `runAgent`: installed skills, the change
 * journal (in-run list, external sinks, end-of-run persistence), the
 * `ToolContext` the tools run against, and the approval-in-flight flag.
 *
 * Every factory is called once per `runAgent` call; nothing run-scoped lives
 * at module scope. The context object is returned as is and mutated in
 * place, never copied: the run keeps reading its fields live.
 *
 * Imports from loop.ts are type-only, so this module adds no runtime import
 * cycle.
 */
import type { AgentEvent, RunAgentOptions } from './loop.js';
import { buildSkillsCatalog, discoverSkills, hasWithheldProjectSkills, type DiscoveredSkill } from './skills.js';
import { saveSession, type RecordedChange } from './checkpoint.js';
import { DEFAULT_LIMITS, type ToolContext } from './tools.js';

/** The run's installed skills, by name and as the system-prompt catalog section. */
export function loadRunSkills(
  cwd: string,
  emit: (e: AgentEvent) => void,
): {
  skillsByName: ReadonlyMap<string, DiscoveredSkill>;
  skillsSection: string;
} {
  // Installed skills (project + user-global). With zero skills the catalog is
  // '' and the system prompt is byte-identical to pre-skills builds. Discovery
  // never throws; failures degrade to an empty set. Project skills are
  // trust-gated inside discoverSkills - a repo-supplied SKILL.md injects into
  // the system prompt, so an untrusted workspace's skills stay out (the same
  // gate project MCP servers and project hooks go through). Say so out loud
  // rather than silently running without them.
  const skills: DiscoveredSkill[] = discoverSkills(cwd);
  if (hasWithheldProjectSkills(cwd)) {
    emit({
      type: 'skill_notice',
      level: 'warn',
      text:
        'Project skills in .spycore/skills/ were skipped: this workspace is not trusted. ' +
        'Run `spycore mcp trust` in this directory to enable them (only trust repositories you know).',
    });
  }
  const skillsByName: ReadonlyMap<string, DiscoveredSkill> = new Map(skills.map((s) => [s.name, s]));
  const skillsSection = buildSkillsCatalog(skills);
  return { skillsByName, skillsSection };
}

/** The run's change journal: the in-run list, the external sinks and the end-of-run persistence. */
export function createRunJournal(opts: RunAgentOptions): {
  changes: RecordedChange[];
  record: (c: RecordedChange) => void;
  recordDelta: (delta: readonly RecordedChange[]) => void;
  persist: () => void;
} {
  const changes: RecordedChange[] = [];
  const externalRecorder = opts.recordChange;
  const externalBatchRecorder = opts.recordChanges;
  /**
   * The observation window's delta, handed over as ONE batch so the caller's
   * journal is committed once rather than once per record. Falls back to the
   * per-record sink, so the records - and the journal - are identical either way.
   *
   * `ctx.recordChange` is deliberately NOT used here: inside the window it is
   * swapped for the self-journaling tracker, and by this point the tracker has
   * already been restored. Going through the same two sinks the tracker wraps keeps
   * exactly one definition of "where a change goes".
   */
  const recordDelta = (delta: readonly RecordedChange[]): void => {
    if (delta.length === 0) return;
    for (const c of delta) changes.push(c);
    if (externalBatchRecorder) externalBatchRecorder(delta);
    else for (const c of delta) externalRecorder?.(c);
  };
  const record = (c: RecordedChange): void => {
    changes.push(c);
    externalRecorder?.(c);
  };
  // Persist the change journal once at the run's end (best-effort - a journal
  // write failure must not break the run). When an external recorder is given
  // (the orchestrator accumulates a whole session, including verify fix-ups),
  // the orchestrator owns persistence instead.
  let persisted = false;
  const persist = (): void => {
    if (externalRecorder || persisted || changes.length === 0) return;
    persisted = true;
    saveSession({ cwd: opts.cwd, task: opts.task, changes });
  };
  return { changes, record, recordDelta, persist };
}

/** The `ToolContext` every tool call of the run starts from. */
export function createToolContext(
  opts: RunAgentOptions,
  { emit, record, skillsByName, webEnabled }: {
    emit: (e: AgentEvent) => void;
    record: (c: RecordedChange) => void;
    skillsByName: ReadonlyMap<string, DiscoveredSkill>;
    webEnabled: boolean;
  },
): ToolContext {
  const ctx: ToolContext = {
    cwd: opts.cwd,
    limits: opts.limits ?? DEFAULT_LIMITS,
    signal: opts.signal,
    requestApproval: opts.requestApproval,
    commandTimeoutMs: opts.commandTimeoutMs,
    planMode: opts.planMode,
    webToolsEnabled: webEnabled,
    apiUrlOverride: opts.apiUrlOverride,
    skills: skillsByName,
    loadedSkills: opts.loadedSkills ?? new Set<string>(),
    // PHASE-1 1.10: rules + the visible-notice sink. Every rule decision is
    // surfaced as a rule_notice event - an auto-approval is never silent.
    commandRules: opts.commandRules,
    onCommandRuleNotice: (n) => {
      const cmd = n.command.length > 80 ? `${n.command.slice(0, 80)}…` : n.command;
      emit(
        n.kind === 'deny'
          ? {
              type: 'rule_notice',
              level: 'warn',
              text: `denied by the ${n.rule.scope} deny rule "${n.rule.entry}": ${cmd}`,
            }
          : {
              type: 'rule_notice',
              level: 'info',
              text: `auto-approved by the ${n.rule.scope} allow rule "${n.rule.entry}": ${cmd}`,
            },
      );
    },
    recordChange: record,
  };
  return ctx;
}

/**
 * Wraps the context's approval resolver so the run knows whether an approval
 * gate is open, and installs `isApprovalInFlight` on the context. Returns a
 * live reader of the same flag.
 */
export function trackApprovalInFlight(ctx: ToolContext): () => boolean {
  // F4: the loop knows whether an approval gate is currently open. Every
  // gated action funnels through `ctx.requestApproval` (F-2c-45), so one
  // wrapper here sees them all; the observation window below wraps and
  // restores THIS wrapper, so the flag stays accurate through it. The
  // auto-compact trigger consults the flag before firing.
  let approvalInFlight = false;
  if (ctx.requestApproval) {
    const baseRequestApproval = ctx.requestApproval;
    ctx.requestApproval = async (req) => {
      approvalInFlight = true;
      try {
        return await baseRequestApproval(req);
      } finally {
        approvalInFlight = false;
      }
    };
  }
  // The CLI-wide dispatch timeout (see tools.ts `withDispatchTimeout`) must
  // not bill human decision time: while an approval prompt is open the
  // deadline slides instead of expiring.
  ctx.isApprovalInFlight = () => approvalInFlight;
  return () => approvalInFlight;
}
