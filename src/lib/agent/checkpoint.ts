/**
 * Checkpoint journal + rewind logic for the agent.
 *
 * A run's records are grouped into one session, persisted per-cwd under the CLI
 * config dir. `spycore rewind` reads the newest session and safely reverses it -
 * never clobbering edits the user made after the agent ran (a sha256 guard skips
 * any file whose content changed since).
 *
 * WHAT REACHES THE JOURNAL, and by which of the two routes:
 * - `write_file` / `edit_file` REPORT THEMSELVES: they know the resolved
 * target and both contents, so they call `ctx.recordChange` directly
 * (`tools.ts` `applyMutation`).
 * - `run_command`, every MCP tool, and hooks that run around a tool call are
 * OPAQUE - they hand work to another process. They are journaled by
 * OBSERVATION: `agent/workspace-delta.ts` takes a bounded before/after
 * picture of the workspace around the call and turns the difference into the
 * same `RecordedChange` values.  One journal, one format, one rewind: the
 * observer is a second SOURCE, never a second recorder.
 *
 * AND WHAT DOES NOT, which is a property of the design and not an omission:
 * anything outside the workspace, anything the agent's own read tools cannot see
 * (`.gitignore`d paths, `node_modules`, `.git`, `build`, `dist`), binary files
 * and files over the observer's per-file cap, and every effect that is not a
 * file's content (a `git push`, a network call, a spawned daemon). The observer
 * REPORTS what it detected but could not capture; it never implies coverage it
 * does not have. `workspace-delta.ts`'s header carries the full list and the
 * measurements behind it.
 *
 * Git-independent (works in any directory) and uses only node built-ins plus the
 * `globby` the read tools already load.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { containmentBound } from '../path-containment.js';
import { getConfigPath } from '../config.js';

/**
 * `'delete'` ARRIVED WITH THE WORKSPACE OBSERVER. The write/edit tools can
 * only create or modify, so two ops were the whole world. `run_command` and MCP
 * tools delete files, and a journal that cannot express a deletion cannot undo
 * one - which is most of what "undo everything the last run changed" was
 * promising and not doing.
 *
 * FORWARD-COMPATIBILITY, MEASURED RATHER THAN HOPED. A 0.7.0 journal read by
 * an OLDER CLI hits `planRewind`'s `else` branch (everything that is not
 * `'create'` is treated as a modify), where `currentSha` of a deleted file is
 * null and the step is SKIPPED with "file is missing". The old reader therefore
 * declines to act on a record it does not understand, which is the fail-safe
 * direction - it does not mis-restore.
 */
export type FileOp = 'create' | 'modify' | 'delete';

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
  /**
   * Additive resume record (absent on sessions written before resume support
   * and on end-of-run-only writers like the bare-runAgent path). Old readers
   * ignore it; new readers treat a missing/malformed value as "not resumable".
   */
  resume?: ResumeState;
  /**
   * Additive fork lineage: the source session id, set on the copy by
   * branchSession. Absent on sessions that were never forked. Old readers
   * ignore it.
   */
  parentId?: string;
}

/** Budget consumption + caps carried across an interrupt (CUMULATIVE - never reset). */
export interface ResumeBudgetState {
  tokensUsed: number;
  turnsUsed: number;
  elapsedMs: number;
  caps: { maxTokens?: number | undefined; maxTimeMs?: number | undefined; maxTurns?: number | undefined };
}

/**
 * Everything `spycore agent --resume` needs to continue a run from its last
 * completed step boundary. The transcript itself lives server-side in the
 * conversation; this record re-binds to it and restores loop state around it.
 */
export interface ResumeState {
  version: 1;
  /** 'running' = a boundary write (a crash leaves this); 'interrupted' = a graceful stop; 'completed' = final answer reached. */
  status: 'running' | 'interrupted' | 'completed';
  /** The execute-phase server conversation; null until execution starts. */
  conversationId: string | null;
  /** Whether the conversation speaks the NATIVE tool protocol (pinned at turn 1). */
  nativeTools: boolean;
  providerKind: 'spycore' | 'byok';
  model: string;
  planMode: boolean;
  approvedPlan: string | null;
  /** Completed loop turns across the whole run (all phases + fixes). */
  turnsCompleted: number;
  maxTurns: number;
  budget: ResumeBudgetState;
  /** Skill names already injected into the conversation (load_skill dedup). */
  loadedSkills: string[];
  /** Workspace fingerprint at the last boundary (drift guard); null = not a git repo. */
  gitHead: string | null;
  updatedAt: string;
}

/** Validate a session's `resume` field; null when absent or malformed (old format). */
export function getResumeState(session: CheckpointSession): ResumeState | null {
  const r = session.resume;
  if (!r || typeof r !== 'object') return null;
  if (r.version !== 1) return null;
  if (r.status !== 'running' && r.status !== 'interrupted' && r.status !== 'completed') return null;
  if (r.conversationId !== null && typeof r.conversationId !== 'string') return null;
  if (r.providerKind !== 'spycore' && r.providerKind !== 'byok') return null;
  if (typeof r.model !== 'string' || typeof r.nativeTools !== 'boolean') return null;
  if (!r.budget || typeof r.budget !== 'object') return null;
  // Numeric fields must be finite numbers >= 0: a hand-edited journal with
  // e.g. `tokensUsed: "lots"` or `turnsUsed: -1` used to pass validation and
  // then poison budget arithmetic (NaN propagates silently; a negative turn
  // count extends the run past its cap). Caps are optional when present.
  const nonNegFinite = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (
    !nonNegFinite(r.budget.tokensUsed) ||
    !nonNegFinite(r.budget.turnsUsed) ||
    !nonNegFinite(r.budget.elapsedMs)
  ) {
    return null;
  }
  if (r.budget.caps !== undefined) {
    if (typeof r.budget.caps !== 'object' || r.budget.caps === null) return null;
    for (const v of [r.budget.caps.maxTokens, r.budget.caps.maxTimeMs, r.budget.caps.maxTurns]) {
      if (v !== undefined && !nonNegFinite(v)) return null;
    }
  }
  if (!nonNegFinite(r.turnsCompleted) || !nonNegFinite(r.maxTurns)) return null;
  if (typeof r.planMode !== 'boolean') return null;
  if (r.approvedPlan !== null && typeof r.approvedPlan !== 'string') return null;
  if (!Array.isArray(r.loadedSkills) || r.loadedSkills.some((s) => typeof s !== 'string')) return null;
  if (r.gitHead !== null && typeof r.gitHead !== 'string') return null;
  if (typeof r.updatedAt !== 'string') return null;
  return r;
}

const MAX_SESSIONS_PER_CWD = 20;

export function sha256(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return createHash('sha256').update(buf).digest('hex');
}

function checkpointsRoot(): string {
  return join(dirname(getConfigPath()), 'checkpoints');
}

/**
 * R-CLI-1 - THE JOURNAL IS OWNER-ONLY, AND IT SAYS SO ITSELF.
 *
 * A session journal holds the BEFORE and AFTER text of every file a run
 * changed. It was written with `writeFileSync(…, 'utf8')` and no mode argument,
 * so it landed at the process umask - commonly world-readable.
 *
 * The numbers are not invented here. They are the ones this package already
 * applies to the file that holds the bearer token, measured at
 * `lib/config.ts:362-363`: `0o600` on the file and `0o700` on its directory.
 * The journal sits under that same configuration directory, so matching it is
 * the only self-consistent answer.
 *
 * Applied to EVERY directory level this module creates, not only the leaf:
 * `mkdirSync(…, { recursive: true })` creates `checkpoints/` and the per-cwd
 * directory in one call, and a `mode` given to it applies to both. An
 * owner-only file inside a world-readable directory still leaks the fact and
 * the name of every observed workspace.
 */
const JOURNAL_FILE_MODE = 0o600;
const JOURNAL_DIR_MODE = 0o700;

/**
 * Tighten a journal directory (and the `checkpoints/` root above it) to
 * 0o700. `mkdirSync(…, { recursive: true, mode })` applies the mode ONLY to
 * directories it creates: a directory that already exists - created before
 * the 0o700 rule, or by an older CLI - keeps whatever the umask gave it,
 * leaving an owner-only journal inside a world-readable directory. Called
 * on every journal write; best-effort, never fatal.
 */
function tightenJournalDir(dir: string): void {
  for (const d of [checkpointsRoot(), dir]) {
    try {
      chmodSync(d, JOURNAL_DIR_MODE);
    } catch {
      /* best-effort - the journal write must not break the run */
    }
  }
}
/**
 * The per-cwd journal directory, keyed by a hash of the cwd.
 *
 * The cwd is canonicalised first: the same directory can be spelled two
 * ways - macOS spells the temp dir `/var/folders/…` while `process.cwd()`
 * reports `/private/var/folders/…`, and a symlinked workspace spells
 * differently again - and a hash of the spelling would file the save and
 * the lookup under different keys, so a fork (or rewind, or resume) of a
 * just-saved session reports "No session for this directory". Hashing the
 * resolved path makes every spelling of one directory the same journal.
 * A path that cannot be resolved (not yet on disk) falls back to the
 * spelling it was given rather than failing the journal write.
 *
 * Exported, and the ONLY way to compute this directory: the tests used to
 * recompute it as `sha256(raw cwd)`, which silently diverged from this
 * function on macOS (raw `/var/…` vs resolved `/private/var/…`) - the
 * tests wrote session files into one directory while save/list read
 * another, so listSessions came back empty and sabotage tests that block
 * the directory missed entirely. Every consumer - product and tests -
 * goes through this function, so the spelling can never drift again.
 */
export function checkpointDirFor(cwd: string): string {
  let canonical = cwd;
  try {
    canonical = realpathSync(cwd);
  } catch {
    /* keep the given spelling - the journal write is best-effort */
  }
  return join(checkpointsRoot(), sha256(canonical));
}
function numericPrefix(id: string): number {
  const n = Number.parseInt(id.split('-')[0] ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Session ids carry a per-process monotonic sequence between the epoch-ms
 * prefix and the random suffix: `${Date.now()}-${seq}-${random}`.
 *
 * `Date.now()` has ~15.6ms granularity on Windows, so two sessions created
 * back-to-back share a millisecond and a sort on the ms prefix alone has no
 * tie-break - "newest" fell back to readdir order, which is
 * filesystem-arbitrary. The sequence makes creation order total within a
 * process; the comparator below makes it deterministic across processes
 * too (old-format `${ms}-${random}` ids have no sequence segment and sort
 * by ms, then by full id).
 */
let sessionSeq = 0;
function nextSessionId(): string {
  sessionSeq += 1;
  return `${Date.now()}-${String(sessionSeq).padStart(6, '0')}-${randomBytes(4).toString('hex')}`;
}

function sessionSeqOf(id: string): number {
  const n = Number.parseInt(id.split('-')[1] ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
}

/** Newest first: epoch-ms prefix, then the monotonic sequence, then the full id. */
function compareSessionIdsNewestFirst(a: string, b: string): number {
  const byMs = numericPrefix(b) - numericPrefix(a);
  if (byMs !== 0) return byMs;
  const bySeq = sessionSeqOf(b) - sessionSeqOf(a);
  if (bySeq !== 0) return bySeq;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Read the current on-disk sha of a path, or null when unreadable/missing. */
export function currentFileSha(path: string): string | null {
  return currentSha(path);
}

function currentSha(path: string): string | null {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

/**
 * Persist a session journal for `cwd`. Best-effort: returns the id, or null on
 * any failure (never throws - a journal write must not break the agent run).
 */
export function saveSession(input: { cwd: string; task: string; changes: RecordedChange[] }): string | null {
  if (input.changes.length === 0) return null;
  try {
    const dir = checkpointDirFor(input.cwd);
    mkdirSync(dir, { recursive: true, mode: JOURNAL_DIR_MODE });
    tightenJournalDir(dir);
    const id = nextSessionId();
    const session: CheckpointSession = {
      id,
      cwd: input.cwd,
      startedAt: new Date().toISOString(),
      task: input.task,
      changes: input.changes.map((c) => ({ ...c, afterSha: sha256(c.after) })),
    };
    const tmp = join(dir, `.${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(session), { encoding: 'utf8', mode: JOURNAL_FILE_MODE });
    renameSync(tmp, join(dir, `${id}.json`));
    pruneSessions(dir);
    return id;
  } catch {
    return null;
  }
}

/**
 * Incremental journal writer for one agent run: the RESUME-aware counterpart of
 * `saveSession`. Persists the SAME per-cwd session file shape (plus the additive
 * `resume` field) at every completed step boundary and on finalize, atomically
 * (temp+rename), so an interrupt or crash leaves a resumable record. Reopening
 * an interrupted session keeps its id - new changes append to the same journal,
 * so `spycore rewind` spans the resume boundary in one lineage.
 *
 * All writes are best-effort: a journal failure must never break the run.
 */
export interface RunRecorder {
  readonly id: string;
  recordChange(change: RecordedChange): void;
  /**
   * F-2c-48 · `C-UX45` - MANY RECORDS, ONE JOURNAL COMMIT.
   *
   * `persist()` re-serialises and rewrites the WHOLE journal, so recording N
   * changes one at a time rewrites it N times: record `i` costs O(i) and the run
   * costs O(N²). Measured at the predecessor commit, 4 KB per record:
   *
   * N=25 7.3 ms · N=50 19.7 ms · N=100 54.7 ms · N=200 150.8 ms · N=400 504.6 ms
   * fitted t(N) = 0.270·N + 0.002436·N² ms - the quadratic term overtakes the
   * per-call constant at N ≈ 111, which is why the measured doubling ratio is
   * ~2.75x rather than the 4x a pure quadratic would show.
   *
   * N is the number of records in ONE run journal, and nothing bounded it. The
   * workspace observer is what makes it large in a single step - one opaque call
   * that touches K files hands over K records at once (measured: one call, 120
   * records, 57 % of the whole run spent inside the recorder). Extrapolated on the
   * fit, an ordinary `prettier --write .` over 2,000 files costs 10.3 s and 8.2 GB
   * of journal rewrites; at the observer's own `DELTA_MAX_FILES` cap, 819 GB.
   *
   * A batch is persisted ONCE, at the end of the synchronous burst that produced
   * it - which is the first moment the batch exists as a complete fact, so nothing
   * is exposed to a crash that was not already. The journal it writes is identical
   * to the one the per-record path writes; `observer-window.test.ts` asserts that
   * rather than assuming it.
   */
  recordChanges(changes: readonly RecordedChange[]): void;
  changes(): RecordedChange[];
  changeCount(): number;
  /** Merge resume-state fields and persist (once a conversation or a change exists). */
  update(patch: Partial<Omit<ResumeState, 'version' | 'status' | 'updatedAt'>>): void;
  /** Final write: 'completed' with zero changes removes the file (matching the
   * no-file behavior of completed changeless runs); anything else persists. */
  finalize(status: 'interrupted' | 'completed'): void;
  /** finalize('interrupted') unless already finalized - for error/teardown paths. */
  abandon(): void;
  /** Current in-memory resume state (banner + tests). */
  state(): ResumeState;
}

type ResumeInitial = Pick<
  ResumeState,
  'providerKind' | 'model' | 'planMode' | 'maxTurns' | 'budget' | 'gitHead'
>;

function makeRecorder(
  cwd: string,
  task: string,
  id: string,
  startedAt: string,
  /**
   * Held ALREADY HASHED. `persist()` used to re-hash every prior record on every
   * write - 35 % of the quadratic, measured by decomposition (re-hash 35 %,
   * `JSON.stringify` 54 %, rewrite 11 %). `afterSha` is a pure function of
   * `after`, so hashing once at record time is the same journal for a third of the
   * work, and it is the half that batching cannot remove.
   */
  changes: FileChange[],
  resume: ResumeState,
): RunRecorder {
  let finalized = false;
  let pruned = false;
  const persist = (): void => {
    // Nothing worth recording yet: no conversation to re-bind and no file
    // changes to guard. Keeps plan-only / not-yet-started runs off disk.
    if (resume.conversationId === null && changes.length === 0) return;
    try {
      const dir = checkpointDirFor(cwd);
      mkdirSync(dir, { recursive: true, mode: JOURNAL_DIR_MODE });
      tightenJournalDir(dir);
      const session: CheckpointSession = {
        id,
        cwd,
        startedAt,
        task,
        changes,
        resume: { ...resume, updatedAt: new Date().toISOString() },
      };
      const tmp = join(dir, `.${id}.json.tmp`);
      writeFileSync(tmp, JSON.stringify(session), { encoding: 'utf8', mode: JOURNAL_FILE_MODE });
      renameSync(tmp, join(dir, `${id}.json`));
      if (!pruned) {
        pruned = true;
        pruneSessions(dir);
      }
    } catch {
      /* best-effort - never break the run */
    }
  };
  return {
    id,
    recordChange(change) {
      changes.push({ ...change, afterSha: sha256(change.after) });
      if (!finalized) persist();
    },
    recordChanges(list) {
      if (list.length === 0) return;
      for (const change of list) changes.push({ ...change, afterSha: sha256(change.after) });
      if (!finalized) persist();
    },
    changes: () => changes,
    changeCount: () => changes.length,
    update(patch) {
      Object.assign(resume, patch);
      if (!finalized) persist();
    },
    finalize(status) {
      if (finalized) return;
      finalized = true;
      resume.status = status;
      if (status === 'completed' && changes.length === 0) {
        // Match today's behavior: a completed run with no changes leaves no file.
        try {
          const file = join(checkpointDirFor(cwd), `${id}.json`);
          if (existsSync(file)) unlinkSync(file);
        } catch {
          /* ignore */
        }
        return;
      }
      finalized = false; // let persist() run once more with the final status
      persist();
      finalized = true;
    },
    abandon() {
      if (!finalized) this.finalize('interrupted');
    },
    state: () => ({ ...resume, loadedSkills: [...resume.loadedSkills] }),
  };
}

/** Start a fresh incrementally-persisted run journal. */
export function createRunRecorder(input: { cwd: string; task: string; initial: ResumeInitial }): RunRecorder {
  const id = nextSessionId();
  const resume: ResumeState = {
    version: 1,
    status: 'running',
    conversationId: null,
    nativeTools: false,
    approvedPlan: null,
    turnsCompleted: 0,
    loadedSkills: [],
    updatedAt: new Date().toISOString(),
    ...input.initial,
  };
  return makeRecorder(input.cwd, input.task, id, new Date().toISOString(), [], resume);
}

/** Re-hash only what the persisted record could not supply - a resumed journal
 * already carries `afterSha` for every change it wrote. */
function withSha(c: FileChange | RecordedChange): FileChange {
  const existing = (c as FileChange).afterSha;
  return typeof existing === 'string' && existing.length > 0
    ? (c as FileChange)
    : { ...c, afterSha: sha256(c.after) };
}

/**
 * Reopen an interrupted session for a resumed run: same id, same journal, same
 * lineage. Null when the session carries no valid resume record.
 */
export function reopenRunRecorder(session: CheckpointSession): RunRecorder | null {
  const prior = getResumeState(session);
  if (!prior) return null;
  const resume: ResumeState = { ...prior, status: 'running', loadedSkills: [...prior.loadedSkills] };
  const changes: FileChange[] = session.changes.map(withSha);
  return makeRecorder(session.cwd, session.task, session.id, session.startedAt, changes, resume);
}

function pruneSessions(dir: string): void {
  try {
    const active = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (active.length <= MAX_SESSIONS_PER_CWD) return;
    const sorted = active.sort(compareSessionIdsNewestFirst);
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
    // Session-level fields are used unguarded downstream: listSessions sorts
    // on `id` via numericPrefix (`id.split`), rewind --list renders `task`
    // (truncate does `s.length`) and `startedAt` (relTime is tolerant of
    // anything Date.parse rejects, so a MISSING startedAt is harmless and
    // stays listable — an existing pin writes journals without it — but a
    // PRESENT non-string startedAt is corrupt data and drops the session).
    // A hand-edited journal with a non-string id used to throw inside the
    // sort and poison the whole listing, even though every other session
    // was fine. Drop the corrupt session like any other corrupt one.
    if (typeof data.id !== 'string' || typeof data.task !== 'string') {
      return null;
    }
    if (data.startedAt !== undefined && typeof data.startedAt !== 'string') {
      return null;
    }
    // Validate every change entry: a hand-edited or corrupt journal with a
    // non-string `path`/`before` used to reach `planRewind`, where
    // `sha256(before)` or `currentSha(path)` threw on the bad type. Invalid
    // entries are dropped - the session survives with the valid ones - and
    // an entry whose `afterSha` is absent or is not the sha of its `after`
    // is repaired, so the rewind guard compares against the true content
    // hash instead of trusting a value the journal merely asserts.
    const changes: FileChange[] = [];
    for (const c of data.changes as unknown[]) {
      if (!c || typeof c !== 'object') continue;
      const ch = c as Partial<FileChange>;
      if (typeof ch.path !== 'string') continue;
      if (ch.op !== 'create' && ch.op !== 'modify' && ch.op !== 'delete') continue;
      if (ch.before !== null && typeof ch.before !== 'string') continue;
      if (typeof ch.after !== 'string') continue;
      const afterSha =
        typeof ch.afterSha === 'string' && ch.afterSha === sha256(ch.after)
          ? ch.afterSha
          : sha256(ch.after);
      changes.push({ path: ch.path, op: ch.op, before: ch.before, after: ch.after, afterSha });
    }
    return { ...data, changes };
  } catch {
    return null;
  }
}

/** Active (not-yet-rewound) sessions for `cwd`, newest first. */
export function listSessions(cwd: string): CheckpointSession[] {
  const dir = checkpointDirFor(cwd);
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
    .sort((a, b) => compareSessionIdsNewestFirst(a.id, b.id));
}

export function latestSession(cwd: string): CheckpointSession | null {
  return listSessions(cwd)[0] ?? null;
}

export function loadSession(cwd: string, id: string): CheckpointSession | null {
  // Validate id to prevent path traversal (mirrors branchSession).
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const file = join(checkpointDirFor(cwd), `${id}.json`);
  return existsSync(file) ? parseSession(file) : null;
}

/** Load a session that was marked done (renamed to `.json.done` by undo). */
export function loadDoneSession(cwd: string, id: string): CheckpointSession | null {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  const file = join(checkpointDirFor(cwd), `${id}.json.done`);
  return existsSync(file) ? parseSession(file) : null;
}

/** Mark a session rewound (rename to `.json.done`) so it isn't re-applied. */
export function markSessionDone(cwd: string, id: string): void {
  try {
    const src = join(checkpointDirFor(cwd), `${id}.json`);
    if (existsSync(src)) renameSync(src, join(checkpointDirFor(cwd), `${id}.json.done`));
  } catch {
    /* ignore */
  }
}

/** Mark a session as active again (rename `.json.done` back to `.json`). */
export function markSessionActive(cwd: string, id: string): void {
  try {
    const src = join(checkpointDirFor(cwd), `${id}.json.done`);
    if (existsSync(src)) renameSync(src, join(checkpointDirFor(cwd), `${id}.json`));
  } catch {
    /* ignore */
  }
}

/**
 * Branch a checkpoint session (copy with a new ID).
 * Creates a new session file that is a copy of the source, allowing the user
 * to try a different approach from the same starting point.
 * Returns the new session ID, or null if the source doesn't exist.
 *
 * Validates sourceId (prevents traversal), uses 0o600 mode (privacy),
 * and atomic tmp+rename (prevents corrupt partial writes).
 */
export function branchSession(cwd: string, sourceId: string): string | null {
  try {
    // Validate sourceId to prevent path traversal.
    if (!/^[A-Za-z0-9_-]+$/.test(sourceId)) {
      return null;
    }
    const dir = checkpointDirFor(cwd);
    // Try active (.json) first, then done (.json.done).
    let src = join(dir, `${sourceId}.json`);
    if (!existsSync(src)) {
      src = join(dir, `${sourceId}.json.done`);
      if (!existsSync(src)) return null;
    }
    const newId = nextSessionId();
    const dest = join(dir, `${newId}.json`);
    const content = readFileSync(src, 'utf-8');
    const session = JSON.parse(content) as CheckpointSession;
    // Update the ID and timestamp for the branch, and record the lineage so
    // the fork references its parent (used by `conversations fork` and /fork).
    session.id = newId;
    session.startedAt = new Date().toISOString();
    session.parentId = sourceId;
    // Atomic write with 0o600 (owner-only, like the main session writer).
    const tmp = `${dest}.tmp`;
    writeFileSync(tmp, JSON.stringify(session, null, 2), { encoding: 'utf-8', mode: JOURNAL_FILE_MODE });
    renameSync(tmp, dest);
    // A branch is a new session: it counts toward the per-cwd cap, so prune
    // here like every other writer, or branches alone could grow the
    // directory past MAX_SESSIONS_PER_CWD without any save ever pruning it.
    pruneSessions(dir);
    return newId;
  } catch {
    return null;
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
    } else if (change.op === 'delete') {
      // The guard is "still absent", not a content hash - there is no content
      // to hash. If anything has taken the path since (the user restored it from
      // git, a later step recreated it), that is a state the agent did not
      // leave, so the same no-clobber rule applies and the step is skipped.
      if (cur !== null) {
        steps.push({ change, action: 'skip', reason: 'recreated since the agent ran' });
      } else {
        steps.push({ change, action: 'restore' });
        sim.set(change.path, sha256(change.before ?? ''));
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
 * Remove now-empty directories above a deleted created file, walking up to -
 * but never including - the session cwd. The agent's writes mkdir parents
 * implicitly (writeAtomic), so a faithful rewind must take those empty dirs
 * back out, or `rewind` leaves `data/`, `out/`, … skeletons behind. A parent
 * that still has any entry is left alone (and stops the walk). Limitation:
 * we don't journal directory creation, so a directory that existed EMPTY
 * before the run and only ever held created files is pruned too - losing an
 * empty pre-existing dir is the lesser error versus keeping run debris.
 */
function pruneEmptyDirs(filePath: string, stopDir: string): void {
  const stop = resolve(stopDir);
  const inside = containmentBound(stop);
  let dir = dirname(resolve(filePath));
  while (dir !== stop && dir.startsWith(stop + sep)) {
    // The lexical bound above says the SPELLING is under the session cwd; it
    // says nothing about where the directory IS. Measured before this line
    // existed: replacing a journaled parent with a symlink out of the workspace
    // made this loop `rmdirSync` a directory OUTSIDE it - a destructive
    // operation bounded by string comparison alone. Resolved containment is
    // re-checked EVERY iteration, not once, because each step up the chain is a
    // different directory and any one of them may be the link.
    if (!inside(dir)) break;
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
 * `cwd` - the session's working directory - is the containment boundary for
 * EVERY sink here and bounds empty-parent pruning for deleted creates.
 *
 * F-2c-40 - THE DATA-LOSS PATH, CLOSED AT THE SINK. `F3-N10` was a write
 * OUTSIDE the workspace, with content the agent chose, performed by the command
 * a user runs precisely when something has already gone wrong. It is fixed at
 * BOTH ends: the predicate (`path-containment.ts`, which no longer calls a
 * dangling symlink "inside") and here.
 *
 * AND `cwd` IS NO LONGER OPTIONAL. It was, and the check was written as
 * `if (inside && …)` - so a call that omitted it silently had NO boundary at
 * all. Two of the four sinks below were additionally unguarded even when it was
 * supplied. The class is now closed by CONSTRUCTION: there is one guard, it runs
 * before the switch, and the type system will not let a caller skip the
 * boundary. Every existing call site was updated to pass one.
 *
 * THE FOUR SINKS, counted (F-2c-40 §3d):
 * 1. `unlinkSync`   - delete a file the agent created        ✔ guarded (was NOT)
 * 2. `pruneEmptyDirs` → `rmdirSync`                          ✔ guarded per iteration (was)
 * 3. `mkdirSync` + `writeFileSync` - the `op:'delete'` arm    ✔ guarded (was, and this is F3-N10's sink)
 * 4. `writeFileSync` - the ordinary restore                  ✔ guarded (was NOT)
 */
export function applyRewind(steps: RestoreStep[], cwd: string): { restored: number; skipped: number } {
  let restored = 0;
  let skipped = 0;
  const inside = containmentBound(resolve(cwd));
  /**
   * BELT AND BRACES, AND THE TWO HALVES FAIL DIFFERENTLY. Containment answers
   * "where does this path resolve to"; this answers "is the thing at the leaf a
   * link at all". A restore is putting back a file the agent's own journal says
   * it changed, and the agent never leaves a symlink there - `writeAtomic`
   * renames over one. So a symlink at the leaf means something ELSE put it
   * there between the run and the rewind, which is exactly the state where
   * following it is wrong however it resolves.
   */
  const leafIsSymlink = (p: string): boolean => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false; // absent - that is the normal case for a delete-restore
    }
  };
  for (const step of steps) {
    if (step.action === 'skip') {
      skipped += 1;
      continue;
    }
    // ONE GUARD, BEFORE THE SWITCH, SO NO ARM CAN BE ADDED WITHOUT IT. The
    // previous shape put the check inside a single arm, and the next arm added
    // - this diff's own `op:'delete'` restore - is precisely how `F-N2d` went
    // from "unreachable defence-in-depth" to a live data-loss path.
    if (!inside(step.change.path) || leafIsSymlink(step.change.path)) {
      skipped += 1;
      continue;
    }
    try {
      if (step.action === 'delete') {
        if (existsSync(step.change.path)) unlinkSync(step.change.path);
        pruneEmptyDirs(step.change.path, cwd);
      } else if (step.change.op === 'delete') {
        // RE-CREATING A FILE IS THE ONLY RESTORE THAT CAN MAKE A PATH EXIST
        // WHERE NOTHING DID, so it is the only one that may need to make
        // DIRECTORIES too - and a `mkdir -p` down a path is exactly where a
        // symlinked segment turns a bounded write into an unbounded one.
        mkdirSync(dirname(step.change.path), { recursive: true });
        // TOCTOU: the containment check above ran BEFORE the mkdir, when
        // the parent directories may not have existed at all - a symlinked
        // segment swapped in between the check and the write would redirect
        // this write outside the workspace. Re-check containment AND the
        // leaf symlink immediately before the write; a failed re-check
        // skips the step. (The mkdir itself can create empty directories
        // through a pre-existing symlink - no content is written there,
        // and the file write below is what the guard protects.)
        if (!inside(step.change.path) || leafIsSymlink(step.change.path)) {
          skipped += 1;
          continue;
        }
        writeFileSync(step.change.path, step.change.before ?? '', 'utf8');
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

/**
 * Plan a redo (re-apply the `after` content, reversing an undo).
 *
 * Mirrors `planRewind` but in the opposite direction: the guard checks that
 * the file is still in the UNDONE state (matches `before`), not that it
 * matches `afterSha`. If the user modified the file after undo, the step is
 * skipped to avoid destroying their edits.
 *
 * Threads the expected content through a sim map (like planRewind) so
 * multi-change sessions (create→modify, modify→modify) redo correctly.
 */
export function planRedo(session: CheckpointSession): RestoreStep[] {
  const steps: RestoreStep[] = [];
  const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
  const currentSha = (path: string): string | null => {
    try {
      if (!existsSync(path)) return null;
      return sha256(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  };

  // Sim map threads expected content through the chain, so a
  // create→modify of the same path redoes correctly (like planRewind).
  const sim = new Map<string, string | null>(); // path → expected sha (null = deleted)
  const expected = (path: string): string | null =>
    sim.has(path) ? (sim.get(path) ?? null) : currentSha(path);

  for (const change of session.changes) {
    const cur = expected(change.path);
    const beforeSha = change.before === null ? null : sha256(change.before);
    // Existence guards FIRST, before the sha guard: for a real journal a
    // create always has `before` null, so a recreated file fails the sha
    // guard (`cur !== null` vs `beforeSha === null`) and used to be
    // misreported "modified since undo" - the inner existence checks below
    // the guard could never fire. Checked first, a recreated file is
    // reported "recreated since undo" and a re-deleted file "deleted since
    // undo", and the sha guard below keeps its "modified since undo" meaning.
    if (change.op === 'create' && cur !== null) {
      steps.push({ change, action: 'skip', reason: 'recreated since undo' });
      continue;
    }
    if (change.op === 'delete' && cur === null) {
      steps.push({ change, action: 'skip', reason: 'deleted since undo' });
      continue;
    }
    // Guard: file must still be in the undone state (matches `before`).
    // If user modified it after undo, skip to avoid destroying edits.
    if (cur !== beforeSha) {
      steps.push({ change, action: 'skip', reason: 'modified since undo' });
      continue;
    }
    if (change.op === 'create') {
      // Agent created the file - redo recreates it with `after` content.
      steps.push({ change, action: 'restore' });
      sim.set(change.path, sha256(change.after));
    } else if (change.op === 'delete') {
      // Agent deleted the file - redo deletes it again.
      steps.push({ change, action: 'delete' });
      sim.set(change.path, null);
    } else {
      // Agent modified the file - redo writes the `after` content.
      steps.push({ change, action: 'restore' });
      sim.set(change.path, sha256(change.after));
    }
  }
  return steps;
}

/**
 * Apply a redo plan (re-apply `after` content).
 *
 * Mirrors `applyRewind` with the same safety guards: containment boundary,
 * symlink-leaf refusal. The `restore` action writes `after` (not `before`).
 * Uses the hardened module-level pruneEmptyDirs (not an inline copy).
 */
export function applyRedo(steps: RestoreStep[], cwd: string): { restored: number; skipped: number } {
  let restored = 0;
  let skipped = 0;
  const inside = containmentBound(resolve(cwd));
  const leafIsSymlink = (p: string): boolean => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };

  for (const step of steps) {
    if (step.action === 'skip') {
      skipped += 1;
      continue;
    }
    if (!inside(step.change.path) || leafIsSymlink(step.change.path)) {
      skipped += 1;
      continue;
    }
    try {
      if (step.action === 'delete') {
        if (existsSync(step.change.path)) unlinkSync(step.change.path);
        // Use the hardened module-level pruneEmptyDirs.
        pruneEmptyDirs(step.change.path, cwd);
      } else if (step.change.op === 'create') {
        // Redo of a create: recreate with `after` content.
        mkdirSync(dirname(step.change.path), { recursive: true });
        // TOCTOU, same as applyRewind's delete arm: re-check containment
        // and the leaf symlink after the mkdir, immediately before the
        // write.
        if (!inside(step.change.path) || leafIsSymlink(step.change.path)) {
          skipped += 1;
          continue;
        }
        writeFileSync(step.change.path, step.change.after, 'utf8');
      } else {
        // Redo of a modify: write the `after` content.
        // (op='delete' with action='restore' is unreachable - planRedo maps it to 'delete'.)
        writeFileSync(step.change.path, step.change.after, 'utf8');
      }
      restored += 1;
    } catch {
      skipped += 1;
    }
  }
  return { restored, skipped };
}
