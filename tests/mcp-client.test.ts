import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshConfigDir } from './helpers.js';
import { McpStdioClient, MCP_PROTOCOL_VERSION } from '../src/lib/agent/mcp-client.js';
import { buildMinimalEnv, writeScope } from '../src/lib/agent/mcp-config.js';
import { isWorkspaceTrusted, trustWorkspace } from '../src/lib/config.js';
import { setupMcpBridge } from '../src/lib/agent/mcp.js';
import { dispatchTool, DEFAULT_LIMITS, type ToolContext, type ToolLimits } from '../src/lib/agent/tools.js';
import type { RequestApproval, ApprovalRequest } from '../src/lib/agent/approval.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const FLOOD_FIXTURE = fileURLToPath(new URL('./fixtures/mcp-flood-server.mjs', import.meta.url));
const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });
const REJECT: RequestApproval = () => Promise.resolve({ approved: false, reason: 'rejected by user' });

function startFixture(env: NodeJS.ProcessEnv = buildMinimalEnv(undefined, process.env)): Promise<McpStdioClient> {
  return McpStdioClient.start({
    command: process.execPath,
    args: [FIXTURE],
    env,
    initTimeoutMs: 5000,
    requestTimeoutMs: 5000,
  });
}

/** Poll until `pid` is no longer a live process (or time out). */
async function waitGone(pid: number, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH — gone
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

let cwd: string;

beforeEach(() => {
  freshConfigDir();
  cwd = mkdtempSync(join(tmpdir(), 'spycli-mcp-cli-'));
});

afterEach(async () => {
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('McpStdioClient (real stdio handshake)', () => {
  test('initializes, records server info + protocol version', async () => {
    const client = await startFixture();
    try {
      expect(client.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
      expect(client.serverInfo?.name).toBe('spycore-fixture');
      expect(typeof client.pid).toBe('number');
    } finally {
      await client.shutdown();
    }
  });

  test('tools/list returns the fixture tools with descriptions', async () => {
    const client = await startFixture();
    try {
      const tools = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(['big', 'echo', 'env_probe']);
      const echo = tools.find((t) => t.name === 'echo');
      expect(echo?.description).toMatch(/echo/i);
      expect(echo?.inputSchema).toMatchObject({ type: 'object' });
    } finally {
      await client.shutdown();
    }
  });

  test('tools/call round-trips (echo)', async () => {
    const client = await startFixture();
    try {
      const res = await client.callTool('echo', { text: 'hello mcp' });
      expect(res.isError).toBe(false);
      expect(res.content).toEqual([{ type: 'text', text: 'hello mcp' }]);
    } finally {
      await client.shutdown();
    }
  });

  test('an isError result is surfaced as such', async () => {
    const env = buildMinimalEnv(undefined, { ...process.env, FIXTURE_NO_TOOL_FOR: 'echo' } as NodeJS.ProcessEnv);
    // FIXTURE_NO_TOOL_FOR is not in the minimal allowlist, so pass it explicitly.
    const client = await startFixture({ ...env, FIXTURE_NO_TOOL_FOR: 'echo' });
    try {
      const res = await client.callTool('echo', { text: 'x' });
      expect(res.isError).toBe(true);
    } finally {
      await client.shutdown();
    }
  });

  test('stdout flooded with no newline past the cap fails the call and kills the server (CL5)', async () => {
    const client = await McpStdioClient.start({
      command: process.execPath,
      args: [FLOOD_FIXTURE],
      env: buildMinimalEnv(undefined, process.env),
      initTimeoutMs: 5000,
      requestTimeoutMs: 5000,
    });
    const pid = client.pid!;
    // The hostile server streams stdout with no newline; the client must bound
    // its unparsed buffer (STDOUT_CAP_BYTES) and tear the connection down rather
    // than grow it without limit (OOM DoS).
    await expect(client.callTool('flood', {}, 8000)).rejects.toThrow(/exceeded|newline|closing/i);
    expect(await waitGone(pid)).toBe(true);
  }, 15000);

  test('start() rejects (degrades) on a command that cannot spawn', async () => {
    await expect(
      McpStdioClient.start({
        command: 'this-binary-does-not-exist-spycore-xyz',
        args: [],
        env: buildMinimalEnv(undefined, process.env),
        initTimeoutMs: 2000,
      }),
    ).rejects.toThrow();
  });

  test('shutdown() closes stdin and the child exits (no orphan)', async () => {
    const client = await startFixture();
    const pid = client.pid!;
    await client.shutdown();
    expect(await waitGone(pid)).toBe(true);
  });

  test('kill() tears down the process group (abort path; pid gone)', async () => {
    const client = await startFixture();
    const pid = client.pid!;
    client.kill();
    expect(await waitGone(pid)).toBe(true);
  });

  test('minimal env: a parent secret is NOT visible to the child; configured vars ARE', async () => {
    const parent = {
      ...process.env,
      SPYCORE_TEST_SECRET: 'topsecret',
      MCP_ALLOWED: 'allowed-value',
    } as NodeJS.ProcessEnv;
    const env = buildMinimalEnv([{ name: 'MCP_ALLOWED' }, { name: 'LITERAL', value: 'lit-val' }], parent);
    const client = await startFixture(env);
    try {
      const res = await client.callTool('env_probe', {});
      const text = res.content[0] && res.content[0].type === 'text' ? res.content[0].text : '{}';
      const probed = JSON.parse(text) as Record<string, unknown>;
      expect(probed.SPYCORE_TEST_SECRET).toBeNull(); // not forwarded
      expect(probed.MCP_ALLOWED).toBe('allowed-value'); // passthrough by NAME
      expect(probed.LITERAL).toBe('lit-val'); // literal value
      expect(probed.HAS_PATH).toBe(true); // PATH baseline present
    } finally {
      await client.shutdown();
    }
  });
});

describe('setupMcpBridge (agent bridging)', () => {
  /**
   * Configure the fixture as a project-scoped server named `fix`. These tests
   * exercise bridging mechanics on a trusted dev workspace, so we trust `cwd`
   * here; the trust gate itself is covered by the CL1 block below.
   */
  function configureFixture(name = 'fix', extra: Partial<{ enabled: boolean }> = {}): void {
    writeScope('project', cwd, [
      { name, command: process.execPath, args: [FIXTURE], ...(extra.enabled === false ? { enabled: false } : {}) },
    ]);
    trustWorkspace(cwd);
  }

  test('zero configured servers → null bridge (no spawn, no prompt section)', async () => {
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT });
    expect(bridge).toBeNull();
  });

  test('registers mcp__<server>__<tool> tools and a catalog mentioning them', async () => {
    configureFixture();
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT });
    expect(bridge).not.toBeNull();
    try {
      const names = [...bridge!.tools.keys()].sort();
      expect(names).toEqual(['mcp__fix__big', 'mcp__fix__echo', 'mcp__fix__env_probe']);
      expect(bridge!.promptSection).toContain('# MCP tools');
      expect(bridge!.promptSection).toContain('mcp__fix__echo');
      expect(bridge!.toolCount).toBe(3);
      expect(bridge!.serverCount).toBe(1);
    } finally {
      await bridge!.shutdown();
    }
  });

  test('an MCP tool call requires approval: rejected → not called', async () => {
    configureFixture();
    const bridge = await setupMcpBridge({ cwd, requestApproval: REJECT });
    try {
      const ctx: ToolContext = { cwd, limits: DEFAULT_LIMITS, requestApproval: REJECT, extraTools: bridge!.tools };
      const res = await dispatchTool('mcp__fix__echo', { text: 'hi' }, ctx);
      expect(res.ok).toBe(false);
      expect(res.kind).toBe('rejected');
      expect(res.content).toMatch(/was not run/);
    } finally {
      await bridge!.shutdown();
    }
  });

  test('approved (or --yes) → called, text content returned', async () => {
    configureFixture();
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT });
    try {
      const ctx: ToolContext = { cwd, limits: DEFAULT_LIMITS, requestApproval: ACCEPT, extraTools: bridge!.tools };
      const res = await dispatchTool('mcp__fix__echo', { text: 'round-trip' }, ctx);
      expect(res.ok).toBe(true);
      expect(res.content).toContain('round-trip');
    } finally {
      await bridge!.shutdown();
    }
  });

  test('a large MCP result is byte-capped by dispatch (maxResultBytes)', async () => {
    configureFixture();
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT });
    try {
      const tiny: ToolLimits = { ...DEFAULT_LIMITS, maxResultBytes: 500 };
      const ctx: ToolContext = { cwd, limits: tiny, requestApproval: ACCEPT, extraTools: bridge!.tools };
      const res = await dispatchTool('mcp__fix__big', { size: 50000 }, ctx);
      expect(res.ok).toBe(true);
      expect(res.content).toMatch(/truncated to/);
      expect(res.content.length).toBeLessThan(2000);
    } finally {
      await bridge!.shutdown();
    }
  });

  test('a server that fails to start degrades gracefully (warning, others survive)', async () => {
    writeScope('project', cwd, [
      { name: 'broken', command: 'this-binary-does-not-exist-spycore-xyz' },
      { name: 'fix', command: process.execPath, args: [FIXTURE] },
    ]);
    trustWorkspace(cwd);
    const warnings: string[] = [];
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT, onWarn: (m) => warnings.push(m) });
    try {
      expect(bridge!.serverCount).toBe(1); // only the good one
      expect([...bridge!.tools.keys()]).toContain('mcp__fix__echo');
      expect(warnings.some((w) => w.includes('broken'))).toBe(true);
    } finally {
      await bridge!.shutdown();
    }
  });

  test('aborting the signal kills the server children (no orphan)', async () => {
    configureFixture();
    const controller = new AbortController();
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT, signal: controller.signal });
    const pids = bridge!.serverPids;
    expect(pids.length).toBe(1);
    controller.abort();
    expect(await waitGone(pids[0]!)).toBe(true);
    await bridge!.shutdown();
  });

  test('a disabled server is never spawned', async () => {
    configureFixture('fix', { enabled: false });
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT });
    expect(bridge).toBeNull(); // no ENABLED servers
  });
});

describe('setupMcpBridge — workspace trust gate (CL1)', () => {
  /** A project-scoped fixture, WITHOUT trusting the workspace. */
  function configureProject(): void {
    writeScope('project', cwd, [{ name: 'fix', command: process.execPath, args: [FIXTURE] }]);
  }

  test('untrusted workspace, no resolver (headless/CI/--yes) → project servers SKIPPED', async () => {
    configureProject();
    const warnings: string[] = [];
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT, onWarn: (m) => warnings.push(m) });
    expect(bridge?.toolCount ?? 0).toBe(0); // nothing spawned
    expect(warnings.some((w) => /untrusted|trust/i.test(w))).toBe(true);
    expect(isWorkspaceTrusted(cwd)).toBe(false); // headless must NOT auto-trust
    await bridge?.shutdown();
  });

  test('interactive grant spawns project servers AND persists trust', async () => {
    configureProject();
    let prompts = 0;
    const bridge = await setupMcpBridge({
      cwd,
      requestApproval: ACCEPT,
      confirmProjectMcpTrust: async () => {
        prompts += 1;
        return true;
      },
    });
    try {
      expect(prompts).toBe(1);
      expect(bridge!.toolCount).toBe(3);
      expect([...bridge!.tools.keys()]).toContain('mcp__fix__echo');
      expect(isWorkspaceTrusted(cwd)).toBe(true);
    } finally {
      await bridge!.shutdown();
    }
  });

  test('interactive decline skips project servers and does NOT persist trust', async () => {
    configureProject();
    const bridge = await setupMcpBridge({
      cwd,
      requestApproval: ACCEPT,
      confirmProjectMcpTrust: async () => false,
    });
    expect(bridge?.toolCount ?? 0).toBe(0);
    expect(isWorkspaceTrusted(cwd)).toBe(false);
    await bridge?.shutdown();
  });

  test('already-trusted workspace spawns project servers without prompting', async () => {
    configureProject();
    trustWorkspace(cwd);
    let prompts = 0;
    const bridge = await setupMcpBridge({
      cwd,
      requestApproval: ACCEPT,
      confirmProjectMcpTrust: async () => {
        prompts += 1;
        return true;
      },
    });
    try {
      expect(prompts).toBe(0); // no prompt — already trusted
      expect(bridge!.toolCount).toBe(3);
    } finally {
      await bridge!.shutdown();
    }
  });

  test('user-global servers spawn regardless of workspace trust (no prompt)', async () => {
    writeScope('user', cwd, [{ name: 'glob', command: process.execPath, args: [FIXTURE] }]);
    let prompts = 0;
    const bridge = await setupMcpBridge({
      cwd,
      requestApproval: ACCEPT,
      confirmProjectMcpTrust: async () => {
        prompts += 1;
        return true;
      },
    });
    try {
      expect(prompts).toBe(0); // user servers need no trust
      expect(bridge!.toolCount).toBe(3);
      expect([...bridge!.tools.keys()]).toContain('mcp__glob__echo');
      expect(isWorkspaceTrusted(cwd)).toBe(false);
    } finally {
      await bridge!.shutdown();
    }
  });
});
