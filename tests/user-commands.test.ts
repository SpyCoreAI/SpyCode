import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';

/**
 * User-defined slash commands - PHASE-1 1.6 feature A.
 *
 * Pinned here:
 *  - discovery + precedence: user + project scopes, project wins, built-ins
 *    ALWAYS win (loader skip + registry structural precedence), untrusted
 *    workspace → project commands not loaded (notice pinned);
 *  - broken/invalid/empty files skip with a notice - the loader never throws;
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

describe('loadUserCommands - discovery, precedence, trust', () => {
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

  test('a built-in name is skipped with a warning - built-ins always win', async () => {
    writeGlobalCommand('help', 'Hijack the help command.');
    writeGlobalCommand('commit', 'Hijack commit.');
    const { loadUserCommands } = await import('../src/lib/slash/user-commands.js');
    const r = loadUserCommands(cwd);
    expect(r.commands.has('help')).toBe(false);
    expect(r.commands.has('commit')).toBe(false);
    expect(r.notices.filter((n) => n.includes('built-in command with that name wins'))).toHaveLength(2);
  });

  test('invalid names / unreadable entries / empty bodies skip with notices - never a throw', async () => {
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

describe('expandUserCommand - substitution + @path includes', () => {
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

// ─────────────────── F6: $NAME named args + --arg flags ─────────────────────

describe('F6 named placeholders', () => {
  async function loaded(name: string) {
    const { loadUserCommands } = await import('../src/lib/slash/user-commands.js');
    const cmd = loadUserCommands(cwd).commands.get(name);
    if (!cmd) throw new Error(`command ${name} did not load`);
    return cmd;
  }

  test('extractNamedPlaceholders: unique, in order; skips $ARGUMENTS and $1..$9', async () => {
    const { extractNamedPlaceholders } = await import('../src/lib/slash/user-commands.js');
    expect(extractNamedPlaceholders('Review $FILE. Again $FILE. Say $MESSAGE to $1. All: $ARGUMENTS.')).toEqual([
      'FILE',
      'MESSAGE',
    ]);
    expect(extractNamedPlaceholders('no placeholders here')).toEqual([]);
    expect(extractNamedPlaceholders('$ARGUMENTS $1 $9')).toEqual([]);
    // `$1x` is positional $1 + literal "x", not a named placeholder.
    expect(extractNamedPlaceholders('$1x')).toEqual([]);
  });

  test('expandUserCommand substitutes $NAME from the named map', async () => {
    writeGlobalCommand('review', 'Review $FILE and tell $MESSAGE.');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('review'), [], { FILE: 'src/a.ts', MESSAGE: 'the team' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toBe('Review src/a.ts and tell the team.');
      expect(r.notices).toHaveLength(0);
    }
  });

  test('named + positional + $ARGUMENTS combine in one template', async () => {
    writeGlobalCommand('combo', '$FILE: fix $1 ($ARGUMENTS) - $MESSAGE');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('combo'), ['null-check'], {
      FILE: 'a.ts',
      MESSAGE: 'urgent',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toBe('a.ts: fix null-check (null-check) - urgent');
  });

  test('a missing $NAME substitutes empty + a notice naming the flag form', async () => {
    writeGlobalCommand('needs', 'File: $FILE.');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('needs'), [], {});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toBe('File: .');
      expect(r.notices.some((n) => n.includes('$FILE') && n.includes('--arg FILE=value'))).toBe(true);
    }
  });

  test('$NAME substitution is SINGLE-PASS: a value containing $NAME stays literal', async () => {
    writeGlobalCommand('lit', 'Value: $FILE');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('lit'), [], { FILE: '$MESSAGE and $1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toBe('Value: $MESSAGE and $1');
  });

  test('$NAME matching is case-sensitive', async () => {
    writeGlobalCommand('cs', '$File vs $FILE');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('cs'), [], { FILE: 'upper' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toBe('vs upper');
      expect(r.notices.some((n) => n.includes('$File'))).toBe(true);
    }
  });

  test('explicitly empty --arg value substitutes empty WITHOUT a missing notice', async () => {
    writeGlobalCommand('empty-ok', 'Note: [$NOTE]');
    const { expandUserCommand } = await import('../src/lib/slash/user-commands.js');
    const r = expandUserCommand(await loaded('empty-ok'), [], { NOTE: '' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toBe('Note: []');
      expect(r.notices).toHaveLength(0);
    }
  });
});

describe('splitNamedArgFlags', () => {
  test('strips --arg NAME=value and --arg=NAME=value, keeps positionals', async () => {
    const { splitNamedArgFlags } = await import('../src/lib/slash/user-commands.js');
    const r = splitNamedArgFlags(['pos1', '--arg', 'FILE=a.ts', '--arg=MESSAGE=hi', 'pos2']);
    expect(r.positional).toEqual(['pos1', 'pos2']);
    expect(r.named).toEqual({ FILE: 'a.ts', MESSAGE: 'hi' });
    expect(r.notices).toHaveLength(0);
  });

  test('quoted values may span tokens; quotes are stripped', async () => {
    const { splitNamedArgFlags } = await import('../src/lib/slash/user-commands.js');
    const r = splitNamedArgFlags(['--arg', 'MESSAGE="ship', 'it', 'friday"', '--arg', "NOTE='a=b'"]);
    expect(r.named).toEqual({ MESSAGE: 'ship it friday', NOTE: 'a=b' });
    expect(r.positional).toEqual([]);
  });

  test('last --arg for a NAME wins; value may contain =', async () => {
    const { splitNamedArgFlags } = await import('../src/lib/slash/user-commands.js');
    const r = splitNamedArgFlags(['--arg', 'FILE=a.ts', '--arg', 'FILE=b=c.ts']);
    expect(r.named).toEqual({ FILE: 'b=c.ts' });
  });

  test('malformed flags are dropped with a notice - never a throw, never positional', async () => {
    const { splitNamedArgFlags } = await import('../src/lib/slash/user-commands.js');
    const r = splitNamedArgFlags(['pos', '--arg', 'BAD-NAME=x', '--arg', 'NOEQUALS', '--arg']);
    expect(r.positional).toEqual(['pos']);
    expect(r.named).toEqual({});
    expect(r.notices).toHaveLength(3);
  });

  test('a lone trailing --arg is dropped with a notice', async () => {
    const { splitNamedArgFlags } = await import('../src/lib/slash/user-commands.js');
    const r = splitNamedArgFlags(['pos', '--arg']);
    expect(r.positional).toEqual(['pos']);
    expect(r.named).toEqual({});
    expect(r.notices).toHaveLength(1);
  });
});

describe('F6 resolver + registry integration', () => {
  const baseCtx = {
    cwd: '/tmp',
    model: 'hermes' as const,
    effort: 'auto' as const,
    conversationId: 'cnv_x',
    apiUrl: undefined,
    injectGuide: false,
    injectChangelog: false,
  };

  async function loaded(name: string) {
    const { loadUserCommands } = await import('../src/lib/slash/user-commands.js');
    const cmd = loadUserCommands(cwd).commands.get(name);
    if (!cmd) throw new Error(`command ${name} did not load`);
    return cmd;
  }

  test('sync resolver: --arg flags feed $NAME on the invocation line', async () => {
    writeGlobalCommand('review', 'Review $FILE for $1.');
    const { loadUserCommands, makeUserCommandResolver } = await import(
      '../src/lib/slash/user-commands.js'
    );
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const resolver = makeUserCommandResolver(loadUserCommands(cwd).commands);
    const outcome = await runSlashCommand('review', ['null-check', '--arg', 'FILE=a.ts'], {
      ...baseCtx,
      resolveUserCommand: resolver,
    });
    expect(outcome).toEqual({
      kind: 'user-command',
      name: 'review',
      source: 'user',
      message: 'Review a.ts for null-check.',
      notices: [],
    });
  });

  test('sync resolver: malformed --arg flags surface as notices', async () => {
    writeGlobalCommand('review', 'Review $FILE.');
    const { loadUserCommands, makeUserCommandResolver } = await import(
      '../src/lib/slash/user-commands.js'
    );
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const resolver = makeUserCommandResolver(loadUserCommands(cwd).commands);
    const outcome = await runSlashCommand('review', ['--arg', 'BAD NAME=x'], {
      ...baseCtx,
      resolveUserCommand: resolver,
    });
    expect(outcome.kind).toBe('user-command');
    if (outcome.kind === 'user-command') {
      expect(outcome.message).toBe('Review .');
      expect(outcome.notices.some((n) => n.includes('malformed --arg'))).toBe(true);
      expect(outcome.notices.some((n) => n.includes('$FILE'))).toBe(true);
    }
  });

  test('async resolver prompts for missing $NAME in template order', async () => {
    writeGlobalCommand('plan', 'File $FILE: $MESSAGE ($FILE again).');
    const { loadUserCommands, makeUserCommandResolverAsync } = await import(
      '../src/lib/slash/user-commands.js'
    );
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const asked: string[] = [];
    const resolver = makeUserCommandResolverAsync(loadUserCommands(cwd).commands, async (ph) => {
      asked.push(ph);
      return { FILE: 'a.ts', MESSAGE: 'go' }[ph];
    });
    const outcome = await runSlashCommand('plan', [], {
      ...baseCtx,
      resolveUserCommandAsync: resolver,
    });
    expect(asked).toEqual(['FILE', 'MESSAGE']);
    expect(outcome).toEqual({
      kind: 'user-command',
      name: 'plan',
      source: 'user',
      message: 'File a.ts: go (a.ts again).',
      notices: [],
    });
  });

  test('async resolver: skipped --arg names are not prompted; declined prompt → notice + empty', async () => {
    writeGlobalCommand('plan', '$FILE then $MESSAGE.');
    const { loadUserCommands, makeUserCommandResolverAsync } = await import(
      '../src/lib/slash/user-commands.js'
    );
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const asked: string[] = [];
    const resolver = makeUserCommandResolverAsync(
      loadUserCommands(cwd).commands,
      async (ph) => {
        asked.push(ph);
        return undefined; // user declined / empty dialog
      },
    );
    const outcome = await runSlashCommand('plan', ['--arg', 'FILE=a.ts'], {
      ...baseCtx,
      resolveUserCommandAsync: resolver,
    });
    expect(asked).toEqual(['MESSAGE']);
    expect(outcome.kind).toBe('user-command');
    if (outcome.kind === 'user-command') {
      expect(outcome.message).toBe('a.ts then .');
      expect(outcome.notices.some((n) => n.includes('$MESSAGE'))).toBe(true);
    }
  });

  test('async resolver without a prompt behaves like the sync resolver', async () => {
    writeGlobalCommand('review', 'Review $FILE.');
    const { loadUserCommands, makeUserCommandResolverAsync } = await import(
      '../src/lib/slash/user-commands.js'
    );
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const resolver = makeUserCommandResolverAsync(loadUserCommands(cwd).commands);
    const outcome = await runSlashCommand('review', ['--arg=FILE=a.ts'], {
      ...baseCtx,
      resolveUserCommandAsync: resolver,
    });
    expect(outcome).toEqual({
      kind: 'user-command',
      name: 'review',
      source: 'user',
      message: 'Review a.ts.',
      notices: [],
    });
  });

  test('registry: async resolver is NOT consulted for built-ins; misses stay unknown', async () => {
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const asyncResolver = vi.fn(async (name: string) =>
      name === 'help'
        ? {
            kind: 'user-command' as const,
            name: 'help',
            source: 'user' as const,
            message: 'hijacked',
            notices: [],
          }
        : null,
    );
    const outcome = await runSlashCommand('help', [], {
      ...baseCtx,
      resolveUserCommandAsync: asyncResolver,
    });
    expect(outcome).toEqual({ kind: 'help' });
    expect(asyncResolver).not.toHaveBeenCalled();
    expect(
      await runSlashCommand('nope', [], { ...baseCtx, resolveUserCommandAsync: asyncResolver }),
    ).toEqual({ kind: 'unknown-command', name: 'nope' });
    expect(asyncResolver).toHaveBeenCalledOnce();
  });

  test('registry: sync resolver result wins over the async resolver', async () => {
    writeGlobalCommand('dup', 'sync $FILE.');
    const { loadUserCommands, makeUserCommandResolver, makeUserCommandResolverAsync } =
      await import('../src/lib/slash/user-commands.js');
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const outcome = await runSlashCommand('dup', ['--arg', 'FILE=a.ts'], {
      ...baseCtx,
      resolveUserCommand: makeUserCommandResolver(loadUserCommands(cwd).commands),
      resolveUserCommandAsync: makeUserCommandResolverAsync(loadUserCommands(cwd).commands),
    });
    expect(outcome.kind).toBe('user-command');
    if (outcome.kind === 'user-command') expect(outcome.message).toBe('sync a.ts.');
  });
});
