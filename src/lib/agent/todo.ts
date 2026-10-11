/**
 * Todo list tracking for agent sessions.
 *
 * A simple file-based todo list that the TUI displays and the user (or agent
 * via the /todo command) can manage. Stored per-session in the checkpoint
 * directory.
 *
 * Format: { todos: [{ id, text, status: 'pending'|'in_progress'|'completed', createdAt }] }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
  // Sanitize sessionId to prevent path traversal.
  // Only allow alphanumeric, dash, underscore. Replace others with underscore.
  const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  if (!safe) {
    throw new Error('Invalid session ID');
  }
  const configDir = dirname(getConfigPath());
  return join(configDir, 'todos', `${safe}.json`);
}

export function loadTodos(sessionId: string): TodoList {
  try {
    const path = todoFilePath(sessionId);
    if (!existsSync(path)) return { todos: [] };
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as TodoList).todos)) {
      return parsed as TodoList;
    }
    return { todos: [] };
  } catch {
    return { todos: [] };
  }
}

export function saveTodos(sessionId: string, list: TodoList): void {
  const path = todoFilePath(sessionId);
  mkdirSync(dirname(path), { recursive: true });
  // 0600: todo text may contain pasted secrets (consistent with checkpoint
  // journals, cron store, projects store).
  writeFileSync(path, JSON.stringify(list, null, 2), { encoding: 'utf-8', mode: 0o600 });
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
