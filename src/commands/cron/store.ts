/**
 * Local persistence for `spycore cron` scheduled prompts.
 *
 * The SpyCore platform exposes scheduled prompts through the main-agent cron
 * tooling, but the CLI has NO platform API endpoint for them (no scheduled-
 * prompts route exists in this codebase - src/lib/api.ts is a generic JSON
 * wrapper and every call site uses /api/memory, /conversations, /v1/skills,
 * etc.). The wave-3a feature brief says not to invent API endpoints, so this
 * command group stores schedules locally in the CLI config dir
 * (`~/.spycore/cron.json`, resolved through getConfigPath() so the
 * SPYCORE_CONFIG_DIR / SPYCORE_TEST_CWD overrides apply).
 *
 * GAP: entries are stored and managed locally, but nothing executes due
 * prompts yet. A follow-up should add execution (e.g. a `run-due` check that
 * fires prompts through the chat pipeline, or a crontab/launchd installer).
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigPath } from '../../lib/config.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';

export interface CronEntry {
  /** Opaque id returned at creation; used by `cron remove`. */
  id: string;
  /** The prompt text to run on schedule. */
  prompt: string;
  /** 5-field cron expression (minute hour dom month dow). */
  schedule: string;
  /** Uppercase SpyCore model label (e.g. "MINOS"), or null for the default. */
  model: string | null;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
}

/** Hard cap on prompt length - mirrors the "validate input, fail loudly" style. */
export const MAX_PROMPT_LENGTH = 2000;

function storePath(): string {
  return join(dirname(getConfigPath()), 'cron.json');
}

export function loadCronEntries(): CronEntry[] {
  const path = storePath();
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new SpycoreCliError(
      `Cannot read the cron store at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_USER_ERROR,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Never silently wipe user data: surface the corruption explicitly.
    throw new SpycoreCliError(
      `The cron store at ${path} is not valid JSON.`,
      EXIT_USER_ERROR,
      'Back it up, then delete it (or fix the JSON) to start fresh.',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new SpycoreCliError(
      `The cron store at ${path} is corrupt (expected a JSON array).`,
      EXIT_USER_ERROR,
      'Back it up, then delete it (or fix the JSON) to start fresh.',
    );
  }
  const entries: CronEntry[] = [];
  for (const item of parsed) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as CronEntry).id === 'string' &&
      typeof (item as CronEntry).prompt === 'string' &&
      typeof (item as CronEntry).schedule === 'string' &&
      typeof (item as CronEntry).createdAt === 'string'
    ) {
      entries.push({
        id: (item as CronEntry).id,
        prompt: (item as CronEntry).prompt,
        schedule: (item as CronEntry).schedule,
        model: typeof (item as CronEntry).model === 'string' ? (item as CronEntry).model : null,
        createdAt: (item as CronEntry).createdAt,
      });
    }
    // Rows that fail shape validation are skipped rather than fatal:
    // one bad row must not brick the whole list.
  }
  return entries;
}

function saveCronEntries(entries: CronEntry[]): void {
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort hardening of an existing store - the write already used
    // mode 0600 for new files; ignore platform chmod quirks.
  }
}

export function addCronEntry(entry: Omit<CronEntry, 'id' | 'createdAt'>): CronEntry {
  const entries = loadCronEntries();
  const created: CronEntry = {
    ...entry,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  entries.push(created);
  saveCronEntries(entries);
  return created;
}

/** Returns true when an entry with that id existed and was removed. */
export function removeCronEntry(id: string): boolean {
  const entries = loadCronEntries();
  const kept = entries.filter((e) => e.id !== id);
  if (kept.length === entries.length) return false;
  saveCronEntries(kept);
  return true;
}

/* ── Cron expression validation (from scratch, no new dependencies) ── */

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** Field index -> [min, max]; minute hour dom month dow. */
const FIELD_BOUNDS: ReadonlyArray<readonly [number, number]> = [
  [0, 59], [0, 23], [1, 31], [1, 12], [0, 7],
];

function parseAtom(atom: string, min: number, max: number, names?: Record<string, number>): number {
  const lowered = atom.toLowerCase();
  if (names && lowered in names) return names[lowered]!;
  if (!/^\d+$/.test(atom)) {
    throw new Error(`"${atom}" is not a number or name`);
  }
  const n = Number(atom);
  if (n < min || n > max) {
    throw new Error(`${n} is out of range ${min}-${max}`);
  }
  return n;
}

function validateField(field: string, fieldIndex: number): void {
  const [min, max] = FIELD_BOUNDS[fieldIndex]!;
  const names = fieldIndex === 3 ? MONTH_NAMES : fieldIndex === 4 ? DOW_NAMES : undefined;
  for (const part of field.split(',')) {
    if (part.length === 0) throw new Error('empty list element');
    const [rangePart, stepPart] = part.split('/');
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) {
        throw new Error(`invalid step "${stepPart}"`);
      }
    }
    if (rangePart === '*') continue;
    if (rangePart === undefined || rangePart.length === 0) {
      throw new Error(`invalid step expression "${part}"`);
    }
    if (rangePart.includes('-')) {
      const [lo, hi] = rangePart.split('-');
      if (lo === undefined || hi === undefined || lo.length === 0 || hi.length === 0) {
        throw new Error(`invalid range "${rangePart}"`);
      }
      const loN = parseAtom(lo, min, max, names);
      const hiN = parseAtom(hi, min, max, names);
      if (loN > hiN) throw new Error(`range "${rangePart}" is reversed`);
      continue;
    }
    parseAtom(rangePart, min, max, names);
  }
}

/**
 * Validate a 5-field cron expression (minute hour day-of-month month
 * day-of-week). Supports `*`, lists, ranges, steps (`*\/15`, `1-30/5`) and
 * 3-letter month / day-of-week names. Returns the normalised schedule on
 * success; throws SpycoreCliError on any problem.
 */
export function validateSchedule(raw: string): string {
  const schedule = raw.trim().replace(/\s+/g, ' ');
  const fields = schedule.split(' ');
  if (fields.length !== 5) {
    throw new SpycoreCliError(
      `Invalid schedule: expected 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}.`,
      EXIT_USER_ERROR,
      'Example: "*/15 * * * *" runs every 15 minutes.',
    );
  }
  for (let i = 0; i < fields.length; i++) {
    try {
      validateField(fields[i]!, i);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new SpycoreCliError(
        `Invalid schedule: field ${i + 1} ("${fields[i]}") - ${reason}.`,
        EXIT_USER_ERROR,
        'Use 5 cron fields: "minute hour day-of-month month day-of-week", e.g. "0 9 * * MON".',
      );
    }
  }
  return schedule;
}
