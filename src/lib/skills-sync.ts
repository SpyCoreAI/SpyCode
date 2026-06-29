/**
 * `spycore skills sync` support: the local sync-state file and the pure
 * diffing planner. The network half lives in the skills command; everything
 * here is filesystem + pure logic so it's trivially testable.
 *
 * State file: <configDir>/skills/.sync.json — records name → sha256 of every
 * skill THIS tool wrote. It is the ownership ledger: sync only ever updates or
 * removes skills recorded here. A user-created skill (present on disk, absent
 * from the ledger) is never overwritten or deleted — on a name collision with
 * an official skill it is skipped with a warning (user content wins, even
 * under --force). Part-1 discovery scans only directories, so the dot-file is
 * invisible to the agent catalog.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userSkillsDir } from './agent/skills.js';

/** One manifest row from GET /api/v1/skills/manifest. */
export interface SkillManifestEntry {
  name: string;
  description: string;
  /** Full-content sha256 (hex) of the skill's SKILL.md. */
  sha256: string;
}

export interface SyncState {
  version: 1;
  lastSync?: string;
  /** name → sha256 recorded at the time sync wrote the file. */
  skills: Record<string, { sha256: string }>;
}

export const emptySyncState = (): SyncState => ({ version: 1, skills: {} });

export function syncStatePath(): string {
  return join(userSkillsDir(), '.sync.json');
}

/** Lenient read — a missing or corrupt state file degrades to empty. */
export function readSyncState(): SyncState {
  try {
    const raw = readFileSync(syncStatePath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<SyncState> | null;
    if (parsed && typeof parsed === 'object' && parsed.skills && typeof parsed.skills === 'object') {
      const skills: Record<string, { sha256: string }> = {};
      for (const [name, v] of Object.entries(parsed.skills)) {
        const sha = (v as { sha256?: unknown } | null)?.sha256;
        if (typeof sha === 'string' && sha.length > 0) skills[name] = { sha256: sha };
      }
      return { version: 1, ...(typeof parsed.lastSync === 'string' ? { lastSync: parsed.lastSync } : {}), skills };
    }
  } catch {
    /* fall through to empty */
  }
  return emptySyncState();
}

/** Atomic write (tmp + rename), creating the skills dir if needed. */
export function writeSyncState(state: SyncState): void {
  const path = syncStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** Hard cap on a skill name (mirrors skills-create's MAX_NAME_LENGTH). */
const MAX_SKILL_NAME_LENGTH = 64;

/**
 * A skill name doubles as a single directory segment under the user-global
 * skills root, so it MUST be a safe slug: lowercase alphanumerics in
 * dash-separated words and nothing else. This rejects path separators, `..`,
 * leading/trailing or doubled dashes, dots (so dotfiles and traversal can't
 * slip through), absolute paths, and control characters — i.e. anything a
 * hostile manifest entry (or a tampered .sync.json) could use to write or
 * delete OUTSIDE the skills dir. Mirrors the kebab-case shape `skills create`
 * enforces (skills-create.ts NAME_RE). (SEC-012.)
 */
const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidSkillName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_SKILL_NAME_LENGTH &&
    SKILL_NAME_RE.test(name)
  );
}

/**
 * Backstop guard: refuse to derive a filesystem path from an unsafe name. The
 * sync planner already filters invalid names out before they reach here
 * (planSkillSync), so in normal operation this never throws — it exists so a
 * future caller can't reintroduce the traversal by skipping the planner.
 */
function assertSafeSkillName(name: string): void {
  if (!isValidSkillName(name)) {
    throw new Error(`Unsafe skill name rejected (path traversal guard): ${JSON.stringify(name)}`);
  }
}

/** Absolute SKILL.md path for a synced skill in the user-global root. */
export function syncedSkillFile(name: string): string {
  assertSafeSkillName(name);
  return join(userSkillsDir(), name, 'SKILL.md');
}

/** Atomically write one synced skill's SKILL.md. */
export function writeSyncedSkill(name: string, content: string): void {
  const file = syncedSkillFile(name); // throws on an unsafe name (SEC-012)
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/** Remove a previously-synced skill directory (ledger-owned only). */
export function removeSyncedSkill(name: string): void {
  assertSafeSkillName(name); // never rm a path derived from an unsafe name (SEC-012)
  rmSync(join(userSkillsDir(), name), { recursive: true, force: true });
}

export function syncedSkillExists(name: string): boolean {
  return existsSync(syncedSkillFile(name));
}

export interface SyncPlan {
  /** Skills to download: 'added' = new to the ledger, 'updated' = sha changed / --force / file missing. */
  download: Array<{ name: string; kind: 'added' | 'updated' }>;
  /** In the ledger AND in the manifest with a matching sha + file present. */
  unchanged: string[];
  /** Name collisions with user-created (un-ledgered) local skills — never touched. */
  skipped: string[];
  /** Manifest entries whose name is not a safe path segment — refused outright (SEC-012). */
  rejected: string[];
  /** In the ledger but gone from the manifest — delete locally. */
  removals: string[];
}

/**
 * Pure sync planner. `localExists` answers "is there a SKILL.md on disk for
 * this name in the user-global root" (injected for testability).
 */
export function planSkillSync(
  manifest: SkillManifestEntry[],
  state: SyncState,
  localExists: (name: string) => boolean,
  force: boolean,
): SyncPlan {
  const plan: SyncPlan = { download: [], unchanged: [], skipped: [], rejected: [], removals: [] };
  const manifestNames = new Set<string>();
  for (const entry of manifest) {
    // Reject any name that isn't a safe path segment BEFORE it can reach a
    // filesystem operation (or the localExists probe below). (SEC-012.)
    if (!isValidSkillName(entry.name)) {
      plan.rejected.push(entry.name);
      continue;
    }
    manifestNames.add(entry.name);
    const tracked = state.skills[entry.name];
    const exists = localExists(entry.name);
    if (!tracked && exists) {
      // User-created skill with an official name: user content wins, always.
      plan.skipped.push(entry.name);
      continue;
    }
    if (!tracked) {
      plan.download.push({ name: entry.name, kind: 'added' });
      continue;
    }
    if (force || tracked.sha256 !== entry.sha256 || !exists) {
      plan.download.push({ name: entry.name, kind: 'updated' });
      continue;
    }
    plan.unchanged.push(entry.name);
  }
  for (const name of Object.keys(state.skills)) {
    // Never derive a delete path from an unsafe (e.g. tampered) ledger name —
    // drop it silently (it also won't be carried into the rebuilt ledger). (SEC-012.)
    if (!isValidSkillName(name)) continue;
    if (!manifestNames.has(name)) plan.removals.push(name);
  }
  return plan;
}

/** Names currently tracked by the sync ledger (for the `official` list label). */
export function officialSkillNames(): Set<string> {
  return new Set(Object.keys(readSyncState().skills));
}
