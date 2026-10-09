import { beforeEach, describe, expect, test } from 'vitest';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests } from '../src/lib/config.js';
import {
  addTodo,
  clearCompletedTodos,
  loadTodos,
  saveTodos,
  updateTodoStatus,
} from '../src/lib/agent/todo.js';

const SESSION = 'test-session-1';

beforeEach(() => {
  freshConfigDir();
  __resetConfigForTests();
});

describe('loadTodos / saveTodos', () => {
  test('a fresh session starts empty', () => {
    expect(loadTodos(SESSION)).toEqual({ todos: [] });
  });

  test('round-trips a list', () => {
    const item = addTodo(SESSION, '  write tests  ');
    expect(item.text).toBe('write tests'); // trimmed
    expect(item.status).toBe('pending');
    expect(item.id.length).toBeGreaterThan(0);
    expect(typeof item.createdAt).toBe('string');

    const loaded = loadTodos(SESSION);
    expect(loaded.todos).toHaveLength(1);
    expect(loaded.todos[0]).toEqual(item);
  });

  test('sessions are isolated from each other', () => {
    addTodo(SESSION, 'one');
    expect(loadTodos('other-session').todos).toHaveLength(0);
  });

  test('corrupt files load as empty instead of throwing', async () => {
    const { getConfigPath } = await import('../src/lib/config.js');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const todosDir = join(dirname(getConfigPath()), 'todos');
    mkdirSync(todosDir, { recursive: true });
    writeFileSync(join(todosDir, 'corrupt.json'), '{not valid json', 'utf-8');
    expect(loadTodos('corrupt')).toEqual({ todos: [] });
  });

  test('session ids are sanitized against path traversal', () => {
    // ../.. is flattened to underscores and length-capped at 64 chars.
    addTodo('../../evil', 'x');
    expect(loadTodos('../../evil').todos).toHaveLength(1);
    expect(loadTodos('evil').todos).toHaveLength(0); // not the same file
  });

  test('an empty session id throws on write (loadTodos swallows it by design)', () => {
    expect(loadTodos('')).toEqual({ todos: [] });
    expect(() => saveTodos('', { todos: [] })).toThrow('Invalid session ID');
    expect(() => addTodo('', 'x')).toThrow('Invalid session ID');
  });
});

describe('updateTodoStatus', () => {
  test('moves an item through the lifecycle', () => {
    const item = addTodo(SESSION, 'task');
    expect(updateTodoStatus(SESSION, item.id, 'in_progress')).toBe(true);
    expect(loadTodos(SESSION).todos[0]!.status).toBe('in_progress');
    expect(updateTodoStatus(SESSION, item.id, 'completed')).toBe(true);
    expect(loadTodos(SESSION).todos[0]!.status).toBe('completed');
  });

  test('unknown id returns false', () => {
    addTodo(SESSION, 'task');
    expect(updateTodoStatus(SESSION, 'nope', 'completed')).toBe(false);
  });
});

describe('clearCompletedTodos', () => {
  test('removes only completed items and reports the count', () => {
    const a = addTodo(SESSION, 'a');
    addTodo(SESSION, 'b');
    updateTodoStatus(SESSION, a.id, 'completed');
    expect(clearCompletedTodos(SESSION)).toBe(1);
    const remaining = loadTodos(SESSION).todos;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.text).toBe('b');
  });

  test('no completed items → 0', () => {
    addTodo(SESSION, 'a');
    expect(clearCompletedTodos(SESSION)).toBe(0);
  });
});
