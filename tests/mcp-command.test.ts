import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { freshConfigDir } from './helpers.js';
import { registerMcpCommand } from '../src/commands/mcp/index.js';
import { loadMcpServers, projectMcpPath } from '../src/lib/agent/mcp-config.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

/** Invoke the mcp command in-process; capture stdout/stderr + any thrown error. */
async function runMcp(
  argv: string[],
  opts: { json?: boolean } = {},
): Promise<{ stdout: string; stderr: string; error: unknown }> {
  const { configureOutput } = await import('../src/lib/output.js');
  const program = new Command();
  program.exitOverride();
  program.addOption(new Option('--api-url <url>')).addOption(new Option('--json')).addOption(new Option('--no-color'));
  configureOutput({ json: Boolean(opts.json), color: false });
  registerMcpCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exitCode;
  (process.stdout.write as unknown) = (c: string | Uint8Array) => (out.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
  (process.stderr.write as unknown) = (c: string | Uint8Array) => (err.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
  let error: unknown;
  try {
    await program.parseAsync(['mcp', ...argv], { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = origExit;
    configureOutput({ json: false, color: true });
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

let cwd: string;
let prevCwd: string;

beforeEach(() => {
  freshConfigDir();
  cwd = mkdtempSync(join(tmpdir(), 'spycli-mcp-cmd-'));
  prevCwd = process.cwd();
  process.chdir(cwd);
});

afterEach(async () => {
  process.chdir(prevCwd);
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('mcp add', () => {
  test('adds a user-scoped server; everything after `--` is the command', async () => {
    const { error } = await runMcp(['add', 'files', '--', 'node', 'server.js', '--flag']);
    expect(error).toBeUndefined();
    const servers = loadMcpServers(cwd);
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: 'files',
      command: 'node',
      args: ['server.js', '--flag'],
      scope: 'user',
      enabled: true,
    });
  });

  test('--project writes ./.spycore/mcp.json', async () => {
    await runMcp(['add', 'p', '--project', '--', 'node', 'p.js']);
    expect(existsSync(projectMcpPath(cwd))).toBe(true);
    const servers = loadMcpServers(cwd);
    expect(servers[0]).toMatchObject({ name: 'p', scope: 'project' });
  });

  test('--env stores literals and passthrough names', async () => {
    await runMcp(['add', 'x', '--env', 'LITERAL=val', '--env', 'PASS_THROUGH', '--', 'node', 's.js']);
    const env = loadMcpServers(cwd)[0]?.env ?? [];
    expect(env).toContainEqual({ name: 'LITERAL', value: 'val' });
    expect(env).toContainEqual({ name: 'PASS_THROUGH' });
  });

  test('rejects an invalid name', async () => {
    const { error } = await runMcp(['add', 'bad name', '--', 'node']);
    expect(error).toBeTruthy();
    expect(loadMcpServers(cwd)).toHaveLength(0);
  });

  test('rejects a missing command', async () => {
    const { error } = await runMcp(['add', 'noco']);
    expect(error).toBeTruthy();
  });

  test('rejects a duplicate name in the same scope', async () => {
    await runMcp(['add', 'dup', '--', 'node', 'a.js']);
    const { error } = await runMcp(['add', 'dup', '--', 'node', 'b.js']);
    expect(error).toBeTruthy();
    expect(loadMcpServers(cwd)).toHaveLength(1);
  });
});

describe('mcp list / enable / disable / remove', () => {
  test('list reflects add/disable/enable/remove', async () => {
    await runMcp(['add', 's1', '--', 'node', 'a.js']);
    let { stdout } = await runMcp(['list']);
    expect(stdout).toContain('s1');
    expect(stdout).toMatch(/s1[\s\S]*yes/); // enabled by default

    await runMcp(['disable', 's1']);
    expect(loadMcpServers(cwd)[0]?.enabled).toBe(false);
    ({ stdout } = await runMcp(['list']));
    expect(stdout).toMatch(/s1[\s\S]*no/);

    await runMcp(['enable', 's1']);
    expect(loadMcpServers(cwd)[0]?.enabled).toBe(true);

    await runMcp(['remove', 's1']);
    expect(loadMcpServers(cwd)).toHaveLength(0);
  });

  test('list --json emits structured rows', async () => {
    await runMcp(['add', 'j1', '--', 'node', 'a.js']);
    const { stdout } = await runMcp(['list'], { json: true });
    const parsed = JSON.parse(stdout) as { servers: Array<{ name: string; scope: string; enabled: boolean }> };
    expect(parsed.servers[0]).toMatchObject({ name: 'j1', scope: 'user', enabled: true });
  });

  test('remove a non-existent server errors', async () => {
    const { error } = await runMcp(['remove', 'ghost']);
    expect(error).toBeTruthy();
  });

  test('project entry overrides a user entry of the same name in list', async () => {
    await runMcp(['add', 'shared', '--', 'node', 'user.js']);
    await runMcp(['add', 'shared', '--project', '--', 'node', 'project.js']);
    const servers = loadMcpServers(cwd);
    const shared = servers.filter((s) => s.name === 'shared');
    expect(shared).toHaveLength(1); // merged, project wins
    expect(shared[0]).toMatchObject({ scope: 'project', command: 'node', args: ['project.js'] });
  });

  test('disable --project targets the project file', async () => {
    await runMcp(['add', 'p', '--project', '--', 'node', 'p.js']);
    await runMcp(['disable', 'p', '--project']);
    expect(loadMcpServers(cwd).find((s) => s.name === 'p')?.enabled).toBe(false);
    // disabling in user scope (where it doesn't exist) errors
    const { error } = await runMcp(['disable', 'p']);
    expect(error).toBeTruthy();
  });
});

describe('mcp add/list — remote (http) entries (1.9)', () => {
  test('add --url stores an http entry with headers; values never echoed', async () => {
    const { stdout, error } = await runMcp([
      'add', 'remote',
      '--url', 'https://mcp.example.com/mcp',
      '--header', 'Authorization: Bearer ${MY_MCP_TOKEN}',
      '--header', 'X-Literal: paste-me-not',
    ]);
    expect(error).toBeUndefined();
    const servers = loadMcpServers(cwd);
    expect(servers[0]).toMatchObject({
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${MY_MCP_TOKEN}', 'X-Literal': 'paste-me-not' },
    });
    // The add output shows provenance, not values.
    expect(stdout).toContain('Authorization (from env)');
    expect(stdout).toContain('X-Literal (literal, hidden)');
    expect(stdout).not.toContain('paste-me-not');
    expect(stdout).not.toContain('MY_MCP_TOKEN}'.replace('}', '')); // env NAME may appear only inside the ${} form
  });

  test('add refuses a non-loopback http:// URL with a clear https error', async () => {
    const { error } = await runMcp(['add', 'bad', '--url', 'http://example.com/mcp']);
    expect(error).toBeTruthy();
    expect(String((error as { hint?: string })?.hint ?? error)).toMatch(/https/);
    expect(loadMcpServers(cwd)).toHaveLength(0);
    // Loopback http IS allowed.
    const ok = await runMcp(['add', 'local', '--url', 'http://127.0.0.1:9999/mcp']);
    expect(ok.error).toBeUndefined();
  });

  test('add refuses mixing a command with --url, and --header without --url', async () => {
    let res = await runMcp(['add', 'x', '--url', 'https://a.example/mcp', '--', 'node', 's.js']);
    expect(res.error).toBeTruthy();
    res = await runMcp(['add', 'y', '--header', 'A: b', '--', 'node', 's.js']);
    expect(res.error).toBeTruthy();
    res = await runMcp(['add', 'z', '--url', 'https://a.example/mcp', '--env', 'K=v']);
    expect(res.error).toBeTruthy();
    expect(loadMcpServers(cwd)).toHaveLength(0);
  });

  test('list shows TYPE + url for remote entries and NEVER header values', async () => {
    await runMcp(['add', 'remote', '--url', 'https://mcp.example.com/mcp', '--header', 'Authorization: Bearer topsecret-abc']);
    await runMcp(['add', 'local', '--', 'node', 'a.js']);
    const { stdout } = await runMcp(['list']);
    expect(stdout).toContain('TYPE');
    expect(stdout).toContain('http');
    expect(stdout).toContain('https://mcp.example.com/mcp');
    expect(stdout).toContain('stdio');
    expect(stdout).not.toContain('topsecret-abc');
  });

  test('a stdio-only list keeps the exact pre-1.9 table (no TYPE column)', async () => {
    await runMcp(['add', 'only', '--', 'node', 'a.js']);
    const { stdout } = await runMcp(['list']);
    expect(stdout).toContain('NAME');
    expect(stdout).not.toContain('TYPE');
  });

  test('list --json redacts remote headers to name + provenance', async () => {
    await runMcp(['add', 'remote', '--url', 'https://m.example/mcp', '--header', 'Authorization: Bearer ${T}']);
    const { stdout } = await runMcp(['list'], { json: true });
    const parsed = JSON.parse(stdout) as { servers: Array<Record<string, unknown>> };
    expect(parsed.servers[0]).toMatchObject({
      name: 'remote',
      type: 'http',
      url: 'https://m.example/mcp',
      headers: ['Authorization (from env)'],
    });
    expect(stdout).not.toContain('Bearer');
  });
});

describe('mcp test (real fixture)', () => {
  test('connects, lists tools, and shuts the server down', async () => {
    await runMcp(['add', 'fix', '--', process.execPath, FIXTURE]);
    const { stdout, error } = await runMcp(['test', 'fix']);
    expect(error).toBeUndefined();
    expect(stdout).toContain('mcp__fix__echo');
    expect(stdout).toContain('mcp__fix__big');
  }, 15000);

  test('test --json reports server info and tools', async () => {
    await runMcp(['add', 'fix', '--', process.execPath, FIXTURE]);
    const { stdout } = await runMcp(['test', 'fix'], { json: true });
    const parsed = JSON.parse(stdout) as { protocolVersion: string; tools: Array<{ name: string }> };
    expect(parsed.protocolVersion).toBe('2025-06-18');
    expect(parsed.tools.map((t) => t.name).sort()).toEqual(['big', 'echo', 'env_probe']);
  }, 15000);

  test('testing an unknown server errors', async () => {
    const { error } = await runMcp(['test', 'nope']);
    expect(error).toBeTruthy();
  });
});

/**
 * ⭐⭐ `mcp test` AND THE WORKSPACE-TRUST GATE — PROVED BY A SPAWN SENTINEL.
 *
 * `loadMcpServers` MERGES project-scoped entries from ./.spycore/mcp.json, and
 * `registerTest` used that merged list with no trust check — so a cloned repo's
 * server ran on `spycore mcp test <name>` in a workspace nobody had trusted,
 * which is the clone-and-run RCE the gate exists to stop, reached through a
 * different command. `setupMcpBridge` (the agent path) refused the identical
 * fixture on the identical workspace; only the command differed.
 *
 * ⭐ WHY A SENTINEL AND NOT AN ERROR ASSERTION. "the command threw" is satisfied
 * by spawn-then-fail exactly as it is by refuse-before-spawn — the disjunction
 * shape whose left arm the defect itself satisfies. The sentinel is a file that
 * only a running child can create, so a spawn cannot hide behind an error.
 *
 * ⭐ THE CONTROLS ARE IN THE SAME SUITE AND RUN FIRST IN SPIRIT: the sentinel is
 * proved able to fire (trusted workspace → the file exists) before its absence
 * is believed, and a user-scoped server is proved still to spawn in an
 * UNtrusted workspace, so the gate is shown to be scoped rather than blanket.
 *
 * WHAT THIS CANNOT SEE: whether the server would have completed a handshake —
 * the sentinel exits immediately by design. Spawn is the property under test.
 */
describe('mcp test — workspace trust gate (project scope)', () => {
  const SENTINEL_FIXTURE = fileURLToPath(new URL('./fixtures/mcp-spawn-sentinel.mjs', import.meta.url));

  /** Path a spawned sentinel writes to; absent until something runs. */
  function sentinelPath(): string {
    return join(cwd, 'spawn-sentinel.log');
  }

  async function addProjectSentinel(): Promise<void> {
    const { writeScope } = await import('../src/lib/agent/mcp-config.js');
    writeScope('project', cwd, [
      { name: 'hostile', command: process.execPath, args: [SENTINEL_FIXTURE, sentinelPath()] },
    ]);
  }

  /**
   * ⭐ THE GRANT IS MADE THROUGH THE REAL COMMAND, NOT BY CALLING
   * `trustWorkspace(cwd)`. Written the direct way this control FAILED, and the
   * reason is worth keeping: on darwin `mkdtemp` returns a `/var/...` path that
   * is a symlink to `/private/var/...`, `process.chdir` then makes
   * `process.cwd()` the resolved form, and `normalizeWorkspacePath` is
   * `path.resolve` — lexical, not symlink-resolving. The two spellings are
   * different keys. `spycore mcp trust` with no argument grants the same
   * spelling the gate later reads, which is what a user actually does.
   */
  test('CONTROL — the sentinel fires when the workspace IS trusted', async () => {
    await addProjectSentinel();
    await runMcp(['trust']);
    await runMcp(['test', 'hostile', '--timeout', '2']);
    expect(existsSync(sentinelPath()), 'the sentinel never fires — its absence below would prove nothing').toBe(true);
  }, 15000);

  test('an UNTRUSTED workspace never spawns a project-scoped server', async () => {
    const { isWorkspaceTrusted } = await import('../src/lib/config.js');
    await addProjectSentinel();
    expect(isWorkspaceTrusted(cwd), 'fixture is already trusted — the subject arm is vacuous').toBe(false);
    const { error } = await runMcp(['test', 'hostile', '--timeout', '2']);
    expect(error, 'the command must refuse, not merely fail to connect').toBeTruthy();
    expect(String((error as Error).message)).toMatch(/not trusted/i);
    expect(existsSync(sentinelPath()), 'a project server SPAWNED from an untrusted workspace').toBe(false);
  }, 15000);

  test('CONTROL — a USER-scoped server still runs in an untrusted workspace', async () => {
    const { isWorkspaceTrusted } = await import('../src/lib/config.js');
    await runMcp(['add', 'fix', '--', process.execPath, FIXTURE]);
    expect(isWorkspaceTrusted(cwd)).toBe(false);
    const { stdout, error } = await runMcp(['test', 'fix']);
    expect(error, 'the gate over-reached onto user scope').toBeUndefined();
    expect(stdout).toContain('mcp__fix__echo');
  }, 15000);
});
