import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';

/**
 * User-defined slash commands — PHASE-1 1.6 feature A.
 *
 * Pinned here:
 *  - discovery + precedence: user + project scopes, project wins, built-ins
 *    ALWAYS win (loader skip + registry structural precedence), untrusted
 *    workspace → project commands not loaded (notice pinned);
 *  - broken/invalid/empty files skip with a notice — the loader never throws;
 *  - template expansion: $ARGUMENTS / $1..$9 single-pass substitution,
 *    missing-arg notice, @path includes via the REUSED machinery (boundary
 *    containment + cycle + depth guards), over-budget → error not a trim;
 *  - the registry resolves /name through ctx.resolveUserCommand ONLY in the
 *    default arm;
 *  - slash suggestions carry descriptions for built-ins AND user commands.
 */

let configDir: string;
let cwd: string;

function writeGlobalCommand(name: string, content: string): void {
  const dir = join(configDir, 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, 'utf8');
}

function writeProjectCommand(name: string, content: string): void {
  const dir = join(cwd, '.spycore', 'commands');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content, 'utf8');
}

beforeEach(() => {
  configDir = freshConfigDir();
  cwd = mkdtempSync(join(tmpdir(), 'spycli-ucmd-'));
});

afterEach(async () => {
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  vi.resetModules();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ───────────────────────── discovery + precedence ──────────────────────────

describe('loadUserCommands — discovery, precedence, trust', () => {
  test('user + project scopes load; frontmatter description; fallback to first body line', async () => {
    writeGlobalCommand('review', '---\ndescription: Review the given file\n---\nReview $1 carefully.');
    writeProjectCommand('deploy-notes', 'Draft deploy notes for $ARGUMENTS.');
    const { trustWorkspace } = await import('../src/lib/config.js');
    trustWorkspace(cwd);
    const { loadUserCommands } = await import('../src/lib/slash/user-commands.js');
    const r = loadUserCommands(cwd);
    expect(r.commands.get('review')?.description).toBe('Review the given file');
    expect(r.commands.get('review')?.source).toBe('user');
    expect(r.commands.get('deploy-notes')?.source).toBe('project');
    expect(r.commands.get('deploy-notes')?.description).toContain('Draft deploy notes');
  });

  test('UNTRUSTED workspace: project commands are NOT loaded, with the trust notice', async () => {
    writeProjectCommand('sneaky', 'Do the thing.');
    const { loadUserCommands } = await import('../src/lib/slash/user-commands.js');
    const r = loadUserCommands(cwd);
    expect(r.commands.has('sneaky')).toBe(false);
    expect(
      r.notices.some((n) => n.includes('untrusted workspace') && n.includes('spycore mcp trust')),
    ).toBe(true);
  });

  test('project wins a user-scope collision (noticed)', async () => {
    writeGlobalCommand('summary', 'User-scope body.');
    writeProjectCommand('summary', 'Project-scope body.');
    const { trustWorkspace } = await import('../src/lib/config.js');
    trustWorkspace(cwd);
    const { loadUserCommands } = await import('../src/lib/slash/user-commands.js');
    const r = loadUserCommands(cwd);
    expect(r.commands.get('summary')?.source).toBe('project');
    expect(r.notices.some((n) => n.includes('overrides'))).toBe(true);
  });

  test('a built-in name is skipped with a warning — built-ins always win', async () => {
    writeGlobalCommand('help', 'Hijack the help command.');
    writeGlobalCommand('commit', 'Hijack commit.');
    const { loadUserCommands } = await import('../src/lib/slash/user-commands.js');
    const r = loadUserCommands(cwd);
    expect(r.commands.has('help')).toBe(false);
    expect(r.commands.has('commit')).toBe(false);
    expect(r.notices.filter((n) => n.includes('built-in command with that name wins'))).toHaveLength(2);
  });

  test('invalid names / unreadable entries / empty bodies skip with notices — never a throw', async () => {
    const dir = join(configDir, 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'has space.md'), 'body', 'utf8'); // invalid name
    mkdirSync(join(dir, 'imadir.md')); // unreadable as a file
    writeGlobalCommand('empty', '---\ndescription: nothing\n---\n   \n');
    writeGlobalCommand('fine', 'A working template.');
    const { loadUserCommands } = await import('../src/lib/slash/user-commands.js');
    const r = loadUserCommands(cwd);
    expect(r.commands.has('fine')).toBe(true);
    expect(r.commands.size).toBe(1);
    expect(r.notices.some((n) => n.includes('name must match'))).toBe(true);
    expect(r.notices.some((n) => n.includes('not readable'))).toBe(true);
    expect(r.notices.some((n) => n.includes('empty template body'))).toBe(true);
  });
});

// ───────────────────────── template expansion ──────────────────────────────

describe('expandUserCommand — substitution + @path includes', () => {
  async function loaded(name: string) {
    const { loadUserCommands } = await import('../src/lib/slash/user-commands.js');
    const cmd = loadUserCommands(cwd).commands.get(name);
    if (!cmd) throw new Error(`command ${name} did not load`);
    return cmd;
  }

  test('$ARGUMENTS joins all args; $1..$n are positional', async () => {
    writeGlobalCommand('fix', 'Fix $1 in $2. Context: $ARGUMENTS');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('fix'), ['null-check', 'parser.ts']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toBe('Fix null-check in parser.ts. Context: null-check parser.ts');
      expect(r.notices).toHaveLength(0);
    }
  });

  test('a missing positional substitutes empty + a notice naming the placeholder', async () => {
    writeGlobalCommand('two', 'A=$1 B=$2.');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('two'), ['only-one']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toBe('A=only-one B=.');
      expect(r.notices.some((n) => n.includes('$2'))).toBe(true);
    }
  });

  test('substitution is SINGLE-PASS: an argument containing $1 stays literal', async () => {
    writeGlobalCommand('echoarg', 'Value: $1');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('echoarg'), ['$1-literal']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toBe('Value: $1-literal');
  });

  test('@path includes resolve via the REUSED machinery, inside the boundary', async () => {
    writeFileSync(join(configDir, 'commands-shared.md'), 'SHARED RULES HERE', 'utf8');
    writeGlobalCommand('with-include', 'Apply these rules:\n@../commands-shared.md\nto $1.');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('with-include'), ['app.ts']);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain('SHARED RULES HERE');
      expect(r.message).toContain('to app.ts');
    }
  });

  test('an @path OUTSIDE the boundary is skipped inert (containment guard)', async () => {
    writeGlobalCommand('escape', 'Try:\n@../../../../../../etc/passwd\nend.');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('escape'), []);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).not.toContain('root:');
      expect(r.message).toContain('skipped (outside the project)');
      expect(r.notices.some((n) => n.includes('outside project'))).toBe(true);
    }
  });

  test('an @path cycle is cut by the visited-set guard', async () => {
    const dir = join(configDir, 'commands');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'A then\n@b.txt', 'utf8');
    writeFileSync(join(dir, 'b.txt'), 'B then\n@a.txt', 'utf8');
    writeGlobalCommand('cyclic', '@a.txt');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('cyclic'), []);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain('A then');
      expect(r.message).toContain('B then');
      expect(r.notices.some((n) => n.includes('cycle'))).toBe(true);
    }
  });

  test('include depth stops at the reused MAX_IMPORT_DEPTH', async () => {
    const dir = join(configDir, 'commands');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i <= 6; i += 1) {
      writeFileSync(join(dir, `d${i}.txt`), `level ${i}\n@d${i + 1}.txt`, 'utf8');
    }
    writeGlobalCommand('deep', '@d0.txt');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('deep'), []);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notices.some((n) => n.includes('max depth'))).toBe(true);
  });

  test('over the wire cap: an explicit error, never a silent trim', async () => {
    writeGlobalCommand('huge', `Preamble $1\n${'x'.repeat(40_000)}`);
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('huge'), ['a']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('limit is');
  });
});

// ─────────────────── registry integration + suggestions ────────────────────

describe('registry integration', () => {
  const baseCtx = {
    cwd: '/tmp',
    model: 'hermes' as const,
    effort: 'auto' as const,
    conversationId: 'cnv_x',
    apiUrl: undefined,
    injectGuide: false,
    injectChangelog: false,
  };

  test('/name resolves through ctx.resolveUserCommand to a user-command outcome', async () => {
    writeGlobalCommand('standup', 'Write a standup from $ARGUMENTS.');
    const { loadUserCommands, makeUserCommandResolver } = await import(
      '../src/lib/slash/user-commands.js'
    );
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const resolver = makeUserCommandResolver(loadUserCommands(cwd).commands);
    const outcome = await runSlashCommand('standup', ['yesterday', 'today'], {
      ...baseCtx,
      resolveUserCommand: resolver,
    });
    expect(outcome).toEqual({
      kind: 'user-command',
      name: 'standup',
      source: 'user',
      message: 'Write a standup from yesterday today.',
      notices: [],
    });
  });

  test('built-ins win STRUCTURALLY: a resolver entry named like a built-in is never consulted', async () => {
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const resolver = vi.fn(() => ({
      kind: 'user-command' as const,
      name: 'help',
      source: 'user' as const,
      message: 'hijacked',
      notices: [],
    }));
    const outcome = await runSlashCommand('help', [], { ...baseCtx, resolveUserCommand: resolver });
    expect(outcome).toEqual({ kind: 'help' });
    expect(resolver).not.toHaveBeenCalled();
  });

  test('unknown stays unknown without a resolver, and when the resolver misses', async () => {
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    expect(await runSlashCommand('nope', [], baseCtx)).toEqual({
      kind: 'unknown-command',
      name: 'nope',
    });
    const missing = vi.fn(() => null);
    expect(
      await runSlashCommand('nope', [], { ...baseCtx, resolveUserCommand: missing }),
    ).toEqual({ kind: 'unknown-command', name: 'nope' });
    expect(missing).toHaveBeenCalledOnce();
  });

  test('an over-budget expansion surfaces as user-command-error through the resolver', async () => {
    writeGlobalCommand('big', 'x'.repeat(40_000));
    const { loadUserCommands, makeUserCommandResolver } = await import(
      '../src/lib/slash/user-commands.js'
    );
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const resolver = makeUserCommandResolver(loadUserCommands(cwd).commands);
    const outcome = await runSlashCommand('big', [], { ...baseCtx, resolveUserCommand: resolver });
    expect(outcome.kind).toBe('user-command-error');
  });
});

describe('slash suggestions', () => {
  test('prefix-filters built-ins with their descriptions', async () => {
    const { slashSuggestions } = await import('../src/lib/slash/user-commands.js');
    const s = slashSuggestions('/gu');
    expect(s.some((x) => x.name === 'guide' && x.summary.length > 0)).toBe(true);
    expect(s.every((x) => x.name.startsWith('gu'))).toBe(true);
  });

  test('lists user commands with their DESCRIPTIONS and source', async () => {
    writeGlobalCommand('standup', '---\ndescription: Draft my standup update\n---\nBody.');
    const { loadUserCommands, slashSuggestions } = await import(
      '../src/lib/slash/user-commands.js'
    );
    const { commands } = loadUserCommands(cwd);
    const s = slashSuggestions('/sta', commands);
    expect(s).toEqual([
      { name: 'standup', summary: 'Draft my standup update', source: 'user' },
    ]);
  });

  test('no suggestions after a space, on non-slash input, or with no match', async () => {
    const { slashSuggestions } = await import('../src/lib/slash/user-commands.js');
    expect(slashSuggestions('/guide refresh')).toEqual([]);
    expect(slashSuggestions('hello')).toEqual([]);
    expect(slashSuggestions('/zzz-none')).toEqual([]);
  });
});
