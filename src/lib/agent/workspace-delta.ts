/**
 * THE WORKSPACE OBSERVER - how an OPAQUE mutation gets into the ONE journal.
 *
 * `write_file` and `edit_file` know exactly what they changed, so they report it
 * to `ctx.recordChange` themselves. `run_command`, every MCP tool, and any hook
 * that runs around a tool call are opaque: they hand work to another process and
 * get back an exit code. Nothing in that result says which files moved.
 *
 * THE MEASUREMENT THAT MADE THIS EXIST. Driven through the real
 * `dispatchTool` against a real workspace, with `write_file` as the control:
 *
 * write_file   create newfile.txt      journaled 1   file created
 * edit_file    edit target.txt         journaled 1   file edited
 * run_command  rm victim.txt           journaled 0   FILE GONE
 * run_command  echo made > made.txt    journaled 0   FILE CREATED
 * run_command  sed -i '' …             journaled 0   FILE EDITED
 * mcp__…__write_probe                  journaled 0   FILE CREATED
 * post-tool hook 'echo … > file'       journaled 0   FILE CREATED
 *
 * Five of the seven mutation paths one agent run has were outside the journal,
 * while three shipped documents promised `rewind` undoes "everything the last
 * run changed". This module is how five becomes seven.
 *
 * THIS IS NOT A SECOND RECORDER. It produces `RecordedChange` values and
 * hands them to the SAME `ctx.recordChange` the file tools use, so there is one
 * journal, one format and one rewind. What is new is the OBSERVATION, not the
 * recording - and that distinction is the whole design.
 *
 * WHAT IT CANNOT SEE, stated here rather than discovered later, because a
 * partial capability described precisely beats a total one described falsely:
 *
 * 1. ANYTHING OUTSIDE THE WORKSPACE. The boundary is `cwd`, resolved. A
 * command that writes to `~/.npmrc`, a global cache, or `../sibling` is
 * invisible here and is NOT restorable.
 * 2. ANYTHING THE AGENT'S OWN READ TOOLS CANNOT SEE. The enumeration is
 * deliberately the SAME one `glob`/`grep`/`repo_map` use - `.gitignore`
 * honoured, `node_modules`/`.git`/`build`/`dist` always excluded. So
 * `npm install`'s writes into `node_modules` are out of scope BY DESIGN;
 * journaling them would be a different and much larger promise. Using a
 * second, wider enumeration here would have meant two definitions of "the
 * workspace" in one package, which is the shape this repository has spent
 * four batches removing.
 * 3. ANYTHING THAT IS NOT A FILE'S CONTENT. A `git push`, a network call, a
 * database write, a spawned daemon. Nothing on disk changes, so nothing is
 * seen - and none of it is reversible by restoring bytes anyway.
 * 4. BINARY FILES AND FILES OVER `DELTA_MAX_FILE_BYTES`. A change to one is
 * DETECTED and reported as uncaptured; it is never journaled, because the
 * journal round-trips content as UTF-8 and restoring a binary through it
 * would corrupt the file. Silently mangling a file would be far worse than
 * declining to restore it.
 * 5. A WORKSPACE OVER THE CAPS. Then no snapshot is taken at all and the call
 * runs unjournaled - reported, never silent.
 * 6. WHO made the change, WITHIN a call. The observer sees a before and an
 * after, not an author.  F-2c-48 removed the unbounded part of that
 * exposure - the approval prompt is no longer inside the comparison, see
 * `openPause`/`closePause` - so what remains is the call's own execution,
 * bounded by the command.  AND THE OLD WORDING HERE NAMED A GUARD THAT
 * CANNOT FIRE: it said `planRewind`'s sha guard "still governs every
 * restore", implying it protects against a concurrent edit. It does not.
 * The guard skips a file whose content is not what the run left - and when
 * the concurrent edit happens INSIDE the window, that content IS what the
 * journal recorded as `after`, so the shas match and the restore proceeds.
 * The guard protects against an edit made AFTER the run. Measured, not
 * reasoned: `restored=2 skipped=0` on a call that mutated nothing.
 *
 * COST, MEASURED before the design was chosen rather than assumed: on the
 * tree this was built in (2,468 enumerated files, 27 MB) a full enumerate +
 * read + hash is ~127 ms + ~96 ms; on a single package (295 files, 2.9 MB) it
 * is ~14 ms + ~7 ms. The `after` pass reads content only for files whose hash
 * moved, so the retained bytes are the BEFORE tree plus the changed set.
 *
 * Git-independent, exactly as `checkpoint.ts` requires: node built-ins plus the
 * `globby` the read tools already import. No repository, no index, no stash.
 */
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { containmentBound, realRoot } from '../path-containment.js';
import type { RecordedChange } from './checkpoint.js';
import { loadSecretGuard } from './secrets.js';

/** Directory names always excluded - mirrors `tools.ts` ALWAYS_IGNORE_GLOBS. */
const ALWAYS_IGNORE_GLOBS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/.git',
  '**/.git/**',
  '**/build',
  '**/build/**',
  '**/dist',
  '**/dist/**',
];

/** Most files a workspace may hold before observation is declined. */
export const DELTA_MAX_FILES = 20_000;
/** Most total bytes of retained text before observation is declined. */
export const DELTA_MAX_BYTES = 64 * 1024 * 1024;
/** Largest single file whose content is retained (and therefore restorable). */
export const DELTA_MAX_FILE_BYTES = 2 * 1024 * 1024;

interface Entry {
  /** sha256 of the raw bytes - computed for EVERY file, capturable or not. */
  sha: string;
  /** UTF-8 content; null when the file is binary or over the per-file cap. */
  content: string | null;
}

export interface WorkspaceSnapshot {
  /** The resolved workspace root the snapshot is relative to. */
  root: string;
  /** rel path (posix-ish, as globby returns) → entry. */
  entries: Map<string, Entry>;
  /**
   * F-2c-41 - EVERY PATH THAT EXISTED, whether or not it was CAPTURED.
   *
   * `entries` is what the observer could see and retain. This is what was THERE.
   * The two differ for a file `.gitignore` was hiding, and for a file that was
   * unreadable at the time - and the gap between them was a data-loss path:
   * `diffWorkspace` read "absent from `entries`" as "the command created it",
   * so `rewind` DELETED pre-existing user files. Proved end to end through the
   * shipped journal: an agent asked to stop ignoring the build output edits
   * `.gitignore`, everything it was hiding becomes visible between the two
   * pictures, and every one of those files is journaled `op:'create'`.
   *
   * `null` when the unfiltered enumeration could not be taken. The consumer then
   * journals NO creates at all, because it can no longer prove a file is new -
   * losing the ability to undo a creation is recoverable; deleting a file the
   * user already had is not.
   */
  present: ReadonlySet<string> | null;
}

export interface WorkspaceDelta {
  /** Journalable changes, absolute paths, ready for `ctx.recordChange`. */
  changes: RecordedChange[];
  /**
   * Paths that demonstrably changed but cannot be restored from the journal -
   * binary, or over the per-file cap. Relative, for display.
   */
  uncaptured: string[];
}

/** True for content that is almost certainly not text - mirrors `tools.ts`. */
function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  if (len === 0) return false;
  let suspicious = 0;
  for (let i = 0; i < len; i += 1) {
    const b = buf[i] as number;
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) suspicious += 1;
  }
  return suspicious / len > 0.3;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Enumerate the workspace exactly as the read tools do. Returns null when the
 * enumeration fails or the tree is over `DELTA_MAX_FILES` - the caller treats
 * null as "cannot observe", never as "nothing changed".
 *
 * `followSymbolicLinks: false` is deliberate and is NOT the read tools'
 * setting. They follow links and then post-filter with the containment filter,
 * because a legitimate in-workspace symlink must stay readable. Here the output
 * feeds a journal whose entries are later WRITTEN BACK, so a followed link is a
 * write outside the boundary on the rewind path. Declining to follow is the
 * conservative direction and it costs only the ability to journal changes made
 * through a symlink - which the containment filter below would refuse anyway.
 */
async function listWorkspace(root: string): Promise<string[] | null> {
  try {
    const { globby } = await import('globby');
    const files = await globby(['**/*'], {
      cwd: root,
      gitignore: true,
      dot: true,
      onlyFiles: true,
      ignore: ALWAYS_IGNORE_GLOBS,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
    return files.length > DELTA_MAX_FILES ? null : files;
  } catch {
    return null;
  }
}

/**
 * Enumerate what EXISTS, ignoring `.gitignore` - names only, nothing read.
 *
 * F-2c-41 - WHY THE OBSERVED POPULATION AND THE EXISTING POPULATION MUST BE
 * TWO DIFFERENT QUESTIONS. `listWorkspace` answers "what can this run observe",
 * and its answer MOVES between the two pictures: the observed command need only
 * edit `.gitignore` - an utterly ordinary request - and everything that file was
 * hiding appears in the second picture with no counterpart in the first. Read as
 * "the command created these", that made `spycore rewind` DELETE them.
 *
 * The fix is not to widen observation. It is to stop inferring creation from
 * absence, and creation can only be inferred against a population that does NOT
 * move - which means one that no user-editable file governs.
 *
 * AND IT IS CHEAPER THAN THE WALK IT SUPPLEMENTS, which is the opposite of
 * what was assumed. Measured on this repository, order-fair, three rounds each
 * after warming: `gitignore:true` 2,496 files in **113 ms**; `gitignore:false`
 * 8,398 files in **18 ms** -  **0.16×**, because EVALUATING the ignore rules
 * costs far more than walking the 5,902 extra files they exclude. The cost
 * objection that shaped this module's design does not apply to this call.
 *
 * `ALWAYS_IGNORE_GLOBS` still applies: `node_modules`, `.git`, `build` and
 * `dist` are excluded from BOTH pictures unconditionally, so they are stable and
 * were never part of this defect.
 */
async function listPresent(root: string): Promise<ReadonlySet<string> | null> {
  try {
    const { globby } = await import('globby');
    const files = await globby(['**/*'], {
      cwd: root,
      gitignore: false,
      dot: true,
      onlyFiles: true,
      ignore: ALWAYS_IGNORE_GLOBS,
      followSymbolicLinks: false,
      suppressErrors: true,
    });
    return new Set(files);
  } catch {
    return null; // the caller must then journal no creates - fail closed
  }
}

/**
 * Take the "before" picture. Returns null when the workspace cannot be observed
 * within the caps - the caller must then tell the user the call is unjournaled
 * rather than proceed as if nothing happened.
 */
export async function snapshotWorkspace(cwd: string): Promise<WorkspaceSnapshot | null> {
  const root = realRoot(resolve(cwd));
  const files = await listWorkspace(root);
  if (files === null) return null;
  const inside = containmentBound(root);
  const isSecret = await loadSecretGuard(root);
  const entries = new Map<string, Entry>();
  let bytes = 0;
  for (const rel of files) {
    const abs = join(root, rel);
    if (!inside(abs)) continue;
    let buf: Buffer;
    try {
      // R-CLI-1 - THE SECRET GUARD, AT THE ELEVENTH READER.
      //
      // This module reads the full plaintext of every file the ignore rules do
      // not hide and stores it in the on-disk journal. Every OTHER reader of
      // file content in this package - the file tools, skill and slash-command
      // discovery, the guide and changelog loaders, memory, the repo scan -
      // consults `loadSecretGuard` first. This one did not, so a credential
      // file that is simply not gitignored, or any file in a project with no
      // `.gitignore` at all, had its plaintext copied to disk.
      //
      // It is handled with the module's OWN existing shape for "present but
      // not retained": keep the hash so a CHANGE IS STILL DETECTED, drop the
      // content. `diffWorkspace` then reports the path as UNCAPTURED, which is
      // the same treatment an over-cap or binary file already gets. Nothing is
      // hidden from the user and no detection is lost - only the plaintext.
      //
      // NOT the two-pass redactor in `lib/redact.ts`, and that is measured
      // rather than assumed: that redactor masks values whose KEY matches a
      // secret-key pattern, and a journal entry's keys are `path`, `before`,
      // `after`, `op`. Driven over a realistic session payload it changes
      // nothing at all and a live-shaped credential survives verbatim. Wiring
      // it here would have shipped a control that cannot fire.
      if (isSecret(abs)) {
        entries.set(rel, { sha: sha256(readFileSync(abs)), content: null });
        continue;
      }
      if (statSync(abs).size > DELTA_MAX_FILE_BYTES) {
        // Too big to retain: hash it so a CHANGE is still detectable, and let
        // the diff report it as uncaptured rather than pretend it is unchanged.
        entries.set(rel, { sha: sha256(readFileSync(abs)), content: null });
        continue;
      }
      buf = readFileSync(abs);
    } catch {
      continue; // unreadable - treated as absent in both passes, so symmetric
    }
    const binary = looksBinary(buf);
    bytes += binary ? 0 : buf.byteLength;
    if (bytes > DELTA_MAX_BYTES) return null;
    entries.set(rel, { sha: sha256(buf), content: binary ? null : buf.toString('utf8') });
  }
  return { root, entries, present: await listPresent(root) };
}

/**
 * F-2c-48 - THE PAUSE, AND WHY THE BASELINE HAS TO MOVE WITH IT.
 *
 * `C-LC8`: the observation window encloses the approval prompt, so a human
 * decision of unbounded length sits INSIDE the before/after bracket. Anything
 * that writes during those seconds - most obviously the user, in another window -
 * is a difference the observer sees and cannot attribute, so it was journaled as
 * the call's own work. Measured through the shipped journal at the predecessor
 * commit: a `run_command true` that mutates NOTHING journaled the user's edit as
 * `modify` and the user's new file as `create`, and `spycore rewind` then reverted
 * the edit and DELETED the file, `restored=2 skipped=0`.
 *
 * AND THE GUARD THE SHIPPED TEXT NAMED CANNOT FIRE HERE. `planRewind` skips a
 * file "whose content is not what the run left" by comparing the on-disk sha
 * against the journal's `afterSha`. When the foreign write happens INSIDE the
 * window, the foreign content IS `after`, so the shas match and the restore
 * proceeds. That guard protects against an edit made AFTER the run; it is
 * structurally blind to one made DURING it.
 *
 * WHY RE-BASE RATHER THAN MOVE THE SNAPSHOT. Taking the "before" picture after
 * approval is one line and it is wrong: the pre-tool hook runs BEFORE the prompt
 * (measured - at the prompt its file is already on disk), so its writes would fall
 * out of the window and `SECURITY.md`'s "Only pre-tool and post-tool hooks are
 * covered" would become false. Re-basing keeps the bracket spanning the whole
 * hook/dispatch/hook sequence and removes only the pause from it.
 *
 * AND WHY A STAT CENSUS RATHER THAN A SECOND PICTURE. Priced on one 2,500-file
 * workspace before either was written: a full read+hash pass is 95.5 ms, while
 * statting the paths the baseline already lists plus the cheap unfiltered
 * enumeration is 6.6 ms - 0.07x. Re-taking the picture at both ends of the pause
 * costs 2.00x the whole window; this costs 1.03x.
 *
 * WHAT IT STRUCTURALLY CANNOT SEE, stated here rather than discovered later:
 * a foreign write that leaves BOTH the byte length and the modification time
 * unchanged. `mtimeMs` carries sub-millisecond resolution on every filesystem this
 * package supports and a human pause is hundreds of milliseconds at minimum, so
 * this needs a deliberately crafted `utimes` call rather than an ordinary edit -
 * but it is a gap, not an impossibility, and a gap named is a gap a later reader
 * can close.
 */
export interface PauseCensus {
  /** size + mtimeMs for every path the baseline CAPTURED, at the pause's start. */
  stats: ReadonlyMap<string, { size: number; mtimeMs: number }>;
  /** The unfiltered name set at the pause's start; null when it could not be taken. */
  present: ReadonlySet<string> | null;
}

/**
 * Open a pause: the cheap picture. Nothing is read and nothing is hashed - the
 * only questions asked are "how big" and "when touched", plus the same
 * gitignore-free name walk `listPresent` already performs, which is what makes a
 * file CREATED during the pause visible at all.
 */
export async function openPause(before: WorkspaceSnapshot): Promise<PauseCensus> {
  const stats = new Map<string, { size: number; mtimeMs: number }>();
  for (const rel of before.entries.keys()) {
    try {
      const st = statSync(join(before.root, rel));
      stats.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
    } catch {
      // Unreadable now: leave it out, so `closePause` does not read its absence
      // as a change made during the pause when it was already gone.
    }
  }
  return { stats, present: await listPresent(before.root) };
}

/**
 * Close a pause by folding everything that happened during it INTO the baseline,
 * so the delta taken afterwards describes the call and nothing else.
 *
 * Returns the relative paths that were re-based, for the caller's notice. An empty
 * array is the overwhelmingly common answer and costs one stat per captured file.
 *
 * Folding IN rather than excluding is deliberate. If the user edits a file
 * during the pause and the command then edits it too, the journal's `before` must
 * be what the user had - that is the content `rewind` should restore. Excluding
 * the path instead would lose the ability to undo the command's own change; and
 * journaling a foreign CREATE as a create is the case that makes `rewind` delete
 * the user's new file, which is the data-loss half of this defect.
 */
export async function closePause(
  before: WorkspaceSnapshot,
  census: PauseCensus,
): Promise<string[]> {
  const { root } = before;
  const inside = containmentBound(root);
  const isSecret = await loadSecretGuard(root);
  const rebased: string[] = [];
  /** Retain no more than the snapshot's own budget allows. */
  let budget = DELTA_MAX_BYTES;
  for (const e of before.entries.values()) budget -= e.content?.length ?? 0;

  /** Read one path into an entry under the snapshot's own capture rules. */
  const capture = (abs: string): Entry | null => {
    try {
      // - the same guard as the snapshot pass. A class closed at
      // one site is not a class closed, and the pause rebases the BASELINE, so
      // a guard here only in the snapshot would let a secret file's plaintext
      // in through the rebase instead.
      if (isSecret(abs)) return { sha: sha256(readFileSync(abs)), content: null };
      if (statSync(abs).size > DELTA_MAX_FILE_BYTES) {
        return { sha: sha256(readFileSync(abs)), content: null };
      }
      const buf = readFileSync(abs);
      const binary = looksBinary(buf);
      if (!binary) {
        if (buf.byteLength > budget) return null; // over the retained-bytes cap
        budget -= buf.byteLength;
      }
      return { sha: sha256(buf), content: binary ? null : buf.toString('utf8') };
    } catch {
      return null;
    }
  };

  // 1. Paths the baseline captured whose bytes may have moved during the pause.
  for (const [rel, at] of census.stats) {
    const abs = join(root, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      // Gone during the pause: drop it, or the delta reports a deletion the call
      // did not perform and `rewind` writes the file back.
      before.entries.delete(rel);
      rebased.push(rel);
      continue;
    }
    if (st.size === at.size && st.mtimeMs === at.mtimeMs) continue;
    const entry = capture(abs);
    if (entry === null) {
      // Cannot retain it now. Dropping the entry would make the delta read the
      // path as CREATED, so keep it out of `entries` and let the diff report it
      // as uncaptured - losing an undo, never inventing a create.
      before.entries.delete(rel);
      rebased.push(rel);
      continue;
    }
    before.entries.set(rel, entry);
    rebased.push(rel);
  }

  // 2. Names that appeared during the pause. Invisible to step 1 by construction -
  // a census over the baseline's own paths cannot see a path that had none.
  const nowPresent = await listPresent(root);
  if (census.present !== null && nowPresent !== null) {
    /**
     * ONLY WHAT APPEARED DURING THE PAUSE MAY JOIN THE BASELINE, AND THE
     * COVERAGE FENCE CAUGHT THE FIRST DRAFT OF THIS.
     *
     * The first version replaced `present` wholesale with `nowPresent`. That is
     * one line and it is wrong: the PRE-TOOL HOOK runs before the pause opens, so
     * a file it created is already in `nowPresent`. Absorbing the whole set made
     * that file "already there", so the delta stopped journaling it as a create
     * and reported it as uncaptured instead - silently deleting the pre-tool-hook
     * coverage `SECURITY.md` promises. `observer-window.test.ts`'s pre-hook cell
     * went red on exactly that, which is what a coverage fence is for.
     *
     * The pause's own arrivals are `nowPresent \ census.present`, and nothing else.
     */
    const grown = new Set(before.present ?? []);
    for (const rel of nowPresent) {
      if (census.present.has(rel)) continue; // present before the pause: not ours
      grown.add(rel);
      if (before.entries.has(rel)) continue;
      const abs = join(root, rel);
      if (!inside(abs)) continue;
      const entry = capture(abs);
      if (entry !== null) before.entries.set(rel, entry);
      rebased.push(rel);
    }
    if (before.present !== null) before.present = grown;
  }

  rebased.sort((a, b) => a.localeCompare(b));
  return rebased;
}

/**
 * One line naming what changed under the observer's feet while the run was paused
 * at an approval prompt. Those changes are deliberately NOT attributed to the
 * call, and saying so is cheaper than letting a user wonder why their edit is
 * absent from `spycore rewind`.
 */
export function pauseNotice(rebased: readonly string[]): string | null {
  if (rebased.length === 0) return null;
  const shown = rebased.slice(0, 3).join(', ');
  const more = rebased.length > 3 ? ` (+${rebased.length - 3} more)` : '';
  return `${rebased.length} file${rebased.length === 1 ? '' : 's'} changed while this call was waiting for approval and ${rebased.length === 1 ? 'was' : 'were'} left out of the run's journal: ${shown}${more}`;
}

/**
 * Take the "after" picture and produce the delta. Content is read only for
 * files whose hash moved, so the second pass retains the changed set rather
 * than the whole tree.
 *
 * `alreadyJournaled` holds absolute paths the tool reported itself (the
 * `write_file` / `edit_file` path inside the same window). They are skipped so
 * one change can never be journaled twice - which would make `rewind` restore
 * an intermediate state.
 */
export async function diffWorkspace(
  before: WorkspaceSnapshot,
  alreadyJournaled: ReadonlySet<string>,
): Promise<WorkspaceDelta> {
  const { root } = before;
  const changes: RecordedChange[] = [];
  const uncaptured: string[] = [];
  const files = await listWorkspace(root);
  if (files === null) return { changes, uncaptured };
  const inside = containmentBound(root);
  const seen = new Set<string>();
  /**
   * F-2c-41 - THE TWO GUARDS BELOW, AND WHY THERE ARE TWO.
   *
   * The observed population moves between the pictures, and it moves in BOTH
   * directions. A file `.gitignore` stops hiding appears with no prior and was
   * read as CREATED; a file `.gitignore` starts hiding disappears and is read as
   * DELETED. Fixing only the first would close the data-loss half of one defect
   * and leave its mirror writing a delete record for a file that is still there
   * - which is the "class closed at one site is not a class closed" shape this
   * arc has now paid for twice.
   */
  const wasPresent = before.present;
  const nowPresent = await listPresent(root);
  // - the THIRD capture site. The snapshot's guard covers a file
  // that existed when the window opened; this covers one CREATED inside it,
  // which has no prior entry at all and would otherwise be journaled whole.
  const isSecret = await loadSecretGuard(root);

  for (const rel of files) {
    const abs = join(root, rel);
    if (!inside(abs)) continue;
    seen.add(rel);
    if (alreadyJournaled.has(abs)) continue;
    const prior = before.entries.get(rel);
    let buf: Buffer;
    let oversize = false;
    try {
      oversize = statSync(abs).size > DELTA_MAX_FILE_BYTES;
      buf = readFileSync(abs);
    } catch {
      continue;
    }
    const sha = sha256(buf);
    if (prior && prior.sha === sha) continue; // unchanged - the common case
    const binary = looksBinary(buf);
    if (binary || oversize || isSecret(abs) || (prior && prior.content === null)) {
      uncaptured.push(rel);
      continue;
    }
    if (!prior) {
      // NO PRIOR ENTRY IS NOT EVIDENCE OF CREATION. It means the observer did
      // not CAPTURE the file before - which is also true of a file that was
      // gitignored then, or unreadable then. Journaling a create makes `rewind`
      // delete it, and it was the user's.
      const provablyNew = wasPresent !== null && !wasPresent.has(rel);
      if (!provablyNew) {
        // It was there and we cannot restore what we never read. Reported, so
        // the user is told - the gap this module exists to close, one level in.
        uncaptured.push(rel);
        continue;
      }
    }
    changes.push({
      path: abs,
      op: prior ? 'modify' : 'create',
      before: prior ? prior.content : null,
      after: buf.toString('utf8'),
    });
  }

  // Deletions: present before, absent now.
  for (const [rel, prior] of before.entries) {
    if (seen.has(rel)) continue;
    const abs = join(root, rel);
    if (alreadyJournaled.has(abs)) continue;
    // THE MIRROR GUARD. Absent from the OBSERVED listing is not absent from
    // the disk: a file the command newly added to `.gitignore` is still there.
    // Journaling it as deleted would have `rewind` write a file back over one
    // that never went away, and would report a deletion that never happened.
    if (nowPresent !== null && nowPresent.has(rel)) continue;
    if (prior.content === null) {
      uncaptured.push(rel);
      continue;
    }
    changes.push({ path: abs, op: 'delete', before: prior.content, after: '' });
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  uncaptured.sort((a, b) => a.localeCompare(b));
  return { changes, uncaptured };
}

/**
 * One line naming what could not be captured, or null when everything that
 * changed was journaled. The caller surfaces it - a gap the user is not told
 * about is the defect this module exists to close, one level in.
 */
export function uncapturedNotice(uncaptured: readonly string[]): string | null {
  if (uncaptured.length === 0) return null;
  const shown = uncaptured.slice(0, 3).join(', ');
  const more = uncaptured.length > 3 ? ` (+${uncaptured.length - 3} more)` : '';
  return `${uncaptured.length} changed file${uncaptured.length === 1 ? '' : 's'} could not be journaled and \`spycore rewind\` will not restore ${uncaptured.length === 1 ? 'it' : 'them'}: ${shown}${more}`;
}

/** Relative display path, used by the callers' notices. */
export function relDisplay(root: string, abs: string): string {
  const rel = relative(root, abs);
  return rel.length === 0 || rel.startsWith(`..${sep}`) ? abs : rel;
}
