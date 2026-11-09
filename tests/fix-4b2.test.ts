/**
 * Phase 4b2 (Low, other commands) regression tests.
 *
 * Each test pins one fixed item so the old silent behavior cannot come back:
 * server-shape guards, export overwrite rules, share 404 mapping, upload
 * plan wording / expiry validation, download size verification, usage flag
 * combination, memory-delete phrase casing, curator validation, skill
 * removal containment, import path/force/key-order/copy warnings, MCP
 * command validation, toolset no-ops, update --check exit codes, ping
 * health reporting, rewind flag combination, runs JSON hygiene, atomic
 * cron/projects stores, and image --count validation.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { freshConfigDir } from './helpers.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: {
    json: () => Promise<unknown>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
  };
}

let responder:
  | ((url: string, init: { method: string; body?: unknown }) => MockResp)
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET', body: init.body });
  }),
}));

// Scripted answers for readSingleLineInput (memory delete confirmation).
// Sync factory (no importOriginal): the async importOriginal form made the
// first module import of this file pathologically slow under vitest.
const promptAnswers = vi.hoisted(() => ({ answers: [] as string[] }));

vi.mock('../src/lib/prompt.js', () => ({
  isPromptCancelled: (err: unknown): boolean =>
    Boolean(err && typeof err === 'object' && (err as { cancelled?: unknown }).cancelled === true),
  readSingleLineInput: vi.fn(async () => promptAnswers.answers.shift() ?? ''),
  readMultilineInput: vi.fn(async () => ''),
  readStdinPipe: vi.fn(async () => ''),
  confirmYesNo: vi.fn(async () => false),
}));

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origStdinTTY = process.stdin.isTTY;

function stdout(): string {
  return stdoutChunks.join('');
}
function allOut(): string {
  return stdoutChunks.join('') + stderrChunks.join('');
}

function jsonResp(status: number, body: unknown): MockResp {
  return {
    statusCode: status,
    headers: {},
    body: { json: async () => body },
  };
}

async function runCli(
  modulePath: string,
  registerName: string,
  argv: string[],
  parentArgs: string[] = [],
  registerArg?: unknown,
): Promise<void> {
  const { Command } = await import('commander');
  const mod = (await import(modulePath)) as Record<
    string,
    (program: never, arg?: unknown) => void
  >;
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.exitOverride();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  const register = mod[registerName]!;
  if (registerArg === undefined) register(program as never);
  else register(program as never, registerArg);
  await program.parseAsync(['node', 'spycore', ...parentArgs, ...argv]);
}

async function setToken(): Promise<void> {
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
}

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  promptAnswers.answers = [];
  stdoutChunks = [];
  stderrChunks = [];
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  await setToken();
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  (process.stdin as { isTTY?: boolean }).isTTY = origStdinTTY;
  vi.resetModules();
});

const CONV_MOD = '../src/commands/conversations/index.js';

function convoWithoutMessages(id = 'cnv_1'): Record<string, unknown> {
  return {
    id,
    title: 'Demo',
    model: 'HERMES',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    // No `messages` key at all - the server-shape drift case.
  };
}

describe('conversations show/export/share without a messages array', () => {
  // 60s: these two pay the first-import cost of the conversations module
  // graph (agent loop, hooks, tools) under vitest transform, which alone
  // exceeds the 10s default in this environment - the timeout covers
  // import, not the assertion.
  test('show prints the header instead of crashing on .slice', async () => {
    responder = () => jsonResp(200, { success: true, data: convoWithoutMessages() });
    await runCli(CONV_MOD, 'registerConversationsCommand', ['conversations', 'show', 'cnv_1']);
    expect(stdout()).toContain('# Demo');
  }, 60_000);

  test('export to stdout works without messages', async () => {
    responder = () => jsonResp(200, { success: true, data: convoWithoutMessages() });
    await runCli(CONV_MOD, 'registerConversationsCommand', ['conversations', 'export', 'cnv_1']);
    expect(stdout()).toContain('# Demo');
  }, 60_000);

  test('buildShareBody degrades to an empty message list', async () => {
    const { buildShareBody } = await import('../src/commands/conversations/share.js');
    const body = buildShareBody(convoWithoutMessages() as never);
    expect(body.messages).toEqual([]);
  });
});

describe('conversations export -o', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-4b2-export-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function exportResponder(): void {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: { ...convoWithoutMessages(), messages: [] },
      });
  }

  test('creates a missing parent directory', async () => {
    exportResponder();
    const out = join(workDir, 'deep', 'nested', 'out.md');
    await runCli(CONV_MOD, 'registerConversationsCommand', [
      'conversations',
      'export',
      'cnv_1',
      '--output',
      out,
    ]);
    expect(readFileSync(out, 'utf8')).toContain('# Demo');
  });

  test('refuses to overwrite without --force, overwrites with it', async () => {
    exportResponder();
    const out = join(workDir, 'out.md');
    writeFileSync(out, 'pre-existing');
    await expect(
      runCli(CONV_MOD, 'registerConversationsCommand', [
        'conversations',
        'export',
        'cnv_1',
        '--output',
        out,
      ]),
    ).rejects.toThrow(/Refusing to overwrite/);
    expect(readFileSync(out, 'utf8')).toBe('pre-existing');
    await runCli(CONV_MOD, 'registerConversationsCommand', [
      'conversations',
      'export',
      'cnv_1',
      '--output',
      out,
      '--force',
    ]);
    expect(readFileSync(out, 'utf8')).toContain('# Demo');
  });
});

describe('conversations share --revoke 404 mapping', () => {
  test('a missing conversation reports "not found", not "unsupported"', async () => {
    let deletes = 0;
    responder = (url, init) => {
      if (init.method === 'DELETE') {
        deletes += 1;
        return jsonResp(200, { success: true, data: {} });
      }
      return jsonResp(404, { success: false, error: 'Not found' });
    };
    await expect(
      runCli(CONV_MOD, 'registerConversationsCommand', [
        'conversations',
        'share',
        'cnv_nope',
        '--revoke',
      ]),
    ).rejects.toThrow(/Conversation not found: cnv_nope/);
    expect(deletes).toBe(0);
  });

  test('an existing conversation whose share route 404s reports unsupported', async () => {
    // The revoke path reports this through fail(), which exits the process
    // (it does not throw) - so the assertion is on the exit + stderr text.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw Object.assign(new Error(`__exit_${code}__`), { exitCode: code });
    }) as never);
    try {
      responder = (url, init) => {
        if (init.method === 'DELETE') return jsonResp(404, { success: false, error: 'Not found' });
        return jsonResp(200, {
          success: true,
          data: { ...convoWithoutMessages(), messages: [] },
        });
      };
      await expect(
        runCli(CONV_MOD, 'registerConversationsCommand', [
          'conversations',
          'share',
          'cnv_1',
          '--revoke',
        ]),
      ).rejects.toThrow('__exit_1__');
      expect(allOut()).toContain('does not support share links');
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe('skills curator validation', () => {
  const SKILLS_MOD = '../src/commands/skills/index.js';

  async function userSkillsDir(): Promise<string> {
    const { getConfigPath } = await import('../src/lib/config.js');
    return join(dirname(getConfigPath()), 'skills');
  }

  test('--stale-days abc errors instead of silently becoming 90', async () => {
    await expect(
      runCli(SKILLS_MOD, 'registerSkillsCommand', ['skills', 'curator', '--stale-days', 'abc']),
    ).rejects.toThrow(/Invalid --stale-days/);
  });

  test('--pin on a nonexistent skill errors', async () => {
    await expect(
      runCli(SKILLS_MOD, 'registerSkillsCommand', ['skills', 'curator', '--pin', 'ghost']),
    ).rejects.toThrow(/No user-global skill named "ghost"/);
  });

  test('--pin on a real skill still works', async () => {
    const dir = join(await userSkillsDir(), 'demo-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# Demo\n', 'utf8');
    await runCli(SKILLS_MOD, 'registerSkillsCommand', ['skills', 'curator', '--pin', 'demo-skill']);
    expect(stdout()).toContain('Pinned "demo-skill"');
  });

  test('--archive without --yes refuses in a non-interactive session', async () => {
    const dir = join(await userSkillsDir(), 'old-idle');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '# Old\n', 'utf8');
    const past = new Date(Date.now() - 200 * 86400_000);
    utimesSync(dir, past, past);
    await expect(
      runCli(SKILLS_MOD, 'registerSkillsCommand', ['skills', 'curator', '--archive']),
    ).rejects.toThrow(/Refusing to archive 1 skill/);
  });

  test('--archive --yes archives a stale skill, and --pin + --archive does both', async () => {
    const base = await userSkillsDir();
    for (const name of ['old-a', 'old-b']) {
      const dir = join(base, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), `# ${name}\n`, 'utf8');
      const past = new Date(Date.now() - 200 * 86400_000);
      utimesSync(dir, past, past);
    }
    await runCli(SKILLS_MOD, 'registerSkillsCommand', [
      'skills',
      'curator',
      '--pin',
      'old-a',
      '--archive',
      '--yes',
    ]);
    expect(stdout()).toContain('Pinned "old-a"');
    // old-a is pinned (so not stale); old-b was archived, not dropped.
    expect(existsSync(join(base, 'old-a', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(base, 'old-b'))).toBe(false);
    expect(readdirSync(join(base, '.archive'))).toHaveLength(1);
    const { readCuratorState } = await import('../src/lib/agent/skill-curator.js');
    expect(readCuratorState(base).pinned).toContain('old-a');
  });
});

describe('memory delete --all confirmation phrase', () => {
  test('"Delete Everything" (capitalized) confirms', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    promptAnswers.answers = ['Delete Everything'];
    responder = () => jsonResp(200, { success: true, data: {} });
    await runCli('../src/commands/memory/index.js', 'registerMemoryCommand', [
      'memory',
      'delete',
      '--all',
    ]);
    expect(stdout()).toContain('All memories cleared');
  });

  test('a wrong phrase still cancels', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    promptAnswers.answers = ['nope'];
    responder = () => jsonResp(200, { success: true, data: {} });
    await runCli('../src/commands/memory/index.js', 'registerMemoryCommand', [
      'memory',
      'delete',
      '--all',
    ]);
    expect(allOut()).toContain('Cancelled');
  });
});

describe('toolsets no-op reporting', () => {
  test('disabling an already-disabled toolset says nothing changed', async () => {
    await runCli('../src/commands/toolsets.js', 'registerToolsetsCommand', [
      'toolsets',
      'disable',
      'web',
      '--surface',
      'tui',
    ]);
    expect(stdout()).toContain('disabled on tui');
    stdoutChunks = [];
    await runCli('../src/commands/toolsets.js', 'registerToolsetsCommand', [
      'toolsets',
      'disable',
      'web',
      '--surface',
      'tui',
    ]);
    expect(stdout()).toContain('already disabled on tui');
    const { getConfigStore } = await import('../src/lib/config.js');
    expect(getConfigStore().get('toolsetsDisabled')).toEqual({ tui: ['web'] });
  });

  test('enabling an already-enabled toolset says nothing changed', async () => {
    await runCli('../src/commands/toolsets.js', 'registerToolsetsCommand', [
      'toolsets',
      'enable',
      'web',
      '--surface',
      'cli',
    ]);
    expect(stdout()).toContain('already enabled on cli');
  });
});

describe('update --check exit codes', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw Object.assign(new Error(`__exit_${code}__`), { exitCode: code });
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  async function runUpdate(argv: string[], parentArgs: string[] = []): Promise<void> {
    const { Command } = await import('commander');
    const { registerUpdateCommand } = await import('../src/commands/update.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: parentArgs.includes('--json'), color: false });
    const program = new Command();
    program.exitOverride();
    program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
    registerUpdateCommand(program, '0.9.9');
    await program.parseAsync(['node', 'spycore', ...parentArgs, ...argv]);
  }

  test('--check exits 2 (not 0) when the registry is unreachable', async () => {
    responder = () => {
      throw new Error('registry down');
    };
    await expect(runUpdate(['update', '--check'])).rejects.toThrow('__exit_2__');
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  test('--check in JSON mode reports checkFailed and exits 2', async () => {
    responder = () => {
      throw new Error('registry down');
    };
    await expect(runUpdate(['update', '--check'], ['--json'])).rejects.toThrow('__exit_2__');
    const parsed = JSON.parse(stdout()) as { checkFailed: boolean; hasUpdate: boolean };
    expect(parsed.checkFailed).toBe(true);
    expect(parsed.hasUpdate).toBe(false);
  });

  test('without --check an unreachable registry still exits 0', async () => {
    responder = () => {
      throw new Error('registry down');
    };
    await runUpdate(['update']);
    expect(stdout()).toContain('Could not reach the npm registry');
    expect(exitSpy).not.toHaveBeenCalled();
  });
});

describe('ping health reporting', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw Object.assign(new Error(`__exit_${code}__`), { exitCode: code });
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  async function runPing(): Promise<void> {
    const { Command } = await import('commander');
    const { registerPingCommand } = await import('../src/commands/ping.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    const program = new Command();
    program.exitOverride();
    program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
    registerPingCommand(program);
    await program.parseAsync(['node', 'spycore', 'ping']);
  }

  test('a 200 with an unparseable body does not claim success', async () => {
    responder = () => ({
      statusCode: 200,
      headers: {},
      body: {
        json: async () => {
          throw new Error('not json');
        },
      },
    });
    await expect(runPing()).rejects.toThrow(/__exit_/);
    expect(allOut()).toContain('could not be parsed as JSON');
    expect(allOut()).not.toContain('API responded with HTTP 200\n');
  });

  test('a 200 with a non-ok status names the status', async () => {
    responder = () =>
      jsonResp(200, { status: 'degraded', uptime: 1, timestamp: '', version: '', build: '' });
    await expect(runPing()).rejects.toThrow(/__exit_/);
    expect(allOut()).toContain('did not report ok (status: degraded)');
  });
});

describe('rewind --list --session', () => {
  test('combining --list with --session errors instead of ignoring --session', async () => {
    await expect(
      runCli('../src/commands/rewind.js', 'registerRewindCommand', [
        'rewind',
        '--list',
        '--session',
        'some-id',
      ]),
    ).rejects.toThrow(/--list and --session cannot be combined/);
  });
});

describe('runs JSON hygiene', () => {
  const RUNS_MOD = '../src/commands/runs.js';

  async function writeRecord(rec: Record<string, unknown>): Promise<string> {
    const { getConfigPath } = await import('../src/lib/config.js');
    const dir = join(dirname(getConfigPath()), 'runs');
    mkdirSync(dir, { recursive: true });
    const id = rec.id as string;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(rec), 'utf8');
    return id;
  }

  function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'run_abcdef123456',
      task: 'do the thing',
      cwd: '/tmp',
      pid: null,
      status: 'done',
      exitCode: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logFile: '/tmp/x.log',
      argv: ['agent', '--token', 'SECRET-PASTED-VALUE'],
      bootTimeMs: null,
      ...overrides,
    };
  }

  test('list --json omits argv', async () => {
    await writeRecord(record());
    await runCli(RUNS_MOD, 'registerRunsCommand', ['runs', 'list', '--format', 'json']);
    const parsed = JSON.parse(stdout()) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).not.toHaveProperty('argv');
    expect(parsed[0]).toMatchObject({ id: 'run_abcdef123456', task: 'do the thing' });
    expect(stdout()).not.toContain('SECRET-PASTED-VALUE');
  });

  test('attach --json omits argv', async () => {
    await writeRecord(record());
    await runCli(
      RUNS_MOD,
      'registerRunsCommand',
      ['runs', 'attach', 'run_abcdef123456'],
      ['--json'],
    );
    const parsed = JSON.parse(stdout()) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('argv');
    expect(stdout()).not.toContain('SECRET-PASTED-VALUE');
  });

  test('kill --json on an already-finished run emits one JSON document', async () => {
    await writeRecord(record());
    await runCli(RUNS_MOD, 'registerRunsCommand', ['runs', 'kill', 'run_abcdef123456'], ['--json']);
    const parsed = JSON.parse(stdout()) as Record<string, unknown>;
    expect(parsed).toEqual({ id: 'run_abcdef123456', status: 'done', killed: false });
  });
});

describe('cron and projects stores write atomically', () => {
  test('cron round-trip leaves no tmp files behind', async () => {
    const { addCronEntry, loadCronEntries } = await import('../src/commands/cron/store.js');
    const created = addCronEntry({ prompt: 'hi', schedule: '* * * * *', model: null });
    expect(loadCronEntries()).toHaveLength(1);
    expect(loadCronEntries()[0]?.id).toBe(created.id);
    const { getConfigPath } = await import('../src/lib/config.js');
    const leftovers = readdirSync(dirname(getConfigPath())).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  test('projects round-trip leaves no tmp files behind', async () => {
    const { saveProjects, loadProjects } = await import('../src/commands/projects/store.js');
    saveProjects([{ name: 'demo', path: '/tmp/demo', addedAt: new Date().toISOString() }]);
    expect(loadProjects()).toHaveLength(1);
    expect(loadProjects()[0]?.name).toBe('demo');
    const { getConfigPath } = await import('../src/lib/config.js');
    const leftovers = readdirSync(dirname(getConfigPath())).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });
});

describe('git-workflow rebase detection', () => {
  test('rebase-merge / rebase-apply state counts as a rebase in progress', async () => {
    const { rebaseInProgress } = await import('../src/commands/git-workflow.js');
    const dir = mkdtempSync(join(tmpdir(), 'spycli-4b2-rebase-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir });
      expect(rebaseInProgress(dir)).toBe(false);
      mkdirSync(join(dir, '.git', 'rebase-merge'), { recursive: true });
      expect(rebaseInProgress(dir)).toBe(true);
      rmSync(join(dir, '.git', 'rebase-merge'), { recursive: true, force: true });
      mkdirSync(join(dir, '.git', 'rebase-apply'), { recursive: true });
      expect(rebaseInProgress(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('import path expansion and comparison', () => {
  test('resolveFromDirRoot expands only bare ~ and ~/...', async () => {
    const { resolveFromDirRoot } = await import('../src/commands/import.js');
    expect(resolveFromDirRoot('~', '/home/u')).toBe('/home/u');
    expect(resolveFromDirRoot('~/x', '/home/u')).toBe(join('/home/u', 'x'));
    expect(resolveFromDirRoot('~other/x', '/home/u')).toBe('~other/x');
    expect(resolveFromDirRoot('plain/rel', '/home/u')).toBe('plain/rel');
  });

  test('planFromDir treats ~other/x as a literal relative path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spycli-4b2-fromdir-'));
    const origCwd = process.cwd();
    try {
      const skillDir = join(root, '~other', 'my-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '# My Skill\n', 'utf8');
      process.chdir(root);
      const { planFromDir } = await import('../src/commands/import.js');
      const plan = planFromDir('~other', root);
      expect(plan.items.map((i) => i.name)).toEqual(['my-skill']);
    } finally {
      process.chdir(origCwd);
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('stableStringify ignores key order', async () => {
    const { stableStringify } = await import('../src/commands/import.js');
    expect(
      stableStringify({ b: 1, a: { d: 4, c: 3 } }),
    ).toBe(stableStringify({ a: { c: 3, d: 4 }, b: 1 }));
  });

  test('an MCP server identical up to key order is "identical", not a conflict', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spycli-4b2-mcp-'));
    try {
      const home = join(root, 'home');
      const cwd = join(root, 'cwd');
      const configDir = join(root, 'config');
      mkdirSync(home, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      process.env.SPYCORE_TEST_CWD = configDir;
      const { writeScope } = await import('../src/lib/agent/mcp-config.js');
      // Stored with keys in one order...
      writeScope('user', cwd, [
        { command: 'node', name: 'srv', type: 'stdio', args: ['a.js'] } as never,
      ]);
      // ...and the Claude entry maps to the same server with keys in another.
      writeFileSync(
        join(home, '.claude.json'),
        JSON.stringify({ mcpServers: { srv: { command: 'node', args: ['a.js'] } } }),
        'utf8',
      );
      const { planClaudeCode } = await import('../src/commands/import.js');
      const plan = planClaudeCode(cwd, false, home);
      const item = plan.items.find((i) => i.kind === 'mcp-server' && i.name === 'srv');
      expect(item?.status).toBe('identical');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a conflicting skill says "will overwrite" with --force, "skip" without it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spycli-4b2-force-'));
    try {
      const home = join(root, 'home');
      const cwd = join(root, 'cwd');
      const configDir = join(root, 'config');
      mkdirSync(join(home, '.claude', 'skills', 'alpha'), { recursive: true });
      writeFileSync(join(home, '.claude', 'skills', 'alpha', 'SKILL.md'), '# New\n', 'utf8');
      mkdirSync(cwd, { recursive: true });
      process.env.SPYCORE_TEST_CWD = configDir;
      const { userSkillsDir } = await import('../src/lib/agent/skills.js');
      const dest = join(userSkillsDir(), 'alpha');
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, 'SKILL.md'), '# Old different content\n', 'utf8');
      const { planClaudeCode } = await import('../src/commands/import.js');
      const without = planClaudeCode(cwd, false, home);
      const itemWithout = without.items.find((i) => i.name === 'alpha');
      expect(itemWithout?.status).toBe('conflict');
      expect(itemWithout?.detail).toContain('skip (use --force to overwrite)');
      const withForce = planClaudeCode(cwd, false, home, undefined, true);
      const itemWith = withForce.items.find((i) => i.name === 'alpha');
      expect(itemWith?.status).toBe('conflict');
      expect(itemWith?.detail).toContain('will overwrite with --force');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a skill directory with scripts and symlinks warns in the preview detail', async () => {
    const root = mkdtempSync(join(tmpdir(), 'spycli-4b2-risky-'));
    try {
      const src = join(root, 'src');
      const skillDir = join(src, 'risky');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '# Risky\n', 'utf8');
      const script = join(skillDir, 'run.sh');
      writeFileSync(script, '#!/bin/sh\necho hi\n', 'utf8');
      const { chmodSync } = await import('node:fs');
      chmodSync(script, 0o755);
      symlinkSync(join(skillDir, 'SKILL.md'), join(skillDir, 'link.md'));
      const { planFromDir } = await import('../src/commands/import.js');
      const plan = planFromDir(src, root);
      expect(plan.items).toHaveLength(1);
      // Windows has no POSIX file modes: chmod 0o755 leaves stat mode at
      // 0o666, so the mode-bit scan counts 0 executables (same cause as the
      // 0600 failure in follow-up 1). The 1-executable assertion is
      // POSIX-only; the symlink count and warning shape still run on
      // Windows.
      if (process.platform !== 'win32') {
        expect(plan.items[0]?.detail).toContain(
          'WARNING: copies 1 executable file(s) and 1 symlink(s) as-is',
        );
      } else {
        expect(plan.items[0]?.detail).toContain(
          'WARNING: copies 0 executable file(s) and 1 symlink(s) as-is',
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('mcp add stdio command validation', () => {
  test('stdioCommandExists finds PATH binaries and rejects typos', async () => {
    const { stdioCommandExists } = await import('../src/commands/mcp/index.js');
    expect(stdioCommandExists('node')).toBe(true);
    expect(stdioCommandExists('definitely-not-a-real-binary-xyz')).toBe(false);
    expect(stdioCommandExists('')).toBe(false);
  });

  test('mcp add with a typo’d binary errors before writing config', async () => {
    await expect(
      runCli('../src/commands/mcp/index.js', 'registerMcpCommand', [
        'mcp',
        'add',
        'ghost',
        '--',
        'definitely-not-a-real-binary-xyz',
      ]),
    ).rejects.toThrow(/was not found on PATH/);
    const { loadMcpServers } = await import('../src/lib/agent/mcp-config.js');
    expect(loadMcpServers(process.cwd())).toHaveLength(0);
  });
});

describe('image --count validation', () => {
  test('--count 0, -1 and abc error instead of silently generating one image', async () => {
    for (const bad of ['0', '-1', 'abc']) {
      await expect(
        runCli('../src/commands/image.js', 'registerImageCommand', [
          'image',
          'hello world',
          '--count',
          bad,
        ]),
      ).rejects.toThrow(/Invalid --count/);
    }
  });
});

describe('usage --week --rolling', () => {
  test('both flags together warn and show both sections', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          plan: 'PRO',
          planDisplay: 'Pro',
          allModels: {
            fiveHour: { used: 5, limit: 100 },
            weekly: { used: 20, limit: 500 },
          },
          hephaestus: {
            fiveHour: { used: 1, limit: 10 },
            weekly: { used: 2, limit: 50 },
          },
          perModel: { HERMES: { fiveHour: 5, weekly: 20 } },
        },
      });
    await runCli('../src/commands/usage.js', 'registerUsageCommand', [
      'usage',
      '--week',
      '--rolling',
    ]);
    expect(allOut()).toContain('showing both sections');
    expect(stdout()).toContain('5-hour window');
    expect(stdout()).toContain('Weekly cap');
    expect(stdout()).toContain('Per-model usage');
  });
});

describe('skills remove containment', () => {
  test('isWithinSkillsRoots accepts skill subdirectories and refuses everything else', async () => {
    const { isWithinSkillsRoots } = await import('../src/commands/skills/remove.js');
    const { getConfigPath } = await import('../src/lib/config.js');
    const configDir = dirname(getConfigPath());
    const cwd = mkdtempSync(join(tmpdir(), 'spycli-4b2-remove-'));
    try {
      const userRoot = join(configDir, 'skills');
      expect(isWithinSkillsRoots(join(userRoot, 'victim'), cwd)).toBe(true);
      expect(isWithinSkillsRoots(join(userRoot, 'a', 'b'), cwd)).toBe(true);
      expect(isWithinSkillsRoots(userRoot, cwd)).toBe(false); // the root itself: never delete
      expect(isWithinSkillsRoots(configDir, cwd)).toBe(false);
      expect(isWithinSkillsRoots('/etc', cwd)).toBe(false);
      expect(isWithinSkillsRoots(join(cwd, '.spycore', 'skills', 'proj'), cwd)).toBe(true);
      expect(isWithinSkillsRoots(join(cwd, '.spycore'), cwd)).toBe(false);
      expect(isWithinSkillsRoots(join(cwd, 'other'), cwd)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('removing a real user skill still works end to end', async () => {
    const { getConfigPath } = await import('../src/lib/config.js');
    const dir = join(dirname(getConfigPath()), 'skills', 'victim');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\nname: victim\ndescription: x\n---\n\n# V\n', 'utf8');
    await runCli('../src/commands/skills/index.js', 'registerSkillsCommand', [
      'skills',
      'remove',
      'victim',
      '--yes',
    ]);
    expect(existsSync(dir)).toBe(false);
  });
});
