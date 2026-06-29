/**
 * Checkpoint journal + rewind logic for the agent.
 *
 * Every file the agent CREATES or OVERWRITES/EDITS via write_file/edit_file is
 * journaled (the prior content + the new content + a sha256 of the new
 * content). A run's records are grouped into one session, persisted per-cwd
 * under the CLI config dir. `spycore rewind` reads the newest session and
 * safely reverses it — never clobbering edits the user made after the agent
 * ran (a sha256 guard skips any file whose content changed since).
 *
 * Git-independent (works in any directory) and uses only node built-ins.
 * run_command is NOT journaled — its side-effects are arbitrary.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { getConfigPath } from '../config.js';

export type FileOp = 'create' | 'modify';

/** What a mutating tool reports right after a successful write. */
export interface RecordedChange {
  /** Absolute path. */
  path: string;
  op: FileOp;
  /** Prior content; null when the agent created the file. */
  before: string | null;
  /** New content the agent wrote. */
  after: string;
}

/** A persisted change, with a content hash of `after` for the rewind guard. */
export interface FileChange extends RecordedChange {
  afterSha: string;
}

export interface CheckpointSession {
  /** Sortable id: `<epochMs>-<rand>`. */
  id: string;
  cwd: string;
  startedAt: string;
  task: string;
  changes: FileChange[];
}

const MAX_SESSIONS_PER_CWD = 20;

export function sha256(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return createHash('sha256').update(buf).digest('hex');
}

function checkpointsRoot(): string {
  return join(dirname(getConfigPath()), 'checkpoints');
}
function cwdDir(cwd: string): string {
  return join(checkpointsRoot(), sha256(cwd));
}
function numericPrefix(id: string): number {
  const n = Number.parseInt(id.split('-')[0] ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}

/** Read the current on-disk sha of a path, or null when unreadable/missing. */
function currentSha(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/**
 * Persist a session journal for `cwd`. Best-effort: returns the id, or null on
 * any failure (never throws — a journal write must not break the agent run).
 */
export function saveSession(input: { cwd: string; task: string; changes: RecordedChange[] }): string | null {
  if (input.changes.length === 0) return null;
  try {
    const dir = cwdDir(input.cwd);
    mkdirSync(dir, { recursive: true });
    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
    const session: CheckpointSession = {
      id,
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
      task: input.task,
      changes: input.changes.map((c) => ({ ...c, afterSha: sha256(c.after) })),
    };
    const tmp = join(dir, `.${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(session), 'utf8');
    renameSync(tmp, join(dir, `${id}.json`));
    pruneSessions(dir);
    return id;
  } catch {
    return null;
  }
}

function pruneSessions(dir: string): void {
  try {
    const active = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (active.length <= MAX_SESSIONS_PER_CWD) return;
    const sorted = active.sort((a, b) => numericPrefix(b) - numericPrefix(a));
    for (const f of sorted.slice(MAX_SESSIONS_PER_CWD)) {
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function parseSession(file: string): CheckpointSession | null {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as CheckpointSession;
    if (!data || typeof data !== 'object' || !Array.isArray(data.changes)) return null;
    return data;
  } catch {
    return null;
  }
}

/** Active (not-yet-rewound) sessions for `cwd`, newest first. */
export function listSessions(cwd: string): CheckpointSession[] {
  const dir = cwdDir(cwd);
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  // `.json` = active; `.json.done` = already rewound (excluded).
  const active = files.filter((f) => f.endsWith('.json'));
  return active
    .map((f) => parseSession(join(dir, f)))
    .filter((s): s is CheckpointSession => s !== null)
    .sort((a, b) => numericPrefix(b.id) - numericPrefix(a.id));
}

export function latestSession(cwd: string): CheckpointSession | null {
  return listSessions(cwd)[0] ?? null;
}

export function loadSession(cwd: string, id: string): CheckpointSession | null {
  const file = join(cwdDir(cwd), `${id}.json`);
  return existsSync(file) ? parseSession(file) : null;
}

/** Mark a session rewound (rename to `.json.done`) so it isn't re-applied. */
export function markSessionDone(cwd: string, id: string): void {
  try {
    const src = join(cwdDir(cwd), `${id}.json`);
    if (existsSync(src)) renameSync(src, join(cwdDir(cwd), `${id}.json.done`));
  } catch {
    /* ignore */
  }
}

export type RestoreAction = 'restore' | 'delete' | 'skip';
export interface RestoreStep {
  change: FileChange;
  action: RestoreAction;
  reason?: string;
}

/**
 * Compute the reverse-order restore plan with a sha256 guard. Threads the
 * expected content through the chain in-memory (so a create→modify of the same
 * file rewinds correctly) WITHOUT mutating the disk. A file whose current
 * content differs from what the agent left is SKIPPED (no clobber).
 */
export function planRewind(session: CheckpointSession): RestoreStep[] {
  const steps: RestoreStep[] = [];
  const sim = new Map<string, string | null>(); // path → expected sha (null = deleted)
  const expected = (path: string): string | null => (sim.has(path) ? sim.get(path) ?? null : currentSha(path));

  for (let i = session.changes.length - 1; i >= 0; i -= 1) {
    const change = session.changes[i]!;
    const cur = expected(change.path);
    if (change.op === 'create') {
      if (cur === null) {
        steps.push({ change, action: 'skip', reason: 'already deleted' });
      } else if (cur !== change.afterSha) {
        steps.push({ change, action: 'skip', reason: 'modified since the agent ran' });
      } else {
        steps.push({ change, action: 'delete' });
        sim.set(change.path, null);
      }
    } else {
      if (cur === null) {
        steps.push({ change, action: 'skip', reason: 'file is missing' });
      } else if (cur !== change.afterSha) {
        steps.push({ change, action: 'skip', reason: 'modified since the agent ran' });
      } else {
        steps.push({ change, action: 'restore' });
        sim.set(change.path, sha256(change.before ?? ''));
      }
    }
  }
  return steps;
}

/**
 * Remove now-empty directories above a deleted created file, walking up to —
 * but never including — the session cwd. The agent's writes mkdir parents
 * implicitly (writeAtomic), so a faithful rewind must take those empty dirs
 * back out, or `rewind` leaves `data/`, `out/`, … skeletons behind. A parent
 * that still has any entry is left alone (and stops the walk). Limitation:
 * we don't journal directory creation, so a directory that existed EMPTY
 * before the run and only ever held created files is pruned too — losing an
 * empty pre-existing dir is the lesser error versus keeping run debris.
 */
function pruneEmptyDirs(filePath: string, stopDir: string): void {
  const stop = resolve(stopDir);
  let dir = dirname(resolve(filePath));
  while (dir !== stop && dir.startsWith(stop + sep)) {
    try {
      if (readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    } catch {
      break;
    }
    dir = dirname(dir);
  }
}

/**
 * Apply a restore plan (delete created files / restore prior content).
 * `cwd` — the session's working directory — bounds empty-parent pruning for
 * deleted creates; when omitted, pruning is skipped (old behavior).
 */
export function applyRewind(steps: RestoreStep[], cwd?: string): { restored: number; skipped: number } {
  let restored = 0;
  let skipped = 0;
  for (const step of steps) {
    if (step.action === 'skip') {
      skipped += 1;
      continue;
    }
    try {
      if (step.action === 'delete') {
        if (existsSync(step.change.path)) unlinkSync(step.change.path);
        if (cwd) pruneEmptyDirs(step.change.path, cwd);
      } else {
        writeFileSync(step.change.path, step.change.before ?? '', 'utf8');
      }
      restored += 1;
    } catch {
      skipped += 1;
    }
  }
  return { restored, skipped };
}
