import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';

/**
 * H15 - tests that actually invoke the command entry points (the
 * `register*Command` wiring), not just the libraries underneath. Whole
 * command groups previously had zero coverage: projects, conversations
 * fork/handoff, memory add/delete/list/show, skills lint/curator wiring,
 * auth login/logout, and ping/runs/version/toolsets/command-rules/acp/
 * md-preview/ui-preview/completion.
 *
 * Paths that call `fail()` are not exercised: `fail()` exits the process,
 * so those branches stay covered only by their existing unit tests.
 */
interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
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

vi.mock('../src/ui/preview/runMarkdown.js', () => ({
  runMarkdownPreview: vi.fn(async () => {}),
}));
vi.mock('../src/ui/preview/run.js', () => ({
  runUiPreview: vi.fn(async () => {}),
}));

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
let workDir: string;
let origCwd: string;

beforeEach(() => {
  freshConfigDir();
  responder = null;
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
  workDir = mkdtempSync(join(tmpdir(), 'spycode-cmds-'));
  origCwd = process.cwd();
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  process.chdir(origCwd);
  vi.resetModules();
  rmSync(workDir, { recursive: true, force: true });
});

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

function stdout(): string {
  return stdoutChunks.join('');
}

type CommandModule = { [key: string]: (program: never) => void };

/** Build a fresh commander program, register one command group, parse argv. */
async function runCli(
  modulePath: string,
  registerName: string,
  argv: string[],
  parentArgs: string[] = [],
  registerArg?: unknown,
): Promise<void> {
  const { Command } = await import('commander');
  const mod = (await import(modulePath)) as CommandModule;
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.exitOverride();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  const register = mod[registerName] as (program: never, arg?: unknown) => void;
  if (registerArg === undefined) register(program as never);
  else register(program as never, registerArg);
  await program.parseAsync(['node', 'spycore', ...parentArgs, ...argv]);
}

async function setToken(): Promise<void> {
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
}

describe('projects commands', () => {
  const MOD = '../src/commands/projects/index.js';

  test('add registers a directory and list shows it; remove unregisters it', async () => {
    const projDir = join(workDir, 'myproj');
    mkdirSync(projDir);
    writeFileSync(join(projDir, 'SPYCODE.md'), '# My Project\n');
    await runCli(MOD, 'registerProjectsCommand', ['projects', 'add', projDir]);
    expect(stdout()).toContain('myproj');
    stdoutChunks = [];
    await runCli(MOD, 'registerProjectsCommand', ['projects', 'list', '--format', 'json']);
    const listed = JSON.parse(stdout()) as { projects: { name: string; path: string }[] };
    expect(listed.projects).toHaveLength(1);
    expect(listed.projects[0]!.name).toBe('myproj');
    expect(listed.projects[0]!.path).toBe(projDir);
    stdoutChunks = [];
    await runCli(MOD, 'registerProjectsCommand', ['projects', 'remove', 'myproj']);
    expect(stdout()).toContain('Removed project myproj');
    stdoutChunks = [];
    await runCli(MOD, 'registerProjectsCommand', ['projects', 'list']);
    expect(stdout()).toContain('No projects registered yet');
  });

  test('add rejects a path that is not a directory', async () => {
    await expect(
      runCli(MOD, 'registerProjectsCommand', ['projects', 'add', join(workDir, 'nope')]),
    ).rejects.toThrow(/Not a directory/);
  });

  test('add rejects an empty name and a name with a path separator', async () => {
    const projDir = join(workDir, 'p2');
    mkdirSync(projDir);
    await expect(
      runCli(MOD, 'registerProjectsCommand', ['projects', 'add', projDir, '--name', '  ']),
    ).rejects.toThrow(/Project name must not be empty/);
    await expect(
      runCli(MOD, 'registerProjectsCommand', ['projects', 'add', projDir, '--name', 'a/b']),
    ).rejects.toThrow(/must not contain path separators/);
  });

  test('remove rejects an unknown name', async () => {
    await expect(
      runCli(MOD, 'registerProjectsCommand', ['projects', 'remove', 'ghost']),
    ).rejects.toThrow(/No project named "ghost"/);
  });

  test('store round-trips entries through the real registry file', async () => {
    const { loadProjects, saveProjects } = await import('../src/commands/projects/store.js');
    expect(loadProjects()).toEqual([]);
    saveProjects([{ name: 'x', path: workDir, addedAt: '2026-11-08T00:00:00.000Z' }]);
    expect(loadProjects()).toHaveLength(1);
    const { getConfigPath } = await import('../src/lib/config.js');
    const { dirname } = await import('node:path');
    expect(existsSync(join(dirname(getConfigPath()), 'projects.json'))).toBe(true);
  });
});

describe('conversations fork and handoff', () => {
  const MOD = '../src/commands/conversations/index.js';

  test('fork errors when the session does not exist', async () => {
    process.chdir(workDir);
    await expect(
      runCli(MOD, 'registerConversationsCommand', ['conversations', 'fork', 'no-such-session']),
    ).rejects.toThrow(/No session "no-such-session"/);
  });

  test('fork creates a branch that keeps the parent reference', async () => {
    process.chdir(workDir);
    const { saveSession } = await import('../src/lib/agent/checkpoint.js');
    const sourceId = saveSession({
      cwd: workDir,
      task: 'original task',
      changes: [{ path: join(workDir, 'f.txt'), op: 'create', before: null, after: 'hi\n' }],
    });
    expect(sourceId).not.toBeNull();
    await runCli(MOD, 'registerConversationsCommand', ['conversations', 'fork', sourceId!]);
    expect(stdout()).toContain(`Forked session ${sourceId}`);
    const { loadSession } = await import('../src/lib/agent/checkpoint.js');
    const match = stdout().match(/Forked session \S+ → (\S+) \(parent:/);
    expect(match).not.toBeNull();
    const forked = loadSession(workDir, match![1]!);
    expect(forked?.parentId).toBe(sourceId);
    stdoutChunks = [];
    await runCli(
      MOD,
      'registerConversationsCommand',
      ['conversations', 'fork', sourceId!],
      ['--json'],
    );
    const parsed = JSON.parse(stdout()) as { id: string; parentId: string; sourceId: string };
    expect(parsed.parentId).toBe(sourceId);
    expect(parsed.sourceId).toBe(sourceId);
  });

  test('fork rejects a hostile session id', async () => {
    process.chdir(workDir);
    await expect(
      runCli(MOD, 'registerConversationsCommand', ['conversations', 'fork', '../escape']),
    ).rejects.toThrow(/No session/);
  });

  test('handoff refuses when not logged in', async () => {
    process.chdir(workDir);
    await expect(
      runCli(MOD, 'registerConversationsCommand', ['conversations', 'handoff', 'cnv_123']),
    ).rejects.toThrow(/Not logged in/);
  });

  test('buildHandoffContinueMessage states the turn contract', async () => {
    const { buildHandoffContinueMessage } = await import(
      '../src/commands/conversations/handoff.js'
    );
    const msg = buildHandoffContinueMessage({
      instruction: 'Fix the failing test.',
      lastRole: 'assistant',
      messageCount: 3,
    });
    expect(msg).toContain('NEW AGENT TURN on the EXISTING conversation');
    expect(msg).toContain('3 messages above are preserved COMPLETE');
    expect(msg).toContain('last role: assistant');
    expect(msg).toContain('New instruction: Fix the failing test.');
    const bare = buildHandoffContinueMessage({ lastRole: 'user', messageCount: 1 });
    expect(bare).toContain('1 message above');
    expect(bare).not.toContain('New instruction:');
  });
});

describe('memory commands', () => {
  const MOD = '../src/commands/memory/index.js';
  const MEM = {
    id: 'mem_abc123',
    category: 'CONTEXT',
    content: 'User prefers dark mode',
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    responder = (url, init) => {
      if (url.includes('/api/memory') && init.method === 'GET') {
        return jsonResp(200, { success: true, data: { memories: [MEM] } });
      }
      if (url.includes('/api/memory') && init.method === 'POST') {
        return jsonResp(200, {
          success: true,
          data: { ...MEM, content: 'hello world', id: 'mem_new1' },
        });
      }
      if (url.includes('/api/memory') && init.method === 'DELETE') {
        return jsonResp(200, { success: true, data: {} });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
  });

  test('add posts the memory and reports its id', async () => {
    await runCli(MOD, 'registerMemoryCommand', ['memory', 'add', 'hello world']);
    expect(stdout()).toContain('Added memory mem_new1');
  });

  test('add rejects content under 2 characters', async () => {
    await expect(
      runCli(MOD, 'registerMemoryCommand', ['memory', 'add', 'x']),
    ).rejects.toThrow(/too short/);
  });

  test('list renders the table and filters by category', async () => {
    await runCli(MOD, 'registerMemoryCommand', ['memory', 'list']);
    expect(stdout()).toContain('User prefers dark mode');
    stdoutChunks = [];
    await runCli(MOD, 'registerMemoryCommand', ['memory', 'list', '--category', 'profile']);
    expect(stdout()).toContain('(no memories yet)');
    stdoutChunks = [];
    await runCli(MOD, 'registerMemoryCommand', ['memory', 'list', '--format', 'json']);
    const parsed = JSON.parse(stdout()) as { memories: { id: string }[] };
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0]!.id).toBe('mem_abc123');
  });

  test('show prints one memory; unknown id errors', async () => {
    await runCli(MOD, 'registerMemoryCommand', ['memory', 'show', 'mem_abc123']);
    expect(stdout()).toContain('ID:        mem_abc123');
    expect(stdout()).toContain('User prefers dark mode');
    await expect(
      runCli(MOD, 'registerMemoryCommand', ['memory', 'show', 'mem_nope']),
    ).rejects.toThrow(/Memory not found: mem_nope/);
  });

  test('delete --yes removes one memory; --all --yes clears everything', async () => {
    await runCli(MOD, 'registerMemoryCommand', ['memory', 'delete', 'mem_abc123', '--yes']);
    expect(stdout()).toContain('Deleted mem_abc123');
    stdoutChunks = [];
    await runCli(MOD, 'registerMemoryCommand', ['memory', 'delete', '--all', '--yes']);
    expect(stdout()).toContain('All memories cleared');
  });

  test('delete with no id and no --all errors', async () => {
    await expect(
      runCli(MOD, 'registerMemoryCommand', ['memory', 'delete', '--yes']),
    ).rejects.toThrow(/Specify a memory id/);
  });
});

describe('skills lint and curator wiring', () => {
  const MOD = '../src/commands/skills/index.js';

  test('lint reports no skills installed when the registry is empty', async () => {
    await runCli(MOD, 'registerSkillsCommand', ['skills', 'lint']);
    expect(stdout()).toContain('No skills installed');
    stdoutChunks = [];
    await runCli(MOD, 'registerSkillsCommand', ['skills', 'lint', '--format', 'json']);
    const parsed = JSON.parse(stdout()) as { skills: unknown[]; totalFindings: number };
    expect(parsed.skills).toEqual([]);
    expect(parsed.totalFindings).toBe(0);
  });

  test('lint exercises an installed user skill through the CLI wiring', async () => {
    const { getConfigPath } = await import('../src/lib/config.js');
    const { dirname } = await import('node:path');
    const skillDir = join(dirname(getConfigPath()), 'skills', 'demo-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: demo-skill\ndescription: A demo skill used by the command-entrypoint tests.\n---\n\n# Demo\n\nDo the demo thing.\n',
    );
    await runCli(MOD, 'registerSkillsCommand', ['skills', 'lint']);
    expect(stdout()).toContain('demo-skill');
  });

  test('curator reports an empty lifecycle state and pins/unpins through the CLI', async () => {
    await runCli(MOD, 'registerSkillsCommand', ['skills', 'curator', '--format', 'json']);
    const parsed = JSON.parse(stdout()) as { stale: unknown[]; pinned: unknown[] };
    expect(parsed.stale).toEqual([]);
    expect(parsed.pinned).toEqual([]);
    stdoutChunks = [];
    await runCli(MOD, 'registerSkillsCommand', ['skills', 'curator', '--pin', 'demo-skill']);
    expect(stdout()).toContain('Pinned "demo-skill"');
    stdoutChunks = [];
    await runCli(MOD, 'registerSkillsCommand', ['skills', 'curator', '--format', 'json']);
    const pinned = JSON.parse(stdout()) as { pinned: string[] };
    expect(pinned.pinned).toContain('demo-skill');
    stdoutChunks = [];
    await runCli(MOD, 'registerSkillsCommand', ['skills', 'curator', '--unpin', 'demo-skill']);
    expect(stdout()).toContain('Unpinned "demo-skill"');
  });
});

describe('auth login and logout', () => {
  test('login completes the device flow and stores the token', async () => {
    responder = (url, init) => {
      if (url.includes('/auth/cli/login') && init.method === 'POST') {
        return jsonResp(200, {
          success: true,
          data: {
            pollToken: 'pt-1',
            approveUrl: 'https://example.com/approve',
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
          },
        });
      }
      if (url.includes('/auth/cli/poll/pt-1') && init.method === 'GET') {
        return jsonResp(200, {
          success: true,
          data: { status: 'approved', token: 'spycli_login_token', email: 'user@example.com' },
        });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await runCli('../src/commands/auth/login.js', 'registerLoginCommand', [
      'login',
      '--no-open',
    ]);
    expect(stdout()).toContain('Logged in as user@example.com');
    const { getToken } = await import('../src/lib/auth.js');
    expect(await getToken()).toBe('spycli_login_token');
  });

  test('logout with no token is a noop', async () => {
    await runCli('../src/commands/auth/logout.js', 'registerLogoutCommand', ['logout']);
    expect(stdout()).toContain('No active token');
    stdoutChunks = [];
    await runCli('../src/commands/auth/logout.js', 'registerLogoutCommand', ['logout'], [
      '--json',
    ]);
    expect(JSON.parse(stdout())).toEqual({ status: 'noop', message: 'No active token' });
  });

  test('logout revokes on the server and clears the token', async () => {
    await setToken();
    responder = (url, init) => {
      if (url.includes('/auth/cli/logout') && init.method === 'POST') {
        return jsonResp(200, { success: true, data: {} });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await runCli('../src/commands/auth/logout.js', 'registerLogoutCommand', ['logout']);
    expect(stdout()).toContain('Logged out');
    const { getToken } = await import('../src/lib/auth.js');
    expect(await getToken()).toBeNull();
  });

  test('logout in JSON mode reports partial when the server revoke fails', async () => {
    await setToken();
    responder = () => {
      throw new Error('network down');
    };
    await runCli(
      '../src/commands/auth/logout.js',
      'registerLogoutCommand',
      ['logout'],
      ['--json'],
    );
    const parsed = JSON.parse(stdout()) as { status: string };
    expect(parsed.status).toBe('partial');
    const { getToken } = await import('../src/lib/auth.js');
    expect(await getToken()).toBeNull();
  });
});

describe('ping, runs, version, toolsets, command-rules', () => {
  test('ping reports API health and unauthenticated auth state', async () => {
    responder = (url) => {
      if (url.endsWith('/health')) {
        return {
          statusCode: 200,
          headers: {},
          body: {
            json: async () => ({
              status: 'ok',
              uptime: 42,
              timestamp: new Date().toISOString(),
              version: '0.9.9',
              build: 'test',
            }),
          },
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    await runCli('../src/commands/ping.js', 'registerPingCommand', ['ping']);
    expect(stdout()).toContain('API reachable');
    expect(stdout()).toContain('Not logged in');
    stdoutChunks = [];
    await runCli('../src/commands/ping.js', 'registerPingCommand', ['ping'], ['--json']);
    const parsed = JSON.parse(stdout()) as { api: { ok: boolean }; auth: { status: string } };
    expect(parsed.api.ok).toBe(true);
    expect(parsed.auth.status).toBe('unauthenticated');
  });

  test('runs list is empty, attach/kill reject unknown ids', async () => {
    await runCli('../src/commands/runs.js', 'registerRunsCommand', ['runs', 'list']);
    expect(stdout()).toContain('No detached runs.');
    stdoutChunks = [];
    await runCli('../src/commands/runs.js', 'registerRunsCommand', ['runs', 'list', '--format', 'json']);
    expect(JSON.parse(stdout())).toEqual([]);
    await expect(
      runCli('../src/commands/runs.js', 'registerRunsCommand', ['runs', 'attach', 'ghost']),
    ).rejects.toThrow(/No detached run 'ghost'/);
    await expect(
      runCli('../src/commands/runs.js', 'registerRunsCommand', ['runs', 'kill', 'ghost']),
    ).rejects.toThrow(/No detached run 'ghost'/);
  });

  test('runs list helpers report liveness honestly', async () => {
    const { isRunAlive } = await import('../src/commands/runs.js');
    expect(
      isRunAlive({ id: 'r1', pid: 999_999_999, status: 'running', startedAt: '' } as never),
    ).toBe(false);
  });

  test('version prints the diagnostic block in text and JSON', async () => {
    await runCli('../src/commands/version.js', 'registerVersionCommand', ['version'], [], '0.9.9');
    expect(stdout()).toContain('spycore CLI 0.9.9');
    expect(stdout()).toContain(`Node:    ${process.version}`);
    stdoutChunks = [];
    await runCli(
      '../src/commands/version.js',
      'registerVersionCommand',
      ['version'],
      ['--json'],
      '0.9.9',
    );
    const parsed = JSON.parse(stdout()) as { cli: string; node: string; configPath: string };
    expect(parsed.cli).toBe('0.9.9');
    expect(parsed.node).toBe(process.version);
    expect(parsed.configPath.length).toBeGreaterThan(0);
  });

  test('toolsets lists, disables and re-enables a toolset per surface', async () => {
    await runCli('../src/commands/toolsets.js', 'registerToolsetsCommand', ['toolsets']);
    expect(stdout()).toContain('Toolsets');
    stdoutChunks = [];
    await runCli('../src/commands/toolsets.js', 'registerToolsetsCommand', [
      'toolsets',
      'disable',
      'web',
      '--surface',
      'tui',
    ]);
    expect(stdout()).toContain('disabled on tui');
    const { getConfigStore } = await import('../src/lib/config.js');
    expect(getConfigStore().get('toolsetsDisabled')).toEqual({ tui: ['web'] });
    stdoutChunks = [];
    await runCli('../src/commands/toolsets.js', 'registerToolsetsCommand', [
      'toolsets',
      'enable',
      'web',
      '--surface',
      'tui',
    ]);
    expect(stdout()).toContain('re-enabled on tui');
    expect(getConfigStore().get('toolsetsDisabled')).toEqual({});
  });

  test('toolsets rejects unknown toolsets and surfaces', async () => {
    await expect(
      runCli('../src/commands/toolsets.js', 'registerToolsetsCommand', [
        'toolsets',
        'disable',
        'nope',
        '--surface',
        'tui',
      ]),
    ).rejects.toThrow(/Unknown toolset/);
    await expect(
      runCli('../src/commands/toolsets.js', 'registerToolsetsCommand', [
        'toolsets',
        'disable',
        'web',
        '--surface',
        'nope',
      ]),
    ).rejects.toThrow(/Unknown surface/);
  });

  test('command-rules reports no rules configured, in text and JSON', async () => {
    await runCli('../src/commands/command-rules.js', 'registerCommandRulesCommand', [
      'command-rules',
    ]);
    expect(stdout()).toContain('No rules configured');
    stdoutChunks = [];
    await runCli(
      '../src/commands/command-rules.js',
      'registerCommandRulesCommand',
      ['command-rules'],
      ['--json'],
    );
    const parsed = JSON.parse(stdout()) as { rules: unknown[] };
    expect(parsed.rules).toEqual([]);
  });
});

describe('acp, previews, completion', () => {
  test('acp rejects Styx Max before starting the server (chat-only model)', async () => {
    await expect(
      runCli('../src/commands/acp.js', 'registerAcpCommand', ['acp', '-m', 'styx_max']),
    ).rejects.toThrow(/Unknown model: styx_max/);
  });

  test('acp with a BYOK provider and no key fails before starting the server', async () => {
    // Anthropic requires a key (unlike the key-optional OpenAI-compatible
    // type, which would happily start the server against a local endpoint).
    delete process.env.ANTHROPIC_API_KEY;
    await expect(
      runCli('../src/commands/acp.js', 'registerAcpCommand', [
        'acp',
        '--provider',
        'anthropic',
        '--model',
        'claude-x',
      ]),
    ).rejects.toThrow(/API key is required/);
  });

  test('acp rejects an unknown provider before starting the server', async () => {
    await expect(
      runCli('../src/commands/acp.js', 'registerAcpCommand', ['acp', '--provider', 'nope']),
    ).rejects.toThrow(/Unknown provider: nope/);
  });

  test('__md-preview and __ui-preview invoke their lazy preview runners', async () => {
    await runCli('../src/commands/md-preview.js', 'registerMdPreviewCommand', ['__md-preview']);
    const { runMarkdownPreview } = await import('../src/ui/preview/runMarkdown.js');
    expect(vi.mocked(runMarkdownPreview)).toHaveBeenCalledTimes(1);
    await runCli('../src/commands/ui-preview.js', 'registerUiPreviewCommand', ['__ui-preview']);
    const { runUiPreview } = await import('../src/ui/preview/run.js');
    expect(vi.mocked(runUiPreview)).toHaveBeenCalledTimes(1);
  });

  test('completion emits a script per shell, hints on stderr, and usage without a shell', async () => {
    for (const shell of ['bash', 'zsh', 'fish', 'powershell'] as const) {
      stdoutChunks = [];
      stderrChunks = [];
      await runCli('../src/commands/completion.js', 'registerCompletionCommand', [
        'completion',
        shell,
      ]);
      expect(stdout()).toContain('spycore');
      expect(stderrChunks.join('')).toContain(`spycore completion ${shell}`);
    }
    await expect(
      runCli('../src/commands/completion.js', 'registerCompletionCommand', ['completion']),
    ).rejects.toThrow(/Usage: spycore completion/);
  });
});
