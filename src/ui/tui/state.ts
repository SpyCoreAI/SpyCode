/**
 * TUI session state that survives restarts: the unsent composer draft.
 *
 * "Drafts are never lost": the draft is written (debounced) on every edit and
 * restored on launch. Best-effort by design - every IO path is guarded so a
 * read-only home directory can never break the TUI. Lives next to the CLI
 * config (same base directory `conf` uses for projectName 'spycore').
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

export interface TuiPersistedState {
  draft: string;
  updatedAt: string;
  /** Composer submit history (capped by the caller). Survives restarts. */
  history?: string[];
}

function stateFilePath(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    const home = homedir();
    if (!home) return null;
    // XDG_CONFIG_HOME takes precedence on all platforms so tests can
    // isolate the state file via a tmpdir (see tests/tui-state.test.ts).
    if (env.XDG_CONFIG_HOME) {
      return join(env.XDG_CONFIG_HOME, 'spycore', 'tui-state.json');
    }
    const base =
      process.platform === 'darwin'
        ? join(home, 'Library', 'Preferences', 'spycore')
        : join(home, '.config', 'spycore');
    return join(base, 'tui-state.json');
  } catch {
    return null;
  }
}

export function loadTuiState(
  env: NodeJS.ProcessEnv = process.env,
): TuiPersistedState | null {
  try {
    const path = stateFilePath(env);
    if (!path) return null;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TuiPersistedState>;
    if (typeof raw.draft !== 'string') return null;
    const history =
      Array.isArray(raw.history) && raw.history.every((h) => typeof h === 'string')
        ? (raw.history as string[]).slice(-100)
        : [];
    return {
      draft: raw.draft,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      history,
    };
  } catch {
    return null;
  }
}

export function saveTuiState(
  state: TuiPersistedState,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const path = stateFilePath(env);
    if (!path) return;
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(state), 'utf8');
  } catch {
    /* best-effort: a draft must never break the session */
  }
}

export function clearTuiDraft(env: NodeJS.ProcessEnv = process.env): void {
  // Clearing the draft must not destroy the submit history.
  const prev = loadTuiState(env);
  saveTuiState({ draft: '', updatedAt: new Date().toISOString(), history: prev?.history ?? [] }, env);
}
