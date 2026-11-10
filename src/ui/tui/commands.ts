/**
 * The TUI's command registry - the SAME list backs `/` commands, the Ctrl+P
 * palette, and /help, so learning one surface teaches all three. Deliberately
 * small: depth over width.
 */
export interface TuiCommand {
  /** Without the leading slash, e.g. 'help'. */
  name: string;
  /** Plain-words summary. */
  summary: string;
  /** Argument shape hint, e.g. '[name]'. */
  usage: string;
}

export const TUI_COMMANDS: readonly TuiCommand[] = [
  { name: 'help', summary: 'Show keys & commands', usage: '' },
  { name: 'model', summary: 'Show or switch the agent model', usage: '[name]' },
  { name: 'diff', summary: "Show the last task's file diff", usage: '' },
  { name: 'undo', summary: "Revert the last task's file changes (shell effects stay)", usage: '' },
  { name: 'redo', summary: "Re-apply the last undone task's file changes", usage: '' },
  { name: 'todo', summary: 'Manage the session todo list', usage: '[add <text> | done <id> | list | clear]' },
  { name: 'plan', summary: 'Toggle plan mode for the next task (propose steps, no file changes)', usage: '' },
  { name: 'approval', summary: 'Set approval mode: ask | auto-all', usage: '<mode>' },
  { name: 'diagnose', summary: 'Run TypeScript diagnostics on the workspace', usage: '' },
  { name: 'branch', summary: 'Branch the last session checkpoint (try a different approach)', usage: '' },
  { name: 'fork', summary: 'Fork a session into a new id (branch with an explicit parent reference)', usage: '[id]' },
  { name: 'usage', summary: 'Show session totals', usage: '' },
  { name: 'compact', summary: 'Collapse the transcript to recent items', usage: '' },
  { name: 'resume', summary: 'Resume an interrupted SpyCore session', usage: '[id] [--force]' },
  { name: 'theme', summary: 'Show or set the theme', usage: '[auto|light|dark|<gallery-id>] (no args: visual picker)' },
  { name: 'clear', summary: 'Clear the visible transcript', usage: '' },
  { name: 'new', summary: 'Start a fresh session (clean slate, no relaunch)', usage: '' },
  { name: 'exit', summary: 'Quit the TUI', usage: '' },
];

/** Prefix-filter the registry (the palette's live filter). Case-insensitive. */
export function filterCommands(filter: string): TuiCommand[] {
  const f = filter.trim().toLowerCase().replace(/^\//, '');
  if (!f) return [...TUI_COMMANDS];
  return TUI_COMMANDS.filter((c) => c.name.startsWith(f));
}

export type TuiInput =
  | { kind: 'empty' }
  /** `!…` - run a shell command directly, no agent involved. */
  | { kind: 'shell'; command: string }
  /** `/name args…` - a registry command. */
  | { kind: 'command'; name: string; args: string[] }
  /** Anything else - an agent task. */
  | { kind: 'task'; text: string };

/** Classify one submitted composer line. Pure and total. */
export function parseTuiInput(raw: string): TuiInput {
  const text = raw.trim();
  if (text.length === 0) return { kind: 'empty' };
  if (text.startsWith('!')) return { kind: 'shell', command: text.slice(1).trim() };
  if (text.startsWith('/')) {
    const [name, ...args] = text.slice(1).split(/\s+/);
    return { kind: 'command', name: (name ?? '').toLowerCase(), args };
  }
  return { kind: 'task', text };
}

/** Look a parsed command name up in the registry. */
export function findCommand(name: string): TuiCommand | undefined {
  return TUI_COMMANDS.find((c) => c.name === name);
}

/**
 * Where a submitted composer input goes. A-8: a TASK submitted while a run
 * is in flight STEERS it (folded in at the next step boundary via the run
 * handle) instead of queueing behind it - mid-turn user intent reaches the
 * agent instead of waiting for the run to end. `!` shell commands still
 * queue exactly like before (BLOCKER #1 fix): nothing executes inline while
 * a run is in flight, so two run loops can never interleave and corrupt
 * session state. Pure - the regression test pins the matrix.
 */
export type SubmitRoute =
  | { action: 'run' }
  | { action: 'steer' }
  | { action: 'queue' }
  | { action: 'queue-full' }
  | { action: 'tui-command' }
  | { action: 'empty' };

export function routeSubmit(
  parsed: TuiInput,
  phase: 'idle' | 'running',
  queueLength: number,
  maxQueue: number,
): SubmitRoute {
  if (parsed.kind === 'empty') return { action: 'empty' };
  if (parsed.kind === 'command') return { action: 'tui-command' };
  if (phase === 'running') {
    // A-8: a mid-run task steers the in-flight run; only `!` shell submits
    // still queue (they must not interleave with the loop).
    if (parsed.kind === 'task') return { action: 'steer' };
    return queueLength >= maxQueue ? { action: 'queue-full' } : { action: 'queue' };
  }
  return { action: 'run' };
}

/** Queue item shape shared with the TUI drain loop. */
export interface TuiQueueItem {
  kind: 'task' | 'shell';
  text: string;
}

/**
 * Shift the next runnable item off the queue, skipping empty `!` submits
 * (N3): an empty shell command queued mid-run must not stall the drain -
 * the loop keeps shifting until a runnable item or an empty queue.
 * Pure - pinned by tests.
 */
export function shiftRunnable(queue: TuiQueueItem[]): TuiQueueItem | undefined {
  let next = queue.shift();
  while (next !== undefined && next.kind === 'shell' && next.text.length === 0) {
    next = queue.shift();
  }
  return next;
}

/** Slash commands refused while a task is in flight (N4). */
const RUNNING_GUARDED_COMMANDS: ReadonlySet<string> = new Set(['compact', 'resume', 'undo', 'redo', 'clear', 'new', 'exit']);

/**
 * True when the named slash command must wait for an idle TUI.
 * Pure - pinned by tests.
 */
export function isRefusedWhileRunning(name: string, phase: 'idle' | 'running'): boolean {
  return phase === 'running' && RUNNING_GUARDED_COMMANDS.has(name);
}
