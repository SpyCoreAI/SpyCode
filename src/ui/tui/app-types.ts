/**
 * TUI app-level types and constants: the transcript item model, session
 * totals, and the caps the app enforces. Extracted from TuiApp.tsx (M-8);
 * behavior unchanged.
 */
import type { AgentUiItem } from '../agent/shared.js';
import type { DistributiveOmit } from '../agent/shared.js';
import type { DiffLine } from '../../lib/agent/diff.js';
import type { HookSession } from '../../lib/hooks.js';
import type { RunAgentOptions } from '../../lib/agent/loop.js';
import type { Theme } from '../theme/theme.js';
import type { ThemeMode } from '../theme/tokens.js';

/** Agent models the TUI may run (mirrors `spycore agent --model`). */
export const TUI_AGENT_MODELS = ['charon', 'styx', 'hermes', 'minos'] as const;

export const TIPS = [
  'Type a task in plain words - the agent works through it step by step.',
  'Every file change asks first: a accept · A accept all · r reject.',
  'Press Ctrl+P to browse every command. /help fits on one screen.',
  "/undo reverts the last task's FILE changes only - git commits and shell effects stay.",
  'Type ! and a command to run it in your shell, no agent involved.',
  '@mention a file to attach its contents to your task.',
] as const;

export const MAX_MENTION_FILES = 5;
export const MAX_MENTION_LINES = 200;
export const MAX_MENTION_BYTES = 100 * 1024;
export const MAX_DIFF_FILES = 12;
export const MAX_DIFF_LINES = 200;
export const QUIT_ARM_MS = 1500;
export const MAX_QUEUE = 5;
/** Transcript cap: oldest items evicted past this (with orphaned peek entries). */
export const MAX_TRANSCRIPT_ITEMS = 2000;

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

export interface DiffFile {
  path: string;
  op: 'create' | 'modify' | 'delete';
  hunks: DiffLine[];
  truncated: boolean;
  /** Uncapped hunks backing Ctrl+O peek. */
  full: DiffLine[];
}

export type TuiItem =
  | AgentUiItem
  | { kind: 'welcome'; id: number; loggedIn: boolean; tip: string }
  | { kind: 'help'; id: number }
  | { kind: 'diff'; id: number; files: DiffFile[]; total: number }
  /** A `/compact` summary replacing the transcript that produced it. */
  | { kind: 'summary'; id: number; text: string; items: number }
  /** Full content of an elided transcript item, opened with Ctrl+O. */
  | { kind: 'peek'; id: number; label: string; full: string };

export type TuiItemInput = DistributiveOmit<TuiItem, 'id'>;

export interface SessionTotals {
  tasks: number;
  turns: number;
  toolCalls: number;
  changedFiles: number;
  /** Cumulative `budget.snapshot().tokensUsed` across runs (metering). */
  tokens: number;
  startedAt: number;
}

export interface LastRun {
  sessionId: string;
  undone: boolean;
  /** true if the last undo was redone (redo available only after undo). */
  redone?: boolean;
}
