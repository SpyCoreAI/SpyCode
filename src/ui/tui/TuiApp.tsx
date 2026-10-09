/**
 * The interactive SpyCode TUI: bare `spycore` lands here.
 *
 * Three persistent zones - scrolling transcript, composer, status bar - over
 * one Ink tree for the whole session. Each submitted task runs the SAME
 * agent engine (`runAgent`) and the SAME approval controller as
 * `spycore agent`; this file is presentation only: it renders events into
 * transcript items and turns keypresses into engine calls. Commands, flags,
 * the API client, auth and billing are untouched.
 *
 * Key handling lives in ONE useInput (the ChatInput idiom): contexts are
 * checked in priority order - palette, confirm, approval, running, composer -
 * so a keypress can never fall through into two meanings (hard rule #1).
 */
import { Box, Static, Text, useApp, useInput, useStdin } from 'ink';
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { homedir, tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Banner, Notice } from '../components/index.js';
import { StreamingMarkdown, Markdown, parseMarkdown } from '../markdown/index.js';
import { ThemeProvider, resolveTheme, useTheme, type Theme } from '../theme/theme.js';
import type { ThemeMode } from '../theme/tokens.js';
import { MAX_CONTENT_WIDTH, useContentWidth } from '../lib/useContentWidth.js';
import { useTerminalSize } from '../lib/useTerminalSize.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import {
  ApprovalView,
  DiffLineView,
  ItemView,
  clamp,
  errMessage,
  modelLabel,
  GLYPH_TOOL,
  type AgentUiItem,
  type CommandInfo,
  type DistributiveOmit,
} from '../agent/shared.js';
import {
  CONTINUE_HINT,
  DEFAULT_MAX_TURNS,
  runAgent,
  type AgentEvent,
  type AgentModelSlug,
  type RunAgentOptions,
} from '../../lib/agent/loop.js';
import {
  createApprovalController,
  type ApprovalController,
  type ApprovalRequest,
} from '../../lib/agent/approval.js';
import { readAgentWebTools } from '../../lib/agent/run-config.js';
import { SpyCoreProvider } from '../../lib/providers/spycore.js';
import type { Provider } from '../../lib/providers/types.js';
import {
  applyRedo,
  applyRewind,
  branchSession,
  createRunRecorder,
  loadDoneSession,
  loadSession,
  markSessionActive,
  markSessionDone,
  planRedo,
  planRewind,
  reopenRunRecorder,
  type CheckpointSession,
  type RecordedChange,
  type RunRecorder,
} from '../../lib/agent/checkpoint.js';
import { relDisplay } from '../../lib/agent/workspace-delta.js';
import {
  addTodo,
  clearCompletedTodos,
  loadTodos,
  updateTodoStatus,
} from '../../lib/agent/todo.js';
import {
  buildResumeBanner,
  buildResumeContinueMessage,
  currentGitHead,
  detectWorkspaceDrift,
  makeRunStateHook,
  resolveResumeTarget,
} from '../../lib/agent/resume.js';
import {
  routeAgentModel,
  routingLine,
} from '../../lib/agent/router.js';
import { resolveProviderSelection } from '../../lib/providers/byok-config.js';
import {
  getConfigStore,
  getDefaultProviderName,
  getStoredProviders,
} from '../../lib/config.js';
import { isAuthenticated } from '../../lib/auth.js';
import { buildContextInjection } from '../../lib/memory.js';
import { createBudget } from '../../lib/agent/budget.js';
import { fireHookEvent, hasHooksFor, type HookSession } from '../../lib/hooks.js';
import { isModelSlug } from '../../lib/models.js';
import type { DiffLine } from '../../lib/agent/diff.js';
import { createTwoFilesPatch } from 'diff';
import { approvalKeyFor, keyIdForInkEvent, actionForKey, labelForAction, KEYBINDINGS, type KeyContext } from './keybindings.js';
import { getEffectiveKeybindings } from '../../lib/config.js';
import { mergeSessionChanges, TuiSessionSidebar, type SessionFileStat } from './sidebar.js';
import {
  clampComposerState,
  cursorOnFirstLine,
  cursorOnLastLine,
  deleteBackward,
  expandPlaceholders,
  insertNewline,
  insertText,
  isPasteChunk,
  moveCursorWord,
  stepCursor,
  moveCursorLine,
  parseEditorSpec,
  pastePlaceholder,
  PASTE_LINE_THRESHOLD,
  stripPlaceholders,
  type ComposerState,
  updateComposerState,
} from './editing.js';
import {
  clampHitIndex,
  findTranscriptHits,
  itemSearchText,
  matchExcerpt,
  type TranscriptSearchRender,
} from './transcript-search.js';
import {
  buildSummaryPrompt,
  serializeTranscriptForSummary,
  SUMMARY_SYSTEM_PROMPT,
} from './compact.js';
import {
  filterCommands,
  findCommand,
  isRefusedWhileRunning,
  parseTuiInput,
  routeSubmit,
  shiftRunnable,
  type TuiCommand,
} from './commands.js';
import { capShellOutput, echoForTranscript } from './collapse.js';
import { notifyUser, ringBell } from './attention.js';
import { copyToClipboard } from './clipboard.js';
import { runShellCommand } from './shell.js';
import { clearTuiDraft, loadTuiState, saveTuiState } from './state.js';
import { resolveThemeMode, type ThemeSetting } from './theme-detect.js';
import { ThemePicker } from './theme-picker.js';
import { listThemeOptions, resolveThemeSelection, isGalleryThemeId } from '../theme/gallery.js';
import { detectCapabilities } from '../theme/capabilities.js';
import { ActivityIndicator } from './activity.js';
import { TuiComposer } from './composer.js';
import { formatTokenCount, hintsForState, TuiStatusBar, visibleHints } from './statusbar.js';
import { CommandPalette } from './palette.js';
import { HelpPanel } from './help.js';

/** Agent models the TUI may run (mirrors `spycore agent --model`). */
const TUI_AGENT_MODELS = ['charon', 'styx', 'hermes', 'minos'] as const;

const TIPS = [
  'Type a task in plain words - the agent works through it step by step.',
  'Every file change asks first: a accept · A accept all · r reject.',
  'Press Ctrl+P to browse every command. /help fits on one screen.',
  "/undo reverts the last task's FILE changes only - git commits and shell effects stay.",
  'Type ! and a command to run it in your shell, no agent involved.',
  '@mention a file to attach its contents to your task.',
] as const;

const MAX_MENTION_FILES = 5;
const MAX_MENTION_LINES = 200;
const MAX_MENTION_BYTES = 100 * 1024;
const MAX_DIFF_FILES = 12;
const MAX_DIFF_LINES = 200;
const QUIT_ARM_MS = 1500;
const MAX_QUEUE = 5;
/** Transcript cap: oldest items evicted past this (with orphaned peek entries). */
const MAX_TRANSCRIPT_ITEMS = 2000;

export interface TuiAppProps {
  initialTheme: Theme;
  /** Startup terminal-background probe (null when unprobed) - kept in a ref
   * so /theme auto keeps reflecting the terminal after a gallery pick. */
  probedMode: ThemeMode | null;
  loggedIn: boolean;
  apiUrl: string | undefined;
  commandRules?: RunAgentOptions['commandRules'] | undefined;
  hooks?: HookSession | undefined;
}

interface DiffFile {
  path: string;
  op: 'create' | 'modify' | 'delete';
  hunks: DiffLine[];
  truncated: boolean;
  /** Uncapped hunks backing Ctrl+O peek. */
  full: DiffLine[];
}

type TuiItem =
  | AgentUiItem
  | { kind: 'welcome'; id: number; loggedIn: boolean; tip: string }
  | { kind: 'help'; id: number }
  | { kind: 'diff'; id: number; files: DiffFile[]; total: number }
  /** A `/compact` summary replacing the transcript that produced it. */
  | { kind: 'summary'; id: number; text: string; items: number }
  /** Full content of an elided transcript item, opened with Ctrl+O. */
  | { kind: 'peek'; id: number; label: string; full: string };

type TuiItemInput = DistributiveOmit<TuiItem, 'id'>;

interface SessionTotals {
  tasks: number;
  turns: number;
  toolCalls: number;
  changedFiles: number;
  /** Cumulative `budget.snapshot().tokensUsed` across runs (metering). */
  tokens: number;
  startedAt: number;
}

interface LastRun {
  sessionId: string;
  undone: boolean;
  /** true if the last undo was redone (redo available only after undo). */
  redone?: boolean;
}

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function displayCwd(cwd: string): string {
  const home = homedir();
  const rel = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (rel.length <= 40) return rel;
  return `…${rel.slice(-39)}`;
}

/** Turn a unified patch into DiffLine rows (headers dropped, capped). The
 * uncapped `full` list backs Ctrl+O peek - the capped view never hides that
 * more exists (the truncation marker is always rendered). */
function patchToHunks(
  before: string,
  after: string,
  path: string,
): { hunks: DiffLine[]; truncated: boolean; full: DiffLine[] } {
  const patch = createTwoFilesPatch(path, path, before, after, '', '', { context: 3 });
  const full: DiffLine[] = [];
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('Index') || raw.startsWith('===')) continue;
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('@@')) full.push({ kind: 'hunk', text: raw });
    else if (raw.startsWith('+')) full.push({ kind: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) full.push({ kind: 'del', text: raw.slice(1) });
    else full.push({ kind: 'context', text: raw.startsWith(' ') ? raw.slice(1) : raw });
  }
  const truncated = full.length > MAX_DIFF_LINES;
  return { hunks: full.slice(0, MAX_DIFF_LINES), truncated, full };
}

/** Render DiffLines back to unified-diff text (for Ctrl+O peek). */
function diffLinesToText(lines: DiffLine[]): string {
  return lines
    .map((l) =>
      l.kind === 'hunk' ? l.text : l.kind === 'add' ? `+${l.text}` : l.kind === 'del' ? `-${l.text}` : ` ${l.text}`,
    )
    .join('\n');
}

function WelcomeView({ loggedIn, tip }: { loggedIn: boolean; tip: string }): ReactNode {
  const { colors } = useTheme();
  return (
    <Box flexDirection="column" marginTop={1}>
      <Banner tagline="interactive" />
      <Box marginTop={1}>
        <Text color={colors.textDim}>{tip}</Text>
      </Box>
      {!loggedIn ? (
        <Box marginTop={1}>
          <Notice variant="warning">
            Not logged in. Run `spycore login` to authenticate, then restart the TUI.
          </Notice>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={colors.muted}>Type a task, or /help for keys &amp; commands.</Text>
      </Box>
    </Box>
  );
}

function TuiDiffView({ files, total, width }: { files: DiffFile[]; total: number; width: number }): ReactNode {
  const { colors, symbols } = useTheme();
  // T2: Use split-view on wide terminals (>= 120 cols), unified otherwise.
  const useSplit = width >= 120;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={colors.accent} bold>
        {`${symbols.section} Diff - ${total} file${total === 1 ? '' : 's'} changed${useSplit ? ' (split view)' : ''}`}
      </Text>
      {files.map((f) => (
        <Box key={f.path} flexDirection="column" marginTop={1}>
          <Text color={f.op === 'delete' ? colors.error : f.op === 'create' ? colors.success : colors.text}>
            {`${f.op === 'create' ? 'new' : f.op === 'delete' ? 'deleted' : 'modified'} ${sanitizeForDisplay(f.path)}`}
          </Text>
          {useSplit ? (
            <TuiDiffSplitView hunks={f.hunks} width={width} truncated={f.truncated} />
          ) : (
            <Box flexDirection="column" paddingLeft={2}>
              {f.hunks.map((h, i) => (
                <DiffLineView key={i} line={h} width={Math.max(8, width - 2)} />
              ))}
              {f.truncated ? <Text color={colors.muted}>… diff truncated</Text> : null}
            </Box>
          )}
        </Box>
      ))}
      {total > files.length ? (
        <Text color={colors.muted}>{`… and ${total - files.length} more file${total - files.length === 1 ? '' : 's'}`}</Text>
      ) : null}
    </Box>
  );
}

/**
 * T2: Split-view diff for wide terminals. Shows old (left) and new (right)
 * side-by-side. Context lines appear in both columns; added lines only on
 * the right; deleted lines only on the left.
 */
function TuiDiffSplitView({ hunks, width, truncated }: { hunks: DiffLine[]; width: number; truncated: boolean }): ReactNode {
  const { colors } = useTheme();
  const colWidth = Math.floor((width - 3) / 2); // 3 for separator " │ "

  // Pair up the hunks into rows: each row has optional left (old) and right (new).
  interface Row { left: string | null; right: string | null; leftKind: string; rightKind: string }
  const rows: Row[] = [];
  let i = 0;
  while (i < hunks.length) {
    const h = hunks[i]!;
    if (h.kind === 'hunk') {
      // Hunk headers span both columns neutrally.
      rows.push({ left: h.text, right: null, leftKind: 'hunk', rightKind: 'empty' });
      i++;
    } else if (h.kind === 'context') {
      rows.push({ left: h.text, right: h.text, leftKind: 'context', rightKind: 'context' });
      i++;
    } else if (h.kind === 'del') {
      // Collect consecutive deletions, then consecutive additions (a changed block).
      const dels: string[] = [];
      while (i < hunks.length && hunks[i]!.kind === 'del') {
        dels.push(hunks[i]!.text);
        i++;
      }
      const adds: string[] = [];
      while (i < hunks.length && hunks[i]!.kind === 'add') {
        adds.push(hunks[i]!.text);
        i++;
      }
      const maxLen = Math.max(dels.length, adds.length);
      for (let j = 0; j < maxLen; j++) {
        rows.push({
          left: j < dels.length ? dels[j]! : null,
          right: j < adds.length ? adds[j]! : null,
          leftKind: j < dels.length ? 'del' : 'empty',
          rightKind: j < adds.length ? 'add' : 'empty',
        });
      }
    } else {
      // Standalone additions (no preceding deletions).
      rows.push({ left: null, right: h.text, leftKind: 'empty', rightKind: 'add' });
      i++;
    }
  }

  // Sanitize display text (security - prevent ANSI escape injection).
  // Use Array.from for proper wide-char handling.
  const truncate = (s: string, w: number): string => {
    const clean = sanitizeForDisplay(s);
    const chars = Array.from(clean);
    if (chars.length > w) return chars.slice(0, w - 1).join('') + '…';
    return chars.join('').padEnd(w);
  };

  return (
    <Box flexDirection="column" paddingLeft={2}>
      {rows.map((r, idx) => (
        r.leftKind === 'hunk' ? (
          <Box key={idx} flexDirection="row">
            <Text color={colors.accent}>{truncate(r.left ?? '', width - 4)}</Text>
          </Box>
        ) : (
          <Box key={idx} flexDirection="row">
            <Text
              color={r.leftKind === 'del' ? colors.error : colors.muted}
              wrap="truncate"
            >
              {truncate(r.left ?? '', colWidth)}
            </Text>
            <Text color={colors.borderSubtle}> │ </Text>
            <Text
              color={r.rightKind === 'add' ? colors.success : colors.muted}
              wrap="truncate"
            >
              {truncate(r.right ?? '', colWidth)}
            </Text>
          </Box>
        )
      ))}
      {truncated ? <Text color={colors.muted}>… diff truncated</Text> : null}
    </Box>
  );
}

function TuiItemView({
  item,
  width,
  search,
}: {
  item: TuiItem;
  width: number;
  search: TranscriptSearchRender | null;
}): ReactNode {
  const { colors } = useTheme();
  // Transcript search: items whose text matched the query get a marker.
  // (Inline segment highlights live in ItemView for the plain-text kinds;
  // Ink never re-renders flushed <Static> items, so this marker - like the
  // search bar's excerpt - is the highlight that always works.)
  const matchMark =
    search && search.query.trim().length > 0 && search.hitIds.has(item.id) ? (
      <Text color={search.currentId === item.id ? colors.accent : colors.muted}>
        {search.currentId === item.id ? '/ current match' : '/ match'}
      </Text>
    ) : null;
  const withMark = (node: ReactNode): ReactNode =>
    matchMark ? (
      <Box flexDirection="column">
        {matchMark}
        {node}
      </Box>
    ) : (
      node
    );
  switch (item.kind) {
    case 'welcome':
      return withMark(<WelcomeView loggedIn={item.loggedIn} tip={item.tip} />);
    case 'help':
      return withMark(<HelpPanel />);
    case 'diff':
      return withMark(<TuiDiffView files={item.files} total={item.total} width={width} />);
    case 'summary':
      return withMark(
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={colors.borderSubtle} paddingX={1}>
          <Text color={colors.accent} bold>
            {`Context compacted - ${item.items} item${item.items === 1 ? '' : 's'} summarized`}
          </Text>
          <Box marginTop={1}>
            <Markdown tokens={parseMarkdown(item.text)} width={Math.max(8, width - 4)} />
          </Box>
        </Box>,
      );
    case 'peek': {
      // The full content behind an elided transcript item (Ctrl+O). Capped at
      // a sane render budget; the label names the source item.
      const lines = item.full.split('\n');
      const shown = lines.slice(0, 500);
      return withMark(
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={colors.borderSubtle} paddingX={1}>
          <Text color={colors.accent} bold>{`Expanded: ${item.label}`}</Text>
          <Box flexDirection="column" marginTop={1}>
            {shown.map((l, i) => (
              <Text key={i} color={colors.textDim}>
                {clamp(sanitizeForDisplay(l), Math.max(8, width - 4)) || ' '}
              </Text>
            ))}
            {lines.length > shown.length ? (
              <Text color={colors.muted}>{`… ${lines.length - shown.length} more lines (still capped for display)`}</Text>
            ) : null}
          </Box>
        </Box>,
      );
    }
    default:
      return withMark(<ItemView item={item} width={width} search={search} />);
  }
}

export function TuiApp({ initialTheme, probedMode, loggedIn, apiUrl, commandRules, hooks }: TuiAppProps): ReactNode {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { colors, symbols } = useTheme();
  const contentWidth = useContentWidth();
  const { width: termWidth } = useTerminalSize();
  const cwd = process.cwd();

  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [items, setItems] = useState<TuiItem[]>(() => {
    // M1: the palette tip names a rebindable key - resolve its label from
    // the table so the welcome tip never advertises a dead key.
    const { bindings: kbBindings, errors } = getEffectiveKeybindings();
    const kbPaletteLabel = labelForAction(kbBindings, 'composer', 'command palette') ?? 'Ctrl+P';
    const tips = TIPS.map((t) => t.replace('Ctrl+P', kbPaletteLabel));
    const initial: TuiItem[] = [
      {
        kind: 'welcome',
        id: 0,
        loggedIn,
        tip: tips[Math.floor(Date.now() / 86_400_000) % tips.length]!,
      },
    ];
    // M1: surface keybinding resolution errors at startup (not silent).
    // B1: use initial.length for the id to avoid colliding with nextId.
    if (errors.length > 0) {
      initial.push({
        kind: 'notice',
        id: initial.length,
        variant: 'warning',
        text: `Keybinding config has ${errors.length} error(s) - using defaults. ${errors[0]}`,
      });
    }
    return initial;
  });
  const [phase, setPhase] = useState<'idle' | 'running'>('idle');
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  // MCP approval args expand/collapse (the 'e' key in the approval context).
  // Reset with every request so one approval's expansion never leaks into
  // the next.
  const [mcpArgsExpanded, setMcpArgsExpanded] = useState(false);
  const [palette, setPalette] = useState<{ filter: string; selected: number } | null>(null);
  const [confirm, setConfirm] = useState<{ question: string; onYes: () => void } | null>(null);
  // M7: theme picker dialog state. When open, the picker owns the keyboard
  // (like the command palette). `selected` is the highlighted index.
  const [themePicker, setThemePicker] = useState<{ selected: number } | null>(null);
  const [composer, setComposer] = useState(() => {
    const s = loadTuiState();
    const draft = s?.draft ?? '';
    return clampComposerState({ value: draft, cursor: draft.length });
  });
  const [history, setHistory] = useState<string[]>(() => loadTuiState()?.history ?? []);
  const [totals, setTotals] = useState<SessionTotals>({ tasks: 0, turns: 0, toolCalls: 0, changedFiles: 0, tokens: 0, startedAt: Date.now() });
  // Wave 1-F (D-F): session sidebar. Hidden by default so the existing
  // full-width layout is untouched until the user opts in with Ctrl+B.
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Net per-file changes accumulated from each run's checkpoint journal.
  const [sidebarFiles, setSidebarFiles] = useState<SessionFileStat[]>([]);
  // Session title: the first submitted task's text.
  const [sessionTitle, setSessionTitle] = useState('');
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  // Plan mode toggle - when true, the next task runs in plan mode (no file changes).
  const [planMode, setPlanMode] = useState(false);
  // Approval mode - 'ask' (default), 'auto-all' (auto-approve everything).
  // Removed 'auto-read' - it was a no-op (read-only tools never request approval).
  const [approvalMode, setApprovalMode] = useState<'ask' | 'auto-all'>('ask');
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [runStartedAt, setRunStartedAt] = useState(0);
  const [quitArmed, setQuitArmed] = useState(false);
  // Transcript search (Ctrl+F): when non-null the search bar is open and owns
  // the keyboard. `index` is the position in the current hit list (-1 = none).
  const [search, setSearch] = useState<{ query: string; cursor: number; index: number } | null>(null);
  const searchRef = useRef(search);
  /** Ref mirror of the transcript items for the synchronous input handler. */
  const itemsRef = useRef(items);

  // B1: seed nextId after the initial items to avoid duplicate React keys
  // when the startup notice is present.
  const nextId = useRef(items.length);
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const phaseRef = useRef<'idle' | 'running'>('idle');
  const approvalRef = useRef<ApprovalRequest | null>(null);
  const paletteRef = useRef<{ filter: string; selected: number } | null>(null);
  const confirmRef = useRef<{ question: string; onYes: () => void } | null>(null);
  const themePickerRef = useRef<{ selected: number } | null>(null);
  const composerRef = useRef(composer);
  const historyRef = useRef<string[]>([]);
  const histIdxRef = useRef(-1);
  const histDraftRef = useRef('');
  /** Busy-queue: tasks AND shell commands wait here while a run is in flight
   * (BLOCKER #1 fix - a `!` shell can no longer run concurrently with a task). */
  const queueRef = useRef<Array<{ kind: 'task' | 'shell'; text: string }>>([]);
  const abortRef = useRef<AbortController | null>(null);
  const controllerRef = useRef<ApprovalController | null>(null);
  const liveTextRef = useRef('');
  const liveToolRef = useRef<{ tool: string; arg: string } | null>(null);
  // M3: the delegation depth of whatever the live block is currently
  // showing (assistant_token / tool_call_started / tool_call carry it).
  // Reset whenever the live content is cleared or finalized into an item.
  const liveDepthRef = useRef<number>(0);
  const statusRef = useRef<'init' | 'streaming' | 'tool'>('init');
  const ctrlCAtRef = useRef(0);
  const quitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunRef = useRef<LastRun | null>(null);
  const fileListRef = useRef<string[] | null>(null);
  const themeSettingRef = useRef<ThemeSetting>((getConfigStore().get('theme') as ThemeSetting) ?? 'auto');
  // M7: the startup terminal-background probe. Kept in a ref so `/theme
  // auto` keeps reflecting the terminal even after a gallery theme (whose
  // mode would otherwise be reused as the "probe").
  const probedModeRef = useRef<ThemeMode | null>(probedMode);
  /** Full text behind `[Pasted ~N lines #id]` placeholders, keyed by id. */
  const pasteStoreRef = useRef(new Map<number, string>());
  const pasteSeqRef = useRef(0);
  /** Full content behind elided transcript items, keyed by item id (Ctrl+O). */
  const elidedRef = useRef(new Map<number, { label: string; full: string }>());
  /** The current run's budget (for live token readout); null when idle. */
  const liveBudgetRef = useRef<{ snapshot: () => { tokensUsed: number } } | null>(null);
  /** Ref mirror of totals for the synchronous input handler. */
  const totalsRef = useRef(totals);

  // Mirror state into refs for the synchronous input handler.
  approvalRef.current = approval;
  paletteRef.current = palette;
  confirmRef.current = confirm;
  themePickerRef.current = themePicker;
  composerRef.current = composer;
  historyRef.current = history;
  totalsRef.current = totals;
  searchRef.current = search;
  itemsRef.current = items;

  /**
   * Live-test finding (2026-10-05): rapid keystrokes could eat a character.
   * `setComposer(f(composerRef.current))` reads a ref that only syncs on
   * render - two input events landing in the same tick both saw the old
   * value, so the second insert overwrote the first (`!echo hello` ran as
   * `cho hello`). updateComposerState applies the transform and syncs the
   * ref immediately, so back-to-back input events chain on the latest value.
   * All composer mutations must go through here, never the bare ref.
   */
  const updateComposer = (fn: (prev: ComposerState) => ComposerState): void =>
    updateComposerState(composerRef, setComposer, fn);

  const push = (item: TuiItemInput): number => {
    const id = nextId.current++;
    setItems((prev) => {
      const next = [...prev, { ...item, id } as TuiItem];
      // Bound the transcript: drop oldest items past the cap. elidedRef is
      // keyed by item id, so eviction also drops orphaned peek entries.
      if (next.length > MAX_TRANSCRIPT_ITEMS) {
        const dropped = next.length - MAX_TRANSCRIPT_ITEMS;
        const evictedIds = new Set(next.slice(0, dropped).map((it) => it.id));
        for (const key of [...elidedRef.current.keys()]) {
          if (evictedIds.has(Number(key))) elidedRef.current.delete(key);
        }
        return next.slice(dropped);
      }
      return next;
    });
    return id;
  };
  const pushNotice = (variant: 'success' | 'error' | 'warning' | 'info', text: string): void => {
    push({ kind: 'notice', variant, text });
  };

  // Draft persistence (debounced): "drafts are never lost" — and a
  // manually-cleared draft must persist as empty, not resurrect stale text.
  useEffect(() => {
    const t = setTimeout(() => {
      saveTuiState({
          draft: composerRef.current.value,
          updatedAt: new Date().toISOString(),
          history: historyRef.current,
        });
    }, 800);
    return () => clearTimeout(t);
  }, [composer.value]);

  // Background @-mention file index (best-effort; suggestions degrade silently).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { globby } = await import('globby');
        const files = await globby(['**/*'], {
          cwd,
          gitignore: true,
          onlyFiles: true,
          deep: 5,
          ignore: ['**/node_modules/**', '**/.git/**'],
        });
        if (!cancelled) fileListRef.current = (files as string[]).slice(0, 2000).sort();
      } catch {
        /* @-mentions still resolve at submit time; only suggestions degrade */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  /** Resolve @path tokens to file contents (capped). Unknown tokens are left alone. */
  const resolveMentions = (text: string): { text: string; context: string } => {
    const seen = new Set<string>();
    const blocks: string[] = [];
    const re = /(^|\s)@([^\s@][^\s]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null && blocks.length < MAX_MENTION_FILES) {
      const rawPath = m[2]!;
      if (seen.has(rawPath)) continue;
      seen.add(rawPath);
      const abs = resolve(cwd, rawPath);
      // D4: contain mentions under cwd - `@../../etc/passwd` or `@/etc/passwd`
      // must not exfiltrate files outside the project.
      const rel = relative(cwd, abs);
      if (rel.startsWith('..') || isAbsolute(rel)) continue;
      // D4: skip dotfiles (.env, .ssh, etc.) - never auto-attach secrets.
      if (rel.split(sep).some((part) => part.startsWith('.'))) continue;
      try {
        const st = statSync(abs);
        if (!st.isFile() || st.size > MAX_MENTION_BYTES) continue;
        const content = readFileSync(abs, 'utf8');
        const lines = content.split('\n');
        const shown = lines.slice(0, MAX_MENTION_LINES).join('\n');
        blocks.push(
          `--- ${rawPath} ---\n${shown}${lines.length > MAX_MENTION_LINES ? `\n… (${lines.length - MAX_MENTION_LINES} more lines)` : ''}`,
        );
      } catch {
        /* not a readable file - leave the token as typed */
      }
    }
    if (blocks.length === 0) return { text, context: '' };
    return {
      text,
      context: `Context from @-mentioned files:\n\n${blocks.join('\n\n')}`,
    };
  };

  const setPhaseBoth = (p: 'idle' | 'running'): void => {
    phaseRef.current = p;
    setPhase(p);
  };

  const handleAgentEvent = (
    e: AgentEvent,
    stats: { turns: number; toolCalls: number },
  ): void => {
    switch (e.type) {
      case 'assistant_token':
        // D3: sanitize the live stream - a prompt-injected model could stream
        // ANSI/OSC sequences (clipboard write, window retitle, cursor moves)
        // that Ink would pass raw to the terminal.
        liveTextRef.current += sanitizeForDisplay(e.chunk);
        liveDepthRef.current = e.depth ?? 0;
        if (statusRef.current !== 'streaming') statusRef.current = 'streaming';
        forceRender();
        break;
      case 'narration':
        liveTextRef.current = '';
        liveDepthRef.current = 0;
        push({ kind: 'assistant', text: sanitizeForDisplay(e.text), final: false, depth: e.depth });
        break;
      case 'tool_call_started':
        liveTextRef.current = '';
        liveToolRef.current = { tool: sanitizeForDisplay(e.name), arg: '' };
        liveDepthRef.current = e.depth ?? 0;
        statusRef.current = 'tool';
        forceRender();
        break;
      case 'tool_call':
        liveTextRef.current = '';
        liveToolRef.current = { tool: sanitizeForDisplay(e.tool), arg: sanitizeForDisplay(e.arg) };
        liveDepthRef.current = e.depth ?? 0;
        statusRef.current = 'tool';
        stats.toolCalls += 1;
        forceRender();
        break;
      case 'tool_result': {
        const arg = liveToolRef.current?.arg ?? '';
        const depth = e.depth;
        if (e.tool === 'run_command') {
          let info: CommandInfo;
          if (e.kind === 'command') {
            info = { outcome: 'ran', ok: e.ok, statusLabel: sanitizeForDisplay(e.summary), tail: sanitizeForDisplay(e.outputTail ?? '') };
          } else if (e.kind === 'rejected') {
            info = { outcome: 'rejected', ok: false, statusLabel: 'rejected', tail: '' };
          } else {
            info = { outcome: 'blocked', ok: false, statusLabel: sanitizeForDisplay(e.summary), tail: '' };
          }
          push({ kind: 'command', command: sanitizeForDisplay(e.command ?? arg), info, depth });
        } else if (e.kind) {
          push({
            kind: 'tool', tool: e.tool, arg, ok: e.ok, summary: sanitizeForDisplay(e.summary),
            mutation: { outcome: e.kind === 'command' ? 'applied' : e.kind, added: e.added ?? 0, removed: e.removed ?? 0, isNew: e.isNew ?? false },
            depth,
          });
        } else {
          push({ kind: 'tool', tool: e.tool, arg, ok: e.ok, summary: sanitizeForDisplay(e.summary), depth });
        }
        liveToolRef.current = null;
        liveDepthRef.current = 0;
        forceRender();
        break;
      }
      case 'parse_error':
        liveTextRef.current = '';
        liveDepthRef.current = 0;
        pushNotice('warning', 'Model emitted no valid tool call - asking it to retry.');
        break;
      case 'skills':
        push({ kind: 'skills', skills: e.skills.map((sk) => sanitizeForDisplay(sk)), depth: e.depth });
        break;
      case 'mcp_notice':
      case 'hook_notice':
      case 'rule_notice':
      case 'skill_notice':
        pushNotice(e.level === 'warn' ? 'warning' : 'info', sanitizeForDisplay(e.text));
        break;
      case 'context_clamped':
        pushNotice('warning', sanitizeForDisplay(e.text));
        break;
      case 'context_full': {
        // M2: warn that context is full. The TUI does not auto-compact
        // mid-run (/compact is refused while running), so the notice
        // tells the user to run /compact when idle - no false promises.
        const pct = Math.round(e.pct);
        pushNotice(
          'warning',
          `Context is ~${pct}% full - run /compact when idle to summarize older messages.`,
        );
        break;
      }
      case 'final':
        liveTextRef.current = '';
        liveDepthRef.current = 0;
        push({ kind: 'assistant', text: sanitizeForDisplay(e.text), final: true, depth: e.depth });
        forceRender();
        break;
      case 'max_turns':
        pushNotice('warning', `Reached the turn limit (${e.turns}). Stopping.`);
        break;
      case 'tool_call_cap':
        pushNotice(
          'warning',
          `Tool-call cap hit (${e.cap} this turn) - ${e.skipped} call${e.skipped === 1 ? '' : 's'} skipped.`,
        );
        break;
    }
  };

  /** Drain one queued item after the current run settles. The queue holds
   * both tasks and `!` shell commands (BLOCKER #1) - exactly one of them
   * runs at a time, so two run loops can never interleave. Empty `!`
   * submits are skipped, never stalling the drain (N3). */
  const drainQueue = (): void => {
    const next = shiftRunnable(queueRef.current);
    if (next === undefined) return;
    if (next.kind === 'shell') void runShellCmd(next.text);
    else void runTask(next.text);
  };

  const finishRun = (): void => {
    liveTextRef.current = '';
    liveToolRef.current = null;
    liveDepthRef.current = 0;
    statusRef.current = 'init';
    setApproval(null);
    controllerRef.current = null;
    abortRef.current = null;
    liveBudgetRef.current = null;
    setRunStartedAt(0);
    setPhaseBoth('idle');
    ringBell();
    notifyUser('SpyCode run complete', 'Your task has finished.');
    drainQueue();
  };

  /**
   * Resolve the model provider for a run: same resolution as `spycore
   * agent` (provider selection, graceful auth gate, per-task triage).
   * Shared by runTask and runCompact so both see identical routing.
   * Returns null (after notifying) when auth is missing.
   */
  const resolveRunProvider = async (
    triageTask: string,
  ): Promise<{
    provider: RunAgentOptions['provider'];
    model: string;
    routeLine: string;
    providerKind: 'spycore' | 'byok';
  } | null> => {
    const selection = resolveProviderSelection({
      providerFlag: undefined,
      baseUrl: undefined,
      model: undefined,
      apiKeyEnv: undefined,
      env: process.env,
      stored: getStoredProviders(),
      defaultProvider: getDefaultProviderName(),
    });
    // Graceful auth gate: one clear line, never the "run me twice" stumble.
    if (selection.kind === 'spycore' && !(await isAuthenticated())) {
      pushNotice('error', 'Not logged in. Run `spycore login` to authenticate, then restart the TUI.');
      return null;
    }
    // Model: explicit /model override wins; otherwise triage per task.
    if (selection.kind === 'byok') {
      const { createByokProvider } = await import('../../lib/providers/factory.js');
      return {
        provider: await createByokProvider(selection.config),
        model: selection.config.model,
        routeLine: selection.config.routingLine,
        providerKind: 'byok',
      };
    }
    const decision = await routeAgentModel({
      explicitModel: (modelOverride as AgentModelSlug | null) ?? undefined,
      task: triageTask,
      apiUrlOverride: apiUrl,
    });
    return {
      provider: undefined,
      model: decision.model,
      routeLine: routingLine(decision),
      providerKind: 'spycore',
    };
  };

  /** D-F: fold one run's journaled changes into the sidebar's net file list. */
  const mergeSidebarChanges = (changes: readonly RecordedChange[]): void => {
    if (changes.length === 0) return;
    setSidebarFiles((prev) => mergeSessionChanges(prev, changes));
  };

  /** F29: fire once per TUI session - resolve a provider WITHOUT triage
   * (triaging would cost a model call of its own) and generate a short
   * session title with the cheapest model. Fail-soft: the raw first-line
   * fallback set in runTask stays when this fails or returns nothing. */
  const titleRequestedRef = useRef(false);
  const autoSessionTitle = async (taskText: string, fallback: string): Promise<void> => {
    if (titleRequestedRef.current) return;
    titleRequestedRef.current = true;
    try {
      const selection = resolveProviderSelection({
        providerFlag: undefined,
        baseUrl: undefined,
        model: undefined,
        apiKeyEnv: undefined,
        env: process.env,
        stored: getStoredProviders(),
        defaultProvider: getDefaultProviderName(),
      });
      if (selection.kind === 'spycore') {
        if (!(await isAuthenticated())) return;
      }
      const { generateSessionTitle, SESSION_TITLE_MODEL } = await import(
        '../../lib/agent/session-title.js'
      );
      let provider: Provider;
      let model: string;
      if (selection.kind === 'byok') {
        const { createByokProvider } = await import('../../lib/providers/factory.js');
        provider = await createByokProvider(selection.config);
        model = selection.config.model;
      } else {
        provider = new SpyCoreProvider();
        model = SESSION_TITLE_MODEL;
      }
      const title = await generateSessionTitle({
        provider,
        model,
        apiUrlOverride: apiUrl,
        task: taskText,
      });
      // Only replace the fallback - if the user (or a later task) already
      // changed the title, leave it alone.
      if (title) setSessionTitle((t) => (t === fallback ? title : t));
    } catch {
      /* fail-soft: the fallback title remains */
    }
  };

  const runTask = async (raw: string): Promise<void> => {
    const startedAt = Date.now();
    setRunStartedAt(startedAt);
    setPhaseBoth('running');
    // D-F: the first submitted task names the session (sidebar title).
    // F29: raw first line is the instant fallback; a cheap model-generated
    // title replaces it in the background when it resolves (fail-soft).
    const fallbackTitle = raw.trim().split('\n')[0] ?? '';
    setSessionTitle((t) => (t === '' ? fallbackTitle : t));
    void autoSessionTitle(raw, fallbackTitle);
    const abort = new AbortController();
    abortRef.current = abort;
    let recorder: RunRecorder | null = null;
    const stats = { turns: 0, toolCalls: 0 };
    try {
      const rp = await resolveRunProvider(raw);
      if (!rp) return;
      const { provider, model, routeLine, providerKind } = rp;
      // Prompt-submit hook gate (blocking-only); a block keeps the draft.
      if (hooks && hasHooksFor(hooks, 'prompt-submit')) {
        const gate = await fireHookEvent(hooks, 'prompt-submit', { prompt: raw });
        for (const n of gate.notices) pushNotice('warning', n);
        if (gate.blocked) {
          updateComposer(() => clampComposerState({ value: raw, cursor: raw.length }));
          return;
        }
      }
      setActiveModel(model);

      const { context } = resolveMentions(raw);
      const cfg = getConfigStore();
      const injection = buildContextInjection({
        cwd,
        injectGuide: cfg.get('injectGuide') !== false,
        injectChangelog: cfg.get('injectChangelog') !== false,
      });
      const projectContext = injection.block.length > 0 ? injection.block : undefined;
      const taskText = context.length > 0 ? `${raw}\n\n${context}` : raw;

      recorder = createRunRecorder({
        cwd,
        task: raw,
        initial: {
          providerKind,
          model,
          planMode,
          maxTurns: DEFAULT_MAX_TURNS,
          budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} },
          gitHead: currentGitHead(cwd),
        },
      });

      // Plan mode is one-shot - reset after the task starts.
      if (planMode) setPlanMode(false);

      const ctrl = createApprovalController({
        // autoApproveAll only in 'auto-all' mode. 'auto-read' is handled
        // by the tool layer (read-only tools don't request approval).
        autoApproveAll: approvalMode === 'auto-all',
        onRequest: (req) => {
          liveToolRef.current = null;
          setApproval(req);
          setMcpArgsExpanded(false);
          ringBell();
          notifyUser(
            'SpyCode approval needed',
            req.kind === 'command' ? req.command : req.kind === 'mcp' ? `${req.tool} (MCP)` : `${req.tool} ${req.path}`,
          );
          forceRender();
        },
        onSettled: () => {
          setApproval(null);
          setMcpArgsExpanded(false);
          forceRender();
        },
      });
      controllerRef.current = ctrl;

      push({ kind: 'task', task: echoForTranscript(raw), fullTask: raw, routingLine: routeLine });

      const budget = createBudget({}, Date.now);
      // Live token readout for the activity indicator (MAJOR #4).
      liveBudgetRef.current = budget;
      const loadedSkills = new Set<string>();
      const res = await runAgent({
        task: taskText,
        model,
        provider,
        maxTurns: DEFAULT_MAX_TURNS,
        apiUrlOverride: apiUrl,
        signal: abort.signal,
        cwd,
        commandTimeoutMs: 120_000,
        requestApproval: ctrl.request,
        recordChange: (c) => recorder?.recordChange(c),
        recordChanges: (cs) => recorder?.recordChanges(cs),
        budget,
        loadedSkills,
        toolProtocol: 'auto',
        planMode,
        // Shared resolver - the same knob `spycore agent` resolves.
        webTools: readAgentWebTools(),
        observeWorkspace: false,
        projectContext,
        onEvent: (e) => handleAgentEvent(e, stats),
        onRunState: makeRunStateHook({ recorder, budget, cwd, loadedSkills }),
        commandRules,
      });

      stats.turns = res.turns;
      // Session metering (MAJOR #4): accumulate this run's token usage.
      // Tokens only - no dollar cost and no context-% exist anywhere to show.
      const tokensUsed = budget.snapshot().tokensUsed;
      setTotals((t) => ({
        tasks: t.tasks + 1,
        turns: t.turns + res.turns,
        toolCalls: t.toolCalls + res.toolCalls,
        changedFiles: t.changedFiles + res.changedFiles,
        tokens: t.tokens + tokensUsed,
        startedAt: t.startedAt,
      }));
      recorder.finalize(res.cancelled ? 'interrupted' : 'completed');
      const session = loadSession(cwd, recorder.id);
      mergeSidebarChanges(session?.changes ?? []);
      lastRunRef.current = session ? { sessionId: session.id, undone: false } : null;

      if (res.cancelled) {
        pushNotice('warning', 'Interrupted.');
      } else if (res.changedFiles > 0) {
        pushNotice(
          'info',
          `${res.changedFiles} file${res.changedFiles === 1 ? '' : 's'} changed - /diff to review, /undo to revert.`,
        );
      }
    } catch (err) {
      pushNotice('error', sanitizeForDisplay(errMessage(err)));
      recorder?.abandon();
    } finally {
      finishRun();
    }
  };

  const runShellCmd = async (command: string): Promise<void> => {
    if (command.length === 0) {
      pushNotice('warning', 'Empty command - type !<command> to run it.');
      return;
    }
    setPhaseBoth('running');
    // D1/D2: wire abort so Ctrl+C/Esc actually interrupt shell commands.
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await runShellCommand(command, cwd, 120_000, ctrl.signal);
      abortRef.current = null;
      const capped = capShellOutput(res.output);
      const id = push({
        kind: 'command',
        command: sanitizeForDisplay(command),
        info: {
          outcome: 'ran',
          ok: res.ok,
          statusLabel: res.statusLabel,
          tail: sanitizeForDisplay(capped.text),
        },
      });
      // Ctrl+O peek (MAJOR #3): keep the full output behind the capped tail.
      // Bound the registry entry so a runaway command can't bloat memory.
      if (capped.truncated) {
        const fullLines = res.output.split('\n').slice(0, 2000);
        elidedRef.current.set(id, { label: `$ ${command}`, full: fullLines.join('\n') });
        // N1: cap the peek registry (oldest evicted) - unbounded growth in
        // shell-heavy sessions would leak memory.
        if (elidedRef.current.size > 50) {
          const oldest = elidedRef.current.keys().next();
          if (!oldest.done) elidedRef.current.delete(oldest.value);
        }
      }
    } finally {
      abortRef.current = null;
      setPhaseBoth('idle');
      ringBell();
      notifyUser('SpyCode shell complete', `$ ${command.slice(0, 80)}`);
      drainQueue();
    }
  };

  /**
   * Ctrl+O: the universal peek gesture (MAJOR #3). Expands the most recent
   * elided transcript item (capped shell output, truncated diff) into a
   * full-content block. One learned gesture, every elided context.
   */
  const expandElided = (): void => {
    if (elidedRef.current.size === 0) {
      pushNotice('info', 'Nothing elided to expand - no collapsed output yet.');
      return;
    }
    const latest = Math.max(...elidedRef.current.keys());
    const entry = elidedRef.current.get(latest)!;
    elidedRef.current.delete(latest);
    push({ kind: 'peek', label: entry.label, full: entry.full });
  };

  /**
   * Paste intelligence (MAJOR #2): big pastes collapse to a
   * `[Pasted ~N lines]` placeholder (full text kept in the paste store and
   * expanded on submit); a single-line paste naming a real file attaches as
   * an @-mention instead of flooding the composer.
   */
  const handlePaste = (text: string): void => {
    const lines = text.split('\n');
    if (lines.length === 1) {
      const candidate = lines[0]!.trim();
      if (candidate.length > 0 && candidate.length <= 500 && !candidate.includes('\0')) {
        try {
          const abs = resolve(cwd, candidate);
          // D4: same containment + dotfile policy as @-mentions.
          const rel = relative(cwd, abs);
          if (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).some((p) => p.startsWith('.'))) {
            const st = statSync(abs);
            if (st.isFile() && st.size <= MAX_MENTION_BYTES) {
              updateComposer((prev) => insertText(prev, `@${rel} `));
              return;
            }
          }
        } catch {
          /* not a readable file - fall through to plain insert */
        }
      }
      updateComposer((prev) => insertText(prev, text));
      return;
    }
    if (lines.length >= PASTE_LINE_THRESHOLD) {
      const id = pasteSeqRef.current++;
      pasteStoreRef.current.set(id, text);
      // Bound the store: placeholders from ancient history are droppable.
      if (pasteStoreRef.current.size > 50) {
        const oldest = pasteStoreRef.current.keys().next();
        if (!oldest.done) pasteStoreRef.current.delete(oldest.value);
      }
      updateComposer((prev) => insertText(prev, pastePlaceholder(lines.length, id)));
      return;
    }
    // A 2-line paste fits the multiline composer: insert verbatim.
    updateComposer((prev) => insertText(prev, text));
  };

  /**
   * `/compact`: serialize the transcript, ask the model for a dense summary
   * in a single no-tools turn, and replace the transcript with it
   * (summary-based real summarization, not trimming).
   */
  const runCompact = async (): Promise<void> => {
    const serial = serializeTranscriptForSummary(items);
    if (serial.count < 4) {
      pushNotice('info', 'Transcript is already small - nothing to compact.');
      return;
    }
    setPhaseBoth('running');
    setRunStartedAt(Date.now());
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const rp = await resolveRunProvider('Summarize the session transcript');
      if (!rp) return;
      // The default (spycore) provider is a lib-internal singleton; mirror it
      // here so the summary turn needs no engine changes.
      const provider: Provider = rp.provider ?? new SpyCoreProvider();
      pushNotice('info', 'Compacting transcript - asking the model for a summary…');
      const conversationId = await provider.createConversation({
        model: rp.model,
        apiUrlOverride: apiUrl,
      });
      let summary = '';
      for await (const event of provider.streamChat({
        conversationId,
        message: buildSummaryPrompt(serial.text),
        system: SUMMARY_SYSTEM_PROMPT,
        model: rp.model,
        apiUrlOverride: apiUrl,
        signal: abort.signal,
      })) {
        if (abort.signal.aborted) break;
        if (event.type === 'text') summary += event.text;
        else if (event.type === 'error') throw new Error(event.message);
        // tool_calls can never happen: no tools were offered this turn.
      }
      summary = summary.trim();
      if (summary.length === 0) throw new Error('The model returned an empty summary.');
      const count = serial.count;
      setItems([{ kind: 'summary', id: nextId.current++, text: summary, items: count }]);
      // N1: the old transcript is gone - its peek entries must go with it.
      elidedRef.current.clear();
      pushNotice('success', `Transcript compacted: ${count} items summarized.`);
    } catch (err) {
      if (abort.signal.aborted) pushNotice('warning', 'Compaction interrupted.');
      else pushNotice('error', `Compaction failed: ${sanitizeForDisplay(errMessage(err))}`);
    } finally {
      finishRun();
    }
  };

  /** ---- slash commands ---- */

  const showDiff = (): void => {
    const last = lastRunRef.current;
    if (!last) {
      pushNotice('info', 'No task has run yet - nothing to diff.');
      return;
    }
    const session = loadSession(cwd, last.sessionId);
    if (!session || session.changes.length === 0) {
      pushNotice('info', 'The last task made no file changes.');
      return;
    }
    const files: DiffFile[] = session.changes.slice(0, MAX_DIFF_FILES).map((c) => {
      const { hunks, truncated, full } = patchToHunks(c.before ?? '', c.after, relative(cwd, c.path));
      return { path: relative(cwd, c.path), op: c.op, hunks, truncated, full };
    });
    const id = push({ kind: 'diff', files, total: session.changes.length });
    // Ctrl+O peek (MAJOR #3): truncated diffs keep their full hunks.
    const truncatedFiles = files.filter((f) => f.truncated);
    if (truncatedFiles.length > 0) {
      const full = truncatedFiles
        .map((f) => `--- ${f.path} ---\n${diffLinesToText(f.full)}`)
        .join('\n');
      elidedRef.current.set(id, { label: `/diff (${truncatedFiles.length} truncated file(s))`, full });
      // N1: cap the peek registry (oldest evicted), same as shell output above.
      if (elidedRef.current.size > 50) {
        const oldest = elidedRef.current.keys().next();
        if (!oldest.done) elidedRef.current.delete(oldest.value);
      }
    }
  };

  const undoLast = (): void => {
    const last = lastRunRef.current;
    if (!last) {
      pushNotice('info', 'Nothing to undo yet.');
      return;
    }
    if (last.undone) {
      pushNotice('info', 'The last task was already undone.');
      return;
    }
    const session = loadSession(cwd, last.sessionId);
    if (!session) {
      pushNotice('warning', 'The last session is no longer on disk.');
      return;
    }
    const steps = planRewind(session);
    const actionable = steps.filter((s) => s.action !== 'skip');
    if (actionable.length === 0) {
      pushNotice('info', 'Nothing restorable - the journal is empty or already reverted.');
      return;
    }
    // List the actual files, not just the count - the person pressing "y"
    // should see what they are agreeing to. Capped so a huge session
    // doesn't flood the dialog; paths are sanitized like every other
    // display of journal-recorded names.
    const MAX_UNDO_LIST_FILES = 10;
    const undoList = actionable
      .slice(0, MAX_UNDO_LIST_FILES)
      .map((s) => `  ${sanitizeForDisplay(relDisplay(cwd, s.change.path))}`)
      .join('\n');
    const undoMore =
      actionable.length > MAX_UNDO_LIST_FILES
        ? `\n  … +${actionable.length - MAX_UNDO_LIST_FILES} more`
        : '';
    setConfirm({
      // THE BOUND, STATED WHERE THE USER RELIES ON IT: undo restores file
      // contents only. Anything the run did outside files - git commits,
      // pushes, installed packages, network calls - persists.
      question: `Revert ${actionable.length} file change${actionable.length === 1 ? '' : 's'} from the last task?\n${undoList}${undoMore}\n(file changes only - shell effects stay)`,
      onYes: () => {
        // D8: applyRewind can throw (locked file, permissions, IO) - don't
        // let it crash the input handler.
        try {
          const r = applyRewind(steps, cwd);
          markSessionDone(cwd, session.id);
          last.undone = true;
          // D-F: the sidebar lists this session's net file changes - drop the
          // paths this undo actually reverted so it stops listing them.
          const reverted = new Set(actionable.map((s) => s.change.path));
          setSidebarFiles((prev) => prev.filter((f) => !reverted.has(f.path)));
          // Reset redone flag so a subsequent undo->redo cycle works.
          last.redone = false;
          pushNotice(
            'success',
            `Undone: ${r.restored} restored${r.skipped > 0 ? `, ${r.skipped} skipped` : ''}.`,
          );
        } catch (err) {
          pushNotice(
            'warning',
            `Undo failed: ${err instanceof Error ? err.message : 'unknown error'} - files unchanged.`,
          );
        }
        forceRender();
      },
    });
    forceRender();
  };

  /**
   * Redo the last undone task. Re-applies the `after` content from the
   * session journal, reversing the undo. Only available after /undo.
   * Uses planRedo/applyRedo with the same safety guards as undo (sha check,
   * containment, symlink refusal).
   */
  const redoLast = (): void => {
    const last = lastRunRef.current;
    if (!last) {
      pushNotice('info', 'Nothing to redo yet.');
      return;
    }
    if (!last.undone) {
      pushNotice('info', 'Nothing to redo - the last task was not undone.');
      return;
    }
    if (last.redone) {
      pushNotice('info', 'The last undo was already redone.');
      return;
    }
    // Undo renames the session to .json.done - load from there.
    const session = loadDoneSession(cwd, last.sessionId);
    if (!session) {
      pushNotice('warning', 'The last session is no longer on disk.');
      return;
    }
    const steps = planRedo(session);
    const actionable = steps.filter((s) => s.action !== 'skip');
    if (actionable.length === 0) {
      pushNotice('info', 'Nothing to redo - files were modified since undo.');
      return;
    }
    setConfirm({
      question: `Re-apply ${actionable.length} file change${actionable.length === 1 ? '' : 's'} from the last task?`,
      onYes: () => {
        try {
          const r = applyRedo(steps, cwd);
          // Rename .json.done back to .json so undo-after-redo works.
          markSessionActive(cwd, session.id);
          last.redone = true;
          // Allow undo again after redo (toggle) - reset redone on next undo.
          last.undone = false;
          pushNotice(
            'success',
            `Redone: ${r.restored} re-applied${r.skipped > 0 ? `, ${r.skipped} skipped` : ''}.`,
          );
        } catch (err) {
          pushNotice(
            'warning',
            `Redo failed: ${err instanceof Error ? err.message : 'unknown error'} - files unchanged.`,
          );
        }
        forceRender();
      },
    });
    forceRender();
  };

  const startResume = (args: string[]): void => {
    const force = args.includes('--force');
    const ref = args.find((a) => a !== '--force');
    let target;
    try {
      target = resolveResumeTarget(cwd, ref ?? true);
    } catch (err) {
      pushNotice('error', errMessage(err));
      return;
    }
    const { session, state } = target;
    if (state.status === 'completed') {
      pushNotice('info', 'That session already completed - nothing to resume.');
      return;
    }
    if (state.providerKind !== 'spycore') {
      pushNotice('warning', 'Only SpyCore sessions can be resumed in the TUI.');
      return;
    }
    const drift = detectWorkspaceDrift(target);
    const begin = (): void => {
      void (async () => {
        setPhaseBoth('running');
        const startedAt = Date.now();
        setRunStartedAt(startedAt);
        const abort = new AbortController();
        abortRef.current = abort;
        try {
          for (const line of buildResumeBanner({
            target,
            drift,
            modelLabel: modelLabel(state.model),
            modelFromFlag: false,
            webTools: readAgentWebTools(),
            observeWorkspace: false,
            budget: state.budget,
          })) {
            pushNotice('info', line);
          }
          const recorder = reopenRunRecorder(session);
          if (!recorder) {
            pushNotice('error', 'Could not reopen the session journal.');
            return;
          }
          const ctrl = createApprovalController({
            // Respect the user's approval mode on resume (was hardcoded false).
            autoApproveAll: approvalMode === 'auto-all',
            onRequest: (req) => {
              liveToolRef.current = null;
              setApproval(req);
              setMcpArgsExpanded(false);
              ringBell();
              forceRender();
            },
            onSettled: () => {
              setApproval(null);
              setMcpArgsExpanded(false);
              forceRender();
            },
          });
          controllerRef.current = ctrl;
          const budget = createBudget({}, Date.now);
          liveBudgetRef.current = budget;
          const loadedSkills = new Set<string>(state.loadedSkills);
          const continueMessage = buildResumeContinueMessage({
            state,
            driftAccepted: drift !== null,
            protocolHint: state.nativeTools ? '' : CONTINUE_HINT,
          });
          push({ kind: 'task', task: echoForTranscript(session.task), fullTask: session.task, routingLine: `Resuming ${session.id}` });
          const res = await runAgent({
            task: session.task,
            model: state.model,
            maxTurns: state.maxTurns,
            apiUrlOverride: apiUrl,
            signal: abort.signal,
            cwd,
            commandTimeoutMs: 120_000,
            requestApproval: ctrl.request,
            recordChange: (c) => recorder.recordChange(c),
            recordChanges: (cs) => recorder.recordChanges(cs),
            budget,
            loadedSkills,
            toolProtocol: 'auto',
            webTools: readAgentWebTools(),
            observeWorkspace: false,
            conversationId: state.conversationId ?? undefined,
            // Resume path - planMode not stored in session, default to false.
            // Plan mode is for new tasks; resumes continue the original run.
            planMode: false,
            continueMessage,
            onEvent: (e) => handleAgentEvent(e, { turns: 0, toolCalls: 0 }),
            onRunState: makeRunStateHook({ recorder, budget, cwd, loadedSkills }),
            commandRules,
          });
          recorder.finalize(res.cancelled ? 'interrupted' : 'completed');
          const done = loadSession(cwd, recorder.id);
          mergeSidebarChanges(done?.changes ?? []);
          lastRunRef.current = done ? { sessionId: done.id, undone: false } : null;
          const resumedTokens = budget.snapshot().tokensUsed;
          setTotals((t) => ({
            tasks: t.tasks + 1,
            turns: t.turns + res.turns,
            toolCalls: t.toolCalls + res.toolCalls,
            changedFiles: t.changedFiles + res.changedFiles,
            tokens: t.tokens + resumedTokens,
            startedAt: t.startedAt,
          }));
          if (res.cancelled) pushNotice('warning', 'Interrupted.');
        } catch (err) {
          pushNotice('error', sanitizeForDisplay(errMessage(err)));
        } finally {
          finishRun();
        }
      })();
    };
    if (drift && !force) {
      const what: string[] = [];
      if (drift.headMoved) what.push('git HEAD moved');
      if (drift.modifiedFiles.length > 0) what.push(`${drift.modifiedFiles.length} file${drift.modifiedFiles.length === 1 ? '' : 's'} changed outside the run`);
      setConfirm({
        question: `Workspace changed since the interrupt (${what.join(', ')}). Resume anyway?`,
        onYes: begin,
      });
      forceRender();
      return;
    }
    begin();
  };

  // M7: apply a theme option id from the picker. Handles the three built-in
  // settings (auto/light/dark) plus gallery theme ids. Gallery themes apply
  // immediately via resolveThemeSelection (M1 fix: previously stored but
  // never applied).
  const applyThemeOption = (id: string): void => {
    const lower = id.toLowerCase();
    if (lower === 'auto' || lower === 'light' || lower === 'dark') {
      themeSettingRef.current = lower as ThemeSetting;
      getConfigStore().set('theme', lower as ThemeSetting);
      // M2: clear stale gallery selection when switching to a built-in.
      getConfigStore().set('themeGallery', '');
      // M7: 'auto' uses the startup probe, not the current theme's mode
      // (which may be a gallery theme's mode after a picker selection).
      const mode = resolveThemeMode(lower as ThemeSetting, probedModeRef.current);
      setTheme(resolveTheme(detectCapabilities(), mode));
      pushNotice('success', `Theme set to ${lower}.`);
      return;
    }
    // Gallery theme id: apply immediately and persist.
    getConfigStore().set('themeGallery', id);
    const applied = resolveThemeSelection(id, detectCapabilities(), theme.mode);
    setTheme(applied);
    pushNotice('success', `Theme set to ${sanitizeForDisplay(id)}.`);
  };

  /**
   * M7: the single effective theme id for the picker. The persisted gallery
   * selection wins over the builtin setting; '' (the cleared state) falls
   * through via ||. One value drives both the initial cursor index and the
   * "(active)" marker, so they can never disagree. The gallery id is
   * validated like run.ts does, so a stale/hand-edited value degrades to
   * the builtin setting instead of mislabeling the picker.
   */
  const effectiveThemeId = (): string => {
    const g = getConfigStore().get('themeGallery') as string;
    return g && isGalleryThemeId(g) ? g : themeSettingRef.current;
  };

  const runTuiCommand = (name: string, args: string[]): void => {
    /**
     * Shared by /clear and /new: drop the visible transcript and every
     * registry that belongs to it. Stale peek entries and paste
     * placeholders must not survive the wipe.
     */
    const clearTranscript = (): void => {
      setItems([]);
      // N1/N2: registries belong to the old transcript - stale peek
      // entries and paste placeholders must not survive the clear.
      elidedRef.current.clear();
      pasteStoreRef.current.clear();
      // Strip placeholder tokens from the draft so a subsequent submit
      // doesn't send the literal "[Pasted ~N lines #id]" text.
      updateComposer((prev) => {
        const stripped = stripPlaceholders(prev.value);
        return { value: stripped, cursor: Math.min(prev.cursor, stripped.length) };
      });
    };

    const cmd = findCommand(name);
    if (!cmd) {
      pushNotice('warning', `Unknown command: /${sanitizeForDisplay(name)}. /help lists commands.`);
      return;
    }
    switch (name) {
      case 'help':
        push({ kind: 'help' });
        break;
      case 'clear':
        if (isRefusedWhileRunning('clear', phaseRef.current)) {
          pushNotice('warning', 'A task is running - /clear is available when idle.');
          break;
        }
        clearTranscript();
        break;
      case 'new': {
        // A fresh session without quit+relaunch: the transcript is wiped
        // like /clear, and every session-scoped piece of state is reset.
        // Undo/redo history, the sidebar's net changes, the session title,
        // and the usage metering all belonged to the old session. Disk
        // journals and file changes are untouched - /new does not revert
        // anything on disk.
        if (isRefusedWhileRunning('new', phaseRef.current)) {
          pushNotice('warning', 'A task is running - /new is available when idle.');
          break;
        }
        clearTranscript();
        lastRunRef.current = null;
        setSessionTitle('');
        setSidebarFiles([]);
        liveBudgetRef.current = null;
        setTotals({ tasks: 0, turns: 0, toolCalls: 0, changedFiles: 0, tokens: 0, startedAt: Date.now() });
        pushNotice('success', 'New session started - clean slate. Files on disk are unchanged (nothing reverted).');
        break;
      }
      case 'model': {
        const want = (args[0] ?? '').toLowerCase();
        if (!want) {
          pushNotice(
            'info',
            modelOverride
              ? `Model override: ${modelLabel(modelOverride)} (cleared on /model auto)`
              : 'Model: auto (triaged per task). /model <name> to pin one.',
          );
          break;
        }
        if (want === 'auto') {
          setModelOverride(null);
          pushNotice('success', 'Model override cleared - back to per-task triage.');
          break;
        }
        if (!(TUI_AGENT_MODELS as readonly string[]).includes(want) || !isModelSlug(want)) {
          pushNotice('warning', `Unknown model: ${args[0]}. Allowed: ${TUI_AGENT_MODELS.join(', ')}, auto.`);
          break;
        }
        setModelOverride(want);
        pushNotice('success', `Model pinned to ${modelLabel(want)} for this session.`);
        break;
      }
      case 'diff':
        showDiff();
        break;
      case 'undo':
        // N4: refuse while a run is in flight, like /compact and /resume -
        // reverting mid-stream would race the running task.
        if (isRefusedWhileRunning('undo', phaseRef.current)) {
          pushNotice('warning', 'A task is running - /undo is available when idle.');
          break;
        }
        undoLast();
        break;
      case 'redo':
        // refuse while a run is in flight, like /undo.
        if (isRefusedWhileRunning('redo', phaseRef.current)) {
          pushNotice('warning', 'A task is running - /redo is available when idle.');
          break;
        }
        redoLast();
        break;
      case 'todo': {
        // Manage the session todo list.
        const sub = (args[0] ?? '').toLowerCase();
        // Use the current session ID, or a default if no session yet.
        const sessionId = lastRunRef.current?.sessionId ?? 'default';
        if (sub === 'add') {
          const text = args.slice(1).join(' ').trim();
          if (!text) {
            pushNotice('warning', 'Usage: /todo add <text>');
            break;
          }
          const item = addTodo(sessionId, text);
          pushNotice('success', `Added todo: ${item.text} (id: ${item.id.slice(-6)})`);
        } else if (sub === 'done') {
          const idPart = args[1] ?? '';
          if (!idPart) {
            pushNotice('warning', 'Usage: /todo done <id>');
            break;
          }
          const list = loadTodos(sessionId);
          const item = list.todos.find((t) => t.id.endsWith(idPart) || t.id === idPart);
          if (!item) {
            pushNotice('warning', `Todo not found: ${idPart}`);
            break;
          }
          updateTodoStatus(sessionId, item.id, 'completed');
          pushNotice('success', `Completed: ${item.text}`);
        } else if (sub === 'clear') {
          const n = clearCompletedTodos(sessionId);
          pushNotice('info', `Cleared ${n} completed todo${n === 1 ? '' : 's'}.`);
        } else {
          // list (default)
          const list = loadTodos(sessionId);
          if (list.todos.length === 0) {
            pushNotice('info', 'No todos yet. Add one with /todo add <text>');
          } else {
            const lines = list.todos.map((t) => {
              const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○';
              return `${icon} ${t.text} (${t.id.slice(-6)})`;
            });
            pushNotice('info', `Todos:\n${lines.join('\n')}`);
          }
        }
        break;
      }
      case 'plan': {
        // Toggle plan mode for the next task.
        const next = !planMode;
        setPlanMode(next);
        pushNotice(
          'info',
          next
            ? 'Plan mode ON - the next task will propose steps without making file changes.'
            : 'Plan mode OFF - the next task will run normally.',
        );
        break;
      }
      case 'approval': {
        // Set approval mode.
        // Only 'ask' and 'auto-all'. 'auto-read' was removed (no-op).
        const mode = (args[0] ?? '').toLowerCase();
        if (mode === 'ask' || mode === 'auto-all') {
          if (mode === 'auto-all') {
            // Safety: require explicit confirmation for auto-all.
            setConfirm({
              question: 'Enable auto-approve for ALL tools (including writes)? This is dangerous.',
              onYes: () => {
                setApprovalMode('auto-all');
                pushNotice('warning', 'Approval mode: auto-all - ALL tool calls will be auto-approved.');
                forceRender();
              },
            });
          } else {
            setApprovalMode(mode);
            pushNotice('info', `Approval mode: ${mode}`);
          }
        } else {
          pushNotice('info', `Current approval mode: ${approvalMode}. Usage: /approval <ask|auto-all>`);
        }
        break;
      }
      case 'diagnose': {
        // Run TypeScript diagnostics on the workspace.
        // Truly async (execFile, not execSync) - UI remains responsive.
        pushNotice('info', 'Running TypeScript diagnostics...');
        (async () => {
          try {
            const { getTypeScriptDiagnostics, formatDiagnostics } = await import('../../lib/agent/diagnostics.js');
            const result = await getTypeScriptDiagnostics(cwd);
            pushNotice('info', formatDiagnostics(result));
          } catch (err) {
            pushNotice('warning', `Diagnostics failed: ${err instanceof Error ? err.message : 'unknown error'}`);
          }
          forceRender();
        })();
        break;
      }
      case 'branch': {
        // Branch the last session checkpoint.
        const last = lastRunRef.current;
        if (!last) {
          pushNotice('info', 'No session to branch yet.');
          break;
        }
        const newId = branchSession(cwd, last.sessionId);
        if (newId) {
          pushNotice('success', `Branched session ${last.sessionId.slice(-8)} → ${newId.slice(-8)}. Use /resume to continue from the branch.`);
        } else {
          pushNotice('warning', 'Failed to branch the session.');
        }
        break;
      }
      case 'fork': {
        // Explicit fork: branch a given session id (or the last run's) into
        // a new session that references its parent. Same checkpoint
        // branching mechanism as /branch, plus the parent pointer.
        const target = args[0] ?? lastRunRef.current?.sessionId;
        if (!target) {
          pushNotice('info', 'No session to fork yet - run a task first, or pass a session id.');
          break;
        }
        const newId = branchSession(cwd, target);
        if (newId) {
          pushNotice('success', `Forked session ${target.slice(-8)} → ${newId.slice(-8)} (parent ${target.slice(-8)}). Use /resume to continue from the fork.`);
        } else {
          pushNotice('warning', `No session "${target}" for this directory.`);
        }
        break;
      }
      case 'usage': {
        const el = formatElapsed(Date.now() - totals.startedAt);
        const tokens =
          totals.tokens > 0
            ? ` · ↑ ${totals.tokens.toLocaleString('en-US')} tokens`
            : '';
        pushNotice(
          'info',
          `Session: ${totals.tasks} task${totals.tasks === 1 ? '' : 's'} · ${totals.turns} turn${totals.turns === 1 ? '' : 's'}${tokens} · ${totals.toolCalls} tool call${totals.toolCalls === 1 ? '' : 's'} · ${totals.changedFiles} file${totals.changedFiles === 1 ? '' : 's'} changed · ${el}`,
        );
        break;
      }
      case 'compact':
        // Real summarization (MAJOR #4 follow-up): the transcript goes to the
        // model for a dense summary and is replaced by it. Refused while a
        // run is in flight - compacting mid-stream would corrupt the session.
        if (isRefusedWhileRunning('compact', phaseRef.current)) {
          pushNotice('warning', 'A task is running - /compact is available when idle.');
          break;
        }
        void runCompact();
        break;
      case 'resume':
        if (isRefusedWhileRunning('resume', phaseRef.current)) {
          pushNotice('warning', 'A task is running - /resume is available when idle.');
          break;
        }
        startResume(args);
        break;
      case 'theme': {
        const want = (args[0] ?? '').toLowerCase();
        if (!want) {
          // M7: no args opens the visual theme picker dialog.
          const options = listThemeOptions();
          const idx = Math.max(0, options.findIndex((o) => o.id === effectiveThemeId()));
          setThemePicker({ selected: idx });
          break;
        }
        if (want !== 'auto' && want !== 'light' && want !== 'dark' && !isGalleryThemeId(want)) {
          pushNotice('warning', `Unknown theme ${sanitizeForDisplay(want)}. Use /theme to open the visual picker, or one of: auto, light, dark.`);
          break;
        }
        // M7: share applyThemeOption so the builtin path also clears a stale
        // persisted gallery selection (themeGallery) - otherwise the stale
        // id would win on next boot and mislabel the picker.
        applyThemeOption(want);
        break;
      }
      case 'exit':
        if (isRefusedWhileRunning('exit', phaseRef.current)) {
          pushNotice('warning', 'A task is running - /exit is available when idle (Ctrl+C to interrupt first).');
          break;
        }
        saveTuiState({
          draft: composerRef.current.value,
          updatedAt: new Date().toISOString(),
          history: historyRef.current,
        });
        exit();
        break;
      default:
        // M6: defensive - should be unreachable since findCommand() gates
        // entry, but if the registry and switch ever drift, fail loudly
        // instead of silently doing nothing.
        pushNotice('warning', `Command /${sanitizeForDisplay(name)} is registered but has no handler. This is a bug - please report it.`);
        break;
    }
  };

  /** ---- composer plumbing ---- */

  const pushHistory = (value: string): void => {
    if (value.trim().length === 0) return;
    const next = [...historyRef.current.slice(-99), value];
    setHistory(next);
    saveTuiState({ draft: '', updatedAt: new Date().toISOString(), history: next });
    histIdxRef.current = -1;
  };

  const historyBack = (): void => {
    const h = historyRef.current;
    if (h.length === 0) return;
    if (histIdxRef.current === -1) {
      histDraftRef.current = composerRef.current.value;
      histIdxRef.current = h.length - 1;
    } else {
      histIdxRef.current = Math.max(0, histIdxRef.current - 1);
    }
    const v = h[histIdxRef.current]!;
    updateComposer(() => ({ value: v, cursor: v.length }));
  };

  const historyForward = (): void => {
    if (histIdxRef.current === -1) return;
    const h = historyRef.current;
    histIdxRef.current += 1;
    if (histIdxRef.current >= h.length) {
      histIdxRef.current = -1;
      const d = histDraftRef.current;
      updateComposer(() => ({ value: d, cursor: d.length }));
    } else {
      const v = h[histIdxRef.current]!;
      updateComposer(() => ({ value: v, cursor: v.length }));
    }
  };

  const activeMention = (): { prefix: string; start: number } | null => {
    const { value, cursor } = composerRef.current;
    const before = value.slice(0, cursor);
    const m = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!m) return null;
    return { prefix: m[2]!, start: before.length - m[2]!.length };
  };

  const mentionSuggestions = (): string[] => {
    const mention = activeMention();
    const list = fileListRef.current;
    if (!mention || !list) return [];
    const p = mention.prefix.toLowerCase();
    return list.filter((f) => f.toLowerCase().includes(p)).slice(0, 6);
  };

  const slashSuggestions = (): TuiCommand[] => {
    const { value } = composerRef.current;
    if (!value.startsWith('/')) return [];
    return filterCommands(value.slice(1)).slice(0, 6);
  };

  const acceptSuggestion = (): void => {
    const { value, cursor } = composerRef.current;
    if (value.startsWith('/')) {
      const first = filterCommands(value.slice(1))[0];
      if (first) {
        const next = `/${first.name} `;
        updateComposer(() => ({ value: next, cursor: next.length }));
      }
      return;
    }
    const mention = activeMention();
    const sug = mentionSuggestions();
    if (mention && sug.length > 0) {
      const pick = sug[0]!;
      const next = `${value.slice(0, mention.start)}${pick} ${value.slice(cursor)}`;
      updateComposer(() => ({ value: next, cursor: mention.start + pick.length + 1 }));
    }
  };

  const openEditor = (): void => {
    const spec = process.env.EDITOR || process.env.VISUAL || 'vi';
    const [bin, ...binArgs] = parseEditorSpec(spec);
    if (!bin) {
      pushNotice('warning', 'Could not determine an editor to launch (empty EDITOR).');
      return;
    }
    // O_EXCL ('wx') + pid + randomness: no symlink race, no collision.
    const tmp = join(tmpdir(), `spycore-tui-${process.pid}-${randomBytes(6).toString('hex')}.md`);
    try {
      writeFileSync(tmp, composerRef.current.value, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    } catch {
      pushNotice('warning', 'Could not open the editor (temp file unwritable).');
      return;
    }
    // spawnSync outcome flags: a failed launch and a bailed-out editor both
    // keep the pre-editor draft (handled below).
    let launched = false;
    let exitedClean = false;
    try {
      // Hand the terminal to the editor: leave raw mode first.
      (stdin as unknown as { setRawMode?: (mode: boolean) => void }).setRawMode?.(false);
      // spawnSync does NOT throw on a failed launch (missing binary) - it
      // reports via `error`; a bailed-out editor reports via non-zero
      // `status`. Both keep the pre-editor draft instead of silently
      // accepting a stale or partial file.
      const result = spawnSync(bin, [...binArgs, tmp], { stdio: 'inherit' });
      launched = !result.error;
      exitedClean = launched && result.status === 0;
    } catch {
      launched = false;
    } finally {
      (stdin as unknown as { setRawMode?: (mode: boolean) => void }).setRawMode?.(true);
    }
    if (!launched || !exitedClean) {
      try {
        unlinkSync(tmp);
      } catch {
        /* already gone */
      }
      pushNotice(
        'warning',
        launched ? 'Editor exited without saving - draft kept.' : `Could not launch ${spec}.`,
      );
      forceRender();
      return;
    }
    try {
      const text = readFileSync(tmp, 'utf8');
      unlinkSync(tmp);
      // Multiline drafts survive the round-trip now: keep newlines.
      const clean = text.replace(/\r\n?/g, '\n');
      const capped = clampComposerState({ value: clean, cursor: clean.length });
      updateComposer(() => ({ value: capped.value, cursor: capped.value.length }));
    } catch {
      /* keep the pre-editor draft */
    }
    forceRender();
  };

  const copyLastReply = (): void => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === 'assistant' && it.final && it.text.trim().length > 0) {
        if (copyToClipboard(it.text)) pushNotice('success', 'Copied the last reply to the clipboard.');
        else pushNotice('warning', 'Clipboard unavailable (no pbcopy/xclip/xsel found).');
        return;
      }
    }
    pushNotice('info', 'No reply to copy yet.');
  };

  const submitComposer = (): void => {
    const raw = composerRef.current.value;
    if (raw.trim().length === 0) return;
    // Expand collapsed paste placeholders: the agent sees the full pasted
    // text, never the `[Pasted ~N lines]` echo.
    const text = expandPlaceholders(raw, pasteStoreRef.current);
    const parsed = parseTuiInput(text);
    // BLOCKER #1: the routing decision is pure (routeSubmit, pinned by
    // tests). While a run is in flight NOTHING executes inline - shell
    // commands queue exactly like tasks, so two run loops can never
    // interleave and corrupt session state.
    const route = routeSubmit(parsed, phaseRef.current, queueRef.current.length, MAX_QUEUE);
    // D6: check queue-full BEFORE mutating composer state - the user shouldn't
    // lose their draft when the queue is full.
    if (route.action === 'queue-full') {
      pushNotice('warning', `Queue is full (${MAX_QUEUE}) - wait for the run to settle.`);
      return;
    }
    pushHistory(raw);
    updateComposer(() => ({ value: '', cursor: 0 }));
    clearTuiDraft();
    switch (route.action) {
      case 'empty':
        return;
      case 'tui-command':
        if (parsed.kind === 'command') runTuiCommand(parsed.name, parsed.args);
        return;
      case 'queue': {
        if (parsed.kind === 'shell') {
          queueRef.current.push({ kind: 'shell', text: parsed.command });
          pushNotice(
            'info',
            `Shell command queued (#${queueRef.current.length}) - runs when the current run finishes.`,
          );
        } else if (parsed.kind === 'task') {
          queueRef.current.push({ kind: 'task', text: parsed.text });
          pushNotice('info', `Received, on it. (queued #${queueRef.current.length})`);
        }
        return;
      }
      case 'run':
        if (parsed.kind === 'shell') void runShellCmd(parsed.command);
        else if (parsed.kind === 'task') void runTask(parsed.text);
        return;
    }
  };

  const doQuit = (): void => {
    saveTuiState({
      draft: composerRef.current.value,
      updatedAt: new Date().toISOString(),
      history: historyRef.current,
    });
    exit();
  };

  /** ---- the single input handler: contexts in priority order ---- */

  // M1: the resolved keybinding table is the source of truth. Loaded once
  // per render from getEffectiveKeybindings() (which applies user overrides
  // onto the pinned contract, fail-closed). The useInput below dispatches
  // via lookupKeyAction() so rebinding a key actually changes behavior.
  // Resolution errors are surfaced as a startup notice (not silent).
  const { bindings: resolvedBindings } = getEffectiveKeybindings();

  /**
   * Determine the active KeyContext from UI state, then look up the action
   * for an Ink key event in the resolved table. Returns null for plain
   * typing (not a binding) or unbound keys.
   *
   * The context model mirrors the hardcoded useInput below so a rebind is
   * a true MOVE of the default key's reach:
   * - While the theme picker is open, only `always`-context bindings
   *   resolve: the picker handler swallows every other key (terminal
   *   `return`), exactly like the defaults. (An approval dismisses the
   *   picker first, so approval keeps priority - checked above the picker.)
   * - In `running`/`approval`, keys the section doesn't consume fall
   *   through to the composer handlers, so an unresolved lookup falls back
   *   to the composer context (again mirroring the hardcoded path).
   */
  const lookupKeyAction = (
    input: string,
    key: {
      ctrl: boolean; meta: boolean; shift?: boolean; return?: boolean;
      escape?: boolean; tab?: boolean; backspace?: boolean; delete?: boolean;
      upArrow?: boolean; downArrow?: boolean; leftArrow?: boolean; rightArrow?: boolean;
      pageUp?: boolean; pageDown?: boolean; home?: boolean; end?: boolean; insert?: boolean;
    },
  ): { context: KeyContext; action: string } | null => {
    const keyId = keyIdForInkEvent(input, key);
    if (!keyId) return null;
    let context: KeyContext = 'composer';
    if (paletteRef.current) context = 'palette';
    else if (confirmRef.current) context = 'confirm';
    else if (approvalRef.current) context = 'approval';
    else if (themePickerRef.current) {
      const global = actionForKey(resolvedBindings, 'always', keyId);
      return global ? { context: 'always', action: global } : null;
    }
    else if (phaseRef.current === 'running') context = 'running';
    let action = actionForKey(resolvedBindings, context, keyId);
    if (!action && (context === 'running' || context === 'approval')) {
      // Mirror the hardcoded fall-through: both sections pass unconsumed
      // keys to the composer handlers.
      action = actionForKey(resolvedBindings, 'composer', keyId);
      if (action) context = 'composer';
    }
    return action ? { context, action } : null;
  };

  /**
   * Transcript search (Ctrl+F) helpers. The search owns the keyboard while
   * open; the query edits like a one-line composer field (functional
   * setState so same-tick keystrokes chain, like updateComposerState).
   */
  const editSearchQuery = (
    fn: (prev: { value: string; cursor: number }) => { value: string; cursor: number },
  ): void => {
    setSearch((prev) => {
      if (!prev) return prev;
      const next = fn({ value: prev.query, cursor: prev.cursor });
      // A new query restarts navigation at the first hit.
      return { query: next.value, cursor: next.cursor, index: 0 };
    });
  };

  /** Move the search navigation to the next/previous hit, wrapping around. */
  const stepSearchHit = (dir: 1 | -1): void => {
    const s = searchRef.current;
    if (!s) return;
    const hits = findTranscriptHits(itemsRef.current, s.query);
    if (hits.length === 0) return;
    const cur = clampHitIndex(s.index, hits);
    setSearch({ ...s, index: (cur + dir + hits.length) % hits.length });
  };

  useInput((input, key) => {
    // T3: Swallow DEC 1004 focus report sequences. When focus tracking is
    // enabled, the terminal sends \x1b[I (focus in) and \x1b[O] (focus out).
    // Ink parses these as input='[I'/'[O' with key.escape=false, and would
    // otherwise pass them to the composer as literal characters.
    // (key.escape is never true for these - verified against Ink parser.)
    if (input === '[I' || input === '[O') {
      return;
    }

    // M1: table-driven override layer. The hardcoded handlers below implement
    // the DEFAULT bindings correctly. This layer checks the RESOLVED table
    // first: if the user rebound a key, the resolved action differs from the
    // default, and we dispatch to the rebound action here. Otherwise we fall
    // through to the default handlers below.
    //
    // The lookup respects context priority (palette > confirm > approval >
    // running > composer) and the `always` fallback, mirroring the hardcoded
    // order. The bidirectional invariant in resolveKeybindings() guarantees
    // `always` keys can't be stolen by context rebinding.
    const tableHit = lookupKeyAction(input, key);
    if (tableHit) {
      const { context, action } = tableHit;
      // Only intercept when the resolved binding differs from the default
      // table - i.e., the user actually rebound this key. Defaults fall
      // through to the battle-tested handlers below.
      const kid = keyIdForInkEvent(input, key)!;
      const defaultAction = actionForKey(KEYBINDINGS, context, kid);
      if (action !== defaultAction) {
        // Mirror the hardcoded picker block below: with an approval
        // pending, any key that reaches the picker dismisses it first.
        // This layer returns early on dispatch, so it must perform the
        // dismissal itself. (Ctrl+C / Ctrl+B return before the picker
        // block, but neither can dispatch here: both are reserved against
        // rebinds, so action === defaultAction for them.)
        if (themePickerRef.current && approvalRef.current) {
          setThemePicker(null);
        }
        // User rebound this key: dispatch the rebound action.
        if (action === 'toggle sidebar') {
          setSidebarOpen((v) => !v);
          return;
        }
        if (action === 'command palette') {
          setPalette({ filter: '', selected: 0 });
          return;
        }
        if (action === 'edit in $EDITOR') {
          openEditor();
          return;
        }
        if (action === 'expand elided output') {
          expandElided();
          return;
        }
        if (action === 'copy last reply') {
          copyLastReply();
          return;
        }
      }
    }

    // Ctrl+C is global-first: it must never be swallowed by a sub-context.
    if (key.ctrl && input === 'c') {
      if (paletteRef.current) {
        setPalette(null);
        return;
      }
      if (themePickerRef.current) {
        setThemePicker(null);
        return;
      }
      if (confirmRef.current) {
        setConfirm(null);
        return;
      }
      if (approvalRef.current && controllerRef.current) {
        controllerRef.current.reject('aborted by user');
        abortRef.current?.abort();
        return;
      }
      if (phaseRef.current === 'running') {
        abortRef.current?.abort();
        return;
      }
      // Idle: double-press to quit (hard rule #2 - never one accidental press).
      const now = Date.now();
      if (now - ctrlCAtRef.current < QUIT_ARM_MS) {
        if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
        doQuit();
        return;
      }
      ctrlCAtRef.current = now;
      setQuitArmed(true);
      if (quitTimerRef.current) clearTimeout(quitTimerRef.current);
      quitTimerRef.current = setTimeout(() => setQuitArmed(false), QUIT_ARM_MS);
      return;
    }

    // Ctrl+B toggles the session sidebar (D-F). Global-first like Ctrl+C: it
    // works in every context (palette, confirm, approval, running, composer).
    // M1: consult the resolved table - if the user rebound 'toggle sidebar'
    // away from ctrl+b, the hardcoded handler must not fire (one key,
    // one meaning).
    if (key.ctrl && input === 'b') {
      const sidebarAction = actionForKey(resolvedBindings, 'always', 'ctrl+b');
      if (sidebarAction === 'toggle sidebar') {
        setSidebarOpen((v) => !v);
        return;
      }
      // Rebound elsewhere: fall through so the rebound key can dispatch.
    }

    // Transcript search (Ctrl+F): while open it owns the keyboard - every
    // key below edits the query or navigates hits; nothing reaches the
    // composer. New transcript items keep arriving (and are searched) while
    // it is open. Esc closes the topmost layer first (like the palette),
    // so a second Esc still interrupts a running task.
    if (searchRef.current) {
      if (key.escape) {
        setSearch(null);
        return;
      }
      if (key.ctrl && input === 'f') {
        // Toggle: Ctrl+F again closes.
        setSearch(null);
        return;
      }
      if (key.return) {
        stepSearchHit(1);
        return;
      }
      if (input === '\n') {
        // Shift+Enter: terminals send \n (Ctrl+J sends \n too - while the
        // search is open both mean "previous match").
        stepSearchHit(-1);
        return;
      }
      if (key.leftArrow) {
        editSearchQuery((prev) => stepCursor(prev, -1));
        return;
      }
      if (key.rightArrow) {
        editSearchQuery((prev) => stepCursor(prev, 1));
        return;
      }
      if (key.backspace || key.delete) {
        editSearchQuery(deleteBackward);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        // Single-line query: strip newlines rather than inserting them.
        const text = input.replace(/\r\n?/g, '\n').replace(/\n/g, '');
        if (text.length > 0) editSearchQuery((prev) => insertText(prev, text));
        return;
      }
      return;
    }
    if (key.ctrl && input === 'f') {
      // A modal/approval owns the keyboard; otherwise open the search. The
      // resolved-table check keeps the M1 "one key, one meaning" contract:
      // if the user rebound 'transcript search' away, Ctrl+F must not fire it.
      if (!paletteRef.current && !confirmRef.current && !themePickerRef.current && !approvalRef.current) {
        if (actionForKey(resolvedBindings, 'composer', 'ctrl+f') === 'transcript search') {
          setSearch({ query: '', cursor: 0, index: -1 });
          return;
        }
      }
      // Rebound elsewhere, or a modal is open: fall through.
    }

    // Palette owns its keys.
    if (paletteRef.current) {
      const p = paletteRef.current;
      const list = filterCommands(p.filter);
      if (key.escape) {
        setPalette(null);
        return;
      }
      if (key.return) {
        const cmd = list[p.selected] ?? list[0];
        setPalette(null);
        if (cmd) runTuiCommand(cmd.name, []);
        return;
      }
      if (key.upArrow) {
        setPalette({ filter: p.filter, selected: (p.selected + list.length - 1) % Math.max(1, list.length) });
        return;
      }
      if (key.downArrow) {
        setPalette({ filter: p.filter, selected: (p.selected + 1) % Math.max(1, list.length) });
        return;
      }
      if (key.backspace || key.delete) {
        setPalette({ filter: p.filter.slice(0, -1), selected: 0 });
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setPalette({ filter: p.filter + input, selected: 0 });
        return;
      }
      return;
    }

    // M7: theme picker owns its keys when open (same pattern as palette).
    // M7: approval takes priority - if an approval arrives while the picker
    // is open, dismiss the picker so the approval can be answered.
    if (themePickerRef.current) {
      if (approvalRef.current) {
        setThemePicker(null);
        // Fall through to approval handling below.
      } else {
      const tp = themePickerRef.current;
      const options = listThemeOptions();
      if (key.escape) {
        setThemePicker(null);
        return;
      }
      if (key.return) {
        const opt = options[tp.selected] ?? options[0];
        setThemePicker(null);
        if (opt) applyThemeOption(opt.id);
        return;
      }
      if (key.upArrow) {
        setThemePicker({ selected: (tp.selected + options.length - 1) % Math.max(1, options.length) });
        return;
      }
      if (key.downArrow) {
        setThemePicker({ selected: (tp.selected + 1) % Math.max(1, options.length) });
        return;
      }
      return;
      } // end else (no approval)
    }

    // Confirm dialogs: y / n / Esc. Modifier combos (Ctrl+Y etc.) must not
    // confirm destructive actions.
    if (confirmRef.current) {
      if (input === 'y' && !key.ctrl && !key.meta) {
        const c = confirmRef.current;
        setConfirm(null);
        c.onYes();
        return;
      }
      if (input === 'n' || key.escape) {
        setConfirm(null);
        return;
      }
      return;
    }

    // Approval panel: the pinned key map (keybindings.approvalKeyFor).
    // Session scope only: a/A/r/Esc. The permanent-allow `w` key was removed
    // from the TUI (proposal); the one-shot agent keeps its own flow.
    // Modifier combos (Ctrl+A etc.) must never trigger approvals.
    // `e` toggles the truncated MCP args expand/collapse - resolved through
    // the keybinding table so a user rebind of 'expand arguments' is honoured
    // (and 'e' stops toggling once rebound away).
    if (approvalRef.current && controllerRef.current && !key.ctrl && !key.meta) {
      const ctrl = controllerRef.current;
      const expandKid = keyIdForInkEvent(input, key);
      if (
        expandKid &&
        actionForKey(resolvedBindings, 'approval', expandKid) === 'expand arguments' &&
        approvalRef.current.kind === 'mcp'
      ) {
        setMcpArgsExpanded((v) => !v);
        return;
      }
      const action = approvalKeyFor(input, key.escape);
      if (action === 'accept') ctrl.resolvePending('accept');
      else if (action === 'accept_all') ctrl.resolvePending('accept_all');
      else if (action === 'reject') ctrl.resolvePending('reject');
      return;
    }

    // While running, the composer stays live for queued follow-ups; Esc
    // interrupts. Everything else falls through to normal editing.
    if (phaseRef.current === 'running') {
      if (key.escape) {
        abortRef.current?.abort();
        return;
      }
    } else if (key.escape) {
      // Idle Esc: stash the draft into history (never destroy it) and clear.
      const v = composerRef.current.value;
      if (v.length > 0) {
        pushHistory(v);
        updateComposer(() => ({ value: '', cursor: 0 }));
        clearTuiDraft();
      }
      histIdxRef.current = -1;
      return;
    }

    // Ctrl+J inserts a newline (multiline composer). Legacy terminals send
    // a lone LF (name 'enter', key.return false); Kitty-protocol terminals
    // send ctrl+j. Enter (\r, key.return) still submits. Checked before the
    // generic text branch so a lone LF is never treated as typing.
    if (input === '\n' || (key.ctrl && input === 'j')) {
      updateComposer(insertNewline);
      return;
    }
    if (key.return) {
      submitComposer();
      return;
    }
    if (key.tab) {
      acceptSuggestion();
      return;
    }
    if (key.upArrow) {
      // Soft history (OpenCode-style): history only at the buffer edges;
      // inside a multiline draft the cursor moves between lines instead.
      const f = composerRef.current;
      if (cursorOnFirstLine(f)) historyBack();
      else updateComposer((prev) => moveCursorLine(prev, -1));
      return;
    }
    if (key.downArrow) {
      const f = composerRef.current;
      if (cursorOnLastLine(f)) historyForward();
      else updateComposer((prev) => moveCursorLine(prev, 1));
      return;
    }
    // M1: only fire when the resolved table still binds this key to the
    // action (one key, one meaning). If the user rebound the action away,
    // the default key must not fire it - the rebind is a MOVE, not an
    // addition. Falls through (swallowed) otherwise.
    if (key.ctrl && input === 'p') {
      if (actionForKey(resolvedBindings, 'composer', 'ctrl+p') === 'command palette') {
        setPalette({ filter: '', selected: 0 });
        return;
      }
    }
    if (key.ctrl && input === 'g') {
      if (actionForKey(resolvedBindings, 'composer', 'ctrl+g') === 'edit in $EDITOR') {
        openEditor();
        return;
      }
    }
    if (key.ctrl && input === 'o') {
      // Universal peek (MAJOR #3): expand the most recent elided output.
      if (actionForKey(resolvedBindings, 'composer', 'ctrl+o') === 'expand elided output') {
        expandElided();
        return;
      }
    }
    if (key.ctrl && input === 'y') {
      if (actionForKey(resolvedBindings, 'composer', 'ctrl+y') === 'copy last reply') {
        copyLastReply();
        return;
      }
    }
    // Word-wise movement (Alt+Left/Right or Ctrl+Left/Right) precedes the
    // plain arrows. Hardcoded like the plain arrows: "ctrl+left" is not a
    // producible keybinding id, and Alt+arrows arrive as meta+arrow.
    if (key.leftArrow && (key.meta || key.ctrl)) {
      updateComposer((prev) => moveCursorWord(prev, -1));
      return;
    }
    if (key.rightArrow && (key.meta || key.ctrl)) {
      updateComposer((prev) => moveCursorWord(prev, 1));
      return;
    }
    if (key.leftArrow) {
      updateComposer((prev) => stepCursor(prev, -1));
      return;
    }
    if (key.rightArrow) {
      updateComposer((prev) => stepCursor(prev, 1));
      return;
    }
    if (key.backspace || key.delete) {
      // Flat-string delete joins lines across newlines correctly.
      updateComposer(deleteBackward);
      return;
    }
    if (input && !key.ctrl && !key.meta) {
      // Printable input, or a paste blob (Ink delivers a paste as ONE input
      // event holding the whole blob). Pastes get intelligence: big ones
      // collapse to a placeholder, file paths attach as @-mentions.
      const text = input.replace(/\r\n?/g, '\n');
      if (isPasteChunk(text)) {
        handlePaste(text);
        return;
      }
      updateComposer((prev) => insertText(prev, text));
    }
  });

  /** ---- render ---- */

  const live = statusRef.current === 'streaming' ? liveTextRef.current : '';
  const liveTool = liveToolRef.current;
  const showLive = phase === 'running' && !approval;
  const composerMode = composer.value.startsWith('!') ? 'shell' : 'normal';
  const composerDisabled = approval !== null || palette !== null || confirm !== null || themePicker !== null;
  const suggestions = !composerDisabled && phase === 'idle' ? [...slashSuggestions().map((c) => `/${c.name} - ${c.summary}`), ...mentionSuggestions().map((f) => `@${f}`)] : [];
  const hintState = approval ? 'approval' : phase === 'running' ? 'running' : 'idle';
  // M1: the idle hints name rebindable actions - derive their labels from
  // the resolved table so a rebind never leaves a dead key advertised
  // (the documented keys and the implemented keys cannot drift apart).
  const paletteHintLabel = labelForAction(resolvedBindings, 'composer', 'command palette') ?? 'Ctrl+P';
  const sidebarHintLabel = labelForAction(resolvedBindings, 'always', 'toggle sidebar') ?? 'Ctrl+B';
  // D-F: advertise the sidebar toggle. Appended BEFORE the collapse policy so
  // it participates in narrowing like every other hint (narrow terminals drop
  // trailing hints first).
  const baseHints = hintsForState(hintState, { paletteLabel: paletteHintLabel });
  if (!quitArmed && hintState === 'idle') baseHints.push(`${sidebarHintLabel} sidebar`);
  const hints = quitArmed
    ? ['Press Ctrl+C again to quit']
    : visibleHints(baseHints, termWidth, symbols.middot);
  // D-F: sidebar geometry. ~30% of the terminal (24-56 cols) when open; the
  // main column's content width follows the space it actually has. Below 40
  // cols the sidebar auto-hides - a 24-col minimum would starve the main
  // column on narrow terminals.
  const sidebarWidth = Math.max(24, Math.min(56, Math.floor(termWidth * 0.3)));
  const showSidebar = sidebarOpen && termWidth >= 40;
  const mainContentWidth = showSidebar ? Math.min(termWidth - sidebarWidth, MAX_CONTENT_WIDTH) : contentWidth;
  const paletteList = palette ? filterCommands(palette.filter) : [];

  // Transcript search (Ctrl+F) render state. NOTE on <Static>: Ink flushes
  // static items to the terminal once and never re-renders them, so inline
  // highlights only appear on items rendered while the search is open. The
  // search bar below always shows the live hit count and an excerpt of the
  // current hit, which is the navigation feedback that works regardless.
  const searchHits = search ? findTranscriptHits(items, search.query) : [];
  const searchIndex = search ? clampHitIndex(search.index, searchHits) : -1;
  const searchRender: TranscriptSearchRender | null = search
    ? {
        query: search.query,
        hitIds: new Set(searchHits),
        currentId: searchIndex >= 0 ? (searchHits[searchIndex] as number) : null,
      }
    : null;
  const searchExcerpt =
    searchRender && searchRender.currentId !== null
      ? (() => {
          const item = items.find((i) => i.id === searchRender.currentId);
          return item ? matchExcerpt(itemSearchText(item), searchRender.query, 40) : null;
        })()
      : null;

  return (
    <ThemeProvider theme={theme}>
      {/* D-F: row layout hosts the session sidebar beside the main column.
          When hidden, this renders exactly the old full-width column. */}
      <Box flexDirection="row">
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
          <Static items={items}>
            {(item) => <TuiItemView key={item.id} item={item} width={mainContentWidth} search={searchRender} />}
          </Static>

          {showLive ? (
            liveTool ? (
              // M3: the live tool indicator honors delegation depth so it
              // does not jump from top level to indented when finalized.
              <Box marginTop={1} paddingLeft={liveDepthRef.current > 0 ? liveDepthRef.current * 2 : 0}>
                <Text color={colors.accent}>{`${GLYPH_TOOL} `}</Text>
                <Text color={colors.text}>{liveTool.tool}</Text>
                {liveTool.arg ? <Text color={colors.muted}>{` ${liveTool.arg}`}</Text> : null}
                <Text color={colors.muted}>  …</Text>
              </Box>
            ) : live.length > 0 ? (
              // M3: same for the live stream - matches the finalized item's indent.
              <Box flexDirection="column" marginTop={1} paddingLeft={liveDepthRef.current > 0 ? liveDepthRef.current * 2 : 0}>
                <StreamingMarkdown content={live} streaming width={Math.max(8, mainContentWidth - liveDepthRef.current * 2)} />
              </Box>
            ) : (
              // M3: the spinner honors delegation depth like its siblings,
              // so it does not render unindented before the first chunk.
              <Box paddingLeft={liveDepthRef.current > 0 ? liveDepthRef.current * 2 : 0}>
                <ActivityIndicator
                  label={statusRef.current === 'streaming' ? 'Thinking' : 'Working'}
                  startedAt={runStartedAt}
                  getLiveTokens={() =>
                    totalsRef.current.tokens + (liveBudgetRef.current?.snapshot().tokensUsed ?? 0)
                  }
                />
              </Box>
            )
          ) : null}

          {approval ? (
            <ApprovalView req={approval} width={mainContentWidth} expandMcpArgs={mcpArgsExpanded} />
          ) : null}

          {confirm ? (
            <Box
              flexDirection="column"
              marginTop={1}
              borderStyle="round"
              borderColor={colors.warning}
              paddingX={1}
            >
              <Text color={colors.text}>{confirm.question}</Text>
              <Box marginTop={1}>
                <Text color={colors.accent} bold>[y]</Text>
                <Text color={colors.muted}> yes </Text>
                <Text color={colors.accent} bold>[n]</Text>
                <Text color={colors.muted}> no (Esc)</Text>
              </Box>
            </Box>
          ) : null}

          {palette ? (
            <CommandPalette
              commands={paletteList}
              selected={Math.min(palette.selected, Math.max(0, paletteList.length - 1))}
              filter={palette.filter}
              width={mainContentWidth}
            />
          ) : null}

          {themePicker ? (
            <ThemePicker
              options={listThemeOptions()}
              selected={themePicker.selected}
              currentId={effectiveThemeId()}
              width={mainContentWidth}
            />
          ) : null}

          {suggestions.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              {suggestions.slice(0, 6).map((s) => (
                <Text key={s} color={colors.muted}>
                  {`  ${s}`}
                </Text>
              ))}
              <Text color={colors.muted}>Tab to accept</Text>
            </Box>
          ) : null}

          {search ? (
            <Box flexDirection="column" marginTop={1}>
              <Box>
                <Text color={colors.accent} bold>/ </Text>
                {(() => {
                  // Code-point aware cursor split (never splits a surrogate pair).
                  const before = search.query.slice(0, search.cursor);
                  const at = [...search.query.slice(search.cursor)][0] ?? '';
                  const after = search.query.slice(search.cursor + at.length);
                  return (
                    <Text color={colors.text}>
                      {before}
                      <Text inverse>{at || ' '}</Text>
                      {after}
                    </Text>
                  );
                })()}
                <Text color={colors.muted}>
                  {searchHits.length > 0
                    ? `  ${searchIndex + 1}/${searchHits.length} match${searchHits.length === 1 ? '' : 'es'}`
                    : search.query.trim().length > 0
                      ? '  no matches'
                      : '  type to search the transcript'}
                  {`  ${symbols.middot} Enter next ${symbols.middot} Shift+Enter prev ${symbols.middot} Esc close`}
                </Text>
              </Box>
              {searchExcerpt ? (
                <Box paddingLeft={2}>
                  <Text color={colors.muted}>{searchExcerpt.before}</Text>
                  <Text backgroundColor={colors.accent} bold>
                    {searchExcerpt.match}
                  </Text>
                  <Text color={colors.muted}>{searchExcerpt.after}</Text>
                </Box>
              ) : null}
            </Box>
          ) : null}

          <TuiComposer
            value={composer.value}
            cursor={composer.cursor}
            placeholder={loggedIn ? 'Type a task, / for commands, ! for shell' : 'Type /help to explore (log in to run tasks)'}
            mode={composerMode}
            disabled={composerDisabled}
            disabledHint={
              approval ? 'Answer the approval above (a / A / r / Esc)' : palette ? 'Palette open' : themePicker ? 'Theme picker open' : 'Answer the question above (y / n)'
            }
          />

          {hints.length > 0 ? (
            <Box marginTop={1}>
              <Text color={colors.muted}>{hints.join(` ${symbols.middot} `)}</Text>
            </Box>
          ) : null}

          <Box marginTop={1}>
            <TuiStatusBar
              model={activeModel ? modelLabel(activeModel) : modelOverride ? modelLabel(modelOverride) : 'auto'}
              tasks={totals.tasks}
              turns={totals.turns}
              tokens={totals.tokens}
              cwd={displayCwd(cwd)}
            />
          </Box>
        </Box>
        {showSidebar ? (
          <TuiSessionSidebar title={sessionTitle} files={sidebarFiles} cwd={cwd} width={sidebarWidth} />
        ) : null}
      </Box>
    </ThemeProvider>
  );
}
