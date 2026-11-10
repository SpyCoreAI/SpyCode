/**
 * The TUI command registry: input classification, prefix filtering (palette +
 * composer), and the small fixed set the proposal requires.
 */
import { describe, expect, test } from 'vitest';
import {
  TUI_COMMANDS,
  filterCommands,
  findCommand,
  parseTuiInput,
} from '../src/ui/tui/commands.js';

describe('parseTuiInput', () => {
  test('slash lines become commands with split args', () => {
    expect(parseTuiInput('/help')).toEqual({ kind: 'command', name: 'help', args: [] });
    expect(parseTuiInput('/model auto')).toEqual({ kind: 'command', name: 'model', args: ['auto'] });
    expect(parseTuiInput('/resume 12 --force')).toEqual({
      kind: 'command',
      name: 'resume',
      args: ['12', '--force'],
    });
  });

  test('unknown slash still classifies as a command (TUI reports it, not the shell)', () => {
    expect(parseTuiInput('/frobnicate')).toEqual({ kind: 'command', name: 'frobnicate', args: [] });
  });

  test('shell mode', () => {
    expect(parseTuiInput('!ls -la')).toEqual({ kind: 'shell', command: 'ls -la' });
    expect(parseTuiInput('!  ')).toEqual({ kind: 'shell', command: '' });
  });

  test('everything else is a task', () => {
    expect(parseTuiInput('hello world')).toEqual({ kind: 'task', text: 'hello world' });
    expect(parseTuiInput('@file.ts explain')).toEqual({ kind: 'task', text: '@file.ts explain' });
  });

  test('blank input is empty', () => {
    expect(parseTuiInput('')).toEqual({ kind: 'empty' });
    expect(parseTuiInput('   ')).toEqual({ kind: 'empty' });
  });
});

describe('registry', () => {
  test('carries the exact v1 slash set', () => {
    const names = TUI_COMMANDS.map((c) => c.name).sort();
    expect(names).toEqual(
      ['approval', 'branch', 'clear', 'compact', 'diagnose', 'diff', 'exit', 'fork', 'help', 'model', 'new', 'plan', 'redo', 'resume', 'theme', 'todo', 'undo', 'usage'].sort(),
    );
  });

  test('every command has a plain-words summary and usage hint', () => {
    for (const c of TUI_COMMANDS) {
      expect(c.summary.length).toBeGreaterThan(0);
      expect(typeof c.usage).toBe('string');
    }
  });

  test('findCommand is an exact lookup', () => {
    expect(findCommand('help')?.name).toBe('help');
    expect(findCommand('nope')).toBeUndefined();
  });

  test('filterCommands matches name prefixes, case-insensitively', () => {
    expect(filterCommands('mo').map((c) => c.name)).toEqual(['model']);
    expect(filterCommands('/TH').map((c) => c.name)).toEqual(['theme']);
    expect(filterCommands('')).toHaveLength(TUI_COMMANDS.length);
    expect(filterCommands('zzz')).toHaveLength(0);
  });
});
