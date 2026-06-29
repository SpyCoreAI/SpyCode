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

export interface ChatAppProps {
  model: ModelSlug;
  /** Initial reasoning effort, already clamped to the model's supported set. */
  effort: EffortLevel;
  conversationId: string;
  apiUrl: string | undefined;
}

type Phase = 'idle' | 'thinking' | 'streaming';
type Mode = 'input' | 'model-select';

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

export function ChatApp({ model: initialModel, effort: initialEffort, conversationId: initialConvo, apiUrl }: ChatAppProps): ReactNode {
  const { exit } = useApp();
  const { write } = useStdout();
  const { colors, symbols } = useTheme();
  const contentWidth = useContentWidth();

  const nextId = useRef(1);
  const [items, setItems] = useState<ChatItem[]>([{ kind: 'banner', id: 0 }]);
  const [staticKey, setStaticKey] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [mode, setMode] = useState<Mode>('input');
  const [model, setModel] = useState<ModelSlug>(initialModel);
  const [effort, setEffort] = useState<EffortLevel>(initialEffort);
  const [conversationId, setConversationId] = useState<string>(initialConvo);
  const [title, setTitle] = useState<string>('');
  const [usage, setUsage] = useState<{ input: number; output: number } | null>(null);
  const [search, setSearch] = useState<'idle' | 'started' | 'completed' | 'failed'>('idle');
  const [searchCount, setSearchCount] = useState(0);

  // Refs read synchronously by the input handler / stream callbacks.
  const phaseRef = useRef<Phase>('idle');
  const modeRef = useRef<Mode>('input');
  const modelRef = useRef<ModelSlug>(initialModel);
  const effortRef = useRef<EffortLevel>(initialEffort);
  const convoRef = useRef<string>(initialConvo);
  const abortRef = useRef<AbortController | null>(null);
  const contentRef = useRef('');
  const skillsRef = useRef<string[]>([]);
  const routedRef = useRef<string | null>(null);
  const inputRef = useRef<{ value: string; cursor: number }>({ value: '', cursor: 0 });
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(-1);
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

  const send = async (message: string): Promise<void> => {
    pushItem({ kind: 'user', text: message });
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
    // Inject project context once per conversation. The display shows the user's
    // text (pushed above); only the wire message carries the context prefix.
    let wireMessage = message;
    const ctx = contextRef.current;
    if (ctx && ctx.block.length > 0 && injectedConvoRef.current !== convoRef.current) {
      wireMessage = `${ctx.block}\n\n${message}`;
      injectedConvoRef.current = convoRef.current;
    }
    try {
      await streamAssistant(
        { conversationId: convoRef.current, message: wireMessage, model: modelAtSend, effort: effortRef.current, apiUrl, signal: controller.signal },
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
          onUsage: (input, output) => setUsage({ input, output }),
          onTitle: (t) => {
            if (t) setTitle(t);
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
    };
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
    const raw = inputRef.current.value;
    inputRef.current = { value: '', cursor: 0 };
    histIdxRef.current = -1;
    forceRender();
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    historyRef.current.push(raw);
    if (trimmed.startsWith('/')) {
      void handleSlash(trimmed);
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
    if (phaseRef.current !== 'idle') return; // ignore typing while streaming
    if (key.return) {
      submit();
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
        <ChatInput
          value={inputRef.current.value}
          cursor={inputRef.current.cursor}
          placeholder="Message SpyCode…"
          disabled={streaming}
        />
      )}

      <Box marginTop={1}>
        <StatusBar
          model={MODEL_DISPLAY[model]}
          service="SpyCore"
          effort={modelSupportsGraduatedEffort(model) ? effort : undefined}
          usage={usageStr}
          branch={title || 'new chat'}
          width={contentWidth}
        />
      </Box>
    </Box>
  );
}
