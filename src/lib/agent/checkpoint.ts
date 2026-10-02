/**
 * Checkpoint journal + rewind logic for the agent.
 *
 * A run's records are grouped into one session, persisted per-cwd under the CLI
 * config dir. `spycore rewind` reads the newest session and safely reverses it —
 * never clobbering edits the user made after the agent ran (a sha256 guard skips
 * any file whose content changed since).
 *
 * ⭐ WHAT REACHES THE JOURNAL, and by which of the two routes:
 *   - `write_file` / `edit_file` REPORT THEMSELVES: they know the resolved
 *     target and both contents, so they call `ctx.recordChange` directly
 *     (`tools.ts` `applyMutation`).
 *   - `run_command`, every MCP tool, and hooks that run around a tool call are
 *     OPAQUE — they hand work to another process. They are journaled by
 *     OBSERVATION: `agent/workspace-delta.ts` takes a bounded before/after
 *     picture of the workspace around the call and turns the difference into the
 *     same `RecordedChange` values. ⭐ One journal, one format, one rewind: the
 *     observer is a second SOURCE, never a second recorder.
 *
 * ⭐⭐ AND WHAT DOES NOT, which is a property of the design and not an omission:
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
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { containmentBound } from '../path-containment.js';
import { getConfigPath } from '../config.js';

/**
 * ⭐ `'delete'` ARRIVED WITH THE WORKSPACE OBSERVER. The write/edit tools can
 * only create or modify, so two ops were the whole world. `run_command` and MCP
 * tools delete files, and a journal that cannot express a deletion cannot undo
 * one — which is most of what "undo everything the last run changed" was
 * promising and not doing.
 *
 * ⭐ FORWARD-COMPATIBILITY, MEASURED RATHER THAN HOPED. A 0.7.0 journal read by
 * an OLDER CLI hits `planRewind`'s `else` branch (everything that is not
 * `'create'` is treated as a modify), where `currentSha` of a deleted file is
 * null and the step is SKIPPED with "file is missing". The old reader therefore
 * declines to act on a record it does not understand, which is the fail-safe
 * direction — it does not mis-restore.
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
}

/** Budget consumption + caps carried across an interrupt (CUMULATIVE — never reset). */
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
 * ⭐⭐ `SPY-416` / R-CLI-1 — THE JOURNAL IS OWNER-ONLY, AND IT SAYS SO ITSELF.
 *
 * A session journal holds the BEFORE and AFTER text of every file a run
 * changed. It was written with `writeFileSync(…, 'utf8')` and no mode argument,
 * so it landed at the process umask — commonly world-readable.
 *
 * ⭐ The numbers are not invented here. They are the ones this package already
 * applies to the file that holds the bearer token, measured at
 * `lib/config.ts:362-363`: `0o600` on the file and `0o700` on its directory.
 * The journal sits under that same configuration directory, so matching it is
 * the only self-consistent answer.
 *
 * ⭐ Applied to EVERY directory level this module creates, not only the leaf:
 * `mkdirSync(…, { recursive: true })` creates `checkpoints/` and the per-cwd
 * directory in one call, and a `mode` given to it applies to both. An
 * owner-only file inside a world-readable directory still leaks the fact and
 * the name of every observed workspace.
 */
const JOURNAL_FILE_MODE = 0o600;
const JOURNAL_DIR_MODE = 0o700;
function cwdDir(cwd: string): string {
  return join(checkpointsRoot(), sha256(cwd));
}
function numericPrefix(id: string): number {
  const n = Number.parseInt(id.split('-')[0] ?? '0', 10);
  return Number.isFinite(n) ? n : 0;
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
 * any failure (never throws — a journal write must not break the agent run).
 */
export function saveSession(input: { cwd: string; task: string; changes: RecordedChange[] }): string | null {
  if (input.changes.length === 0) return null;
  try {
    const dir = cwdDir(input.cwd);
    mkdirSync(dir, { recursive: true, mode: JOURNAL_DIR_MODE });
    const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
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
 * an interrupted session keeps its id — new changes append to the same journal,
 * so `spycore rewind` spans the resume boundary in one lineage.
 *
 * All writes are best-effort: a journal failure must never break the run.
 */
export interface RunRecorder {
  readonly id: string;
  recordChange(change: RecordedChange): void;
  /**
   * ⭐⭐ F-2c-48 · `C-UX45` — MANY RECORDS, ONE JOURNAL COMMIT.
   *
   * `persist()` re-serialises and rewrites the WHOLE journal, so recording N
   * changes one at a time rewrites it N times: record `i` costs O(i) and the run
   * costs O(N²). Measured at the predecessor commit, 4 KB per record:
   *
   *     N=25 7.3 ms · N=50 19.7 ms · N=100 54.7 ms · N=200 150.8 ms · N=400 504.6 ms
   *     fitted t(N) = 0.270·N + 0.002436·N² ms — the quadratic term overtakes the
   *     per-call constant at N ≈ 111, which is why the measured doubling ratio is
   *     ~2.75x rather than the 4x a pure quadratic would show.
   *
   * ⭐ N is the number of records in ONE run journal, and nothing bounded it. The
   * workspace observer is what makes it large in a single step — one opaque call
   * that touches K files hands over K records at once (measured: one call, 120
   * records, 57 % of the whole run spent inside the recorder). Extrapolated on the
   * fit, an ordinary `prettier --write .` over 2,000 files costs 10.3 s and 8.2 GB
   * of journal rewrites; at the observer's own `DELTA_MAX_FILES` cap, 819 GB.
   *
   * ⭐ A batch is persisted ONCE, at the end of the synchronous burst that produced
   * it — which is the first moment the batch exists as a complete fact, so nothing
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
   *  no-file behavior of completed changeless runs); anything else persists. */
  finalize(status: 'interrupted' | 'completed'): void;
  /** finalize('interrupted') unless already finalized — for error/teardown paths. */
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
   * ⭐ Held ALREADY HASHED. `persist()` used to re-hash every prior record on every
   * write — 35 % of the quadratic, measured by decomposition (re-hash 35 %,
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
      const dir = cwdDir(cwd);
      mkdirSync(dir, { recursive: true, mode: JOURNAL_DIR_MODE });
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
      /* best-effort — never break the run */
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
          const file = join(cwdDir(cwd), `${id}.json`);
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
  const id = `${Date.now()}-${randomBytes(4).toString('hex')}`;
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

/** Re-hash only what the persisted record could not supply — a resumed journal
 *  already carries `afterSha` for every change it wrote. */
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
    } else if (change.op === 'delete') {
      // ⭐ The guard is "still absent", not a content hash — there is no content
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
  const inside = containmentBound(stop);
  let dir = dirname(resolve(filePath));
  while (dir !== stop && dir.startsWith(stop + sep)) {
    // ⭐ The lexical bound above says the SPELLING is under the session cwd; it
    // says nothing about where the directory IS. Measured before this line
    // existed: replacing a journaled parent with a symlink out of the workspace
    // made this loop `rmdirSync` a directory OUTSIDE it — a destructive
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
 * `cwd` — the session's working directory — is the containment boundary for
 * EVERY sink here and bounds empty-parent pruning for deleted creates.
 *
 * ⭐⭐ F-2c-40 — THE DATA-LOSS PATH, CLOSED AT THE SINK. `F3-N10` was a write
 * OUTSIDE the workspace, with content the agent chose, performed by the command
 * a user runs precisely when something has already gone wrong. It is fixed at
 * BOTH ends: the predicate (`path-containment.ts`, which no longer calls a
 * dangling symlink "inside") and here.
 *
 * ⭐⭐ AND `cwd` IS NO LONGER OPTIONAL. It was, and the check was written as
 * `if (inside && …)` — so a call that omitted it silently had NO boundary at
 * all. Two of the four sinks below were additionally unguarded even when it was
 * supplied. The class is now closed by CONSTRUCTION: there is one guard, it runs
 * before the switch, and the type system will not let a caller skip the
 * boundary. Every existing call site was updated to pass one.
 *
 * ⭐ THE FOUR SINKS, counted (F-2c-40 §3d):
 *   1. `unlinkSync`   — delete a file the agent created        ✔ guarded (was NOT)
 *   2. `pruneEmptyDirs` → `rmdirSync`                          ✔ guarded per iteration (was)
 *   3. `mkdirSync` + `writeFileSync` — the `op:'delete'` arm    ✔ guarded (was, and this is F3-N10's sink)
 *   4. `writeFileSync` — the ordinary restore                  ✔ guarded (was NOT)
 */
export function applyRewind(steps: RestoreStep[], cwd: string): { restored: number; skipped: number } {
  let restored = 0;
  let skipped = 0;
  const inside = containmentBound(resolve(cwd));
  /**
   * ⭐ BELT AND BRACES, AND THE TWO HALVES FAIL DIFFERENTLY. Containment answers
   * "where does this path resolve to"; this answers "is the thing at the leaf a
   * link at all". A restore is putting back a file the agent's own journal says
   * it changed, and the agent never leaves a symlink there — `writeAtomic`
   * renames over one. So a symlink at the leaf means something ELSE put it
   * there between the run and the rewind, which is exactly the state where
   * following it is wrong however it resolves.
   */
  const leafIsSymlink = (p: string): boolean => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false; // absent — that is the normal case for a delete-restore
    }
  };
  for (const step of steps) {
    if (step.action === 'skip') {
      skipped += 1;
      continue;
    }
    // ⭐ ONE GUARD, BEFORE THE SWITCH, SO NO ARM CAN BE ADDED WITHOUT IT. The
    // previous shape put the check inside a single arm, and the next arm added
    // — this diff's own `op:'delete'` restore — is precisely how `F-N2d` went
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
        // ⭐ RE-CREATING A FILE IS THE ONLY RESTORE THAT CAN MAKE A PATH EXIST
        // WHERE NOTHING DID, so it is the only one that may need to make
        // DIRECTORIES too — and a `mkdir -p` down a path is exactly where a
        // symlinked segment turns a bounded write into an unbounded one.
        mkdirSync(dirname(step.change.path), { recursive: true });
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
