/**
 * H-7 - light two-file durable memory (the chosen memory design; A-1 was
 * rejected - do not build a layered ProfileStore on top of this).
 *
 * Two plain Markdown files in the CLI config dir, managed by the agent
 * itself through the `memory` tool:
 *
 *   <configDir>/memories/MEMORY.md  - the agent's own notes (facts, lessons,
 *                                     decisions worth keeping across runs)
 *   <configDir>/memories/USER.md    - the user profile (preferences,
 *                                     communication style, durable facts)
 *
 * Three hard properties:
 * 1. FROZEN SNAPSHOT - the files are read ONCE at session start
 *    (`loadDurableMemorySnapshot`) and rendered into the system prompt as a
 *    fixed block. Mid-run writes by the agent do NOT change what the run
 *    sees; they take effect on the NEXT run. (Same cache discipline as the
 *    rest of the system prompt - A-6/H-1.)
 * 2. CAP WITH ERROR - each file has a hard character cap. A write that
 *    would exceed it FAILS with an error telling the agent to make room
 *    first (merge or delete entries) - nothing is ever silently deleted.
 *    (One entry is capped at 4k chars, visibly truncated with an ellipsis,
 *    so a single write cannot eat the whole file.)
 * 3. SECRET HYGIENE - the agent is instructed (in the snapshot block and
 *    the tool description) never to store secrets; additionally every write
 *    is passed through redactFreeText so a pasted credential never lands on
 *    disk unscrubbed, and the files live at 0600 next to the CLI config.
 *
 * Writes are atomic (temp file + rename), like the rest of the CLI's disk
 * state. This module self-registers the `memory` tool on import (H-6).
 */
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { getConfigPath } from '../config.js';
import { redactFreeText } from '../redact.js';
import { truncateSafe } from '../text.js';
import { APPROVAL_ANTI_SPAM_TEXT, resolveApproval } from './approval.js';
import { computeFileDiff } from './diff.js';
import { optString, registerTool, reqString, ToolError, type ToolContext } from './tool-core.js';

/** The agent's own durable notes. */
export const DURABLE_MEMORY_FILE = 'MEMORY.md';
/** The user profile the agent maintains. */
export const DURABLE_USER_FILE = 'USER.md';
/** Subdirectory of the CLI config dir holding both files. */
export const DURABLE_MEMORY_DIRNAME = 'memories';
/**
 * Hard per-file character cap. A write that would exceed it errors - the
 * agent must make room first (merge or delete), never silently drop.
 */
export const DURABLE_MEMORY_CAP_CHARS = 48_000;
/** Cap on one appended entry, so a single write cannot eat the whole file. */
export const DURABLE_MEMORY_ENTRY_CAP_CHARS = 4_000;

/** The durable-memory directory (created on first write, never on read). */
export function durableMemoryDir(configDir?: string): string {
  const base = configDir ?? dirname(getConfigPath());
  return join(base, DURABLE_MEMORY_DIRNAME);
}

function filePath(file: 'memory' | 'user', configDir?: string): string {
  return join(durableMemoryDir(configDir), file === 'memory' ? DURABLE_MEMORY_FILE : DURABLE_USER_FILE);
}

/**
 * Read one durable file; missing/unreadable ⇒ ''. Never throws.
 *
 * A file containing NUL bytes is NOT empty: NULs are stripped and the rest
 * is returned. The old behavior returned `''` for any NUL-containing file,
 * and the next append then wrote back only the new entry - silently
 * discarding the whole file. (A NUL cannot come from the memory tool, which
 * writes clean text; it can come from a stray binary write or a corrupt
 * disk, and losing the file over it is the worse outcome.)
 */
export function readDurableFile(file: 'memory' | 'user', configDir?: string): string {
  try {
    const p = filePath(file, configDir);
    if (!existsSync(p)) return '';
    const raw = readFileSync(p, 'utf8');
    return raw.includes('\u0000') ? raw.replace(/\u0000/g, '') : raw;
  } catch {
    return '';
  }
}

/** The frozen session-start snapshot of both files. Read once per run. */
export interface DurableMemorySnapshot {
  memory: string;
  user: string;
  memoryChars: number;
  userChars: number;
  capChars: number;
}

/** Load both files NOW - the caller renders the block and keeps it fixed. */
export function loadDurableMemorySnapshot(configDir?: string): DurableMemorySnapshot {
  const memory = readDurableFile('memory', configDir);
  const user = readDurableFile('user', configDir);
  return {
    memory,
    user,
    memoryChars: memory.length,
    userChars: user.length,
    capChars: DURABLE_MEMORY_CAP_CHARS,
  };
}

/**
 * Render the frozen block for the system prompt. '' when both files are
 * empty (the prompt is then byte-identical to a memory-free build).
 */
export function renderDurableMemoryBlock(snap: DurableMemorySnapshot): string {
  const sections: string[] = [];
  if (snap.user.trim().length > 0) {
    sections.push(
      `# User profile (frozen at session start - ${(snap.userChars / 1000).toFixed(1)}k of ${(snap.capChars / 1000).toFixed(0)}k chars)\n${snap.user.trim()}`,
    );
  }
  if (snap.memory.trim().length > 0) {
    sections.push(
      `# Durable memory (frozen at session start - ${(snap.memoryChars / 1000).toFixed(1)}k of ${(snap.capChars / 1000).toFixed(0)}k chars)\n${snap.memory.trim()}`,
    );
  }
  if (sections.length === 0) return '';
  return `\n\n${sections.join('\n\n')}\n\nThese are YOUR long-term notes about the user and past work. They were frozen when this session started - updates you make with the memory tool take effect on the NEXT session, not this one. Never store secrets, API keys, tokens, or passwords in them.`;
}

/** Atomic write (temp + rename) at 0600 - secrets-adjacent content. */
function writeDurableFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  // Random temp name: a fixed `${path}.tmp-${pid}` name is guessable, so
  // another local process can plant the temp file (or a stale one from a
  // crashed run can linger and be mistaken for fresh). The mode is applied
  // AFTER the write as well as at creation: `writeFileSync`'s `mode` only
  // sets permissions when it creates the file, so a temp file that already
  // existed (planted, or left by a crash) would keep its old mode.
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
  // Stale temp files from crashed runs (same basename, older than an hour)
  // are removed best-effort so they cannot accumulate - or be mistaken for
  // a live write by a later run.
  try {
    const dir = dirname(path);
    const base = basename(path);
    const tmpName = basename(tmp);
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`${base}.tmp-`) || f === tmpName) continue;
      const fp = join(dir, f);
      try {
        if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* best-effort cleanup only */
  }
}

/**
 * Scrub entry lines for storage: redact secrets, drop empties, cap one
 * entry at 4k chars. Shared by the writer and the approval preview so the
 * card shows exactly what lands on disk.
 */
function cleanEntryLines(lines: string[]): string[] {
  return lines
    .map((l) => redactFreeText(l).trim())
    .filter((l) => l.length > 0)
    .map((l) => (l.length > DURABLE_MEMORY_ENTRY_CAP_CHARS ? `${truncateSafe(l, DURABLE_MEMORY_ENTRY_CAP_CHARS)}…` : l));
}

/** The file content after appending `addition` (already bulleted) to `current`. */
function appendText(current: string, addition: string): string {
  return current.length === 0 ? `${addition}\n` : `${current.replace(/\n+$/, '\n')}${addition}\n`;
}

/**
 * Approval gate for memory writes, identical in shape to the write_file /
 * edit_file gate: the user sees the diff and the write applies only after
 * they approve. `mutating: true` on the tool already blocks plan mode at
 * dispatch; this is the per-call gate for execute mode. Returns true when
 * the write may proceed.
 */
async function approveMemoryWrite(
  ctx: ToolContext,
  file: 'memory' | 'user',
  oldText: string,
  newText: string,
): Promise<{ approved: boolean; reason?: string }> {
  const fd = await computeFileDiff(oldText, newText);
  const outcome = await resolveApproval(ctx.requestApproval, {
    kind: 'write',
    tool: 'memory',
    path: file === 'memory' ? DURABLE_MEMORY_FILE : DURABLE_USER_FILE,
    isNew: oldText.length === 0,
    added: fd.added,
    removed: fd.removed,
    diff: fd.lines,
    truncated: fd.truncated,
    hiddenLines: fd.hiddenLines,
  });
  return outcome.approved ? { approved: true } : { approved: false, reason: outcome.reason };
}

function memoryWriteRejected(file: 'memory' | 'user', reason: string | undefined) {
  return {
    ok: false,
    kind: 'rejected' as const,
    summary: 'rejected',
    content: `Memory write to ${file === 'memory' ? DURABLE_MEMORY_FILE : DURABLE_USER_FILE} was not applied: ${reason ?? 'rejected by user'}. The file is unchanged. ${APPROVAL_ANTI_SPAM_TEXT}`,
  };
}

/**
 * Append entries to one durable file. Lines are scrubbed for secrets before
 * they touch disk. Throws ToolError when the cap would be exceeded - the
 * caller must make room first; nothing is silently dropped.
 */
export function appendDurableMemory(
  file: 'memory' | 'user',
  lines: string[],
  configDir?: string,
  /**
   * Already-read file content. The `memory` tool passes the snapshot it
   * showed in the approval diff: re-reading here would let a file change
   * made during the (unbounded) approval pause land without ever appearing
   * in the approved diff. Callers without an approved snapshot omit it and
   * the file is read fresh, as before.
   */
  currentText?: string,
): { chars: number; capChars: number } {
  const clean = cleanEntryLines(lines);
  if (clean.length === 0) throw new ToolError('nothing to remember - the text was empty');
  const current = currentText ?? readDurableFile(file, configDir);
  const addition = clean.map((l) => `- ${l}`).join('\n');
  const next = appendText(current, addition);
  if (next.length > DURABLE_MEMORY_CAP_CHARS) {
    throw new ToolError(
      `${file === 'memory' ? DURABLE_MEMORY_FILE : DURABLE_USER_FILE} is full ` +
        `(${current.length.toLocaleString('en-US')} of ${DURABLE_MEMORY_CAP_CHARS.toLocaleString('en-US')} chars) - ` +
        `merge or delete entries with the memory tool's remove action first, then retry. Nothing was written.`,
    );
  }
  writeDurableFileAtomic(filePath(file, configDir), next);
  return { chars: next.length, capChars: DURABLE_MEMORY_CAP_CHARS };
}

/**
 * Append a raw text section (not bulleted) to one durable file - for
 * imports that carry their own structure (e.g. a CLAUDE.md). Same cap
 * discipline as `appendDurableMemory`: exceeding the cap throws, nothing is
 * silently dropped.
 */
export function appendDurableMemoryRaw(
  file: 'memory' | 'user',
  section: string,
  configDir?: string,
): { chars: number; capChars: number } {
  const clean = redactFreeText(section).trim();
  if (clean.length === 0) throw new ToolError('nothing to import - the text was empty');
  const current = readDurableFile(file, configDir);
  const next = current.length === 0 ? `${clean}\n` : `${current.replace(/\n+$/, '\n')}\n${clean}\n`;
  if (next.length > DURABLE_MEMORY_CAP_CHARS) {
    throw new ToolError(
      `${file === 'memory' ? DURABLE_MEMORY_FILE : DURABLE_USER_FILE} is full ` +
        `(${current.length.toLocaleString('en-US')} of ${DURABLE_MEMORY_CAP_CHARS.toLocaleString('en-US')} chars) - ` +
        `merge or delete entries first, then retry. Nothing was written.`,
    );
  }
  writeDurableFileAtomic(filePath(file, configDir), next);
  return { chars: next.length, capChars: DURABLE_MEMORY_CAP_CHARS };
}

/**
 * Remove every line containing `match` (case-insensitive substring) from one
 * durable file. Returns the number of lines removed. Never throws for a
 * missing file.
 */
export function removeDurableMemoryLines(
  file: 'memory' | 'user',
  match: string,
  configDir?: string,
  /**
   * Already-read file content - same single-read discipline as
   * appendDurableMemory: the `memory` tool passes the snapshot behind the
   * approved diff, so a line added during the approval pause cannot be
   * deleted without ever appearing in that diff.
   */
  currentText?: string,
): { removed: number; chars: number } {
  const needle = match.trim().toLowerCase();
  if (needle.length === 0) throw new ToolError('match must not be empty');
  const p = filePath(file, configDir);
  const current = currentText ?? readDurableFile(file, configDir);
  if (current.length === 0) return { removed: 0, chars: 0 };
  const kept = current.split('\n').filter((l) => !l.toLowerCase().includes(needle));
  const removed = current.split('\n').length - kept.length;
  if (removed > 0) writeDurableFileAtomic(p, kept.join('\n'));
  return { removed, chars: kept.join('\n').length };
}

// ─────────────────────── the `memory` tool ───────────────────────

/**
 * H-10: sub-agents (leaf role) may READ durable memory but never write it -
 * their observations belong in the report to the parent, not in the user's
 * long-term files.
 */
function assertMemoryWritable(ctx: ToolContext): void {
  if (ctx.role === 'leaf') {
    throw new ToolError(
      'sub-agents cannot write durable memory - include what you learned in your final report to the parent instead',
    );
  }
}

const MEMORY_TOOL_NAME = 'memory';

registerTool({
  name: MEMORY_TOOL_NAME,
  // Mutating: writes permanent memory. Plan mode blocks the tool at
  // dispatch, and add/remove pause for user approval in execute mode
  // (see approveMemoryWrite). `view` is read-only, but the tool is one
  // registration - the plan-phase snapshot is already in the system
  // prompt, so plan mode loses nothing by not calling it.
  mutating: true,
  description:
    'Your durable two-file memory: MEMORY.md (your own notes across sessions) and USER.md (the user profile). ' +
    'Actions: view (read both files), add (append entries; file=memory|user, default memory), remove (delete lines containing `match`). ' +
    'Each file has a hard character cap - when full, writes FAIL with an error instead of silently dropping: merge or remove entries first. ' +
    'The session sees a FROZEN snapshot from session start, so your writes take effect on the NEXT session. ' +
    'NEVER store secrets, API keys, tokens, or passwords. Sub-agents can view but never write.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'view | add | remove (default view)' },
      file: { type: 'string', description: 'memory | user (default memory)' },
      text: { type: 'string', description: 'Entry text for add (one entry per line)' },
      match: { type: 'string', description: 'Case-insensitive substring: remove lines containing it' },
    },
  },
  async execute(args, ctx) {
    const action = (optString(args, 'action') ?? 'view').trim().toLowerCase();
    const file = (optString(args, 'file') ?? 'memory').trim().toLowerCase();
    if (file !== 'memory' && file !== 'user') {
      throw new ToolError('file must be "memory" or "user"');
    }
    const f = file as 'memory' | 'user';
    if (action === 'view') {
      const mem = readDurableFile('memory');
      const usr = readDurableFile('user');
      const lines = [
        `--- MEMORY.md (${mem.length.toLocaleString('en-US')}/${DURABLE_MEMORY_CAP_CHARS.toLocaleString('en-US')} chars) ---`,
        mem.trim().length > 0 ? mem.trim() : '(empty)',
        '',
        `--- USER.md (${usr.length.toLocaleString('en-US')}/${DURABLE_MEMORY_CAP_CHARS.toLocaleString('en-US')} chars) ---`,
        usr.trim().length > 0 ? usr.trim() : '(empty)',
      ];
      return { ok: true, summary: 'durable memory shown', content: lines.join('\n') };
    }
    if (action === 'add') {
      assertMemoryWritable(ctx);
      const text = reqString(args, 'text');
      // Approval BEFORE the write, on the exact diff that will land:
      // the tool is mutating (plan mode blocks it at dispatch) and every
      // execute-mode write pauses for the user like write_file does.
      // Single-read: the approved diff is computed from `current`, and the
      // write below reuses that same snapshot instead of re-reading the
      // file - otherwise a change made during the approval pause could land
      // (add) or be deleted (remove) without ever appearing in the diff.
      // Trade-off, stated: a concurrent edit made during the pause is
      // overwritten by the approved snapshot rather than preserved.
      const current = readDurableFile(f);
      const clean = cleanEntryLines(text.split('\n'));
      if (clean.length === 0) throw new ToolError('nothing to remember - the text was empty');
      const addition = clean.map((l) => `- ${l}`).join('\n');
      const gate = await approveMemoryWrite(ctx, f, current, appendText(current, addition));
      if (!gate.approved) return memoryWriteRejected(f, gate.reason);
      const res = appendDurableMemory(f, text.split('\n'), undefined, current);
      return {
        ok: true,
        summary: `remembered in ${f === 'memory' ? DURABLE_MEMORY_FILE : DURABLE_USER_FILE}`,
        content:
          `Appended to ${f === 'memory' ? DURABLE_MEMORY_FILE : DURABLE_USER_FILE} ` +
          `(${res.chars.toLocaleString('en-US')}/${res.capChars.toLocaleString('en-US')} chars). ` +
          'It takes effect on the NEXT session - this session keeps its frozen snapshot.',
      };
    }
    if (action === 'remove') {
      assertMemoryWritable(ctx);
      const match = reqString(args, 'match');
      const current = readDurableFile(f);
      const needle = match.trim().toLowerCase();
      if (needle.length === 0) throw new ToolError('match must not be empty');
      const kept = current.split('\n').filter((l) => !l.toLowerCase().includes(needle));
      const gate = await approveMemoryWrite(ctx, f, current, kept.join('\n'));
      if (!gate.approved) return memoryWriteRejected(f, gate.reason);
      const res = removeDurableMemoryLines(f, match, undefined, current);
      return {
        ok: true,
        summary: `${res.removed} line${res.removed === 1 ? '' : 's'} removed`,
        content:
          `Removed ${res.removed} line${res.removed === 1 ? '' : 's'} containing "${match}" from ` +
          `${f === 'memory' ? DURABLE_MEMORY_FILE : DURABLE_USER_FILE}.`,
      };
    }
    throw new ToolError('action must be "view", "add", or "remove"');
  },
});
