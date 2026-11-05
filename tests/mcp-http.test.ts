/**
 * PHASE-1 1.9 - remote MCP over streamable HTTP. Everything runs against an
 * in-process node:http mock on 127.0.0.1 (loopback, so plain http is allowed
 * by the transport's own rules); no external network is touched.
 *
 * Pinned here:
 *  - handshake + tools/list + tools/call round-trip (JSON and SSE-upgraded);
 *  - Mcp-Session-Id captured + replayed; 404 → ONE re-init + replay, then fail;
 *  - security: https-for-non-loopback (no escape), header values never leak,
 *    response size cap, connect + request timeouts, bounded failure breaker;
 *  - ${ENV} header expansion (resolved / unresolved → per-server isolation);
 *  - CL1 trust gate identical to stdio (untrusted ⇒ ZERO network contact);
 *  - classification: mutating, absent in plan declarations, approval-gated,
 *    hooks fire around remote dispatch - the EXACT stdio path.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import {
  McpHttpClient,
  HTTP_RESPONSE_CAP_BYTES,
  HTTP_MAX_CONSECUTIVE_FAILURES,
} from '../src/lib/agent/mcp-http-client.js';
import { validateRemoteMcpUrl, writeScope } from '../src/lib/agent/mcp-config.js';
import { isWorkspaceTrusted, trustWorkspace } from '../src/lib/config.js';
import { setupMcpBridge } from '../src/lib/agent/mcp.js';
import {
  buildToolDeclarations,
  dispatchTool,
  DEFAULT_LIMITS,
  type ToolContext,
  type ToolLimits,
} from '../src/lib/agent/tools.js';
import { runAgent } from '../src/lib/agent/loop.js';
import type { Provider, ProviderEvent, StreamChatParams } from '../src/lib/providers/types.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';

const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });
const REJECT: RequestApproval = () => Promise.resolve({ approved: false, reason: 'rejected by user' });

const SECRET = 'sk-remote-test-secret-9f2a';
const SECRET_ENV = 'MCP_HTTP_TEST_SECRET';

// ─────────────────────── in-process mock server ───────────────────────

interface Rpc {
  id?: number | string;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; [k: string]: unknown };
}

interface CapturedRequest {
  httpMethod: string;
  rpcMethod: string | undefined;
  headers: NodeJS.Dict<string | string[]>;
  body: Rpc | undefined;
}

interface MockState {
  initCount: number;
  sessionSeq: number;
}

interface MockCfg {
  /** Session id issued at initialize. undefined → auto `sess-<n>`; null → none. */
  sessionId?: string | null;
  /** Answer tools/call with an SSE-upgraded response instead of plain JSON. */
  sseForCalls?: boolean;
  /** Custom handler; return true when the response was fully handled. */
  onRpc?: (rpc: Rpc, req: IncomingMessage, res: ServerResponse, state: MockState) => boolean | void;
}

interface Mock {
  url: string;
  captured: CapturedRequest[];
  state: MockState;
  close: () => Promise<void>;
}

const ECHO_TOOL = {
  name: 'echo',
  description: 'Echo the provided text back to the caller.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', description: 'Text to echo' } },
    required: ['text'],
  },
};

function startMock(cfg: MockCfg = {}): Promise<Mock> {
  const captured: CapturedRequest[] = [];
  const state: MockState = { initCount: 0, sessionSeq: 0 };
  const server = createServer((req, res) => {
    res.on('error', () => {
      /* client aborted mid-write - expected in cap/timeout tests */
    });
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let rpc: Rpc | undefined;
      try {
        rpc = raw.length > 0 ? (JSON.parse(raw) as Rpc) : undefined;
      } catch {
        rpc = undefined;
      }
      captured.push({ httpMethod: req.method ?? '', rpcMethod: rpc?.method, headers: req.headers, body: rpc });
      if (cfg.onRpc && cfg.onRpc(rpc ?? {}, req, res, state) === true) return;
      if (req.method === 'DELETE') {
        res.statusCode = 200;
        res.end();
        return;
      }
      if (!rpc || rpc.id === undefined) {
        res.statusCode = 202; // notification accepted
        res.end();
        return;
      }
      if (rpc.method === 'initialize') {
        state.initCount += 1;
        state.sessionSeq += 1;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (cfg.sessionId !== null) headers['mcp-session-id'] = cfg.sessionId ?? `sess-${state.sessionSeq}`;
        res.writeHead(200, headers);
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: 'mock-remote', version: '1.0.0' },
            },
          }),
        );
        return;
      }
      if (rpc.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [ECHO_TOOL] } }));
        return;
      }
      if (rpc.method === 'tools/call') {
        const text = String(rpc.params?.arguments?.text ?? '');
        const response = {
          jsonrpc: '2.0',
          id: rpc.id,
          result: { content: [{ type: 'text', text }], isError: false },
        };
        if (cfg.sseForCalls) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          // A notification frame first - the client must skip it, then stop at
          // the response matching its request id.
          res.write('data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}\n\n');
          res.write(`data: ${JSON.stringify(response)}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(response));
        }
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: `method not found: ${rpc.method}` } }),
      );
    });
  });
  return new Promise<Mock>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        captured,
        state,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}

let cwd: string;
const mocks: Mock[] = [];

async function mock(cfg: MockCfg = {}): Promise<Mock> {
  const m = await startMock(cfg);
  mocks.push(m);
  return m;
}

beforeEach(() => {
  freshConfigDir();
  cwd = mkdtempSync(join(tmpdir(), 'spycli-mcp-http-'));
});

afterEach(async () => {
  delete process.env[SECRET_ENV];
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  await Promise.all(mocks.splice(0).map((m) => m.close()));
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ─────────────────────── 1. transport round-trip ───────────────────────

describe('McpHttpClient - streamable HTTP round-trip', () => {
  test('initialize handshake, tools/list, tools/call over plain JSON', async () => {
    const m = await mock();
    const client = await McpHttpClient.connect({ url: m.url, headers: {}, initTimeoutMs: 5000, requestTimeoutMs: 5000 });
    try {
      expect(client.protocolVersion).toBe('2025-06-18');
      expect(client.serverInfo?.name).toBe('mock-remote');
      expect(client.pid).toBeUndefined();
      const tools = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(['echo']);
      const res = await client.callTool('echo', { text: 'remote round-trip' });
      expect(res.isError).toBe(false);
      expect(res.content).toEqual([{ type: 'text', text: 'remote round-trip' }]);
    } finally {
      await client.shutdown();
    }
    // notifications/initialized was POSTed after the handshake (dialect parity).
    expect(m.captured.some((c) => c.rpcMethod === 'notifications/initialized')).toBe(true);
  });

  test('an SSE-upgraded tools/call response is parsed via the shared parser', async () => {
    const m = await mock({ sseForCalls: true });
    const client = await McpHttpClient.connect({ url: m.url, headers: {}, initTimeoutMs: 5000, requestTimeoutMs: 5000 });
    try {
      const res = await client.callTool('echo', { text: 'via-sse' });
      expect(res.isError).toBe(false);
      expect(res.content).toEqual([{ type: 'text', text: 'via-sse' }]);
    } finally {
      await client.shutdown();
    }
  });
});

// ─────────────────────── 2. session management ───────────────────────

describe('McpHttpClient - Mcp-Session-Id', () => {
  test('the session id from initialize is replayed on every subsequent request', async () => {
    const m = await mock({ sessionId: 'sess-fixed' });
    const client = await McpHttpClient.connect({ url: m.url, headers: {}, initTimeoutMs: 5000, requestTimeoutMs: 5000 });
    try {
      await client.listTools();
      await client.callTool('echo', { text: 'x' });
    } finally {
      await client.shutdown();
    }
    const postInit = m.captured.filter((c) => c.rpcMethod !== 'initialize' && c.httpMethod === 'POST');
    expect(postInit.length).toBeGreaterThanOrEqual(3); // initialized + list + call
    for (const c of postInit) expect(c.headers['mcp-session-id']).toBe('sess-fixed');
    // The negotiated protocol version rides post-init requests, per spec.
    const call = m.captured.find((c) => c.rpcMethod === 'tools/call');
    expect(call?.headers['mcp-protocol-version']).toBe('2025-06-18');
    // Graceful shutdown DELETEs the session.
    expect(m.captured.some((c) => c.httpMethod === 'DELETE' && c.headers['mcp-session-id'] === 'sess-fixed')).toBe(true);
  });

  test('404 (session expired) → ONE re-initialize + replay succeeds', async () => {
    let expiredOnce = false;
    const m = await mock({
      onRpc: (rpc, _req, res) => {
        if (rpc.method === 'tools/call' && !expiredOnce) {
          expiredOnce = true;
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{}');
          return true;
        }
        return false;
      },
    });
    const client = await McpHttpClient.connect({ url: m.url, headers: {}, initTimeoutMs: 5000, requestTimeoutMs: 5000 });
    try {
      const res = await client.callTool('echo', { text: 'after-expiry' });
      expect(res.content).toEqual([{ type: 'text', text: 'after-expiry' }]);
    } finally {
      await client.shutdown();
    }
    expect(m.state.initCount).toBe(2); // original + exactly one re-init
    // The replayed call carried the NEW session id.
    const calls = m.captured.filter((c) => c.rpcMethod === 'tools/call');
    expect(calls[calls.length - 1]?.headers['mcp-session-id']).toBe('sess-2');
  });

  test('a second 404 after the re-initialize fails cleanly (no loop)', async () => {
    const m = await mock({
      onRpc: (rpc, _req, res) => {
        if (rpc.method === 'tools/call') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end('{}');
          return true;
        }
        return false;
      },
    });
    const client = await McpHttpClient.connect({ url: m.url, headers: {}, initTimeoutMs: 5000, requestTimeoutMs: 5000 });
    try {
      await expect(client.callTool('echo', { text: 'x' })).rejects.toThrow(/HTTP 404/);
    } finally {
      await client.shutdown();
    }
    expect(m.state.initCount).toBe(2); // bounded: exactly one re-init attempt
  });
});

// ─────────────────────── 3. security pins ───────────────────────

describe('remote MCP - security invariants', () => {
  test('https is required off-loopback (no escape hatch); loopback http allowed', () => {
    expect(validateRemoteMcpUrl('http://example.com/mcp')).toMatch(/https/);
    expect(validateRemoteMcpUrl('http://10.1.2.3/mcp')).toMatch(/https/);
    expect(validateRemoteMcpUrl('https://example.com/mcp')).toBeNull();
    expect(validateRemoteMcpUrl('http://127.0.0.1:8080/mcp')).toBeNull();
    expect(validateRemoteMcpUrl('http://localhost:8080/mcp')).toBeNull();
    expect(validateRemoteMcpUrl('http://[::1]:8080/mcp')).toBeNull();
    expect(validateRemoteMcpUrl('ftp://example.com/mcp')).toMatch(/scheme/);
    expect(validateRemoteMcpUrl('not a url')).toMatch(/not a valid URL/);
    // Credentials in the URL are refused - auth belongs in an env-ref header.
    expect(validateRemoteMcpUrl('https://user:pass@example.com/mcp')).toMatch(/credentials/i);
  });

  test('the transport itself refuses a non-loopback http URL (defense in depth)', async () => {
    await expect(
      McpHttpClient.connect({ url: 'http://example.invalid/mcp', headers: {}, initTimeoutMs: 500 }),
    ).rejects.toThrow(/https/);
  });

  test('a non-loopback http config entry is refused at load: warning, no tools, session survives', async () => {
    const good = await mock();
    writeScope('project', cwd, [
      { name: 'bad', type: 'http', url: 'http://example.com/mcp' },
      { name: 'good', type: 'http', url: good.url },
    ]);
    trustWorkspace(cwd);
    const warnings: string[] = [];
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT, onWarn: (m) => warnings.push(m) });
    try {
      expect(warnings.some((w) => w.includes('bad') && /https/.test(w))).toBe(true);
      expect([...bridge!.tools.keys()]).toEqual(['mcp__good__echo']); // isolation: the good server still bridged
    } finally {
      await bridge!.shutdown();
    }
  });

  test('the Authorization header VALUE never appears in any warning, error, or listing', async () => {
    process.env[SECRET_ENV] = SECRET;
    // A server that always 500s → every surface this config can produce fires.
    const m = await mock({
      onRpc: (_rpc, _req, res) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{}');
        return true;
      },
    });
    writeScope('project', cwd, [
      { name: 'r', type: 'http', url: m.url, headers: { Authorization: `Bearer \${${SECRET_ENV}}` } },
    ]);
    trustWorkspace(cwd);
    const warnings: string[] = [];
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT, onWarn: (w) => warnings.push(w) });
    await bridge?.shutdown();
    expect(warnings.length).toBeGreaterThan(0);
    for (const w of warnings) expect(w).not.toContain(SECRET);
    // Direct connect error message is clean too.
    let message = '';
    try {
      await McpHttpClient.connect({
        url: m.url,
        headers: { Authorization: `Bearer ${SECRET}` },
        initTimeoutMs: 2000,
      });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain(SECRET);
    expect(message).toMatch(/HTTP 500/); // status only - the body is never echoed
  });

  test('a response over the size cap terminates the connection with a clean error', async () => {
    const m = await mock({
      onRpc: (rpc, _req, res) => {
        if (rpc.method === 'tools/call') {
          res.writeHead(200, { 'content-type': 'application/json' });
          // Stream well past the cap; the client must abort, not accumulate.
          const chunk = 'x'.repeat(1024 * 1024);
          res.write('{"jsonrpc":"2.0","id":0,"result":{"content":[{"type":"text","text":"');
          for (let i = 0; i < 10; i += 1) {
            try {
              res.write(chunk);
            } catch {
              break;
            }
          }
          try {
            res.end('"}]}}');
          } catch {
            /* client already gone */
          }
          return true;
        }
        return false;
      },
    });
    const client = await McpHttpClient.connect({ url: m.url, headers: {}, initTimeoutMs: 5000, requestTimeoutMs: 15000 });
    try {
      await expect(client.callTool('echo', { text: 'x' })).rejects.toThrow(
        new RegExp(`exceeded ${HTTP_RESPONSE_CAP_BYTES}`),
      );
    } finally {
      await client.shutdown();
    }
  }, 20000);

  test('the per-tool-result caps still apply through dispatch (same path as stdio)', async () => {
    const m = await mock();
    writeScope('project', cwd, [{ name: 'r', type: 'http', url: m.url }]);
    trustWorkspace(cwd);
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT });
    try {
      const tiny: ToolLimits = { ...DEFAULT_LIMITS, maxResultChars: 200 };
      const ctx: ToolContext = { cwd, limits: tiny, requestApproval: ACCEPT, extraTools: bridge!.tools };
      const res = await dispatchTool('mcp__r__echo', { text: 'y'.repeat(5000) }, ctx);
      expect(res.ok).toBe(true);
      expect(res.content).toMatch(/truncated to/);
      expect(res.content.length).toBeLessThan(1000);
    } finally {
      await bridge!.shutdown();
    }
  });

  test('the connect (initialize) timeout fires against a hanging server', async () => {
    const m = await mock({
      onRpc: (rpc) => (rpc.method === 'initialize' ? true : false), // swallow - never respond
    });
    await expect(
      McpHttpClient.connect({ url: m.url, headers: {}, initTimeoutMs: 400 }),
    ).rejects.toThrow(/timed out after 400ms/);
  });

  test('the per-request timeout fires against a hanging tool call', async () => {
    const m = await mock({
      onRpc: (rpc) => (rpc.method === 'tools/call' ? true : false), // swallow - never respond
    });
    const client = await McpHttpClient.connect({ url: m.url, headers: {}, initTimeoutMs: 5000, requestTimeoutMs: 5000 });
    try {
      await expect(client.callTool('echo', { text: 'x' }, 400)).rejects.toThrow(/timed out after 400ms/);
    } finally {
      await client.shutdown();
    }
  });

  test(`after ${HTTP_MAX_CONSECUTIVE_FAILURES} consecutive transport failures the server is failed for the session (one notice, fast-fail, no more requests)`, async () => {
    const m = await mock({
      onRpc: (rpc, _req, res) => {
        if (rpc.method === 'tools/call') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{}');
          return true;
        }
        return false;
      },
    });
    const notices: string[] = [];
    const client = await McpHttpClient.connect({
      url: m.url,
      headers: {},
      initTimeoutMs: 5000,
      requestTimeoutMs: 5000,
      onPermanentFailure: (r) => notices.push(r),
    });
    try {
      for (let i = 0; i < HTTP_MAX_CONSECUTIVE_FAILURES; i += 1) {
        await expect(client.callTool('echo', { text: 'x' })).rejects.toThrow(/HTTP 500/);
      }
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatch(/disabled for this session/);
      const requestsBefore = m.captured.length;
      await expect(client.callTool('echo', { text: 'x' })).rejects.toThrow(/disabled for this session/);
      expect(m.captured.length).toBe(requestsBefore); // fast-fail: no network contact
    } finally {
      await client.shutdown();
    }
  });
});

// ─────────────────────── 4. ${ENV} header expansion ───────────────────────

describe('remote MCP - header env expansion', () => {
  test('a resolved ${ENV} reference reaches the server; the value appears nowhere else', async () => {
    process.env[SECRET_ENV] = SECRET;
    const m = await mock();
    writeScope('project', cwd, [
      { name: 'r', type: 'http', url: m.url, headers: { Authorization: `Bearer \${${SECRET_ENV}}` } },
    ]);
    trustWorkspace(cwd);
    const warnings: string[] = [];
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT, onWarn: (w) => warnings.push(w) });
    try {
      expect(bridge!.toolCount).toBe(1);
      const init = m.captured.find((c) => c.rpcMethod === 'initialize');
      expect(init?.headers.authorization).toBe(`Bearer ${SECRET}`); // expanded on the wire
      for (const w of warnings) expect(w).not.toContain(SECRET);
      expect(bridge!.promptSection).not.toContain(SECRET);
    } finally {
      await bridge!.shutdown();
    }
  });

  test('an unresolved ${ENV} reference fails THAT server with a clear error; the session survives', async () => {
    const good = await mock();
    const bad = await mock();
    writeScope('project', cwd, [
      { name: 'bad', type: 'http', url: bad.url, headers: { Authorization: 'Bearer ${SPYCORE_UNSET_VAR_XYZ}' } },
      { name: 'good', type: 'http', url: good.url },
    ]);
    trustWorkspace(cwd);
    const warnings: string[] = [];
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT, onWarn: (w) => warnings.push(w) });
    try {
      expect(warnings.some((w) => w.includes('bad') && w.includes('SPYCORE_UNSET_VAR_XYZ'))).toBe(true);
      expect([...bridge!.tools.keys()]).toEqual(['mcp__good__echo']);
      expect(bad.captured).toHaveLength(0); // never contacted with a broken header set
    } finally {
      await bridge!.shutdown();
    }
  });
});

// ─────────────────────── 5. trust + classification + hooks ───────────────────────

describe('remote MCP - CL1 trust gate + 1.7 classification + 1.6 hooks', () => {
  test('an untrusted workspace NEVER contacts a project-scoped remote server (CL1, identical to stdio)', async () => {
    const m = await mock();
    writeScope('project', cwd, [{ name: 'r', type: 'http', url: m.url }]);
    const warnings: string[] = [];
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT, onWarn: (w) => warnings.push(w) });
    expect(bridge?.toolCount ?? 0).toBe(0);
    expect(warnings.some((w) => /untrusted|trust/i.test(w))).toBe(true);
    expect(isWorkspaceTrusted(cwd)).toBe(false); // headless must NOT auto-trust
    expect(m.captured).toHaveLength(0); // the gate runs BEFORE any network contact
    await bridge?.shutdown();
  });

  test('remote tools are mutating and ABSENT from plan-mode declarations (1.7 structural pin)', async () => {
    const m = await mock();
    writeScope('project', cwd, [{ name: 'r', type: 'http', url: m.url }]);
    trustWorkspace(cwd);
    const bridge = await setupMcpBridge({ cwd, requestApproval: ACCEPT });
    try {
      const tool = bridge!.tools.get('mcp__r__echo');
      expect(tool).toBeDefined();
      expect(tool!.mutating).toBe(true);
      const readOnly = buildToolDeclarations({ readOnlyOnly: true, extraTools: bridge!.tools }).map((d) => d.name);
      expect(readOnly.some((n) => n.startsWith('mcp__'))).toBe(false);
      const full = buildToolDeclarations({ extraTools: bridge!.tools }).map((d) => d.name);
      expect(full).toContain('mcp__r__echo');
    } finally {
      await bridge!.shutdown();
    }
  });

  test('a rejected approval means the remote server never receives tools/call', async () => {
    const m = await mock();
    writeScope('project', cwd, [{ name: 'r', type: 'http', url: m.url }]);
    trustWorkspace(cwd);
    const bridge = await setupMcpBridge({ cwd, requestApproval: REJECT });
    try {
      const ctx: ToolContext = { cwd, limits: DEFAULT_LIMITS, requestApproval: REJECT, extraTools: bridge!.tools };
      const res = await dispatchTool('mcp__r__echo', { text: 'no' }, ctx);
      expect(res.ok).toBe(false);
      expect(res.kind).toBe('rejected');
      expect(m.captured.some((c) => c.rpcMethod === 'tools/call')).toBe(false);
    } finally {
      await bridge!.shutdown();
    }
  });

  test('lifecycle hooks wrap remote MCP dispatch: a pre-tool block stops the call', async () => {
    const m = await mock();
    writeScope('project', cwd, [{ name: 'r', type: 'http', url: m.url }]);
    trustWorkspace(cwd);

    const block = (tool: string, args: unknown): string =>
      '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';
    class StubProvider implements Provider {
      readonly id = 'openai' as const;
      private turn = 0;
      constructor(private readonly replies: string[]) {}
      createConversation(): Promise<string> {
        return Promise.resolve('cnv_stub');
      }
      async *streamChat(_params: StreamChatParams): AsyncIterable<ProviderEvent> {
        const reply = this.replies[this.turn++] ?? 'Done.';
        yield { type: 'text', text: reply };
        yield { type: 'usage', input: 1, output: 1 };
        yield { type: 'done' };
      }
    }

    const preToolCalls: string[] = [];
    const postToolCalls: string[] = [];
    const provider = new StubProvider([block('mcp__r__echo', { text: 'hi' }), 'Finished.']);
    const events: Array<{ type: string; [k: string]: unknown }> = [];
    await runAgent({
      task: 'call the remote tool',
      cwd,
      provider,
      requestApproval: ACCEPT,
      onEvent: (e) => events.push(e as never),
      hooks: {
        hasAny: true,
        preTool: async (name) => {
          preToolCalls.push(name);
          return name.startsWith('mcp__')
            ? { blocked: true, reason: 'blocked by test hook', notices: [] }
            : { blocked: false, reason: null, notices: [] };
        },
        postTool: async (name) => {
          postToolCalls.push(name);
          return { feedback: null, notices: [] };
        },
      },
    });
    expect(preToolCalls).toContain('mcp__r__echo'); // the hook saw the remote dispatch
    expect(m.captured.some((c) => c.rpcMethod === 'tools/call')).toBe(false); // block prevented the call
    const res = events.find((e) => e.type === 'tool_result') as { ok?: boolean } | undefined;
    expect(res?.ok).toBe(false);
  }, 15000);
});
