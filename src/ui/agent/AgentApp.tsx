import { Box, Static, Text, useApp, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Spinner } from '../components/index.js';
import { Markdown, parseMarkdown, StreamingMarkdown } from '../markdown/index.js';
import { useTheme } from '../theme/theme.js';
import { useContentWidth } from '../lib/useContentWidth.js';
import {
  ApprovalView,
  ItemView,
  clamp,
  errMessage,
  modelLabel,
  GLYPH_TOOL,
  type AgentUiItem,
  type CommandInfo,
  type DistributiveOmit,
} from './shared.js';
import { runAgent, type AgentEvent, type RunAgentOptions } from '../../lib/agent/loop.js';
import type { Provider } from '../../lib/providers/types.js';
import { runVerifyLoop, type VerifyEvent } from '../../lib/agent/verify.js';
import { saveSession, type RecordedChange, type RunRecorder } from '../../lib/agent/checkpoint.js';
import { makeRunStateHook } from '../../lib/agent/resume.js';
import type { AgentResumeConfig } from './run.js';
import { snapshotStructure, finalizeTaskMemory } from '../../lib/agent/task-memory.js';
import { getConfigStore } from '../../lib/config.js';
import { buildContextInjection } from '../../lib/memory.js';
import {
  createBudget,
  formatBudgetBar,
  describeBudgetStop,
  type Budget,
  type BudgetCaps,
  type BudgetSnapshot,
} from '../../lib/agent/budget.js';
import { stripToolBlocksForDisplay } from '../../lib/agent/protocol.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import {
  createApprovalController,
  type ApprovalController,
  type ApprovalRequest,
} from '../../lib/agent/approval.js';
import {
  appendUserAllowRule,
  deriveAlwaysAllowEntry,
} from '../../lib/agent/command-rules.js';
import { composeReviseFeedback, runPlanEditSession } from '../../lib/plan-edit.js';

export interface AgentAppProps {
  task: string;
  /** Wire model id: a SpyCore slug, or a BYOK model id ('gpt-4o'). */
  model: string;
  /** Active model-call provider; omitted → the loop's default SpyCore provider. */
  provider?: Provider | undefined;
  maxTurns: number;
  /** Max tool calls dispatched per turn. */
  maxToolCallsPerTurn: number;
  apiUrl: string | undefined;
  cwd: string;
  /** --yes: auto-approve all writes/commands without prompting. */
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
  /** PHASE-1 1.10: live command allow/deny rules. The SAME object is handed
   * to runAgent, so an "always allow" append takes effect mid-run. */
  commandRules?: RunAgentOptions['commandRules'] | undefined;
}

/**
 * The user's decision on a proposed plan. 1.11 key map (mirrors the chat
 * host's menu semantics): [e] = direct EDIT session (was: feedback), [r] =
 * revise with feedback (was: reject), [c]/Esc = cancel. Esc and Ctrl+C are
 * unchanged; the feedback text is collected separately via the plan-input
 * prompt, so no decision carries it inline anymore.
 */
type PlanDecision = { action: 'approve' | 'approve_all' | 'reject' | 'edit' | 'revise' };

type Status = 'init' | 'streaming' | 'tool' | 'done';

/** The plan approval block: the proposed plan + the a/A/e/r/c menu (1.11). */
function PlanView({ plan, width }: { plan: string; width: number }): ReactNode {
  const { colors, symbols } = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>{`${symbols.section} Plan`}</Text>
      <Markdown tokens={parseMarkdown(sanitizeForDisplay(plan) || '_(no plan produced)_')} width={width} />
      <Box marginTop={1}>
        <Text color={colors.accent} bold>[a]</Text>
        <Text color={colors.muted}> approve & run </Text>
        <Text color={colors.accent} bold>[A]</Text>
        <Text color={colors.muted}> approve & auto-run </Text>
        <Text color={colors.accent} bold>[e]</Text>
        <Text color={colors.muted}> edit </Text>
        <Text color={colors.accent} bold>[r]</Text>
        <Text color={colors.muted}> revise </Text>
        <Text color={colors.accent} bold>[c]</Text>
        <Text color={colors.muted}> cancel (Ctrl+C aborts)</Text>
      </Box>
    </Box>
  );
}

/**
 * One single-line plan question (an edit-session op / a revise feedback) -
 * the agent TUI's mirror of the chat session's interact primitive: Enter
 * resolves, Esc cancels ('c' for op prompts, '' for text), Ctrl+C aborts.
 */
function PlanInputView({
  question,
  inputKey,
  onSubmit,
}: {
  question: string;
  inputKey: number;
  onSubmit: (value: string) => void;
}): ReactNode {
  const { colors } = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>{sanitizeForDisplay(question)}</Text>
      <TextInput key={inputKey} onSubmit={onSubmit} />
    </Box>
  );
}

export function AgentApp({ task, model, provider, maxTurns, maxToolCallsPerTurn, apiUrl, cwd, autoApprove, commandTimeoutMs, routingLine, planMode, verifyCommand, verifyAttempts, budgetCaps, toolProtocol, webTools, observeWorkspace, attachments, attachedContext, recorder, resume, hooks, commandRules }: AgentAppProps): ReactNode {
  const { exit } = useApp();
  const { colors, symbols } = useTheme();
  const width = useContentWidth();

  // One shared budget for the whole run (initial + plan + every verify fix).
  // On resume the interrupted run's consumption is pre-loaded - CUMULATIVE.
  const budgetRef = useRef<Budget | null>(null);
  if (budgetRef.current === null) budgetRef.current = createBudget(budgetCaps, Date.now, resume?.budgetInitial);
  const budget = budgetRef.current;
  const [budgetSnap, setBudgetSnap] = useState<BudgetSnapshot | null>(null);

  const nextId = useRef(2);
  const [items, setItems] = useState<AgentUiItem[]>([
    { kind: 'banner', id: 0 },
    { kind: 'task', id: 1, task, routingLine },
  ]);
  const [status, setStatus] = useState<Status>('init');
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  // MCP approval args expand/collapse ('e' in the approval context).
  const [mcpArgsExpanded, setMcpArgsExpanded] = useState(false);
  // 1.10: the "always allow" confirm sub-state - the exact entry to be saved.
  const [alwaysConfirm, setAlwaysConfirm] = useState<string | null>(null);
  const alwaysConfirmRef = useRef<string | null>(null);
  const statusRef = useRef<Status>('init');
  const runningRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const liveTextRef = useRef('');
  const liveToolRef = useRef<{ tool: string; arg: string } | null>(null);
  const startedRef = useRef(false);
  const approvalActiveRef = useRef(false);
  const [planPrompt, setPlanPrompt] = useState<{ plan: string } | null>(null);
  // 1.11: ONE pending single-line plan question (edit op / revise feedback) -
  // the agent TUI's mirror of the chat interact primitive. `seq` keys the
  // TextInput so every question mounts a fresh (empty) buffer.
  const [planInput, setPlanInput] = useState<{ question: string; seq: number } | null>(null);
  const planInputRef = useRef<{ kind: 'choice' | 'text'; resolve: (answer: string) => void } | null>(null);
  const planInputSeqRef = useRef(0);
  const planActiveRef = useRef(false);
  const planResolveRef = useRef<((d: PlanDecision) => void) | null>(null);
  const phaseRef = useRef<'normal' | 'plan' | 'execute'>('normal');
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  const setStatusBoth = (s: Status): void => {
    statusRef.current = s;
    setStatus(s);
  };
  const push = (item: DistributiveOmit<AgentUiItem, 'id'>): void => {
    setItems((prev) => [...prev, { ...item, id: nextId.current++ } as AgentUiItem]);
  };

  // Plan approval: the orchestrator awaits requestPlanDecision; a keypress
  // resolves it.
  const requestPlanDecision = (plan: string): Promise<PlanDecision> =>
    new Promise((resolve) => {
      planResolveRef.current = resolve;
      setPlanPrompt({ plan });
      forceRender();
    });
  const resolvePlan = (d: PlanDecision): void => {
    const r = planResolveRef.current;
    planResolveRef.current = null;
    setPlanPrompt(null);
    forceRender();
    if (r) r(d);
  };
  // 1.11 plan-input primitive: ask ONE single-line question; Enter resolves
  // the value, Esc resolves 'c' (choice) / '' (text) - the exact chat-session
  // interact contract, so the shared edit session behaves identically here.
  // After a run abort, resolve instantly so a mid-session loop unwinds.
  const promptPlanInput = (question: string, kind: 'choice' | 'text'): Promise<string> => {
    if (abortRef.current?.signal.aborted) {
      return Promise.resolve(kind === 'choice' ? 'c' : '');
    }
    return new Promise((resolve) => {
      planInputRef.current = { kind, resolve };
      setPlanInput({ question, seq: ++planInputSeqRef.current });
      forceRender();
    });
  };
  const resolvePlanInput = (answer: string): void => {
    const r = planInputRef.current;
    planInputRef.current = null;
    setPlanInput(null);
    forceRender();
    if (r) r.resolve(answer);
  };

  // The approval state machine is created once; its callbacks drive React.
  const controllerRef = useRef<ApprovalController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createApprovalController({
      autoApproveAll: autoApprove,
      onRequest: (req) => {
        liveToolRef.current = null;
        setApproval(req);
        setMcpArgsExpanded(false);
        forceRender();
      },
      onSettled: () => {
        setApproval(null);
        setMcpArgsExpanded(false);
        setAlwaysConfirm(null); // any settle path clears the 1.10 confirm step
        forceRender();
      },
    });
  }
  // Mirror approval/plan presence into refs for the (synchronous) input handler.
  approvalActiveRef.current = approval !== null;
  alwaysConfirmRef.current = alwaysConfirm;
  planActiveRef.current = planPrompt !== null;

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const controller = new AbortController();
    abortRef.current = controller;
    const ctrl = controllerRef.current;

    const handleEvent = (e: AgentEvent): void => {
      switch (e.type) {
        case 'assistant_token':
          liveTextRef.current += e.chunk;
          if (statusRef.current !== 'streaming') setStatusBoth('streaming');
          forceRender();
          break;
        case 'narration':
          liveTextRef.current = '';
          push({ kind: 'assistant', text: sanitizeForDisplay(stripToolBlocksForDisplay(e.text)), final: false });
          break;
        case 'tool_call_started':
          // NATIVE mode early affordance: the model named a tool mid-stream -
          // show "⚙ <tool> …" before the turn completes. The committed tool
          // line + result still come from tool_call / tool_result below.
          liveTextRef.current = '';
          liveToolRef.current = { tool: sanitizeForDisplay(e.name), arg: '' };
          setStatusBoth('tool');
          forceRender();
          break;
        case 'tool_call':
          liveTextRef.current = '';
          liveToolRef.current = { tool: sanitizeForDisplay(e.tool), arg: sanitizeForDisplay(e.arg) };
          setStatusBoth('tool');
          forceRender();
          break;
        case 'tool_result': {
          const arg = liveToolRef.current?.arg ?? '';
          if (e.tool === 'run_command') {
            let info: CommandInfo;
            if (e.kind === 'command') {
              info = { outcome: 'ran', ok: e.ok, statusLabel: sanitizeForDisplay(e.summary), tail: sanitizeForDisplay(e.outputTail ?? '') };
            } else if (e.kind === 'rejected') {
              info = { outcome: 'rejected', ok: false, statusLabel: 'rejected', tail: '' };
            } else {
              info = { outcome: 'blocked', ok: false, statusLabel: sanitizeForDisplay(e.summary), tail: '' };
            }
            push({ kind: 'command', command: sanitizeForDisplay(e.command ?? arg), info });
          } else if (e.kind) {
            push({
              kind: 'tool',
              tool: e.tool,
              arg,
              ok: e.ok,
              summary: sanitizeForDisplay(e.summary),
              mutation: { outcome: e.kind === 'command' ? 'applied' : e.kind, added: e.added ?? 0, removed: e.removed ?? 0, isNew: e.isNew ?? false },
            });
          } else if (e.tool === 'write_file' || e.tool === 'edit_file') {
            if (!e.ok) {
              push({
                kind: 'tool',
                tool: e.tool,
                arg,
                ok: false,
                summary: sanitizeForDisplay(e.summary),
                mutation: { outcome: 'blocked', added: 0, removed: 0, isNew: false },
              });
            } else {
              push({ kind: 'tool', tool: e.tool, arg, ok: e.ok, summary: e.summary });
            }
          } else {
            push({ kind: 'tool', tool: e.tool, arg, ok: e.ok, summary: e.summary });
          }
          liveToolRef.current = null;
          forceRender();
          break;
        }
        case 'parse_error':
          liveTextRef.current = '';
          push({ kind: 'notice', variant: 'warning', text: 'Model emitted no valid tool call - asking it to retry.' });
          break;
        case 'skills':
          push({ kind: 'skills', skills: e.skills.map((sk) => sanitizeForDisplay(sk)) });
          break;
        case 'mcp_notice':
          push({ kind: 'notice', variant: e.level === 'warn' ? 'warning' : 'info', text: sanitizeForDisplay(e.text) });
          break;
        case 'hook_notice':
          push({ kind: 'notice', variant: e.level === 'warn' ? 'warning' : 'info', text: sanitizeForDisplay(e.text) });
          break;
        case 'rule_notice':
          // 1.10: allowlist auto-approvals (info) and rule denials (warn) -
          // every rule decision is a visible line, never silent.
          push({ kind: 'notice', variant: e.level === 'warn' ? 'warning' : 'info', text: sanitizeForDisplay(e.text) });
          break;
        case 'skill_notice':
          push({ kind: 'notice', variant: e.level === 'warn' ? 'warning' : 'info', text: sanitizeForDisplay(e.text) });
          break;
        case 'final':
          liveTextRef.current = '';
          // In the plan phase the final answer IS the plan - it's shown in the
          // plan approval view, not committed as a "Result".
          if (phaseRef.current !== 'plan') {
            push({ kind: 'assistant', text: sanitizeForDisplay(stripToolBlocksForDisplay(e.text)), final: true });
          }
          forceRender();
          break;
        case 'max_turns':
          push({ kind: 'notice', variant: 'warning', text: `Reached the turn limit (${e.turns}). Stopping.` });
          break;
        case 'tool_call_cap':
          push({
            kind: 'notice',
            variant: 'warning',
            text: `Tool-call cap hit (${e.cap} this turn) - ${e.skipped} call${e.skipped === 1 ? '' : 's'} skipped.`,
          });
          break;
        case 'budget':
          setBudgetSnap({ tokensUsed: e.tokensUsed, turnsUsed: e.turnsUsed, elapsedMs: e.elapsedMs });
          break;
        case 'budget_stop': {
          const snap = { tokensUsed: e.tokensUsed, turnsUsed: e.turnsUsed, elapsedMs: e.elapsedMs };
          setBudgetSnap(snap);
          push({
            kind: 'notice',
            variant: 'warning',
            text: `stopped - ${describeBudgetStop(e.reason, snap, budgetCaps)} · the task may be incomplete`,
          });
          forceRender();
          break;
        }
      }
    };

    // One session journal for the whole run (initial + verify fix-ups) so
    // `spycore rewind` undoes everything together; runAgent defers persistence
    // to us because we pass recordChange. With a recorder, the journal persists
    // incrementally at every step boundary so an interrupt stays resumable;
    // without one (legacy direct render), the end-of-run saveSession stands.
    const sessionChanges: RecordedChange[] = [];
    // Part 3b: structural fingerprint BEFORE the task, for the write-at-end diff.
    const beforeStructure = snapshotStructure(cwd);
    // One session-wide set so a skill loaded in any phase isn't re-injected -
    // restored on resume (the bodies already live in the conversation).
    const loadedSkills = new Set<string>(resume?.loadedSkills ?? []);

    // Read-at-start project context: load SPYCODE.md + CODEBASE_GUIDE.md + the
    // CODEBASE_CHANGELOG.md tail ONCE for the whole task (one disk read,
    // honouring injectGuide/injectChangelog) and thread the SAME block into
    // every phase's system prompt - mirroring chat's read-at-start injection.
    // No memory files → empty block → nothing injected and no notice.
    // A resumed run continues an existing conversation - the context (if any)
    // already rode the original first turn, so it is neither re-read nor noted.
    const ctxCfg = getConfigStore();
    const contextInjection = resume
      ? null
      : buildContextInjection({
          cwd,
          injectGuide: ctxCfg.get('injectGuide') !== false,
          injectChangelog: ctxCfg.get('injectChangelog') !== false,
        });
    const projectContext =
      contextInjection && contextInjection.block.length > 0 ? contextInjection.block : undefined;

    const runPhase = (extra: {
      planMode?: boolean;
      approvedPlan?: string;
      planEdited?: boolean;
      planFeedback?: string;
      conversationId?: string;
      continueMessage?: string;
    }) =>
      runAgent({
        task,
        model,
        maxTurns,
        maxToolCallsPerTurn,
        apiUrlOverride: apiUrl,
        signal: controller.signal,
        cwd,
        commandTimeoutMs,
        requestApproval: ctrl?.request,
        recordChange: (c) => {
          sessionChanges.push(c);
          recorder?.recordChange(c);
        },
        // F-2c-48 · C-UX45: the observation window's delta arrives whole, so a
        // command that touched hundreds of files costs ONE journal commit rather
        // than one per record. The records pushed here are identical either way.
        recordChanges: (cs) => {
          for (const c of cs) sessionChanges.push(c);
          recorder?.recordChanges(cs);
        },
        budget,
        loadedSkills,
        toolProtocol,
        webTools,
        observeWorkspace,
        projectContext,
        // Attachments apply to the first turn of each FRESH conversation
        // (plan + execute phases); continuations inherit via history.
        attachments,
        attachedContext,
        onEvent: handleEvent,
        provider,
        // Lifecycle-hook bridge (pre/post-tool) - blocking-only influence.
        ...(hooks ? { hooks } : {}),
        // 1.10: the LIVE rules object - an "always allow" append mid-run
        // takes effect for subsequent commands in this same run.
        commandRules,
        // Step-boundary journal - execute/verify phases only (planning is
        // read-only and opens its own throwaway conversation).
        ...(recorder && !extra.planMode
          ? { onRunState: makeRunStateHook({ recorder, budget, cwd, loadedSkills }) }
          : {}),
        ...extra,
      });

    const handleVerifyEvent = (e: VerifyEvent): void => {
      liveTextRef.current = '';
      if (e.type === 'verify_start') {
        const label = e.attempts > 1 ? ` (attempt ${e.attempt}/${e.attempts})` : '';
        push({ kind: 'notice', variant: 'info', text: `Verifying${label} → ${e.command}` });
      } else if (e.passed) {
        push({ kind: 'notice', variant: 'success', text: 'verification passed' });
      } else if (e.blocked) {
        push({ kind: 'notice', variant: 'error', text: sanitizeForDisplay(e.outputTail) });
      } else {
        push({ kind: 'notice', variant: 'warning', text: `verification failed (attempt ${e.attempt}/${e.attempts})` });
      }
    };

    void (async () => {
      try {
        // Resume banner: what was restored, how config re-resolved, drift status.
        if (resume) {
          for (const line of resume.bannerLines) push({ kind: 'notice', variant: 'info', text: line });
        }
        // Surface the read-at-start memory load (same transparency as chat's
        // "Loaded project context" line). Silent when no memory files exist.
        if (projectContext && contextInjection) {
          const names = contextInjection.parts
            .filter((p) => p.status !== 'off' && p.status !== 'dropped')
            .map((p) => p.label)
            .join(', ');
          push({ kind: 'notice', variant: 'success', text: `Loaded project context: ${names}` });
        }
        let approvedPlan: string | undefined;
        let planEdited = false;
        if (planMode && !resume) {
          push({
            kind: 'notice',
            variant: 'info',
            text: "Plan mode - I'll investigate and propose a plan for your approval before changing anything.",
          });
          phaseRef.current = 'plan';
          let feedback: string | undefined;
          regen: for (;;) {
            const planRes = await runPhase({ planMode: true, planFeedback: feedback });
            if (planRes.cancelled) {
              push({ kind: 'notice', variant: 'warning', text: 'Interrupted.' });
              return;
            }
            // `lastGenerated` is the model's latest plan; `plan` may diverge
            // from it through [e]dit sessions (1.11). Approving the divergent
            // text marks the execute injection (planEdited) - it pre-approves
            // NOTHING either way.
            const lastGenerated = planRes.finalText.trim();
            let plan = lastGenerated;
            for (;;) {
              const decision = await requestPlanDecision(plan.length > 0 ? plan : '(the model produced no plan)');
              if (decision.action === 'reject') {
                push({ kind: 'notice', variant: 'warning', text: 'Plan rejected - nothing was executed.' });
                return;
              }
              if (decision.action === 'edit') {
                // The SHARED edit session (lib/plan-edit.ts) on the plan-input
                // primitive; discard inside it restores the pre-edit plan and
                // returns to this menu - never run-cancel.
                const res = await runPlanEditSession(plan, {
                  present: (t) => push({ kind: 'notice', variant: 'info', text: t }),
                  ask: (q) => promptPlanInput(q, 'choice'),
                  readText: (q) => promptPlanInput(q, 'text'),
                  notify: (k, t) => push({ kind: 'notice', variant: k, text: t }),
                });
                if (controller.signal.aborted) {
                  push({ kind: 'notice', variant: 'warning', text: 'Interrupted.' });
                  return;
                }
                plan = res.plan;
                continue;
              }
              if (decision.action === 'revise') {
                const fb = (await promptPlanInput('Feedback for the revised plan:', 'text')).trim();
                if (controller.signal.aborted) {
                  push({ kind: 'notice', variant: 'warning', text: 'Interrupted.' });
                  return;
                }
                // Unedited → the feedback verbatim (unchanged 1.7 payload);
                // edited → the EDITED plan rides as the current plan.
                const composed = composeReviseFeedback(plan, lastGenerated, fb);
                feedback = composed.length > 0 ? composed : undefined;
                push({ kind: 'notice', variant: 'info', text: 'Revising the plan…' });
                continue regen;
              }
              if (decision.action === 'approve_all') ctrl?.setAutoApproveAll(true);
              planEdited = plan !== lastGenerated;
              approvedPlan = plan;
              push({ kind: 'notice', variant: 'success', text: 'Plan approved - executing.' });
              break regen;
            }
          }
          phaseRef.current = 'execute';
        }

        // M5: the recorder stores the (possibly edited) plan VERBATIM - the
        // M4 marker is injection-time wording in the loop, never stored text.
        if (approvedPlan && approvedPlan.trim().length > 0) recorder?.update({ approvedPlan });
        let verifyCancelled = false;
        const res = resume
          ? await runPhase({ conversationId: resume.conversationId, continueMessage: resume.continueMessage })
          : await runPhase({ approvedPlan, ...(planEdited ? { planEdited: true } : {}) });
        if (res.cancelled) {
          push({ kind: 'notice', variant: 'warning', text: 'Interrupted.' });
        } else if (verifyCommand && !res.budgetStop) {
          // Self-verify: run the check; on failure feed it back and re-verify.
          // The shared budget can stop this loop too (a fix exhausting a cap).
          const outcome = await runVerifyLoop(res.conversationId, {
            verifyCommand,
            attempts: verifyAttempts,
            cwd,
            commandTimeoutMs,
            signal: controller.signal,
            continueRun: (cid, msg) => runPhase({ conversationId: cid, continueMessage: msg }),
            budget,
            // The SAME controller run_command is gated by, so the verify
            // command surfaces in the ordinary approval UI (and an "always
            // allow" rule added mid-run applies to it, like any other command).
            requestApproval: ctrl?.request,
            commandRules,
            onEvent: handleVerifyEvent,
          });
          if (outcome.cancelled) {
            verifyCancelled = true;
            push({ kind: 'notice', variant: 'warning', text: 'Interrupted.' });
          } else if (!outcome.passed && !outcome.stoppedByBudget) {
            // A budget stop already announced itself; don't double-report.
            push({
              kind: 'notice',
              variant: 'error',
              text: `verification still failing after ${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'}`,
            });
          }
        }
        // Persist the whole session (initial + verify fix-ups) as one checkpoint.
        // A run that stopped short of a final answer (interrupt, budget, turn
        // limit) finalizes as 'interrupted' - i.e. resumable.
        // Part 3b write-at-end: log to ./CODEBASE_CHANGELOG.md + refresh the
        // guide on a structural change. Fully isolated from the agent flow.
        //
        // BEFORE the journal is sealed, and the order is the point - see the
        // sibling comment in commands/agent.ts. These two files are the user's
        // own and the run modifies them; a record pushed after `finalize()` is
        // never persisted, so it would look journaled and rewind nothing.
        let memNotice: string | null = null;
        if ((recorder ? recorder.changeCount() : sessionChanges.length) > 0) {
          try {
            const cfg = getConfigStore();
            const mem = await finalizeTaskMemory({
              cwd,
              task,
              changes: recorder ? recorder.changes() : sessionChanges,
              before: beforeStructure,
              autoChangelog: cfg.get('autoChangelog') !== false,
              autoRefreshGuide: cfg.get('autoRefreshGuide') !== false,
              recordChange: (c) => {
                if (recorder) recorder.recordChange(c);
                else sessionChanges.push(c);
              },
            });
            memNotice = mem.notice;
          } catch {
            /* write-at-end is best-effort */
          }
        }
        if (recorder) {
          const stoppedShort = res.cancelled || res.budgetStop !== null || res.reachedMaxTurns || verifyCancelled;
          recorder.finalize(stoppedShort ? 'interrupted' : 'completed');
        } else if (sessionChanges.length > 0) {
          saveSession({ cwd, task, changes: sessionChanges });
        }
        const changed = recorder ? recorder.changeCount() : sessionChanges.length;
        if (changed > 0) {
          push({
            kind: 'notice',
            variant: 'info',
            // "in this workspace" is the whole correction. The count is of
            // JOURNALED files, and the journal is bounded by the workspace - so
            // the sentence names its own scope instead of leaving the reader to
            // assume it covers everything the run touched.
            text: `${changed} file${changed === 1 ? '' : 's'} changed in this workspace - run \`spycore rewind\` to undo.`,
          });
        }
        if (memNotice) push({ kind: 'notice', variant: 'success', text: memNotice });
      } catch (err) {
        push({ kind: 'notice', variant: 'error', text: sanitizeForDisplay(errMessage(err)) });
      } finally {
        // Any path that skipped the normal finalize (plan rejected/interrupted,
        // a thrown provider error) still records what already happened. No-op
        // when finalize already ran, and writes nothing for no-progress runs.
        recorder?.abandon();
        runningRef.current = false;
        liveTextRef.current = '';
        liveToolRef.current = null;
        setStatusBoth('done');
        setTimeout(() => exit(), 10);
      }
    })();

    return () => {
      controller.abort();
    };
    // Run exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    const ctrl = controllerRef.current;
    // Plan input (1.11 edit op / revise feedback): the TextInput owns typing;
    // Enter submits via its onSubmit, Esc cancels per the interact contract
    // ('c' for op prompts → discard, '' for text → cancel that op), Ctrl+C
    // aborts the run (the pending question resolves so the flow unwinds).
    if (planInputRef.current) {
      if (key.ctrl && input === 'c') {
        const kind = planInputRef.current.kind;
        abortRef.current?.abort();
        resolvePlanInput(kind === 'choice' ? 'c' : '');
        return;
      }
      if (key.escape) {
        resolvePlanInput(planInputRef.current.kind === 'choice' ? 'c' : '');
        return;
      }
      return;
    }
    // Plan decision prompt (a / A / e / r / c) - 1.11 key map: e = edit
    // session, r = revise (feedback), c/Esc = cancel; Ctrl+C aborts.
    if (planActiveRef.current) {
      if (key.ctrl && input === 'c') {
        resolvePlan({ action: 'reject' });
        abortRef.current?.abort();
        return;
      }
      if (input === 'a') resolvePlan({ action: 'approve' });
      else if (input === 'A') resolvePlan({ action: 'approve_all' });
      else if (input === 'e') resolvePlan({ action: 'edit' });
      else if (input === 'r') resolvePlan({ action: 'revise' });
      else if (input === 'c' || key.escape) resolvePlan({ action: 'reject' });
      return;
    }
    // While an approval is pending, the keypresses drive the decision.
    if (approvalActiveRef.current && ctrl) {
      if (key.ctrl && input === 'c') {
        ctrl.reject('aborted by user');
        abortRef.current?.abort();
        return;
      }
      // 1.10 "always allow" confirm step: y saves the shown entry to the USER
      // config (never project) and approves this command; n backs out to the
      // normal prompt with no decision made.
      if (alwaysConfirmRef.current !== null) {
        const entry = alwaysConfirmRef.current;
        if (input === 'y') {
          try {
            const rule = appendUserAllowRule(entry);
            commandRules?.allow.push(rule); // live - applies for the rest of the run
            push({ kind: 'notice', variant: 'success', text: `Saved allow rule "${entry}" to your user command rules.` });
          } catch (err) {
            push({ kind: 'notice', variant: 'warning', text: `Could not save the allow rule: ${errMessage(err)}` });
          }
          setAlwaysConfirm(null);
          ctrl.resolvePending('accept');
        } else if (input === 'n' || key.escape) {
          setAlwaysConfirm(null);
          forceRender();
        }
        return;
      }
      if (input === 'a') ctrl.resolvePending('accept');
      else if (input === 'A') ctrl.resolvePending('accept_all');
      else if (input === 'e' && ctrl.pending()?.kind === 'mcp') setMcpArgsExpanded((v) => !v);
      else if (input === 'w') {
        // Offered only for command approvals with a derivable safe pattern:
        // metachar-ineligible commands never get one (deriveAlwaysAllowEntry
        // returns null), so they can never be persisted as auto-approvable.
        const req = ctrl.pending();
        if (req?.kind === 'command' && commandRules) {
          const entry = deriveAlwaysAllowEntry(req.command);
          if (entry !== null) {
            setAlwaysConfirm(entry);
            forceRender();
          }
        }
      } else if (input === 'r' || key.escape) ctrl.resolvePending('reject');
      return;
    }
    if (key.ctrl && input === 'c') {
      if (runningRef.current && abortRef.current) abortRef.current.abort();
      else exit();
    }
  });

  const liveTool = liveToolRef.current;
  // Hide spycore:tool fenced blocks (and any still-open partial) from the
  // streamed assistant text - the ⚙ tool lines represent those actions.
  const live = sanitizeForDisplay(stripToolBlocksForDisplay(liveTextRef.current));
  // Running cost indicator (only the dimensions with caps); '' when none set.
  const budgetBar = budget.hasCaps ? formatBudgetBar(budgetSnap ?? budget.snapshot(), budgetCaps) : '';

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => <ItemView key={item.id} item={item} width={width} />}</Static>

      {status !== 'done' ? (
        planInput ? (
          <PlanInputView
            question={planInput.question}
            inputKey={planInput.seq}
            onSubmit={resolvePlanInput}
          />
        ) : planPrompt ? (
          <PlanView plan={planPrompt.plan} width={width} />
        ) : approval ? (
          <ApprovalView
            req={approval}
            width={width}
            allowPermanent
            expandMcpArgs={mcpArgsExpanded}
            alwaysEntry={
              approval.kind === 'command' && commandRules
                ? deriveAlwaysAllowEntry(approval.command)
                : null
            }
            confirmingEntry={alwaysConfirm}
          />
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {status === 'tool' && liveTool ? (
              liveTool.tool === 'run_command' ? (
                <Box>
                  <Text color={colors.accent} bold>{'$ '}</Text>
                  <Text color={colors.text}>{clamp(liveTool.arg, Math.max(8, width - 6))}</Text>
                  <Text color={colors.muted}>{'  …'}</Text>
                </Box>
              ) : (
                <Box>
                  <Text color={colors.accent}>{`${GLYPH_TOOL} `}</Text>
                  <Text color={colors.text}>{liveTool.tool}</Text>
                  {liveTool.arg ? <Text color={colors.muted}>{` ${liveTool.arg}`}</Text> : null}
                  <Text color={colors.muted}>{'  …'}</Text>
                </Box>
              )
            ) : live.length > 0 ? (
              <StreamingMarkdown content={live} streaming width={width} />
            ) : (
              <Spinner label={status === 'streaming' ? 'Thinking…' : 'Working…'} />
            )}
          </Box>
        )
      ) : null}

      <Box marginTop={1}>
        <Text color={colors.muted}>
          {`${symbols.diamond} ${modelLabel(model)}  ${symbols.middot}  agent${budgetBar ? `  ${symbols.middot}  ${budgetBar}` : ''}`}
        </Text>
      </Box>
    </Box>
  );
}
