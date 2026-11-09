/**
 * Todo list tracking for agent sessions.
 *
 * A simple file-based todo list that the TUI displays and the user (or agent
 * via the /todo command) can manage. Stored per-session in the checkpoint
 * directory.
 *
 * Format: { todos: [{ id, text, status: 'pending'|'in_progress'|'completed', createdAt }] }
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getConfigPath } from '../config.js';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  createdAt: string;
}

export interface TodoList {
  todos: TodoItem[];
}

function todoFilePath(sessionId: string): string {
  // The filename is the sha256 of the WHOLE session id. The old scheme
  // sanitized the id (invalid chars to `_`) and truncated it to 64 chars,
  // so two distinct ids sharing a 64-char prefix - or differing only in
  // characters that sanitize to `_` - wrote the SAME file and silently
  // merged (or clobbered) each other's todos. A hash cannot collide in
  // practice and needs no truncation. The empty-id rejection is preserved
  // (pinned by tests/todo.test.ts: `saveTodos('')` throws).
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (!safe) {
    throw new Error('Invalid session ID');
  }
  const configDir = dirname(getConfigPath());
  return join(configDir, 'todos', `${createHash('sha256').update(sessionId, 'utf8').digest('hex')}.json`);
}

/** The pre-hash filename, for the one-time read migration in `loadTodos`. */
function legacyTodoFilePath(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  if (!safe) {
    throw new Error('Invalid session ID');
  }
  const configDir = dirname(getConfigPath());
  return join(configDir, 'todos', `${safe}.json`);
}

function readTodoFile(path: string): TodoList | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as TodoList).todos)) {
      return parsed as TodoList;
    }
    return null;
  } catch {
    return null;
  }
}

export function loadTodos(sessionId: string): TodoList {
  try {
    const path = todoFilePath(sessionId);
    const current = readTodoFile(path);
    if (current) return current;
    // Natural migration: a list written by an older CLI lives under the
    // legacy sanitized name. Read it once from there; the next save lands
    // under the hashed name.
    const legacy = legacyTodoFilePath(sessionId);
    if (legacy !== path) {
      const old = readTodoFile(legacy);
      if (old) return old;
    }
    return { todos: [] };
  } catch {
    return { todos: [] };
  }
}

export function saveTodos(sessionId: string, list: TodoList): void {
  const path = todoFilePath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  // Atomic (temp+rename) under a lock: the old direct write could be
  // interleaved with a second process's write (lost update) or observed
  // half-written by a concurrent reader. The temp name is random; the mode
  // is applied after the write as well as at creation (see durable-memory).
  const release = acquireTodosLock(path);
  try {
    const tmp = join(
      dirname(path),
      `.${basename(path)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
    );
    try {
      // 0600: todo text may contain pasted secrets (consistent with checkpoint
      // journals, cron store, projects store).
      writeFileSync(tmp, JSON.stringify(list, null, 2), { encoding: 'utf-8', mode: 0o600 });
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
  } finally {
    release();
  }
}

/**
 * Exclusive lock for one todo file: a create-exclusive lock file
 * (`<path>.lock`) holding the owner's pid. Two CLI processes saving the
 * same session's todos at once used to read-modify-write the same file
 * unlocked, so one save silently lost the other.
 *
 * Twin of `acquireRulesLock` in command-rules.ts - no shared lock helper
 * exists in the repo, so the two are kept identical in shape, each pointing
 * at the other. A stale lock (older than 30 s, or owned by a dead pid) is
 * removed; otherwise acquisition waits up to 5 s, then throws rather than
 * proceeding unlocked.
 */
const TODOS_LOCK_TIMEOUT_MS = 5_000;
const TODOS_LOCK_STALE_MS = 30_000;

function acquireTodosLock(path: string): () => void {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + TODOS_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, `${process.pid}\n`);
      } catch {
        /* the pid is advisory - the lock is the file itself */
      }
      return () => {
        try {
          closeSync(fd);
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(lockPath);
        } catch {
          /* ignore - a stale lock is reaped by the next acquirer */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const st = statSync(lockPath);
        stale = Date.now() - st.mtimeMs > TODOS_LOCK_STALE_MS;
        if (!stale) {
          const owner = Number.parseInt(readFileSync(lockPath, 'utf8').trim(), 10);
          if (Number.isInteger(owner) && owner > 0) {
            try {
              process.kill(owner, 0);
            } catch {
              stale = true; // owner pid is dead
            }
          }
        }
      } catch {
        /* lock vanished mid-check - retry */
      }
      if (stale) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* someone else reaped it - retry */
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for the todos lock (${lockPath})`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function addTodo(sessionId: string, text: string): TodoItem {
  const list = loadTodos(sessionId);
  const item: TodoItem = {
    id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text: text.trim(),
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  list.todos.push(item);
  saveTodos(sessionId, list);
  return item;
}

export function updateTodoStatus(
  sessionId: string,
  id: string,
  status: TodoStatus,
): boolean {
  const list = loadTodos(sessionId);
  const item = list.todos.find((t) => t.id === id);
  if (!item) return false;
  item.status = status;
  saveTodos(sessionId, list);
  return true;
}

export function clearCompletedTodos(sessionId: string): number {
  const list = loadTodos(sessionId);
  const before = list.todos.length;
  list.todos = list.todos.filter((t) => t.status !== 'completed');
  saveTodos(sessionId, list);
  return before - list.todos.length;
}
