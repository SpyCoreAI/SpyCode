import { Box, Static, Text, useApp, useInput } from 'ink';
import { TextInput } from '@inkjs/ui';
import { useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import { Banner, Notice, Spinner, type NoticeVariant } from '../components/index.js';
import { Markdown, parseMarkdown, StreamingMarkdown } from '../markdown/index.js';
import { useTheme } from '../theme/theme.js';
import { useContentWidth } from '../lib/useContentWidth.js';
import { runAgent, type AgentEvent } from '../../lib/agent/loop.js';
import type { Provider } from '../../lib/providers/types.js';
import { runVerifyLoop, type VerifyEvent } from '../../lib/agent/verify.js';
import { saveSession, type RecordedChange } from '../../lib/agent/checkpoint.js';
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
  type MutationOutcome,
} from '../../lib/agent/approval.js';
import type { DiffLine } from '../../lib/agent/diff.js';
import { MODEL_DISPLAY, isModelSlug } from '../../lib/models.js';
import { SpycoreCliError } from '../../lib/errors.js';

export interface AgentAppProps {
  task: string;
  /** Wire model id: a SpyCore slug, or a BYOK model id ('gpt-4o'). */
  model: string;
  /** Active model-call provider; omitted → the loop's default SpyCore provider. */
  provider?: Provider | undefined;
  maxTurns: number;
  apiUrl: string | undefined;
  cwd: string;
  /** --yes: auto-approve all writes/commands without prompting. */
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

/** The user's decision on a proposed plan. */
type PlanDecision = { action: 'approve' | 'approve_all' | 'reject' | 'edit'; feedback?: string };

interface MutationInfo {
  outcome: MutationOutcome;
  added: number;
  removed: number;
  isNew: boolean;
}

interface CommandInfo {
  outcome: 'ran' | 'rejected' | 'blocked';
  ok: boolean;
  /** e.g. "exit 0 (1.2s)" or "timed out after 120s (120.0s)". */
  statusLabel: string;
  /** Capped output tail. */
  tail: string;
}

/** Items committed to <Static> scrollback (each rendered exactly once). */
type AgentUiItem =
  | { kind: 'banner'; id: number }
  | { kind: 'task'; id: number; task: string; routingLine: string }
  | { kind: 'assistant'; id: number; text: string; final: boolean }
  | { kind: 'tool'; id: number; tool: string; arg: string; ok: boolean; summary: string; mutation?: MutationInfo }
  | { kind: 'command'; id: number; command: string; info: CommandInfo }
  | { kind: 'notice'; id: number; variant: NoticeVariant; text: string }
  /** Server-side skills the backend activated (spycore provider only) — a dim one-liner. */
  | { kind: 'skills'; id: number; skills: string[] };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Status = 'init' | 'streaming' | 'tool' | 'done';

const GLYPH_TOOL = '⚙';
const GLYPH_WRITE = '✚';
const GLYPH_EDIT = '✎';
const GLYPH_BLOCK = '⊘';

function modelLabel(slug: string): string {
  const lc = slug.toLowerCase();
  return isModelSlug(lc) ? MODEL_DISPLAY[lc] : slug;
}

function errMessage(err: unknown): string {
  if (err instanceof SpycoreCliError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

function statLabel(added: number, removed: number): string {
  return removed > 0 ? `+${added} -${removed}` : `+${added}`;
}

/** Clamp a single display line to the content width. */
function clamp(s: string, width: number): string {
  const max = Math.max(8, width);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** One diff line, marker-prefixed and width-clamped, colored by kind. The
 *  line text is FILE/MODEL-controlled — sanitized so an escape sequence in a
 *  diff can never restyle or overwrite the approval prompt around it. */
function DiffLineView({ line, width }: { line: DiffLine; width: number }): ReactNode {
  const { colors } = useTheme();
  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : line.kind === 'hunk' ? '' : ' ';
  const text = clamp(sanitizeForDisplay(line.kind === 'hunk' ? line.text : `${marker}${line.text}`), width);
  const color =
    line.kind === 'add'
      ? colors.success
      : line.kind === 'del'
        ? colors.error
        : line.kind === 'hunk'
          ? colors.accent
          : colors.muted;
  return <Text color={color}>{text.length > 0 ? text : ' '}</Text>;
}

/** The a/A/r prompt row, shared by write + command approvals. */
function ApprovalPrompt(): ReactNode {
  const { colors } = useTheme();
  return (
    <Box marginTop={1}>
      <Text color={colors.accent} bold>[a]</Text>
      <Text color={colors.muted}> accept </Text>
      <Text color={colors.accent} bold>[A]</Text>
      <Text color={colors.muted}> accept all </Text>
      <Text color={colors.accent} bold>[r]</Text>
      <Text color={colors.muted}> reject (Ctrl+C aborts)</Text>
    </Box>
  );
}

/** The interactive approval block: a write diff, a command, or an MCP call + a/A/r prompt. */
function ApprovalView({ req, width }: { req: ApprovalRequest; width: number }): ReactNode {
  const { colors } = useTheme();
  if (req.kind === 'command') {
    // The command is rendered IN FULL (ink wraps long lines — no truncation
    // at the approval gate) and sanitized so embedded \r/escapes are visible
    // instead of rewriting the prompt. What's approved is what runs.
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.warning} bold>{'run command'}</Text>
        <Box>
          <Text color={colors.accent} bold>{'$ '}</Text>
          <Text color={colors.text}>{sanitizeForDisplay(req.command)}</Text>
        </Box>
        <ApprovalPrompt />
      </Box>
    );
  }
  if (req.kind === 'mcp') {
    const argsJson = Object.keys(req.args).length > 0 ? JSON.stringify(req.args, null, 2) : '(no arguments)';
    const argLines = sanitizeForDisplay(argsJson).split('\n').slice(0, 20);
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color={colors.warning} bold>{`🔌 MCP tool · ${sanitizeForDisplay(req.server)}`}</Text>
        <Box>
          <Text color={colors.accent} bold>{`${sanitizeForDisplay(req.tool)} `}</Text>
          <Text color={colors.muted}>{`(${sanitizeForDisplay(req.fullName)})`}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {argLines.map((l, i) => (
            <Text key={i} color={colors.muted}>{clamp(l, width) || ' '}</Text>
          ))}
        </Box>
        <ApprovalPrompt />
      </Box>
    );
  }
  const glyph = req.tool === 'edit_file' ? GLYPH_EDIT : GLYPH_WRITE;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.warning} bold>
        {`${glyph} ${req.tool} ${sanitizeForDisplay(req.path)}${req.isNew ? '  (new file)' : ''}  (${statLabel(req.added, req.removed)})`}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {req.diff.map((line, i) => (
          <DiffLineView key={i} line={line} width={width} />
        ))}
        {req.truncated ? (
          <Text color={colors.muted}>{`… +${req.hiddenLines} more diff line${req.hiddenLines === 1 ? '' : 's'}`}</Text>
        ) : null}
      </Box>
      <ApprovalPrompt />
    </Box>
  );
}

/** The plan approval block: the proposed plan + an a/A/e/r prompt or an edit input. */
function PlanView({
  plan,
  editing,
  width,
  onSubmitEdit,
}: {
  plan: string;
  editing: boolean;
  width: number;
  onSubmitEdit: (value: string) => void;
}): ReactNode {
  const { colors, symbols } = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>{`${symbols.section} Plan`}</Text>
      <Markdown tokens={parseMarkdown(sanitizeForDisplay(plan) || '_(no plan produced)_')} width={width} />
      {editing ? (
        <Box marginTop={1}>
          <Text color={colors.accent} bold>{'feedback ❯ '}</Text>
          <TextInput placeholder="what should change?" onSubmit={onSubmitEdit} />
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={colors.accent} bold>[a]</Text>
          <Text color={colors.muted}> approve & run </Text>
          <Text color={colors.accent} bold>[A]</Text>
          <Text color={colors.muted}> approve & auto-run </Text>
          <Text color={colors.accent} bold>[e]</Text>
          <Text color={colors.muted}> edit </Text>
          <Text color={colors.accent} bold>[r]</Text>
          <Text color={colors.muted}> reject (Ctrl+C aborts)</Text>
        </Box>
      )}
    </Box>
  );
}

function ItemView({ item, width }: { item: AgentUiItem; width: number }): ReactNode {
  const { colors, symbols } = useTheme();
  switch (item.kind) {
    case 'banner':
      return <Banner tagline="agent session" />;
    case 'task':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.accent} bold>{`${symbols.pointer} Task`}</Text>
          <Box width={Math.max(1, width - 2)}>
            <Text color={colors.text}>{item.task}</Text>
          </Box>
          <Text color={colors.muted}>{`${item.routingLine}  ${symbols.middot}  Ctrl+C to stop`}</Text>
        </Box>
      );
    case 'assistant':
      return (
        <Box flexDirection="column" marginTop={1}>
          {item.final ? <Text color={colors.muted}>{`${symbols.success} Result`}</Text> : null}
          <Markdown tokens={parseMarkdown(item.text || '_(no content)_')} width={width} />
        </Box>
      );
    case 'tool': {
      if (item.mutation) {
        const m = item.mutation;
        if (m.outcome === 'applied') {
          const glyph = item.tool === 'edit_file' ? GLYPH_EDIT : GLYPH_WRITE;
          return (
            <Box marginTop={1}>
              <Text color={colors.success}>{`${glyph} `}</Text>
              <Text color={colors.text}>{item.tool}</Text>
              {item.arg ? <Text color={colors.muted}>{` ${item.arg}`}</Text> : null}
              <Text color={colors.muted}>{`  (${statLabel(m.added, m.removed)})`}</Text>
            </Box>
          );
        }
        const blocked = m.outcome === 'blocked';
        return (
          <Box marginTop={1}>
            <Text color={blocked ? colors.error : colors.warning}>{`${GLYPH_BLOCK} `}</Text>
            <Text color={colors.muted}>{`${blocked ? 'blocked' : 'rejected'} ${item.tool}${item.arg ? ` ${item.arg}` : ''}`}</Text>
          </Box>
        );
      }
      return (
        <Box marginTop={1}>
          <Text color={item.ok ? colors.accent : colors.error}>{`${GLYPH_TOOL} `}</Text>
          <Text color={colors.text}>{item.tool}</Text>
          {item.arg ? <Text color={colors.muted}>{` ${item.arg}`}</Text> : null}
          <Text color={colors.muted}>{`  ${symbols.arrow} ${item.ok ? '' : 'error: '}${item.summary}`}</Text>
        </Box>
      );
    }
    case 'command': {
      const { info } = item;
      const sigilColor =
        info.outcome === 'ran' ? (info.ok ? colors.success : colors.error)
          : info.outcome === 'blocked' ? colors.error
            : colors.warning;
      const status =
        info.outcome === 'rejected' ? 'rejected'
          : info.outcome === 'blocked' ? `blocked (${info.statusLabel})`
            : info.statusLabel;
      const tailLines = info.tail.trim().length > 0 ? info.tail.split('\n').slice(-40) : [];
      return (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color={sigilColor} bold>{'$ '}</Text>
            <Text color={colors.text}>{clamp(item.command, Math.max(8, width - 12))}</Text>
            <Text color={colors.muted}>{`  ${symbols.arrow} ${status}`}</Text>
          </Box>
          {tailLines.length > 0 ? (
            <Box flexDirection="column" paddingLeft={2}>
              {tailLines.map((l, i) => (
                <Text key={i} color={colors.muted}>{clamp(l, Math.max(8, width - 2)) || ' '}</Text>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    }
    case 'notice':
      return (
        <Box marginTop={1}>
          <Notice variant={item.variant}>{item.text}</Notice>
        </Box>
      );
    case 'skills':
      return (
        <Box marginTop={1}>
          <Text color={colors.muted}>{`⚡ skills: ${item.skills.join(', ')}`}</Text>
        </Box>
      );
  }
}

export function AgentApp({ task, model, provider, maxTurns, apiUrl, cwd, autoApprove, commandTimeoutMs, routingLine, planMode, verifyCommand, verifyAttempts, budgetCaps, toolProtocol }: AgentAppProps): ReactNode {
  const { exit } = useApp();
  const { colors, symbols } = useTheme();
  const width = useContentWidth();

  // One shared budget for the whole run (initial + plan + every verify fix).
  const budgetRef = useRef<Budget | null>(null);
  if (budgetRef.current === null) budgetRef.current = createBudget(budgetCaps);
  const budget = budgetRef.current;
  const [budgetSnap, setBudgetSnap] = useState<BudgetSnapshot | null>(null);

  const nextId = useRef(2);
  const [items, setItems] = useState<AgentUiItem[]>([
    { kind: 'banner', id: 0 },
    { kind: 'task', id: 1, task, routingLine },
  ]);
  const [status, setStatus] = useState<Status>('init');
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const statusRef = useRef<Status>('init');
  const runningRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const liveTextRef = useRef('');
  const liveToolRef = useRef<{ tool: string; arg: string } | null>(null);
  const startedRef = useRef(false);
  const approvalActiveRef = useRef(false);
  const [planPrompt, setPlanPrompt] = useState<{ plan: string } | null>(null);
  const [planEditing, setPlanEditing] = useState(false);
  const planActiveRef = useRef(false);
  const planEditingRef = useRef(false);
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

  // Plan approval: the orchestrator awaits requestPlanDecision; a keypress (or
  // the edit TextInput) resolves it.
  const requestPlanDecision = (plan: string): Promise<PlanDecision> =>
    new Promise((resolve) => {
      planResolveRef.current = resolve;
      setPlanEditing(false);
      setPlanPrompt({ plan });
      forceRender();
    });
  const resolvePlan = (d: PlanDecision): void => {
    const r = planResolveRef.current;
    planResolveRef.current = null;
    setPlanPrompt(null);
    setPlanEditing(false);
    forceRender();
    if (r) r(d);
  };

  // The approval state machine is created once; its callbacks drive React.
  const controllerRef = useRef<ApprovalController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createApprovalController({
      autoApproveAll: autoApprove,
      onRequest: (req) => {
        liveToolRef.current = null;
        setApproval(req);
        forceRender();
      },
      onSettled: () => {
        setApproval(null);
        forceRender();
      },
    });
  }
  // Mirror approval/plan presence into refs for the (synchronous) input handler.
  approvalActiveRef.current = approval !== null;
  planActiveRef.current = planPrompt !== null;
  planEditingRef.current = planEditing;

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
          // NATIVE mode early affordance: the model named a tool mid-stream —
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
          push({ kind: 'notice', variant: 'warning', text: 'Model emitted no valid tool call — asking it to retry.' });
          break;
        case 'skills':
          push({ kind: 'skills', skills: e.skills.map((sk) => sanitizeForDisplay(sk)) });
          break;
        case 'mcp_notice':
          push({ kind: 'notice', variant: e.level === 'warn' ? 'warning' : 'info', text: sanitizeForDisplay(e.text) });
          break;
        case 'final':
          liveTextRef.current = '';
          // In the plan phase the final answer IS the plan — it's shown in the
          // plan approval view, not committed as a "Result".
          if (phaseRef.current !== 'plan') {
            push({ kind: 'assistant', text: sanitizeForDisplay(stripToolBlocksForDisplay(e.text)), final: true });
          }
          forceRender();
          break;
        case 'max_turns':
          push({ kind: 'notice', variant: 'warning', text: `Reached the turn limit (${e.turns}). Stopping.` });
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
            text: `stopped — ${describeBudgetStop(e.reason, snap, budgetCaps)} · the task may be incomplete`,
          });
          forceRender();
          break;
        }
      }
    };

    // One session journal for the whole run (initial + verify fix-ups) so
    // `spycore rewind` undoes everything together; runAgent defers persistence
    // to us because we pass recordChange.
    const sessionChanges: RecordedChange[] = [];
    // Part 3b: structural fingerprint BEFORE the task, for the write-at-end diff.
    const beforeStructure = snapshotStructure(cwd);
    // One session-wide set so a skill loaded in any phase isn't re-injected.
    const loadedSkills = new Set<string>();

    // Read-at-start project context: load SPYCODE.md + CODEBASE_GUIDE.md + the
    // CODEBASE_CHANGELOG.md tail ONCE for the whole task (one disk read,
    // honouring injectGuide/injectChangelog) and thread the SAME block into
    // every phase's system prompt — mirroring chat's read-at-start injection.
    // No memory files → empty block → nothing injected and no notice.
    const ctxCfg = getConfigStore();
    const contextInjection = buildContextInjection({
      cwd,
      injectGuide: ctxCfg.get('injectGuide') !== false,
      injectChangelog: ctxCfg.get('injectChangelog') !== false,
    });
    const projectContext = contextInjection.block.length > 0 ? contextInjection.block : undefined;

    const runPhase = (extra: {
      planMode?: boolean;
      approvedPlan?: string;
      planFeedback?: string;
      conversationId?: string;
      continueMessage?: string;
    }) =>
      runAgent({
        task,
        model,
        maxTurns,
        apiUrlOverride: apiUrl,
        signal: controller.signal,
        cwd,
        commandTimeoutMs,
        requestApproval: ctrl?.request,
        recordChange: (c) => sessionChanges.push(c),
        budget,
        loadedSkills,
        toolProtocol,
        projectContext,
        onEvent: handleEvent,
        provider,
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
        // Surface the read-at-start memory load (same transparency as chat's
        // "Loaded project context" line). Silent when no memory files exist.
        if (projectContext) {
          const names = contextInjection.parts
            .filter((p) => p.status !== 'off' && p.status !== 'dropped')
            .map((p) => p.label)
            .join(', ');
          push({ kind: 'notice', variant: 'success', text: `Loaded project context: ${names}` });
        }
        let approvedPlan: string | undefined;
        if (planMode) {
          push({
            kind: 'notice',
            variant: 'info',
            text: "Plan mode — I'll investigate and propose a plan for your approval before changing anything.",
          });
          phaseRef.current = 'plan';
          let feedback: string | undefined;
          for (;;) {
            const planRes = await runPhase({ planMode: true, planFeedback: feedback });
            if (planRes.cancelled) {
              push({ kind: 'notice', variant: 'warning', text: 'Interrupted.' });
              return;
            }
            const plan = planRes.finalText.trim();
            const decision = await requestPlanDecision(plan.length > 0 ? plan : '(the model produced no plan)');
            if (decision.action === 'reject') {
              push({ kind: 'notice', variant: 'warning', text: 'Plan rejected — nothing was executed.' });
              return;
            }
            if (decision.action === 'edit') {
              feedback = decision.feedback;
              push({ kind: 'notice', variant: 'info', text: 'Revising the plan…' });
              continue;
            }
            if (decision.action === 'approve_all') ctrl?.setAutoApproveAll(true);
            approvedPlan = plan;
            push({ kind: 'notice', variant: 'success', text: 'Plan approved — executing.' });
            break;
          }
          phaseRef.current = 'execute';
        }

        const res = await runPhase({ approvedPlan });
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
            onEvent: handleVerifyEvent,
          });
          if (outcome.cancelled) {
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
        if (sessionChanges.length > 0) {
          saveSession({ cwd, task, changes: sessionChanges });
          push({
            kind: 'notice',
            variant: 'info',
            text: `${sessionChanges.length} file${sessionChanges.length === 1 ? '' : 's'} changed — run \`spycore rewind\` to undo.`,
          });
          // Part 3b write-at-end: log to ./CODEBASE_CHANGELOG.md + refresh the
          // guide on a structural change. Fully isolated from the agent flow.
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
            if (mem.notice) push({ kind: 'notice', variant: 'success', text: mem.notice });
          } catch {
            /* write-at-end is best-effort */
          }
        }
      } catch (err) {
        push({ kind: 'notice', variant: 'error', text: sanitizeForDisplay(errMessage(err)) });
      } finally {
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
    // Plan edit: the TextInput owns keys; Ctrl+C aborts.
    if (planEditingRef.current) {
      if (key.ctrl && input === 'c') {
        resolvePlan({ action: 'reject' });
        abortRef.current?.abort();
      }
      return;
    }
    // Plan decision prompt (a / A / e / r).
    if (planActiveRef.current) {
      if (key.ctrl && input === 'c') {
        resolvePlan({ action: 'reject' });
        abortRef.current?.abort();
        return;
      }
      if (input === 'a') resolvePlan({ action: 'approve' });
      else if (input === 'A') resolvePlan({ action: 'approve_all' });
      else if (input === 'e') {
        setPlanEditing(true);
        forceRender();
      } else if (input === 'r' || key.escape) resolvePlan({ action: 'reject' });
      return;
    }
    // While an approval is pending, the keypresses drive the decision.
    if (approvalActiveRef.current && ctrl) {
      if (key.ctrl && input === 'c') {
        ctrl.reject('aborted by user');
        abortRef.current?.abort();
        return;
      }
      if (input === 'a') ctrl.resolvePending('accept');
      else if (input === 'A') ctrl.resolvePending('accept_all');
      else if (input === 'r' || key.escape) ctrl.resolvePending('reject');
      return;
    }
    if (key.ctrl && input === 'c') {
      if (runningRef.current && abortRef.current) abortRef.current.abort();
      else exit();
    }
  });

  const liveTool = liveToolRef.current;
  // Hide spycore:tool fenced blocks (and any still-open partial) from the
  // streamed assistant text — the ⚙ tool lines represent those actions.
  const live = sanitizeForDisplay(stripToolBlocksForDisplay(liveTextRef.current));
  // Running cost indicator (only the dimensions with caps); '' when none set.
  const budgetBar = budget.hasCaps ? formatBudgetBar(budgetSnap ?? budget.snapshot(), budgetCaps) : '';

  return (
    <Box flexDirection="column">
      <Static items={items}>{(item) => <ItemView key={item.id} item={item} width={width} />}</Static>

      {status !== 'done' ? (
        planPrompt ? (
          <PlanView
            plan={planPrompt.plan}
            editing={planEditing}
            width={width}
            onSubmitEdit={(v) => resolvePlan({ action: 'edit', feedback: v.trim() })}
          />
        ) : approval ? (
          <ApprovalView req={approval} width={width} />
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
