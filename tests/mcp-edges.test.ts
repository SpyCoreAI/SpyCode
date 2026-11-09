import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import { registerMcpCommand } from '../src/commands/mcp/index.js';
import {
  loadMcpServers,
  writeProjectMcpServers,
} from '../src/lib/agent/mcp-config.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));

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
const origStdin = process.stdin;

beforeEach(() => {
  freshConfigDir();
  cwd = mkdtempSync(join(tmpdir(), 'spycli-mcp-edge-'));
  prevCwd = process.cwd();
  process.chdir(cwd);
});

afterEach(async () => {
  process.chdir(prevCwd);
  Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('mcp add edges', () => {
  test('an invalid --env value errors', async () => {
    const { error } = await runMcp(['add', 'x', '--env', '=nope', '--', 'node']);
    expect((error as Error)?.message).toMatch(/Invalid --env value/);
  });

  test('an invalid --header value errors on a remote add', async () => {
    const { error } = await runMcp([
      'add',
      'r',
      '--url',
      'https://mcp.example.com/mcp',
      '--header',
      'not-a-header',
    ]);
    expect((error as Error)?.message).toMatch(/Invalid --header value/);
  });

  test('an empty command word is filtered out, leaving no command', async () => {
    const { error } = await runMcp(['add', 'x', '--', '']);
    expect((error as Error)?.message).toMatch(/A command \(or --url/);
  });

  test('--env is refused for a remote add, --header for a stdio add', async () => {
    let r = await runMcp(['add', 'r', '--url', 'https://mcp.example.com/mcp', '--env', 'FOO=bar']);
    expect((r.error as Error)?.message).toMatch(/stdio servers only/);
    r = await runMcp(['add', 'x', '--header', 'Authorization: Bearer ${T}', '--', 'node']);
    expect((r.error as Error)?.message).toMatch(/--url servers only/);
  });

  test('a remote add with headers prints the redacted URL and header names', async () => {
    const { error, stdout, stderr } = await runMcp([
      'add',
      'r',
      '--url',
      'https://mcp.example.com/mcp',
      '--header',
      'Authorization: Bearer ${MCP_TOKEN}',
    ]);
    expect(error).toBeUndefined();
    expect(stdout + stderr).toContain('https://mcp.example.com/mcp');
    const servers = loadMcpServers(cwd);
    expect(servers[0]).toMatchObject({ name: 'r', type: 'http' });
    expect(servers[0]!.headers).toEqual({ Authorization: 'Bearer ${MCP_TOKEN}' });
  });

  test('a stdio add with env and no args stores no args key', async () => {
    const { error } = await runMcp(['add', 'x', '--env', 'FOO=bar', '--', 'node']);
    expect(error).toBeUndefined();
    const servers = loadMcpServers(cwd);
    expect(servers[0]).toMatchObject({ name: 'x', command: 'node', env: [{ name: 'FOO', value: 'bar' }] });
    expect(servers[0]).not.toHaveProperty('args');
  });
});

describe('mcp list edges', () => {
  test('an empty store lists nothing with no project footer', async () => {
    const { stdout, stderr } = await runMcp(['list']);
    expect(stdout + stderr).toContain('No MCP servers configured.');
  });

  test('a remote row in JSON redacts the URL and describes headers', async () => {
    await runMcp([
      'add',
      'r',
      '--url',
      'https://mcp.example.com/mcp',
      '--header',
      'Authorization: Bearer ${MCP_TOKEN}',
    ]);
    const { stdout, error } = await runMcp(['list'], { json: true });
    expect(error).toBeUndefined();
    const parsed = JSON.parse(stdout) as { servers: Array<Record<string, unknown>> };
    expect(parsed.servers[0]).toMatchObject({ name: 'r', type: 'http', url: 'https://mcp.example.com/mcp' });
    expect(parsed.servers[0]!.headers).toEqual(['Authorization (from env)']);
  });

  test('a url-less remote row in JSON does not crash', async () => {
    const { setStoredMcpServers } = await import('../src/lib/config.js');
    setStoredMcpServers([{ name: 'r', type: 'http' }]);
    const { stdout, error } = await runMcp(['list'], { json: true });
    expect(error).toBeUndefined();
    const parsed = JSON.parse(stdout) as { servers: Array<Record<string, unknown>> };
    expect(parsed.servers[0]).toMatchObject({ name: 'r', type: 'http' });
    expect(parsed.servers[0]!.url).toBeUndefined();
  });

  test('project servers show the trust footer, trusted or not', async () => {
    writeProjectMcpServers(cwd, [{ name: 'p', command: 'node' }]);
    let r = await runMcp(['list']);
    expect(r.stdout + r.stderr).toContain('NOT trusted');
    await runMcp(['trust']);
    r = await runMcp(['list']);
    expect(r.stdout + r.stderr).toContain('This workspace is trusted');
  });
});

describe('mcp trust, remove, toggle edges', () => {
  test('trusting twice reports already trusted; untrusting an unknown path reports it', async () => {
    let r = await runMcp(['trust', cwd]);
    expect(r.stdout + r.stderr).toContain('Trusted workspace');
    r = await runMcp(['trust', cwd]);
    expect(r.stdout + r.stderr).toContain('already trusted');
    r = await runMcp(['untrust', join(cwd, 'elsewhere')]);
    expect(r.stdout + r.stderr).toContain('was not trusted');
  });

  test('declining the remove prompt keeps the server', async () => {
    await runMcp(['add', 'x', '--', 'node']);
    const fakeStdin = Readable.from(['n\n']);
    (fakeStdin as unknown as { isTTY: boolean }).isTTY = true;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    const r = await runMcp(['remove', 'x']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('Cancelled - nothing removed.');
    expect(loadMcpServers(cwd)).toHaveLength(1);
  });

  test('untrusting with no path defaults to the current directory', async () => {
    const r = await runMcp(['untrust']);
    expect(r.stdout + r.stderr).toContain('was not trusted');
  });

  test('disabling one of two servers keeps the other', async () => {
    await runMcp(['add', 'one', '--', 'node']);
    await runMcp(['add', 'two', '--', 'node']);
    const r = await runMcp(['disable', 'one']);
    expect(r.error).toBeUndefined();
    const servers = loadMcpServers(cwd);
    expect(servers.find((s) => s.name === 'two')?.enabled).not.toBe(false);
    expect(servers.find((s) => s.name === 'one')?.enabled).toBe(false);
  });
});

describe('mcp test edges', () => {
  test('the echo fixture connects and lists its tools', async () => {
    await runMcp(['add', 'echo', '--', process.execPath, FIXTURE]);
    const r = await runMcp(['test', 'echo']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('spycore-fixture 0.0.1');
    expect(r.stdout + r.stderr).toContain('mcp__echo__echo');
  });

  test('a server with no tools warns, and a tool without a description renders bare', async () => {
    const noTools = join(cwd, 'no-tools.mjs');
    writeFileSync(
      noTools,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bare', version: '1' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
});
`,
    );
    await runMcp(['add', 'bare', '--', process.execPath, noTools]);
    let r = await runMcp(['test', 'bare']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('exposed no tools');

    const oneBare = join(cwd, 'one-bare.mjs');
    writeFileSync(
      oneBare,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bare' } } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'nodesc', inputSchema: { type: 'object', properties: {} } }] } });
});
`,
    );
    await runMcp(['add', 'bare1', '--', process.execPath, oneBare]);
    r = await runMcp(['test', 'bare1']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('1 tool:');
    expect(r.stdout + r.stderr).toContain('mcp__bare1__nodesc\n');
  });

  test('a server entry without a command fails to connect', async () => {
    const { setStoredMcpServers } = await import('../src/lib/config.js');
    setStoredMcpServers([{ name: 'nocmd' }]);
    const r = await runMcp(['test', 'nocmd']);
    expect((r.error as Error)?.message).toMatch(/Failed to connect/);
  });

  test('a remote entry without a URL fails validation before connecting', async () => {
    const { setStoredMcpServers } = await import('../src/lib/config.js');
    setStoredMcpServers([{ name: 'r', type: 'http' }]);
    const r = await runMcp(['test', 'r']);
    expect((r.error as Error)?.message).toMatch(/Failed to connect/);
  });

  test('a server without a name or protocol version renders fallbacks', async () => {
    const bare = join(cwd, 'bare2.mjs');
    writeFileSync(
      bare,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  if (msg.method === 'initialize') send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { tools: {} }, serverInfo: {} } });
  else if (msg.method === 'tools/list') send({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } });
});
`,
    );
    await runMcp(['add', 'bare2', '--', process.execPath, bare]);
    const r = await runMcp(['test', 'bare2']);
    expect(r.error).toBeUndefined();
    expect(r.stdout + r.stderr).toContain('Connected to server (protocol unknown).');
  });

  test('a remote server that refuses the connection fails to connect', async () => {
    await runMcp(['add', 'r', '--url', 'http://127.0.0.1:9/mcp']);
    const r = await runMcp(['test', 'r']);
    expect((r.error as Error)?.message).toMatch(/Failed to connect/);
  });

  // R3-6 / R2-9: `--timeout abc` used to silently default (the old test
  // pinned that lenient behavior); strict-parse now errors loudly, like
  // the rest of the CLI's numeric flags.
  test('a valid timeout is accepted and an invalid one errors', async () => {
    await runMcp(['add', 'echo', '--', process.execPath, FIXTURE]);
    let r = await runMcp(['test', 'echo', '--timeout', '5']);
    expect(r.error).toBeUndefined();
    r = await runMcp(['test', 'echo', '--timeout', 'abc']);
    expect((r.error as Error)?.message).toMatch(/Invalid --timeout/);
  });
});
