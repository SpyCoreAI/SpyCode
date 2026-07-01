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
