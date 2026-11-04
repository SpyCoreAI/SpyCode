/**
 * F30 — Projects as workspace (client scaffolding).
 *
 * Local registry of project workspaces: directories the user has registered
 * with `spycore projects add`. A "project workspace" here means a directory
 * containing SPYCODE.md (SpyCode's per-project memory file); registration
 * itself only records the directory path and never reads or transmits the
 * directory's contents.
 *
 * Storage is CLIENT-LOCAL ONLY: one JSON file next to the CLI config
 * (`<configDir>/projects.json`, 0600). Nothing here touches the network.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * CLOUD-SYNC GAP — READ BEFORE ADDING NETWORK CALLS.
 *
 * As of 2026-10-07 the SpyCore platform exposes NO project/workspace
 * endpoints. Verified against the CLI's transport layer (src/lib/api.ts and
 * every api.get/post call site): the only server collections are
 * /api/memory, /api/usage, /api/user/me, /auth/cli/*, /conversations, and
 * /v1/skills/manifest. There is no /api/projects, no /api/workspaces, and no
 * R2-backed project sync of any kind. Do NOT invent endpoint URLs and call
 * them — they do not exist and any such call would 404 at best and leak
 * local paths at worst.
 *
 * When the platform does grow project sync (e.g. R2-backed snapshots of
 * project workspaces shared across the user's machines), the client will
 * need endpoints along these lines — listed here as a DESIGN NOTE ONLY:
 *
 *   GET    /api/projects              list the user's synced project workspaces
 *   POST   /api/projects              register/sync one (name, path hint,
 *                                     SPYCODE.md content hash — never raw paths
 *                                     as identifiers across machines)
 *   DELETE /api/projects/:id          unregister one
 *   PUT    /api/projects/:id/blob     upload an R2 snapshot of the workspace
 *   GET    /api/projects/:id/blob     download the snapshot
 *
 * Until those exist, this module must stay purely local. A future sync
 * implementation should treat the local registry as the source of truth for
 * "what is registered here" and the server as the source of truth for "what
 * is synced", merging on (userId, name) — never on absolute path, which is
 * meaningless across machines.
 * ─────────────────────────────────────────────────────────────────────────
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigPath } from '../../lib/config.js';

/** One registered project workspace. */
export interface ProjectEntry {
  /** Unique display name (defaults to the directory basename). */
  name: string;
  /** Absolute path of the workspace directory. */
  path: string;
  /** ISO timestamp of when it was registered. */
  addedAt: string;
}

/** The per-project memory file that makes a directory a SpyCode workspace. */
export const SPYCODE_MD = 'SPYCODE.md';

function registryPath(): string {
  // dirname(getConfigPath()) is the CLI's own config dir (respects
  // SPYCORE_CONFIG_DIR / SPYCORE_TEST_CWD, so tests stay isolated).
  return join(dirname(getConfigPath()), 'projects.json');
}

function isProjectEntry(value: unknown): value is ProjectEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.name === 'string' &&
    typeof e.path === 'string' &&
    typeof e.addedAt === 'string'
  );
}

/** Load the registry. Returns [] when the file is missing or unreadable. */
export function loadProjects(): ProjectEntry[] {
  let raw: string;
  try {
    raw = readFileSync(registryPath(), 'utf-8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    // m5: corrupt file - preserve the evidence before failing open. The
    // corrupt file is renamed aside so a subsequent save doesn't destroy it.
    try {
      const corruptPath = `${registryPath()}.corrupt-${Date.now()}`;
      renameSync(registryPath(), corruptPath);
    } catch {
      // rename failed - fail open anyway
    }
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isProjectEntry);
}

/** Persist the registry (0600 — paths are mildly sensitive). */
export function saveProjects(entries: ProjectEntry[]): void {
  const file = registryPath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
}

/** True when the directory contains a SPYCODE.md workspace marker. */
export function hasSpycodeMd(dir: string): boolean {
  try {
    return existsSync(join(dir, SPYCODE_MD));
  } catch {
    return false;
  }
}

/** Find a registered project by its exact name. */
export function findProject(entries: ProjectEntry[], name: string): ProjectEntry | undefined {
  return entries.find((e) => e.name === name);
}
