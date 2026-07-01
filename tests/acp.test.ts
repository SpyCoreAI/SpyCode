import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { JsonRpcEndpoint } from '../src/lib/acp/jsonrpc.js';
import { AcpAgentServer, ACP_PROTOCOL_VERSION } from '../src/lib/acp/server.js';
import type { Provider, ProviderEvent, StreamChatParams, CreateConversationParams } from '../src/lib/providers/types.js';

/**
 * Deterministic ACP tests: the server runs in-process over PassThrough streams
 * (the exact framing/dispatch code the real stdio path uses), driven by a fake
 * scripted client. The provider is a stub — no network. The committed
 * tests/fixtures/acp-client.mjs script is the over-real-stdio variant used for
 * live verification against the built binary.
 */

// ─────────────────────── fake ACP client ───────────────────────

type PermissionResponder = (params: Record<string, unknown>) => Promise<unknown> | unknown;

class FakeAcpClient {
  readonly toServer = new PassThrough();
  readonly fromServer = new PassThrough();
  /** Every frame the server wrote (raw line + parsed). */
  readonly frames: Array<Record<string, unknown>> = [];
  readonly rawLines: string[] = [];
  /** session/update payloads in arrival order. */
  readonly updates: Array<Record<string, unknown>> = [];
  /** Incoming session/request_permission requests (params), in order. */
  readonly permissionRequests: Array<Record<string, unknown>> = [];
  onPermission: PermissionResponder = () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } });

  private nextId = 100;
  private readonly pending = new Map<number, (v: { result?: unknown; error?: { code: number; message: string } }) => void>();
  private buf = '';

  constructor() {
    this.fromServer.setEncoding('utf8');
    this.fromServer.on('data', (chunk: string) => {
      this.buf += chunk;
      let nl = this.buf.indexOf('\n');
      while (nl !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.trim().length > 0) this.handleLine(line);
        nl = this.buf.indexOf('\n');
      }
    });
  }

  private handleLine(line: string): void {
    this.rawLines.push(line);
    const msg = JSON.parse(line) as Record<string, unknown>;
    this.frames.push(msg);
    // Response to one of our requests.
    if (typeof msg.id === 'number' && this.pending.has(msg.id) && !('method' in msg)) {
      const resolve = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      resolve(msg as { result?: unknown; error?: { code: number; message: string } });
      return;
    }
    // Notification from the server.
    if (msg.method === 'session/update' && !('id' in msg)) {
      const params = msg.params as Record<string, unknown>;
      this.updates.push(params.update as Record<string, unknown>);
      return;
    }
    // Server → client request (permission).
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      const params = msg.params as Record<string, unknown>;
      this.permissionRequests.push(params);
      void Promise.resolve(this.onPermission(params)).then((result) => {
        if (result === undefined) return; // deliberately left unanswered
        this.send({ jsonrpc: '2.0', id: msg.id, result });
      });
      return;
    }
  }

  private send(frame: Record<string, unknown>): void {
    this.toServer.write(`${JSON.stringify(frame)}\n`);
  }

  request(method: string, params: unknown): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Answer an as-yet-unanswered permission request by frame id. */
  respondToPermission(requestFrameId: number, result: unknown): void {
    this.send({ jsonrpc: '2.0', id: requestFrameId, result });
  }

  close(): void {
    this.toServer.end();
  }
}

// ─────────────────────── stub provider ───────────────────────

const usageDone: ProviderEvent[] = [{ type: 'usage', input: 1, output: 1 }, { type: 'done' }];
const textTurn = (text: string): ProviderEvent[] => [{ type: 'text', text }, ...usageDone];
const nativeToolTurn = (
  calls: Array<{ id: string; name: string; arguments: string }>,
  narration = '',
): ProviderEvent[] => [
  ...(narration ? [{ type: 'text', text: narration } satisfies ProviderEvent] : []),
  { type: 'tool_call_started', index: 0, name: calls[0]!.name },
  { type: 'tool_calls', calls },
  ...usageDone,
];

class StubProvider implements Provider {
  readonly id = 'spycore' as const;
  readonly calls: StreamChatParams[] = [];
  createCount = 0;
  private turn = 0;
  /** When set, this turn's stream blocks until the signal aborts. */
  hangOnTurn = -1;
  constructor(private readonly scripts: ProviderEvent[][]) {}
  createConversation(_p: CreateConversationParams): Promise<string> {
    this.createCount += 1;
    return Promise.resolve(`cnv_stub_${this.createCount}`);
  }
  supportsNativeTools(): boolean {
    return true;
  }
  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    const myTurn = this.turn++;
    this.calls.push(params);
    if (myTurn === this.hangOnTurn) {
      // Block until aborted (cancel test), then end the turn quietly.
      await new Promise<void>((resolve) => {
        if (params.signal?.aborted) return resolve();
        params.signal?.addEventListener('abort', () => resolve(), { once: true });
        // Safety: never hang the suite.
        setTimeout(resolve, 8000).unref?.();
      });
      yield { type: 'done' };
      return;
    }
    const evs = this.scripts[myTurn] ?? textTurn('fallback final');
    for (const e of evs) yield e;
  }
}

// ─────────────────────── harness ───────────────────────

let workDir: string;
let client: FakeAcpClient;
let endpointDone: Promise<void>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

function startServer(provider: Provider, opts: { authed?: () => Promise<boolean>; requiresAuth?: boolean } = {}): void {
  client = new FakeAcpClient();
  const endpoint = new JsonRpcEndpoint(client.toServer, client.fromServer);
  new AcpAgentServer({
    endpoint,
    provider,
    model: 'styx',
    toolProtocol: 'auto',
    requiresSpycoreAuth: opts.requiresAuth ?? true,
    isAuthenticated: opts.authed ?? (() => Promise.resolve(true)),
    agentVersion: '0.0.0-test',
    commandTimeoutMs: 10_000,
    maxTurns: 10,
  });
  endpointDone = endpoint.start();
}

beforeEach(() => {
  freshConfigDir();
  workDir = mkdtempSync(join(tmpdir(), 'spycli-acp-'));
  // stdout purity: NOTHING may hit the real process stdout during ACP serving.
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  client?.close();
  await endpointDone?.catch(() => {});
  const calls = stdoutSpy.mock.calls.length;
  stdoutSpy.mockRestore();
  expect(calls).toBe(0); // purity, enforced for every test
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function newSession(): Promise<string> {
  const resp = await client.request('session/new', { cwd: workDir, mcpServers: [] });
  return (resp.result as { sessionId: string }).sessionId;
}

const promptBlocks = (text: string): Array<Record<string, unknown>> => [{ type: 'text', text }];

// ─────────────────────── tests ───────────────────────

describe('acp initialize + auth', () => {
  test('negotiates v1, advertises honest capabilities, empty authMethods when logged in', async () => {
    startServer(new StubProvider([textTurn('hi')]));
    const resp = await client.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    const result = resp.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(result.agentCapabilities).toMatchObject({
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    });
    expect(result.authMethods).toEqual([]);
    expect((result.agentInfo as Record<string, unknown>).name).toBe('spycore');
  });

  test('a newer requested version still gets our latest (1) per spec — client decides', async () => {
    startServer(new StubProvider([]));
    const resp = await client.request('initialize', { protocolVersion: 99 });
    expect((resp.result as Record<string, unknown>).protocolVersion).toBe(1);
  });

  test('unauthenticated: authMethods advertised; session/new + authenticate gate with -32000', async () => {
    let authed = false;
    startServer(new StubProvider([textTurn('hi')]), { authed: () => Promise.resolve(authed) });
    const init = await client.request('initialize', { protocolVersion: 1 });
    const methods = (init.result as Record<string, unknown>).authMethods as Array<{ id: string }>;
    expect(methods.map((m) => m.id)).toEqual(['spycore-login']);

    const newResp = await client.request('session/new', { cwd: workDir, mcpServers: [] });
    expect(newResp.error?.code).toBe(-32000);

    const authFail = await client.request('authenticate', { methodId: 'spycore-login' });
    expect(authFail.error?.code).toBe(-32000);

    authed = true; // user ran `spycore login` out of band
    const authOk = await client.request('authenticate', { methodId: 'spycore-login' });
    expect(authOk.error).toBeUndefined();
    const newOk = await client.request('session/new', { cwd: workDir, mcpServers: [] });
    expect((newOk.result as { sessionId: string }).sessionId).toMatch(/^sess_/);
  });

  test('BYOK-style server (requiresAuth=false) never gates on auth', async () => {
    startServer(new StubProvider([textTurn('answer')]), { requiresAuth: false, authed: () => Promise.resolve(false) });
    const init = await client.request('initialize', { protocolVersion: 1 });
    expect((init.result as Record<string, unknown>).authMethods).toEqual([]);
    const resp = await client.request('session/new', { cwd: workDir, mcpServers: [] });
    expect(resp.error).toBeUndefined();
  });
});

describe('acp session/new validation', () => {
  test('relative cwd → invalid params', async () => {
    startServer(new StubProvider([]));
    const resp = await client.request('session/new', { cwd: 'relative/path', mcpServers: [] });
    expect(resp.error?.code).toBe(-32602);
  });

  test('nonexistent cwd → invalid params', async () => {
    startServer(new StubProvider([]));
    const resp = await client.request('session/new', { cwd: join(workDir, 'nope-missing'), mcpServers: [] });
    expect(resp.error?.code).toBe(-32602);
  });

  test('unknown sessionId on prompt → invalid params', async () => {
    startServer(new StubProvider([]));
    const resp = await client.request('session/prompt', { sessionId: 'sess_ghost', prompt: promptBlocks('hi') });
    expect(resp.error?.code).toBe(-32602);
  });

  test('empty prompt blocks → invalid params', async () => {
    startServer(new StubProvider([]));
    const id = await newSession();
    const resp = await client.request('session/prompt', { sessionId: id, prompt: [] });
    expect(resp.error?.code).toBe(-32602);
  });
});

describe('acp prompt turn — update sequence', () => {
  test('chunk → tool_call(pending) → in_progress → completed → final chunk → end_turn', async () => {
    const provider = new StubProvider([
      nativeToolTurn(
        [{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'hello.txt', content: 'HI\n' }) }],
        'Creating the file now.',
      ),
      textTurn('All done!'),
    ]);
    startServer(provider);
    const sessionId = await newSession();
    const resp = await client.request('session/prompt', { sessionId, prompt: promptBlocks('create hello.txt') });
    expect((resp.result as { stopReason: string }).stopReason).toBe('end_turn');

    const kinds = client.updates.map((u) => `${u.sessionUpdate}${u.status ? `:${u.status}` : ''}`);
    expect(kinds).toEqual([
      // Native mode announces the call EARLY (tool_call_started fires
      // mid-stream, before the turn's consolidated narration block lands).
      'tool_call:pending',
      'agent_message_chunk', // "Creating the file now."
      'tool_call_update:in_progress',
      'tool_call_update:completed',
      'agent_message_chunk', // "All done!"
    ]);

    // The early tool_call announce carries kind; the enriching in_progress
    // update (post-dispatch, args known) carries locations + rawInput.
    const toolCall = client.updates.find((u) => u.sessionUpdate === 'tool_call')!;
    expect(toolCall.kind).toBe('edit');
    const inProgress = client.updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'in_progress')!;
    expect(inProgress.toolCallId).toBe(toolCall.toolCallId);
    expect((inProgress.locations as Array<{ path: string }>)[0]!.path).toBe(join(workDir, 'hello.txt'));
    expect(inProgress.rawInput).toMatchObject({ path: 'hello.txt' });
    const completed = client.updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed')!;
    expect(completed.toolCallId).toBe(toolCall.toolCallId);
    // The write actually happened (permission auto-allowed by the fake client).
    expect(readFileSync(join(workDir, 'hello.txt'), 'utf8')).toBe('HI\n');
    expect(client.permissionRequests).toHaveLength(1);
  });

  test('permission reject-once → tool not executed, update failed, run continues', async () => {
    client?.close();
    const provider = new StubProvider([
      nativeToolTurn([{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'no.txt', content: 'x' }) }]),
      textTurn('Understood, stopping.'),
    ]);
    startServer(provider);
    client.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'reject-once' } });
    const sessionId = await newSession();
    const resp = await client.request('session/prompt', { sessionId, prompt: promptBlocks('write it') });
    expect((resp.result as { stopReason: string }).stopReason).toBe('end_turn');
    expect(existsSync(join(workDir, 'no.txt'))).toBe(false);
    const failed = client.updates.find((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'failed');
    expect(failed).toBeTruthy();
  });

  test('allow-always: session-scoped accept-all — only ONE permission request for two writes', async () => {
    const provider = new StubProvider([
      nativeToolTurn([{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'A' }) }]),
      nativeToolTurn([{ id: 'c2', name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'B' }) }]),
      textTurn('Both written.'),
    ]);
    startServer(provider);
    client.onPermission = () => ({ outcome: { outcome: 'selected', optionId: 'allow-always' } });
    const sessionId = await newSession();
    await client.request('session/prompt', { sessionId, prompt: promptBlocks('write both') });
    expect(existsSync(join(workDir, 'a.txt'))).toBe(true);
    expect(existsSync(join(workDir, 'b.txt'))).toBe(true);
    expect(client.permissionRequests).toHaveLength(1);
  });

  test('client permission failure (method error) → safe default REJECT', async () => {
    const provider = new StubProvider([
      nativeToolTurn([{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'err.txt', content: 'x' }) }]),
      textTurn('ok'),
    ]);
    startServer(provider);
    client.onPermission = (params) => {
      // Simulate a client that errors on request_permission.
      const frame = client.frames.find(
        (f) => f.method === 'session/request_permission' && (f.params as Record<string, unknown>).toolCall === params.toolCall,
      );
      client['toServer'].write(
        `${JSON.stringify({ jsonrpc: '2.0', id: frame!.id, error: { code: -32601, message: 'unsupported' } })}\n`,
      );
      return undefined; // we answered manually with an error
    };
    const sessionId = await newSession();
    await client.request('session/prompt', { sessionId, prompt: promptBlocks('write it') });
    expect(existsSync(join(workDir, 'err.txt'))).toBe(false);
  });

  test('multiple prompts reuse ONE conversation; second prompt continues it', async () => {
    const provider = new StubProvider([textTurn('first answer'), textTurn('second answer')]);
    startServer(provider);
    const sessionId = await newSession();
    await client.request('session/prompt', { sessionId, prompt: promptBlocks('first') });
    await client.request('session/prompt', { sessionId, prompt: promptBlocks('second') });
    expect(provider.createCount).toBe(1);
    expect(provider.calls[1]!.conversationId).toBe('cnv_stub_1');
    expect(provider.calls[1]!.message).toContain('second');
    expect(provider.calls[1]!.system).toBeUndefined(); // continuation — no system prompt
  });

  test('concurrent prompt on the same session is rejected', async () => {
    const provider = new StubProvider([]);
    provider.hangOnTurn = 0;
    startServer(provider);
    const sessionId = await newSession();
    const first = client.request('session/prompt', { sessionId, prompt: promptBlocks('long task') });
    await new Promise((r) => setTimeout(r, 50));
    const second = await client.request('session/prompt', { sessionId, prompt: promptBlocks('again') });
    expect(second.error?.message).toMatch(/already running/i);
    client.notify('session/cancel', { sessionId });
    const firstResp = await first;
    expect((firstResp.result as { stopReason: string }).stopReason).toBe('cancelled');
  });
});

describe('acp cancellation', () => {
  test('cancel during a pending permission: permission resolves cancelled, prompt → cancelled, tool terminal', async () => {
    const provider = new StubProvider([
      nativeToolTurn([{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'c.txt', content: 'x' }) }]),
      textTurn('never reached'),
    ]);
    startServer(provider);
    const sessionId = await newSession();
    // Client holds the permission unanswered, then cancels and answers
    // cancelled (the spec-mandated client behavior).
    client.onPermission = () => {
      setTimeout(() => {
        client.notify('session/cancel', { sessionId });
        const frame = client.frames.find((f) => f.method === 'session/request_permission');
        client.respondToPermission(frame!.id as number, { outcome: { outcome: 'cancelled' } });
      }, 30);
      return undefined; // answered later, manually
    };
    const resp = await client.request('session/prompt', { sessionId, prompt: promptBlocks('write c.txt') });
    expect((resp.result as { stopReason: string }).stopReason).toBe('cancelled');
    expect(existsSync(join(workDir, 'c.txt'))).toBe(false);
    // The in-flight tool call got a terminal status.
    const last = client.updates.filter((u) => u.sessionUpdate === 'tool_call_update').at(-1)!;
    expect(['failed', 'completed']).toContain(last.status);
    // The session is reusable afterwards (no orphan running state).
    const again = await client.request('session/prompt', { sessionId, prompt: promptBlocks('hello again') });
    expect((again.result as { stopReason: string }).stopReason).toBe('end_turn');
  });

  test('belt-and-suspenders: cancel with a client that NEVER answers the permission still resolves cancelled', async () => {
    const provider = new StubProvider([
      nativeToolTurn([{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'd.txt', content: 'x' }) }]),
    ]);
    startServer(provider);
    const sessionId = await newSession();
    client.onPermission = () => {
      setTimeout(() => client.notify('session/cancel', { sessionId }), 30);
      return undefined; // never answered — the abort race must unstick us
    };
    const resp = await client.request('session/prompt', { sessionId, prompt: promptBlocks('write d.txt') });
    expect((resp.result as { stopReason: string }).stopReason).toBe('cancelled');
    expect(existsSync(join(workDir, 'd.txt'))).toBe(false);
  });
});

describe('acp wire hygiene', () => {
  test('every server frame is valid JSON-RPC 2.0 (stdout purity of the protocol stream)', async () => {
    const provider = new StubProvider([
      nativeToolTurn([{ id: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'x.txt' }) }]),
      textTurn('done'),
    ]);
    startServer(provider);
    const sessionId = await newSession();
    await client.request('session/prompt', { sessionId, prompt: promptBlocks('read x') });
    expect(client.rawLines.length).toBeGreaterThan(3);
    for (const line of client.rawLines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed.jsonrpc).toBe('2.0');
    }
  });

  test('unknown method → -32601', async () => {
    startServer(new StubProvider([]));
    const resp = await client.request('session/load', { sessionId: 'x' });
    expect(resp.error?.code).toBe(-32601);
  });
});
