import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateBashCompletion } from '../src/lib/completion/bash.js';
import { generateZshCompletion } from '../src/lib/completion/zsh.js';
import { generateFishCompletion } from '../src/lib/completion/fish.js';
import { generatePowerShellCompletion } from '../src/lib/completion/powershell.js';
import { COMMAND_SPEC, walkCommands, findCommand } from '../src/lib/completion/spec.js';

describe('completion spec', () => {
  test('every advertised command appears in the spec', () => {
    const expected = [
      'version',
      'login',
      'logout',
      'whoami',
      'ping',
      'config',
      'chat',
      'conversations',
      'files',
      'memory',
      'usage',
      'image',
      'agent',
      'provider',
      'skills',
      'update',
      'completion',
      'schema',
    ];
    const top = (COMMAND_SPEC.subcommands ?? []).map((s) => s.name);
    for (const name of expected) {
      expect(top).toContain(name);
    }
  });

  test('walkCommands enumerates nested subcommands', () => {
    const all = [...walkCommands()].map((x) => x.path.join('.'));
    expect(all).toContain('conversations.list');
    expect(all).toContain('files.upload');
    expect(all).toContain('config.set');
    expect(all).toContain('memory.delete');
  });

  test('findCommand resolves nested paths', () => {
    expect(findCommand(['chat'])?.name).toBe('chat');
    expect(findCommand(['conversations', 'export'])?.name).toBe('export');
    expect(findCommand(['nope'])).toBeUndefined();
  });

  test('chat command exposes the canonical model values', () => {
    const chat = findCommand(['chat']);
    const modelOpt = chat?.options?.find((o) => o.name === '--model');
    expect(modelOpt?.values).toEqual(['hermes', 'minos', 'styx', 'styx_max', 'charon']);
  });

  /**
   * Contract tests for spec-vs-implementation drift classes seen in the
   * past — pin them so a future authoring slip can't reintroduce the
   * same drift silently.
   */
  test('chat does NOT advertise the removed --search flag', () => {
    const chat = findCommand(['chat']);
    expect(chat?.options?.find((o) => o.name === '--search')).toBeUndefined();
  });

  test('chat does NOT advertise --format (it streams; --format is for read/list commands)', () => {
    const chat = findCommand(['chat']);
    expect(chat?.options?.find((o) => o.name === '--format')).toBeUndefined();
  });

  test('memory add does NOT advertise the nonexistent --stdin flag', () => {
    const add = findCommand(['memory', 'add']);
    expect(add?.options?.find((o) => o.name === '--stdin')).toBeUndefined();
  });

  test('files upload exposes -n/--name, -p/--purpose, and --mime', () => {
    const upload = findCommand(['files', 'upload']);
    const names = upload?.options?.map((o) => o.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(['--name', '--purpose', '--mime']));
    expect(upload?.options?.find((o) => o.name === '--name')?.short).toBe('-n');
    expect(upload?.options?.find((o) => o.name === '--purpose')?.short).toBe('-p');
  });

  test('files download exposes -f/--force', () => {
    const dl = findCommand(['files', 'download']);
    expect(dl?.options?.find((o) => o.name === '--force')?.short).toBe('-f');
  });

  test('files list exposes --page (server-side pagination)', () => {
    const list = findCommand(['files', 'list']);
    expect(list?.options?.find((o) => o.name === '--page')).toBeDefined();
  });

  test('read/list commands expose --format with output-format values', () => {
    const fmtValues = ['text', 'json', 'markdown', 'yaml'];
    const convFmt = findCommand(['conversations', 'list'])?.options?.find(
      (o) => o.name === '--format',
    );
    expect(convFmt?.values).toEqual(fmtValues);
    for (const path of [['files', 'list'], ['usage'], ['whoami']]) {
      expect(
        findCommand(path)?.options?.find((o) => o.name === '--format'),
      ).toBeDefined();
    }
  });

  test('config list exposes --format and config get exposes --reveal', () => {
    const list = findCommand(['config', 'list']);
    expect(list?.options?.find((o) => o.name === '--format')?.values).toEqual([
      'text',
      'json',
      'markdown',
      'yaml',
    ]);
    const get = findCommand(['config', 'get']);
    expect(get?.options?.find((o) => o.name === '--reveal')).toBeDefined();
  });

  test('image exposes -c/--count', () => {
    const img = findCommand(['image']);
    expect(img?.options?.find((o) => o.name === '--count')?.short).toBe('-c');
  });

  test('login exposes --no-open', () => {
    const login = findCommand(['login']);
    expect(login?.options?.find((o) => o.name === '--no-open')).toBeDefined();
  });

  test('memory list exposes --category and --limit', () => {
    const ml = findCommand(['memory', 'list']);
    const names = ml?.options?.map((o) => o.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(['--category', '--limit']));
  });

  test('memory add exposes -c/--category and --pinned', () => {
    const add = findCommand(['memory', 'add']);
    const names = add?.options?.map((o) => o.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(['--category', '--pinned']));
    expect(add?.options?.find((o) => o.name === '--category')?.short).toBe('-c');
  });

  test('agent model values exclude HEPHAESTUS (text models only)', () => {
    const agent = findCommand(['agent']);
    const modelOpt = agent?.options?.find((o) => o.name === '--model');
    expect(modelOpt?.values).toEqual(['hermes', 'minos', 'styx', 'charon']);
  });
});

describe('bash completion', () => {
  test('script header declares bash and ends with complete -F', () => {
    const out = generateBashCompletion();
    expect(out).toContain('#!/usr/bin/env bash');
    expect(out).toContain('complete -F _spycore spycore');
  });

  test('emits a case branch for every top-level command', () => {
    const out = generateBashCompletion();
    for (const sub of COMMAND_SPEC.subcommands ?? []) {
      expect(out).toContain(`"${sub.name}"`);
    }
  });

  test('emits value tables for choice-typed flags', () => {
    const out = generateBashCompletion();
    // Chat model choices.
    expect(out).toContain('hermes minos styx charon');
    // conversations export --format choices.
    expect(out).toContain('markdown json');
  });

  test('passes bash -n syntax check', () => {
    const out = generateBashCompletion();
    const dir = mkdtempSync(join(tmpdir(), 'spycli-bash-'));
    const file = join(dir, 'completion.bash');
    writeFileSync(file, out, 'utf-8');
    // bash -n parses without executing. Skip on Windows where bash may
    // not be on PATH for non-WSL runners — we still validated the bytes
    // above and the script is generated deterministically.
    try {
      execFileSync('bash', ['-n', file], { stdio: 'pipe' });
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === 'ENOENT') return; // bash not installed
      throw err;
    }
  });

});

describe('zsh completion', () => {
  test('starts with #compdef spycore', () => {
    const out = generateZshCompletion();
    expect(out.startsWith('#compdef spycore')).toBe(true);
  });

  test('emits a function per command', () => {
    const out = generateZshCompletion();
    expect(out).toContain('_spycore() {');
    expect(out).toContain('_spycore_chat() {');
    expect(out).toContain('_spycore_conversations() {');
    expect(out).toContain('_spycore_conversations_list() {');
  });

  test('uses _describe for subcommand menus with descriptions', () => {
    const out = generateZshCompletion();
    expect(out).toContain('_describe ');
    expect(out).toContain('Send a message and stream the assistant reply');
  });

  test('flag specs include value choices for --model', () => {
    const out = generateZshCompletion();
    expect(out).toMatch(/hermes minos styx charon/);
  });

});

describe('fish completion', () => {
  test('disables file completion globally then opts back in for arg-taking commands', () => {
    const out = generateFishCompletion();
    expect(out).toContain('complete -c spycore -f');
    // chat takes positional args, so it should re-enable file completion in
    // the chat scope. We assert the directive exists.
    expect(out).toMatch(/__fish_seen_subcommand_from chat.*-F/);
  });

  test('every top-level subcommand is registered with __fish_use_subcommand', () => {
    const out = generateFishCompletion();
    for (const sub of COMMAND_SPEC.subcommands ?? []) {
      expect(out).toContain(`-n '__fish_use_subcommand' -a '${sub.name}'`);
    }
  });

  test('emits value choices for --model', () => {
    const out = generateFishCompletion();
    expect(out).toMatch(/-l model.*-x -a 'hermes minos styx charon'/);
  });

  test('escapes single quotes in descriptions', () => {
    const out = generateFishCompletion();
    // Sanity: no unescaped single quote inside a description body. We just
    // make sure the generated script is syntactically reasonable: every
    // `-d '...'` directive opens and closes its quote on the same line.
    for (const line of out.split('\n')) {
      const matches = line.match(/-d '/g);
      if (!matches) continue;
      // Count unescaped single quotes after `-d '` to make sure we close.
      // Simple heuristic — fails if a description contains `\'` but ends
      // without a closing `'` which we don't generate.
      const trimmed = line.trim();
      expect(trimmed.endsWith("'")).toBe(true);
    }
  });

});

describe('powershell completion', () => {
  test('uses Register-ArgumentCompleter -Native', () => {
    const out = generatePowerShellCompletion();
    expect(out).toContain('Register-ArgumentCompleter -Native -CommandName spycore');
  });

  test('declares subcommand and option hashtables', () => {
    const out = generatePowerShellCompletion();
    expect(out).toContain('$global:SpycoreCompletionSubs = @{');
    expect(out).toContain('$global:SpycoreCompletionOpts = @{');
    expect(out).toContain('$global:SpycoreCompletionValues = @{');
  });

  test('every top-level subcommand has an entry', () => {
    const out = generatePowerShellCompletion();
    for (const sub of COMMAND_SPEC.subcommands ?? []) {
      expect(out).toContain(`'${sub.name}'`);
    }
  });

  test('value tables include model choices', () => {
    const out = generatePowerShellCompletion();
    expect(out).toMatch(/'hermes', 'minos', 'styx', 'charon'/);
  });

  test('returns CompletionResult objects', () => {
    const out = generatePowerShellCompletion();
    expect(out).toContain('[System.Management.Automation.CompletionResult]::new');
  });

});
