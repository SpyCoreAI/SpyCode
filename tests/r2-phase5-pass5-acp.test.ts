import { afterEach, beforeEach, describe, expect, test, vi, type MockInstance } from 'vitest';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { JsonRpcEndpoint } from '../src/lib/acp/jsonrpc.js';
import { AcpAgentServer } from '../src/lib/acp/server.js';
import type { Provider, ProviderEvent, StreamChatParams, CreateConversationParams } from '../src/lib/providers/types.js';

/**
 * Phase 5 pass 5, R2-16 (ACP permission bridge labels the approval with the
 * wrong tool call) regressions.
 *
 * Each test was written against the FIXED behaviour and fails on the pre-fix
 * tree for the reason named in its comment (verified by stashing the fix -
 * see the fix log); nothing here pins the old buggy shape.
 *
 * Harness copied from tests/acp.test.ts (FakeAcpClient + StubProvider),
 * extended with a toolProtocol parameter so the fenced shape can be driven.
 */

type PermissionResponder = (params: Record<string, unknown>) => Promise<unknown> | unknown;

class FakeAcpClient {
  readonly toServer = new PassThrough();
  readonly fromServer = new PassThrough();
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
    if (typeof msg.id === 'number' && this.pending.has(msg.id) && !('method' in msg)) {
      const resolve = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      resolve(msg as { result?: unknown; error?: { code: number; message: string } });
      return;
    }
    if (msg.method === 'session/update' && !('id' in msg)) {
      const params = msg.params as Record<string, unknown>;
      this.updates.push(params.update as Record<string, unknown>);
      return;
    }
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      const params = msg.params as Record<string, unknown>;
      this.permissionRequests.push(params);
      void Promise.resolve(this.onPermission(params)).then((result) => {
        if (result === undefined) return;
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

  close(): void {
    this.toServer.end();
  }
}

const usageDone: ProviderEvent[] = [{ type: 'usage', input: 1, output: 1 }, { type: 'done' }];
const textTurn = (text: string): ProviderEvent[] => [{ type: 'text', text }, ...usageDone];
const fenced = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

class StubProvider implements Provider {
  readonly id = 'spycore' as const;
  private turn = 0;
  constructor(
    private readonly capable: boolean,
    private readonly scripts: ProviderEvent[][],
  ) {}
  createConversation(_p: CreateConversationParams): Promise<string> {
    return Promise.resolve('cnv_stub');
  }
  supportsNativeTools(): boolean {
    return this.capable;
  }
  async *streamChat(_params: StreamChatParams): AsyncIterable<ProviderEvent> {
    const evs = this.scripts[this.turn++] ?? textTurn('fallback final');
    for (const e of evs) yield e;
  }
}

let workDir: string;
let client: FakeAcpClient;
let endpointDone: Promise<void>;
let stdoutSpy: MockInstance<typeof process.stdout.write>;

function startServer(provider: Provider, toolProtocol: 'auto' | 'native' | 'fenced'): void {
  client = new FakeAcpClient();
  const endpoint = new JsonRpcEndpoint(client.toServer, client.fromServer);
  new AcpAgentServer({
    endpoint,
    provider,
    model: 'styx',
    toolProtocol,
    requiresSpycoreAuth: false,
    isAuthenticated: () => Promise.resolve(true),
    agentVersion: '0.0.0-test',
    commandTimeoutMs: 10_000,
    maxTurns: 10,
  });
  endpointDone = endpoint.start();
}

beforeEach(() => {
  freshConfigDir();
  workDir = mkdtempSync(join(tmpdir(), 'spycli-r2p5-acp-'));
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  client?.close();
  await endpointDone?.catch(() => {});
  const calls = stdoutSpy.mock.calls.length;
  stdoutSpy.mockRestore();
  expect(calls).toBe(0);
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

const toolCallOf = (p: Record<string, unknown>): Record<string, unknown> =>
  p.toolCall as Record<string, unknown>;

describe('R2-16 ACP permission requests carry the dispatching call id', () => {
  test('fenced single write: the permission names the id the tool_call update will carry', { timeout: 60_000 }, async () => {
    const provider = new StubProvider(false, [
      [{ type: 'text', text: fenced('write_file', { path: 'hello.txt', content: 'HI\n' }) }, ...usageDone],
      textTurn('Done.'),
    ]);
    startServer(provider, 'fenced');
    const sessionId = await newSession();
    const resp = await client.request('session/prompt', { sessionId, prompt: promptBlocks('create hello.txt') });
    expect((resp.result as { stopReason: string }).stopReason).toBe('end_turn');
    expect(client.permissionRequests).toHaveLength(1);
    const toolCall = toolCallOf(client.permissionRequests[0]!);
    // Pre-fix this was a fresh random `call_<8 hex>` id the client had
    // never been sent a tool_call update for (serial dispatch approves
    // before it announces, so currentTool was still null).
    expect(toolCall.toolCallId).toBe('call_t1_0');
    expect(toolCall.title).toBe('write_file: hello.txt');
    expect(toolCall.kind).toBe('edit');
    const announced = client.updates
      .filter((u) => u.sessionUpdate === 'tool_call')
      .map((u) => u.toolCallId as string);
    expect(announced).toEqual(['call_t1_0']);
    expect(announced).toContain(toolCall.toolCallId);
    // The approval still routes to the right call: the file was written.
    expect(readFileSync(join(workDir, 'hello.txt'), 'utf8')).toBe('HI\n');
  });

  test('native two-call turn: permission ids match the announced ids, in order, each call announced once', { timeout: 60_000 }, async () => {
    const calls = [
      { id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'A' }) },
      { id: 'c2', name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'B' }) },
    ];
    const provider = new StubProvider(true, [
      [
        { type: 'tool_call_started', index: 0, name: 'write_file' },
        { type: 'tool_call_started', index: 1, name: 'write_file' },
        { type: 'tool_calls', calls },
        ...usageDone,
      ],
      textTurn('Done.'),
    ]);
    startServer(provider, 'native');
    const sessionId = await newSession();
    const resp = await client.request('session/prompt', { sessionId, prompt: promptBlocks('write a and b') });
    expect((resp.result as { stopReason: string }).stopReason).toBe('end_turn');
    expect(client.permissionRequests).toHaveLength(2);
    // Pre-fix the ids were SWAPPED (['call_t1_1', 'call_t1_0']): the bridge
    // read currentTool, which ends as the LAST streamed tool_call_started.
    const perm = client.permissionRequests.map((p) => toolCallOf(p));
    expect(perm.map((t) => t.toolCallId)).toEqual(['call_t1_0', 'call_t1_1']);
    // Id and title stay paired: the prompt for call 0 is about a.txt.
    expect(perm.map((t) => t.title)).toEqual(['write_file: a.txt', 'write_file: b.txt']);
    const announced = client.updates
      .filter((u) => u.sessionUpdate === 'tool_call')
      .map((u) => u.toolCallId as string);
    // Pre-fix each call was announced TWICE (once from tool_call_started,
    // once from tool_call, because the dedup check never matched).
    expect(announced).toEqual(['call_t1_0', 'call_t1_1']);
    // Completion updates track the same ids, in dispatch order.
    const completed = client.updates
      .filter((u) => u.sessionUpdate === 'tool_call_update' && u.status === 'completed')
      .map((u) => u.toolCallId as string);
    expect(completed).toEqual(['call_t1_0', 'call_t1_1']);
    expect(readFileSync(join(workDir, 'a.txt'), 'utf8')).toBe('A');
    expect(readFileSync(join(workDir, 'b.txt'), 'utf8')).toBe('B');
  });
});
