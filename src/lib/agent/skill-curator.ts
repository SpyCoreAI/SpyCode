/**
 * H-13 - the skill curator: lifecycle for a growing skill catalog.
 *
 * Three jobs, all scoped to USER-GLOBAL skills (project skills and the
 * sync ledger's official skills are always off-limits):
 *
 * 1. USAGE TELEMETRY - every `load_skill` call records a view in
 *    `<userSkillsDir>/.usage.json` (`views`, `last_activity_at`).
 *    Best-effort: telemetry must never break a run.
 * 2. AUTO-ARCHIVE - `findStaleSkills` lists skills idle longer than the
 *    threshold (default 90 days); `archiveSkill` moves one to
 *    `.archive/<name>-<timestamp>`. Archiving is the ceiling - the curator
 *    NEVER deletes. Pinned skills are exempt from everything.
 * 3. PIN - `pinSkill` / `unpinSkill` mark skills exempt from archiving.
 *
 * Pin state lives in `<userSkillsDir>/.curator.json`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userSkillsDir } from './skills.js';

/** Telemetry file name inside the user skills dir. */
export const SKILL_USAGE_FILENAME = '.usage.json';
/** Curator state (pins) file name inside the user skills dir. */
export const SKILL_CURATOR_FILENAME = '.curator.json';
/** Archive directory name inside the user skills dir. */
export const SKILL_ARCHIVE_DIRNAME = '.archive';
/** Default inactivity threshold (days) before a skill counts as stale. */
export const DEFAULT_STALE_DAYS = 90;

/** One skill's usage record. */
export interface SkillUsageEntry {
  /** Successful `load_skill` calls. */
  views: number;
  /** ISO timestamp of the last load, or null when never loaded. */
  lastActivityAt: string | null;
}

export interface SkillUsageFile {
  version: 1;
  skills: Record<string, SkillUsageEntry>;
}

export interface CuratorState {
  version: 1;
  pinned: string[];
}

function usagePath(userDir: string): string {
  return join(userDir, SKILL_USAGE_FILENAME);
}

function curatorPath(userDir: string): string {
  return join(userDir, SKILL_CURATOR_FILENAME);
}

function readJsonFile<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Read the usage telemetry ({} when the file is missing/corrupt). */
export function readSkillUsage(userDir: string = userSkillsDir()): Record<string, SkillUsageEntry> {
  const file = readJsonFile<SkillUsageFile>(usagePath(userDir));
  if (!file || typeof file.skills !== 'object' || file.skills === null) return {};
  return file.skills;
}

/**
 * Record one `load_skill` view. Best-effort by contract - telemetry must
 * never throw into a run, so every failure is swallowed here.
 */
export function recordSkillLoad(name: string, userDir: string = userSkillsDir()): void {
  try {
    const key = name.trim();
    if (key.length === 0) return;
    mkdirSync(userDir, { recursive: true });
    const skills = readSkillUsage(userDir);
    const prev = skills[key];
    skills[key] = {
      views: (prev?.views ?? 0) + 1,
      lastActivityAt: new Date().toISOString(),
    };
    writeFileSync(usagePath(userDir), JSON.stringify({ version: 1, skills }, null, 2), 'utf8');
  } catch {
    /* telemetry is best-effort */
  }
}

/** Read the curator state ({pinned: []} when missing/corrupt). */
export function readCuratorState(userDir: string = userSkillsDir()): CuratorState {
  const file = readJsonFile<CuratorState>(curatorPath(userDir));
  if (!file || !Array.isArray(file.pinned)) return { version: 1, pinned: [] };
  return { version: 1, pinned: file.pinned.filter((n) => typeof n === 'string') };
}

function writeCuratorState(state: CuratorState, userDir: string): void {
  mkdirSync(userDir, { recursive: true });
  writeFileSync(curatorPath(userDir), JSON.stringify(state, null, 2), 'utf8');
}

/** True when the skill is pinned (exempt from every curator transition). */
export function isSkillPinned(name: string, userDir: string = userSkillsDir()): boolean {
  return readCuratorState(userDir).pinned.includes(name);
}

/** Pin a skill: exempt from stale detection and auto-archive. */
export function pinSkill(name: string, userDir: string = userSkillsDir()): void {
  const state = readCuratorState(userDir);
  if (!state.pinned.includes(name)) {
    state.pinned.push(name);
    state.pinned.sort();
    writeCuratorState(state, userDir);
  }
}

/** Unpin a skill. */
export function unpinSkill(name: string, userDir: string = userSkillsDir()): void {
  const state = readCuratorState(userDir);
  const next = state.pinned.filter((n) => n !== name);
  if (next.length !== state.pinned.length) writeCuratorState({ version: 1, pinned: next }, userDir);
}

/** One stale skill candidate. */
export interface StaleSkill {
  name: string;
  /** Last load timestamp, or null when never loaded since telemetry started. */
  lastActivityAt: string | null;
  /** Why it counts as stale (idle days, or never-used + old directory). */
  reason: string;
}

export interface FindStaleSkillsOpts {
  userDir?: string | undefined;
  /** Inactivity threshold in days. Default DEFAULT_STALE_DAYS. */
  inactiveDays?: number | undefined;
  /** Skill names the caller wants excluded (e.g. the sync ledger's official skills). */
  exclude?: ReadonlySet<string> | undefined;
  /** Clock override (tests pin this). */
  now?: number | undefined;
}

/**
 * Skills idle longer than `inactiveDays` (or never loaded and whose
 * directory is older than the threshold). Pinned and excluded skills are
 * never returned. Project skills are not scanned at all - this only looks
 * at the user-global dir.
 */
export function findStaleSkills(opts: FindStaleSkillsOpts = {}): StaleSkill[] {
  const userDir = opts.userDir ?? userSkillsDir();
  const inactiveDays = opts.inactiveDays ?? DEFAULT_STALE_DAYS;
  const now = opts.now ?? Date.now();
  const thresholdMs = inactiveDays * 24 * 60 * 60 * 1000;
  const usage = readSkillUsage(userDir);
  const pinned = new Set(readCuratorState(userDir).pinned);
  const out: StaleSkill[] = [];
  let dirents;
  try {
    dirents = existsSync(userDir) ? readdirNames(userDir) : [];
  } catch {
    return [];
  }
  for (const name of dirents) {
    if (name.startsWith('.')) continue; // .usage.json, .curator.json, .archive/
    if (pinned.has(name) || opts.exclude?.has(name)) continue;
    const entry = usage[name];
    const last = entry?.lastActivityAt ?? null;
    if (last) {
      const ageMs = now - Date.parse(last);
      if (Number.isFinite(ageMs) && ageMs >= thresholdMs) {
        out.push({
          name,
          lastActivityAt: last,
          reason: `idle ${Math.floor(ageMs / 86_400_000)} days (threshold ${inactiveDays})`,
        });
      }
      continue;
    }
    // Never loaded since telemetry started: fall back to the directory
    // mtime so long-used pre-telemetry skills are not archived on day one.
    const mtime = dirMtimeMs(userDir, name);
    if (mtime !== null && now - mtime >= thresholdMs) {
      out.push({
        name,
        lastActivityAt: null,
        reason: `never loaded and unchanged for ${Math.floor((now - mtime) / 86_400_000)} days`,
      });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function readdirNames(dir: string): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) out.push(d.name);
  }
  return out;
}

function dirMtimeMs(userDir: string, name: string): number | null {
  try {
    return statSync(join(userDir, name)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Archive a user-global skill into `.archive/<name>-<timestamp>`. The
 * ceiling is archive - this NEVER deletes. Refuses pinned skills, dotfiles,
 * and names outside the user dir. Returns where it went.
 */
export function archiveSkill(
  name: string,
  userDir: string = userSkillsDir(),
): { archivedTo: string } {
  const clean = name.trim();
  if (clean.length === 0 || clean.startsWith('.') || clean.includes('/') || clean.includes('\\')) {
    throw new Error(`refusing to archive "${name}" - not a plain skill directory name`);
  }
  if (isSkillPinned(clean, userDir)) {
    throw new Error(`"${clean}" is pinned - unpin it first (spycore skills curator --unpin ${clean})`);
  }
  const src = join(userDir, clean);
  let st;
  try {
    st = statSync(src);
  } catch {
    throw new Error(`no user-global skill named "${clean}"`);
  }
  if (!st.isDirectory()) throw new Error(`"${clean}" is not a skill directory`);
  const archiveDir = join(userDir, SKILL_ARCHIVE_DIRNAME);
  mkdirSync(archiveDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = join(archiveDir, `${clean}-${stamp}`);
  renameSync(src, dest);
  return { archivedTo: dest };
}
