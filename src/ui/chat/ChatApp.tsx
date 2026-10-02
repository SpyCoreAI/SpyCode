import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { Select } from '@inkjs/ui';
import { useReducer, useRef, useState, type ReactNode } from 'react';
import { Notice, Spinner, StatusBar, type NoticeVariant } from '../components/index.js';
import { StreamingMarkdown } from '../markdown/index.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { useTheme } from '../theme/theme.js';
import { useContentWidth } from '../lib/useContentWidth.js';
import { ChatInput } from './ChatInput.js';
import { MessageView, type ChatItem } from './MessageView.js';
import { streamAssistant } from './stream.js';
import {
  CHAT_MODELS,
  MODEL_DISPLAY,
  isModelSlug,
  type ModelSlug,
} from '../../lib/models.js';
import {
  EFFORT_LEVELS,
  modelSupportsGraduatedEffort,
  type EffortLevel,
} from '../../lib/effort.js';
import { api } from '../../lib/api.js';
import { getConfigStore } from '../../lib/config.js';
import { SpycoreCliError } from '../../lib/errors.js';
import { buildContextInjection } from '../../lib/memory.js';
import {
  parseSlashInput,
  runSlashCommand,
  type SlashContext,
  type SlashOutcome,
} from '../../lib/slash/registry.js';
import {
  assertWireMessageFits,
  attachmentChip,
  buildTextAttachmentBlocks,
  isVisionModelSlug,
  PendingAttachments,
  uploadImageAttachments,
  visionGateError,
  type LocalAttachment,
} from '../../lib/attachments.js';
import { clampWireAssembly, type WirePart } from '../../lib/wire-clamp.js';
import {
  contextPercent,
  contextWarnText,
  estimateTokensFromChars,
  formatContextSegment,
  nextContextWarnState,
} from '../../lib/context-meter.js';
import { runCompactFlow } from '../../lib/slash/compact-flow.js';
import {
  makeUserCommandResolver,
  slashSuggestions,
  type LoadedUserCommand,
} from '../../lib/slash/user-commands.js';
import { runCommitFlow } from '../../lib/slash/commit-flow.js';
import {
  fireHookEvent,
  hasHooksFor,
  type HookSession,
} from '../../lib/hooks.js';
import {
  DEFAULT_CHAT_MODE,
  modeSwitchBlockedReason,
  nextChatMode,
  type ChatMode,
} from '../../lib/chat-mode.js';
import { runChatAgentTurn } from '../../lib/chat-agent-run.js';
import type { AgentEvent } from '../../lib/agent/loop.js';
import type { ApprovalRequest } from '../../lib/agent/approval.js';
import type { EffectiveCommandRules } from '../../lib/agent/command-rules.js';

export interface ChatAppProps {
  model: ModelSlug;
  /** Initial reasoning effort, already clamped to the model's supported set. */
  effort: EffortLevel;
  conversationId: string;
  apiUrl: string | undefined;
  /** --attach seeds: validated attachments queued for the FIRST message. */
  initialAttachments?: LocalAttachment[] | undefined;
  /** 1.6: user-defined slash commands, loaded once at session start. */
  userCommands?: ReadonlyMap<string, LoadedUserCommand> | undefined;
  /** 1.6: the session's lifecycle hooks (loaded + approval-gated by run.ts). */
  hooks?: HookSession | undefined;
  /** 1.10: command allow/deny rules for agent-mode runs (loaded + trust/
   *  approval-gated by run.ts). Absent ⇒ rule-free approval behavior. */
  commandRules?: EffectiveCommandRules | undefined;
}

type Phase = 'idle' | 'thinking' | 'streaming';
type Mode = 'input' | 'model-select' | 'interact';

/** Distributive Omit so a discriminated-union member keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}
function displayFor(routed: string | null, fallback: ModelSlug): string {
  if (routed) {
    const lc = routed.toLowerCase();
    return isModelSlug(lc) ? MODEL_DISPLAY[lc] : routed;
  }
  return MODEL_DISPLAY[fallback];
}
function errMessage(err: unknown): string {
  if (err instanceof SpycoreCliError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function ChatApp({ model: initialModel, effort: initialEffort, conversationId: initialConvo, apiUrl, initialAttachments, userCommands, hooks, commandRules }: ChatAppProps): ReactNode {
  const { exit } = useApp();
  const { write } = useStdout();
  const { colors, symbols } = useTheme();
  const contentWidth = useContentWidth();

  const nextId = useRef(1);
  const [items, setItems] = useState<ChatItem[]>(() => {
    // Seed the transcript with the banner + one chip per --attach file so the
    // user sees what is queued for their first message.
    const seeded: ChatItem[] = [{ kind: 'banner', id: 0 }];
    for (const att of initialAttachments ?? []) {
      seeded.push({
        kind: 'notice',
        id: nextId.current++,
        variant: 'info',
        text: `Attached ${sanitizeForDisplay(attachmentChip(att))} — applies to your next message.`,
      });
    }
    return seeded;
  });
  const [staticKey, setStaticKey] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<Mode>('input');
  const [model, setModel] = useState<ModelSlug>(initialModel);
  const [effort, setEffort] = useState<EffortLevel>(initialEffort);
  // 1.7 session mode: per-session only, ALWAYS starts at ask (the unmarked
  // default — no config key, so an unswitched session is byte-identical).
  const [chatMode, setChatMode] = useState<ChatMode>(DEFAULT_CHAT_MODE);
  const [conversationId, setConversationId] = useState<string>(initialConvo);
  const [title, setTitle] = useState<string>('');
  const [usage, setUsage] = useState<{ input: number; output: number } | null>(null);
  // 1.8 context meter: tokens the model last read (exact from the server's
  // usage event) or the chars/4 estimate before the first reply; null → the
  // segment is hidden and the status bar renders byte-identically.
  const [meterTokens, setMeterTokens] = useState<number | null>(null);
  const [search, setSearch] = useState<'idle' | 'started' | 'completed' | 'failed'>('idle');
  const [searchCount, setSearchCount] = useState(0);

  // Refs read synchronously by the input handler / stream callbacks.
  const phaseRef = useRef<Phase>('idle');
  const modeRef = useRef<Mode>('input');
  const modelRef = useRef<ModelSlug>(initialModel);
  const effortRef = useRef<EffortLevel>(initialEffort);
  const chatModeRef = useRef<ChatMode>(DEFAULT_CHAT_MODE);
  const convoRef = useRef<string>(initialConvo);
  const abortRef = useRef<AbortController | null>(null);
  const contentRef = useRef('');
  const skillsRef = useRef<string[]>([]);
  const routedRef = useRef<string | null>(null);
  const inputRef = useRef<{ value: string; cursor: number }>({ value: '', cursor: 0 });
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(-1);
  // Attachments queued for the NEXT message (/attach + --attach seeds).
  // Consumed exactly once — cleared only after a successful upload + send
  // handoff, so an upload failure never silently drops them.
  const pendingAttachmentsRef = useRef<PendingAttachments>(
    new PendingAttachments(initialAttachments),
  );
  // 1.6 interact primitive: ONE pending question at a time; the standard
  // input buffer collects the answer and Enter resolves the promise. This is
  // the minimal multi-step primitive multi-turn flows (/commit) run on.
  const interactRef = useRef<{
    question: string;
    kind: 'choice' | 'text';
    resolve: (answer: string) => void;
  } | null>(null);
  // A multi-step flow is active — the normal submit path is paused.
  const flowActiveRef = useRef(false);
  // 1.8 meter internals: cumulative chars sent this conversation (the chars/4
  // heuristic base), the last exact usage.input (null until the first reply),
  // and the warn-once/hysteresis arm state. All reset on /new.
  const sentCharsRef = useRef(0);
  const lastUsageInputRef = useRef<number | null>(null);
  const warnArmedRef = useRef(true);
  const [, forceRender] = useReducer((x: number) => x + 1, 0);

  // Project context (SPYCODE.md memory + the generated CODEBASE_GUIDE.md + the
  // latest CODEBASE_CHANGELOG.md entries) loaded from disk. Injected once at the
  // head of each conversation (after the server identity prompt, never overriding
  // it), and re-read from disk on /new, /init and /remember so an edit takes
  // effect without restarting the session — which is also how it survives a
  // context reset (re-read at the conversation boundary, never the transcript).
  // `injectedConvoRef` tracks which conversation already received the block, so
  // it is sent exactly once per conversation.
  const buildContext = (): ReturnType<typeof buildContextInjection> => {
    const cfg = getConfigStore();
    return buildContextInjection({
      cwd: process.cwd(),
      injectGuide: cfg.get('injectGuide') !== false,
      injectChangelog: cfg.get('injectChangelog') !== false,
    });
  };
  const contextRef = useRef<ReturnType<typeof buildContextInjection> | null>(null);
  if (contextRef.current === null) contextRef.current = buildContext();
  const injectedConvoRef = useRef<string | null>(null);

  // Mirror selectable state into refs for the input handler.
  modeRef.current = mode;
  modelRef.current = model;
  effortRef.current = effort;
  chatModeRef.current = chatMode;
  convoRef.current = conversationId;

  const pushItem = (item: DistributiveOmit<ChatItem, 'id'>): void => {
    setItems((prev) => [...prev, { ...item, id: nextId.current++ } as ChatItem]);
  };
  const pushNotice = (variant: NoticeVariant, text: string): void => {
    pushItem({ kind: 'notice', variant, text });
  };
  const pushError = (err: unknown): void => {
    const hint = err instanceof SpycoreCliError ? err.hint : undefined;
    pushItem({ kind: 'error', message: errMessage(err), hint });
  };

  // 1.8: set the meter and fire the 80%-once warning (re-arms below 70% via
  // the hysteresis helper, or on conversation change via the /new reset).
  const updateMeter = (tokens: number): void => {
    setMeterTokens(tokens);
    const pct = contextPercent(tokens, modelRef.current);
    if (pct === null) return;
    const next = nextContextWarnState(warnArmedRef.current, pct);
    warnArmedRef.current = next.armed;
    if (next.warn) pushNotice('warning', contextWarnText(pct));
  };

  const send = async (message: string, echoText?: string): Promise<void> => {
    // ── 1.6: prompt-submit hook. Blocking-only: exit 2 keeps the message in
    // the input (nothing sent, nothing consumed); other failures warn and
    // continue. Skipped entirely when no such hook is configured.
    if (hooks && hasHooksFor(hooks, 'prompt-submit')) {
      const gate = await fireHookEvent(hooks, 'prompt-submit', { prompt: message });
      for (const n of gate.notices) pushNotice('warning', n);
      if (gate.blocked) {
        inputRef.current = { value: message, cursor: message.length };
        forceRender();
        return;
      }
    }
    // Snapshot the pending attachments; they are consumed only after the
    // uploads succeed — a failure keeps them queued and restores the input,
    // so nothing is ever silently dropped.
    const attachmentsAtSend = pendingAttachmentsRef.current.snapshot();
    const textAttachments = attachmentsAtSend.filter((a) => a.kind === 'text');
    const imageAttachments = attachmentsAtSend.filter((a) => a.kind === 'image');

    // Assemble the wire message — the once-per-conversation project-context
    // prefix, the user's text, and the inlined text-file blocks — through the
    // single 1.8 clamp: the result NEVER exceeds the server's 32,000-char cap
    // and any cut is explicit (in-band marker + a warning notice; priority
    // user text > attached files > project context). An oversized context
    // block can no longer brick the send. The injected flag is only committed
    // after every pre-flight check passes.
    const ctx = contextRef.current;
    const needsInjection =
      !!ctx && ctx.block.length > 0 && injectedConvoRef.current !== convoRef.current;
    const wireParts: WirePart[] = [];
    if (needsInjection) {
      wireParts.push({
        body: ctx!.block,
        post: '\n\n',
        kind: 'injection',
        label: 'project context',
      });
    }
    wireParts.push({ body: message, kind: 'user', label: 'message' });
    const blocks = buildTextAttachmentBlocks(textAttachments);
    if (blocks.length > 0) {
      wireParts.push({
        pre: '\n\n[Attached files]\n',
        body: blocks,
        kind: 'attachments',
        label: 'attached files',
      });
    }
    const assembly = clampWireAssembly(wireParts);
    const wireMessage = assembly.wire;
    if (assembly.warning) pushNotice('warning', assembly.warning);
    try {
      // Never throws now that the assembly is clamped — kept as the hard
      // client invariant's defense in depth.
      assertWireMessageFits(wireMessage, textAttachments.length);
    } catch (err) {
      pushError(err);
      inputRef.current = { value: message, cursor: message.length };
      forceRender();
      return;
    }

    contentRef.current = '';
    skillsRef.current = [];
    routedRef.current = null;
    setSearch('idle');
    setSearchCount(0);
    phaseRef.current = 'thinking';
    setPhase('thinking');
    forceRender();

    const controller = new AbortController();
    abortRef.current = controller;
    const modelAtSend = modelRef.current;

    // Upload images through the existing files-upload plumbing (multipart,
    // CHAT_IMAGE); the FILE IDs ride the stream's `attachments` field. A
    // failed upload surfaces its clean error, restores the typed message and
    // keeps the queue intact.
    let attachmentIds: string[] = [];
    if (imageAttachments.length > 0) {
      try {
        attachmentIds = await uploadImageAttachments(imageAttachments, {
          apiUrlOverride: apiUrl,
          signal: controller.signal,
        });
      } catch (err) {
        pushError(err);
        inputRef.current = { value: message, cursor: message.length };
        abortRef.current = null;
        phaseRef.current = 'idle';
        setPhase('idle');
        forceRender();
        return;
      }
    }
    // All pre-flight work done — consume the queue and commit the context
    // injection for this conversation.
    pendingAttachmentsRef.current.consume();
    if (needsInjection) injectedConvoRef.current = convoRef.current;
    // 1.8 meter: before the first reply the chars/4 heuristic over what was
    // sent is the only signal; after that the exact usage event wins.
    sentCharsRef.current += wireMessage.length;
    if (lastUsageInputRef.current === null) {
      updateMeter(estimateTokensFromChars(sentCharsRef.current));
    }

    pushItem({ kind: 'user', text: echoText ?? message });
    try {
      await streamAssistant(
        { conversationId: convoRef.current, message: wireMessage, model: modelAtSend, effort: effortRef.current, apiUrl, signal: controller.signal, attachments: attachmentIds },
        {
          onText: (c) => {
            contentRef.current += c;
            if (phaseRef.current !== 'streaming') {
              phaseRef.current = 'streaming';
              setPhase('streaming');
            }
            forceRender();
          },
          onThinking: () => {},
          onSkills: (s) => {
            skillsRef.current = s;
            forceRender();
          },
          onSearch: (state, count) => {
            setSearch(state);
            if (typeof count === 'number') setSearchCount(count);
          },
          onRouted: (m) => {
            routedRef.current = m;
            forceRender();
          },
          onAutoSwitch: (from, to, reason) => {
            pushNotice('warning', `Switched ${from} → ${to}${reason ? `: ${reason}` : ''}`);
          },
          onMemory: () => {},
          onUsage: (input, output) => {
            setUsage({ input, output });
            // 1.8 meter: last-turn input ≈ the full assembled context the
            // model just read — the exact source once a reply exists.
            lastUsageInputRef.current = input;
            updateMeter(input);
          },
          onTitle: (t) => {
            // ⭐ Sanitized at the STATE boundary, not at the render site: the
            // title is server-authored (an SSE `title` event) and lands in the
            // PERSISTENT status bar, so it is re-emitted on every frame rather
            // than printed once. Cleaning it here means every consumer of
            // `title` is covered, including any added later (SPY-226).
            if (t) setTitle(sanitizeForDisplay(t));
          },
          onFinishReason: (reason) => {
            if (reason === 'length') pushNotice('warning', 'Response truncated (max tokens hit).');
          },
        },
      );
      pushItem({
        kind: 'assistant',
        content: contentRef.current,
        model: displayFor(routedRef.current, modelAtSend),
        skills: [...skillsRef.current],
      });
    } catch (err) {
      if (controller.signal.aborted) {
        if (contentRef.current.trim().length > 0) {
          pushItem({
            kind: 'assistant',
            content: contentRef.current,
            model: displayFor(routedRef.current, modelAtSend),
            skills: [...skillsRef.current],
            interrupted: true,
          });
        }
        pushNotice('warning', 'Interrupted.');
      } else {
        pushError(err);
      }
    } finally {
      abortRef.current = null;
      contentRef.current = '';
      skillsRef.current = [];
      routedRef.current = null;
      setSearch('idle');
      phaseRef.current = 'idle';
      setPhase('idle');
      forceRender();
    }
  };

  const doClear = (): void => {
    setItems([{ kind: 'banner', id: nextId.current++ }]);
    setStaticKey((k) => k + 1);
    write('[2J[3J[H');
  };

  // Render-agnostic inputs the shared slash core needs, snapshotted from the
  // live refs/config at dispatch time.
  const buildSlashContext = (): SlashContext => {
    const cfg = getConfigStore();
    return {
      cwd: process.cwd(),
      model: modelRef.current,
      effort: effortRef.current,
      conversationId: convoRef.current,
      apiUrl,
      injectGuide: cfg.get('injectGuide') !== false,
      injectChangelog: cfg.get('injectChangelog') !== false,
      // 1.6: user-defined commands resolve ONLY after every built-in case.
      resolveUserCommand: userCommands ? makeUserCommandResolver(userCommands) : undefined,
      // 1.7: /mode with no argument reports the session's current mode.
      chatMode: chatModeRef.current,
    };
  };

  // ── 1.7 session modes ───────────────────────────────────────────────────
  // A switch is REJECTED while anything is running (never queued); an
  // in-flight run's registry could not change anyway — runAgent composes it
  // once at start. Both /mode and Shift+Tab go through this one gate.
  const MODE_BLURB: Record<ChatMode, string> = {
    ask: 'plain conversation — no tools, nothing on disk is touched.',
    plan: 'read-only exploration; a plan is produced for your approval.',
    agent: 'full agent loop; every write and command still asks for approval.',
  };
  const applyModeSwitch = (next: ChatMode): void => {
    const blocked = modeSwitchBlockedReason(
      phaseRef.current !== 'idle' || flowActiveRef.current,
    );
    if (blocked) {
      pushNotice('warning', blocked);
      return;
    }
    if (next === chatModeRef.current) {
      pushNotice('info', `Mode: ${next} — ${MODE_BLURB[next]}`);
      return;
    }
    chatModeRef.current = next;
    setChatMode(next);
    pushNotice('success', `Mode: ${next} — ${MODE_BLURB[next]}`);
  };

  /** Compact, sanitized rendering of loop events for the chat transcript. */
  const renderAgentEvent = (e: AgentEvent): void => {
    switch (e.type) {
      case 'tool_call':
        pushNotice('info', `⚙ ${e.tool}${e.arg ? ` ${sanitizeForDisplay(e.arg)}` : ''}`);
        break;
      case 'tool_result':
        pushNotice(
          e.ok ? 'info' : 'warning',
          `${e.ok ? '✓' : '✗'} ${e.tool}: ${sanitizeForDisplay(e.summary)}`,
        );
        break;
      case 'narration': {
        const text = sanitizeForDisplay(e.text).trim();
        if (text) pushNotice('info', text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text);
        break;
      }
      case 'final':
        if (e.text.trim().length > 0) {
          pushItem({
            kind: 'assistant',
            content: e.text,
            model: displayFor(null, modelRef.current),
            skills: [],
          });
        }
        break;
      case 'parse_error':
        pushNotice('warning', sanitizeForDisplay(e.message));
        break;
      case 'mcp_notice':
      case 'hook_notice':
      case 'rule_notice':
        pushNotice(e.level === 'warn' ? 'warning' : 'info', sanitizeForDisplay(e.text));
        break;
      case 'context_clamped':
        // 1.8: the first-turn assembly was cut to fit the wire cap — surfaced,
        // never silent.
        pushNotice('warning', sanitizeForDisplay(e.text));
        break;
      case 'max_turns':
        pushNotice('warning', `Reached the turn limit (${e.turns}).`);
        break;
      default:
        // assistant_token / tool_call_started / skills / budget events are
        // noise at this surface's granularity.
        break;
    }
  };

  const describeApproval = (req: ApprovalRequest): string => {
    if (req.kind === 'write') {
      return `The agent wants to ${req.isNew ? 'create' : 'edit'} ${sanitizeForDisplay(req.path)} (+${req.added}/-${req.removed}).`;
    }
    if (req.kind === 'command') {
      return `The agent wants to run: ${sanitizeForDisplay(req.command)}`;
    }
    return `The agent wants to call MCP tool ${sanitizeForDisplay(req.fullName)} with ${sanitizeForDisplay(JSON.stringify(req.args)).slice(0, 400)}`;
  };

  // One plan-/agent-mode turn, hosted entirely on the EXISTING runAgent path
  // (lib/chat-agent-run.ts). The interact primitive supplies plan decisions
  // and the NORMAL per-action approvals — a mode is never an approval.
  const runModeTurn = async (task: string): Promise<void> => {
    if (flowActiveRef.current) {
      pushNotice('warning', 'An interactive flow is already in progress — finish it first.');
      return;
    }
    flowActiveRef.current = true;
    if (pendingAttachmentsRef.current.snapshot().length > 0) {
      pushNotice('warning', 'Attachments stay queued for your next ask-mode message — this run ignores them.');
    }
    pushItem({ kind: 'user', text: task });
    try {
      const ctx = contextRef.current;
      await runChatAgentTurn({
        cwd: process.cwd(),
        task,
        mode: chatModeRef.current === 'plan' ? 'plan' : 'agent',
        model: modelRef.current,
        apiUrlOverride: apiUrl,
        hooks,
        commandRules,
        projectContext: ctx && ctx.block.length > 0 ? ctx.block : undefined,
        io: {
          notify: (kind, text) => pushNotice(kind, text),
          renderEvent: renderAgentEvent,
          presentPlan: (plan) =>
            pushNotice('info', `Proposed plan:\n${sanitizeForDisplay(plan)}`),
          ask: (q) => promptInteract(q, 'choice'),
          readText: (q) => promptInteract(q, 'text'),
          requestApproval: async (req) => {
            pushNotice('warning', describeApproval(req));
            const answer = (
              await promptInteract('[y]es / [a]ll (rest of run) / [n]o: ', 'choice')
            )
              .trim()
              .toLowerCase();
            if (answer === 'a' || answer === 'all') return 'accept_all';
            if (answer === 'y' || answer === 'yes') return 'accept';
            return 'reject';
          },
        },
      });
    } catch (err) {
      pushError(err);
    } finally {
      flowActiveRef.current = false;
      if (modeRef.current === 'interact') {
        interactRef.current = null;
        modeRef.current = 'input';
        setMode('input');
      }
      forceRender();
    }
  };

  // ── 1.6 interact primitive ────────────────────────────────────────────
  // Ask ONE question; the answer is typed into the standard input and Enter
  // resolves. 'choice' questions cancel to 'c' on Esc; 'text' to ''.
  const promptInteract = (question: string, kind: 'choice' | 'text'): Promise<string> =>
    new Promise((resolve) => {
      interactRef.current = { question, kind, resolve };
      modeRef.current = 'interact';
      setMode('interact');
      forceRender();
    });

  // The /compact flow — the render-agnostic 1.8 core (lib/slash/compact-flow)
  // on the SAME interact primitive as /commit. Gated through the 1.7 helper:
  // an in-place summarize must never race a streaming turn or an active flow.
  const runCompactFlowTui = async (): Promise<void> => {
    const blocked = modeSwitchBlockedReason(
      phaseRef.current !== 'idle' || flowActiveRef.current,
      '/compact',
    );
    if (blocked) {
      pushNotice('warning', blocked);
      return;
    }
    flowActiveRef.current = true;
    try {
      await runCompactFlow({
        conversationId: convoRef.current,
        apiUrlOverride: apiUrl,
        io: {
          notify: (kind, text) => pushNotice(kind, text),
          ask: (q) => promptInteract(q, 'choice'),
        },
      });
    } catch (err) {
      pushError(err);
    } finally {
      flowActiveRef.current = false;
      if (modeRef.current === 'interact') {
        interactRef.current = null;
        modeRef.current = 'input';
        setMode('input');
      }
      forceRender();
    }
  };

  // The /commit flow: the SAME core `spycore commit` uses (lib/git.ts +
  // git-generate.ts via runCommitFlow) — this is only the IO wiring.
  const runCommitFlowTui = async (): Promise<void> => {
    if (flowActiveRef.current) return;
    flowActiveRef.current = true;
    try {
      await runCommitFlow({
        cwd: process.cwd(),
        model: modelRef.current,
        apiUrlOverride: apiUrl,
        io: {
          notify: (kind, text) => pushNotice(kind, text),
          present: (text) => pushNotice('info', `Proposed commit message:\n${text}`),
          ask: (q) => promptInteract(q, 'choice'),
          readText: (q) => promptInteract(q, 'text'),
        },
      });
    } catch (err) {
      pushError(err);
    } finally {
      flowActiveRef.current = false;
      if (modeRef.current === 'interact') {
        interactRef.current = null;
        modeRef.current = 'input';
        setMode('input');
      }
      forceRender();
    }
  };

  // Render a structured SlashOutcome (from the shared core) as Ink message items
  // / notices, and perform the session-state side effects each surface owns
  // (context re-read, conversation creation, screen clear, exit). Behaviour is
  // byte-for-byte what the old inline switch produced.
  const renderOutcome = async (outcome: SlashOutcome): Promise<void> => {
    switch (outcome.kind) {
      case 'help':
        pushItem({ kind: 'help' });
        break;
      case 'model-prompt':
        // /model with no argument opens the interactive picker.
        setMode('model-select');
        break;
      case 'model-changed':
        modelRef.current = outcome.model;
        setModel(outcome.model);
        pushNotice('success', `Model set to ${MODEL_DISPLAY[outcome.model]}`);
        // Clamp the active effort to the new model's supported set so a stale
        // unsupported level is never carried into the next message.
        if (outcome.effortClamped) {
          effortRef.current = outcome.effort;
          setEffort(outcome.effort);
          pushNotice(
            'warning',
            `Effort '${outcome.requestedEffort}' isn't supported by ${MODEL_DISPLAY[outcome.model]}; using '${outcome.effort}'.`,
          );
        }
        break;
      case 'model-unknown':
        pushNotice('warning', outcome.message);
        break;
      case 'effort-info':
        pushItem({
          kind: 'effort',
          model: MODEL_DISPLAY[outcome.model],
          current: outcome.current,
          levels: outcome.levels,
        });
        break;
      case 'effort-changed':
        effortRef.current = outcome.level;
        setEffort(outcome.level);
        if (outcome.clamped) {
          pushNotice(
            'warning',
            `Effort '${outcome.requested}' isn't supported by ${MODEL_DISPLAY[outcome.model]}; using '${outcome.level}'.`,
          );
        } else {
          pushNotice('success', `Effort set to ${outcome.level}.`);
        }
        break;
      case 'effort-unknown':
        pushNotice('warning', `Unknown effort: ${outcome.input}. Try ${EFFORT_LEVELS.join(', ')}`);
        break;
      case 'init':
        for (const r of outcome.results) {
          if (r.error) {
            pushError(new Error(r.error));
            continue;
          }
          if (r.file === 'spycode') {
            pushNotice(
              r.created ? 'success' : 'warning',
              r.created
                ? `Created ${r.path} — review the generated sections; it loads on your next new conversation.`
                : `SPYCODE.md already exists at ${r.path} — left untouched.`,
            );
          } else if (r.file === 'guide') {
            pushNotice(
              r.created ? 'success' : 'warning',
              r.created
                ? `Created ${r.path} — a generated architecture reference; regenerate with /guide refresh.`
                : `CODEBASE_GUIDE.md already exists at ${r.path} — run /guide refresh to regenerate it.`,
            );
          } else {
            pushNotice(
              r.created ? 'success' : 'warning',
              r.created
                ? `Created ${r.path} — SpyCode logs notable changes here (newest first); view with /changelog.`
                : `CODEBASE_CHANGELOG.md already exists at ${r.path} — left untouched.`,
            );
          }
        }
        // New files change what loads — re-read so the next message + /memory
        // reflect them.
        contextRef.current = buildContext();
        break;
      case 'memory':
        pushItem({
          kind: 'memory',
          parts: outcome.injection.parts.map((p) => ({
            label: p.label,
            detail:
              p.status === 'off'
                ? 'disabled'
                : `${p.lines} line${p.lines === 1 ? '' : 's'} · ${p.chars} chars · ${p.kind}${
                    p.status === 'truncated'
                      ? ' · truncated'
                      : p.status === 'dropped'
                        ? ' · dropped (over budget)'
                        : ''
                  }`,
          })),
          totalChars: outcome.injection.totalChars,
          notices: outcome.injection.notices,
        });
        break;
      case 'remember':
        // Re-read from disk and force a re-inject into THIS conversation so the
        // fresh note takes effect on the next message.
        contextRef.current = buildContext();
        injectedConvoRef.current = null;
        pushNotice('success', `${outcome.created ? 'Created' : 'Updated'} ${outcome.path} — active on your next message.`);
        break;
      case 'remember-usage':
        pushNotice('warning', 'Usage: /remember <note>');
        break;
      case 'remember-error':
        pushError(new Error(outcome.message));
        break;
      case 'guide-status':
        pushItem({ kind: 'guide', exists: outcome.exists, path: outcome.path, lines: outcome.lines });
        break;
      case 'guide-refreshed':
        pushNotice(
          'success',
          `Regenerated CODEBASE_GUIDE.md at ${outcome.path}${
            outcome.preservedNotes ? ' — your "## Notes (manual)" section was preserved.' : '.'
          }`,
        );
        break;
      case 'guide-refresh-error':
        pushError(new Error(outcome.message));
        break;
      case 'guide-unknown-sub':
        pushNotice('warning', `Unknown /guide subcommand: ${outcome.sub} — try /guide or /guide refresh`);
        break;
      case 'changelog':
        pushItem({
          kind: 'changelog',
          exists: outcome.exists,
          path: outcome.path,
          lines: outcome.lines,
          entryCount: outcome.entryCount,
          shownEntryCount: outcome.shownEntryCount,
          text: outcome.text,
        });
        break;
      case 'attach':
        // Queue for the NEXT message + compact echo chip (sanitized filename).
        pendingAttachmentsRef.current.add(outcome.attachment);
        pushNotice(
          'info',
          `Attached ${sanitizeForDisplay(attachmentChip(outcome.attachment))} — applies to your next message.`,
        );
        break;
      case 'attach-usage':
        pushNotice('warning', 'Usage: /attach <path>');
        break;
      case 'attach-error':
        pushError(new Error(outcome.message));
        break;
      case 'new-conversation':
        try {
          const next = await api.post<{ id: string }>('/conversations', {
            apiUrlOverride: apiUrl,
            body: { model: modelRef.current.toUpperCase() },
          });
          convoRef.current = next.id;
          setConversationId(next.id);
          setTitle('');
          setUsage(null);
          // 1.8: fresh conversation → fresh meter (hidden) + re-armed warning.
          sentCharsRef.current = 0;
          lastUsageInputRef.current = null;
          setMeterTokens(null);
          warnArmedRef.current = true;
          // Re-read context from disk for the fresh conversation; the differing
          // conversation id makes the next send re-inject it.
          contextRef.current = buildContext();
          pushNotice('success', 'Started a new conversation.');
        } catch (err) {
          pushError(err);
        }
        break;
      case 'save-usage':
        pushNotice('warning', 'Usage: /save <file>');
        break;
      case 'saved':
        pushNotice('success', `Saved to ${outcome.path}`);
        break;
      case 'save-error':
        pushNotice('error', `Save failed: ${outcome.message}`);
        break;
      case 'clear':
        doClear();
        break;
      case 'commit-flow':
        // The interactive commit flow — runs on the interact primitive,
        // wrapping the EXACT 1.5 machinery (no new git-write path).
        void runCommitFlowTui();
        break;
      case 'compact-flow':
        // 1.8: the confirm-gated in-place condense, on the interact primitive.
        void runCompactFlowTui();
        break;
      case 'mode-info':
        pushNotice(
          'info',
          `Mode: ${outcome.mode} — ${MODE_BLURB[outcome.mode]} (available: ${outcome.modes.join(', ')}; Shift+Tab cycles)`,
        );
        break;
      case 'mode-changed':
        applyModeSwitch(outcome.mode);
        break;
      case 'mode-unknown':
        pushNotice('warning', `Unknown mode: ${outcome.input} — try ${outcome.modes.join(', ')}.`);
        break;
      case 'user-command': {
        for (const n of outcome.notices) pushNotice('warning', n);
        // The expanded template is sent as a NORMAL message; the echo is
        // display-sanitized and capped (template bodies can inline files).
        const echo = sanitizeForDisplay(outcome.message);
        void send(
          outcome.message,
          echo.length > 2_000 ? `${echo.slice(0, 2_000)}\n[… echo truncated]` : echo,
        );
        break;
      }
      case 'user-command-error':
        pushNotice('error', outcome.message);
        break;
      case 'exit':
        exit();
        break;
      case 'unknown-command':
        pushNotice('warning', `Unknown command: /${outcome.name} — try /help`);
        break;
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  };

  const handleSlash = async (raw: string): Promise<void> => {
    const { name, args } = parseSlashInput(raw);
    // /model opens the interactive picker (irreducibly UI); the picker's
    // selection is applied through the SAME shared core (see the Select
    // onChange), so the model-change logic stays unified and tested.
    if (name === 'model') {
      setMode('model-select');
      return;
    }
    const outcome = await runSlashCommand(name, args, buildSlashContext());
    await renderOutcome(outcome);
  };

  const submit = (): void => {
    if (flowActiveRef.current) {
      pushNotice('warning', 'Finish the /commit flow first (answer its prompt, or Esc to cancel).');
      return;
    }
    const raw = inputRef.current.value;
    const trimmed = raw.trim();
    // Vision gate BEFORE the input is cleared: queued images + a non-vision
    // model fail here with the actionable error, keeping both the typed
    // message and the attachment queue intact (switch with /model and resend).
    if (
      trimmed.length > 0 &&
      !trimmed.startsWith('/') &&
      chatModeRef.current === 'ask' &&
      pendingAttachmentsRef.current.hasImages() &&
      !isVisionModelSlug(modelRef.current)
    ) {
      pushError(visionGateError(modelRef.current));
      return;
    }
    inputRef.current = { value: '', cursor: 0 };
    histIdxRef.current = -1;
    forceRender();
    if (trimmed.length === 0) return;
    historyRef.current.push(raw);
    if (trimmed.startsWith('/')) {
      void handleSlash(trimmed);
      return;
    }
    // 1.7: plan/agent modes route the prompt through the hosted agent turn;
    // ask (the default) keeps the byte-identical plain chat path.
    if (chatModeRef.current !== 'ask') {
      void runModeTurn(raw.trim());
      return;
    }
    void send(raw);
  };

  const recallHistory = (dir: -1 | 1): void => {
    const h = historyRef.current;
    if (h.length === 0) return;
    let idx = histIdxRef.current;
    if (dir === -1) {
      idx = idx === -1 ? h.length - 1 : Math.max(0, idx - 1);
    } else {
      if (idx === -1) return;
      idx += 1;
      if (idx >= h.length) {
        histIdxRef.current = -1;
        inputRef.current = { value: '', cursor: 0 };
        forceRender();
        return;
      }
    }
    histIdxRef.current = idx;
    const v = h[idx] ?? '';
    inputRef.current = { value: v, cursor: v.length };
    forceRender();
  };

  useInput((inputChar, key) => {
    if (key.ctrl && inputChar === 'c') {
      if (phaseRef.current !== 'idle' && abortRef.current) abortRef.current.abort();
      else exit();
      return;
    }
    if (modeRef.current === 'model-select') {
      if (key.escape) setMode('input');
      return; // the Select owns arrows/enter
    }
    // 1.6 interact mode: the shared editing keys below still fill the input;
    // Enter resolves the pending question, Esc cancels it. The resolver is
    // cleared BEFORE resolving so a re-entrant prompt can re-arm cleanly.
    if (modeRef.current === 'interact') {
      if (key.return) {
        const it = interactRef.current;
        const answer = inputRef.current.value;
        interactRef.current = null;
        inputRef.current = { value: '', cursor: 0 };
        modeRef.current = 'input';
        setMode('input');
        forceRender();
        it?.resolve(answer);
        return;
      }
      if (key.escape) {
        const it = interactRef.current;
        interactRef.current = null;
        inputRef.current = { value: '', cursor: 0 };
        modeRef.current = 'input';
        setMode('input');
        forceRender();
        if (it) it.resolve(it.kind === 'choice' ? 'c' : '');
        return;
      }
      // fall through: character/backspace/arrow editing works as normal
    }
    // 1.7: Shift+Tab (backtab, ESC[Z) cycles ask → plan → agent. Placed
    // before the idle gate so a mid-run attempt gets the "blocked" notice
    // instead of being silently swallowed. /mode is the fallback binding.
    if (key.tab && key.shift) {
      applyModeSwitch(nextChatMode(chatModeRef.current));
      return;
    }
    if (phaseRef.current !== 'idle') return; // ignore typing while streaming
    if (key.return) {
      submit();
      return;
    }
    // 1.6: Tab completes the first slash suggestion while typing a /name.
    if (key.tab) {
      const current = inputRef.current.value;
      if (current.startsWith('/') && modeRef.current === 'input') {
        const matches = slashSuggestions(current, userCommands);
        const first = matches[0];
        if (first) {
          const next = `/${first.name} `;
          inputRef.current = { value: next, cursor: next.length };
          forceRender();
        }
      }
      return;
    }
    if (key.escape) {
      inputRef.current = { value: '', cursor: 0 };
      histIdxRef.current = -1;
      forceRender();
      return;
    }
    if (key.upArrow) {
      recallHistory(-1);
      return;
    }
    if (key.downArrow) {
      recallHistory(1);
      return;
    }
    if (key.leftArrow) {
      const f = inputRef.current;
      inputRef.current = { value: f.value, cursor: Math.max(0, f.cursor - 1) };
      forceRender();
      return;
    }
    if (key.rightArrow) {
      const f = inputRef.current;
      inputRef.current = { value: f.value, cursor: Math.min(f.value.length, f.cursor + 1) };
      forceRender();
      return;
    }
    if (key.backspace || key.delete) {
      const f = inputRef.current;
      if (f.cursor > 0) {
        inputRef.current = {
          value: f.value.slice(0, f.cursor - 1) + f.value.slice(f.cursor),
          cursor: f.cursor - 1,
        };
        forceRender();
      }
      return;
    }
    if (inputChar && !key.ctrl && !key.meta) {
      // Printable input or a paste blob; normalize pasted newlines.
      const text = inputChar.replace(/\r\n?/g, '\n');
      const f = inputRef.current;
      inputRef.current = {
        value: f.value.slice(0, f.cursor) + text + f.value.slice(f.cursor),
        cursor: f.cursor + text.length,
      };
      forceRender();
    }
  });

  const usageStr = usage ? `${fmtTokens(usage.input + usage.output)} tokens` : '0 tokens';
  const streaming = phase !== 'idle';
  // 1.6: prefix-filtered slash suggestions (built-ins + user commands, with
  // descriptions) while the user types a /name. Tab completes the first.
  const suggestions =
    mode === 'input' && !streaming && inputRef.current.value.startsWith('/')
      ? slashSuggestions(inputRef.current.value, userCommands)
      : [];

  return (
    <Box flexDirection="column">
      <Static key={staticKey} items={items}>
        {(item) => <MessageView key={item.id} item={item} width={contentWidth} />}
      </Static>

      {streaming ? (
        <Box flexDirection="column" marginTop={1}>
          {search === 'started' ? <Notice variant="info">Searching the web…</Notice> : null}
          {search === 'completed' ? (
            <Text color={colors.muted}>{`${symbols.success} Found ${searchCount} source${searchCount === 1 ? '' : 's'}`}</Text>
          ) : null}
          {search === 'failed' ? <Notice variant="warning">Search returned no results.</Notice> : null}
          {phase === 'thinking' && contentRef.current.length === 0 ? (
            <Spinner label="Thinking…" />
          ) : (
            <Box flexDirection="column">
              <Text color={colors.muted}>
                {`${symbols.diamond} ${displayFor(routedRef.current, model)}`}
                {skillsRef.current.length > 0 ? `  ${symbols.middot}  skills: ${skillsRef.current.join(', ')}` : ''}
              </Text>
              <StreamingMarkdown content={sanitizeForDisplay(contentRef.current)} streaming width={contentWidth} />
            </Box>
          )}
        </Box>
      ) : null}

      {mode === 'model-select' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={colors.accent} bold>{`${symbols.section} Select a model`}</Text>
          <Select
            options={CHAT_MODELS.map((m) => ({ label: MODEL_DISPLAY[m], value: m }))}
            defaultValue={model}
            onChange={(value) => {
              // Close the picker immediately, then apply the selection through
              // the SAME shared core the one-shot /model uses — so the
              // resolve + effort-clamp logic is the one tested path.
              modeRef.current = 'input';
              setMode('input');
              void (async () => {
                await renderOutcome(await runSlashCommand('model', [value], buildSlashContext()));
              })();
            }}
          />
          <Text color={colors.muted}>{`↑/↓ choose  ${symbols.middot}  Enter select  ${symbols.middot}  Esc cancel`}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {mode === 'interact' && interactRef.current ? (
            <Text color={colors.accent}>
              {sanitizeForDisplay(interactRef.current.question)}
            </Text>
          ) : null}
          <ChatInput
            value={inputRef.current.value}
            cursor={inputRef.current.cursor}
            placeholder={mode === 'interact' ? 'Answer…' : 'Message SpyCode…'}
            disabled={streaming}
          />
          {suggestions.length > 0 ? (
            <Box flexDirection="column">
              {suggestions.map((s) => (
                <Text key={`${s.source}:${s.name}`} color={colors.muted}>
                  {`/${s.name}`.padEnd(14)}
                  {` ${sanitizeForDisplay(s.summary)}`}
                  {s.source !== 'builtin' ? `  (${s.source})` : ''}
                </Text>
              ))}
              <Text color={colors.muted}>{`${symbols.middot} Tab completes the first match`}</Text>
            </Box>
          ) : null}
        </Box>
      )}

      <Box marginTop={1}>
        <StatusBar
          model={MODEL_DISPLAY[model]}
          service="SpyCore"
          effort={modelSupportsGraduatedEffort(model) ? effort : undefined}
          mode={chatMode === 'ask' ? undefined : chatMode}
          usage={usageStr}
          context={formatContextSegment(meterTokens, model)}
          branch={title || 'new chat'}
          width={contentWidth}
        />
      </Box>
    </Box>
  );
}
