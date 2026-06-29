import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import type {
  Provider,
  ProviderEvent,
  StreamChatParams,
  CreateConversationParams,
} from '../src/lib/providers/types.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';

const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });
const REJECT: RequestApproval = () => Promise.resolve({ approved: false, reason: 'rejected by user' });

const fenced = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

// ─────────────────────── Part B: loop behavior (StubProvider) ───────────────────────

/** A scripted provider that records every streamChat call and yields canned events. */
class StubProvider implements Provider {
  readonly id: 'spycore' | 'openai';
  readonly calls: StreamChatParams[] = [];
  readonly systems: string[] = [];
  private turn = 0;
  constructor(
    id: 'spycore' | 'openai',
    private readonly capable: boolean,
    private readonly scripts: ProviderEvent[][],
  ) {
    this.id = id;
  }
  createConversation(_p: CreateConversationParams): Promise<string> {
    return Promise.resolve('cnv_stub');
  }
  supportsNativeTools(): boolean {
    return this.capable;
  }
  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    this.calls.push(params);
    if (params.system) this.systems.push(params.system);
    const evs = this.scripts[this.turn++] ?? [
      { type: 'text', text: 'fallback final' },
      { type: 'usage', input: 1, output: 1 },
      { type: 'done' },
    ];
    for (const e of evs) yield e;
  }
}

const usageDone: ProviderEvent[] = [{ type: 'usage', input: 1, output: 1 }, { type: 'done' }];
const toolTurn = (calls: Array<{ id: string; name: string; arguments: string }>): ProviderEvent[] => [
  { type: 'tool_call_started', index: 0, name: calls[0]!.name },
  { type: 'tool_calls', calls },
  ...usageDone,
];
const textTurn = (text: string): ProviderEvent[] => [{ type: 'text', text }, ...usageDone];

let workDir: string;
beforeEach(() => {
  freshConfigDir();
  workDir = mkdtempSync(join(tmpdir(), 'spycli-native-'));
});
afterEach(() => {
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('runAgent — native mode (capability-gated)', () => {
  test('capable server: declares tools, drops fenced wire instructions, runs a tool then finishes', async () => {
    writeFileSync(join(workDir, 'data.txt'), 'hello agent');
    const provider = new StubProvider('spycore', true, [
      toolTurn([{ id: 'c1', name: 'read_file', arguments: '{"path":"data.txt"}' }]),
      textTurn('The file says hello.'),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'read it', cwd: workDir, provider, requestApproval: ACCEPT, onEvent: (e) => events.push(e) });

    // system prompt has NO fenced wire instructions
    expect(provider.systems[0]).not.toContain('spycore:tool');
    expect(provider.systems[0]).toContain('native tool-calling');
    // turn 1 declared tools incl. read_file with a mapped JSON schema
    const tools = provider.calls[0]!.tools!;
    const readFile = tools.find((t) => t.name === 'read_file')!;
    expect(readFile.parameters).toMatchObject({ type: 'object', properties: { path: { type: 'string' } }, required: ['path'] });
    expect(tools.some((t) => t.name === 'write_file')).toBe(true);
    expect(tools.some((t) => t.name === 'load_skill')).toBe(true);
    // the tool ran and the result fed back
    expect(result.toolCalls).toBe(1);
    expect(result.finalText).toContain('hello');
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'read_file', ok: true });
    expect(events.some((e) => e.type === 'tool_call_started')).toBe(true);
  });

  test('toolResults continuation: 2nd turn sends toolResults and an empty message (no user text)', async () => {
    writeFileSync(join(workDir, 'data.txt'), 'hi');
    const provider = new StubProvider('spycore', true, [
      toolTurn([{ id: 'c1', name: 'read_file', arguments: '{"path":"data.txt"}' }]),
      textTurn('done'),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({ task: 't', cwd: workDir, provider, requestApproval: ACCEPT });
    const cont = provider.calls[1]!;
    expect(cont.message).toBe('');
    expect(cont.toolResults).toHaveLength(1);
    expect(cont.toolResults![0]).toMatchObject({ id: 'c1', name: 'read_file' });
    expect(cont.toolResults![0]!.content).toContain('hi');
    // tools are re-declared every turn
    expect(cont.tools && cont.tools.length).toBeGreaterThan(0);
  });

  test('approval honored: a rejected write is NOT applied and an error result feeds back', async () => {
    const provider = new StubProvider('spycore', true, [
      toolTurn([{ id: 'c1', name: 'write_file', arguments: '{"path":"out.txt","content":"x"}' }]),
      textTurn('ok stopping'),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({ task: 'w', cwd: workDir, provider, requestApproval: REJECT, onEvent: (e) => events.push(e) });
    expect(existsSync(join(workDir, 'out.txt'))).toBe(false);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'write_file', ok: false, kind: 'rejected' });
    // the rejection rode back as the tool result content
    expect(provider.calls[1]!.toolResults![0]!.content).toMatch(/not applied|rejected/i);
  });

  test('--yes / accept-all: a write is applied natively', async () => {
    const provider = new StubProvider('spycore', true, [
      toolTurn([{ id: 'c1', name: 'write_file', arguments: '{"path":"y.txt","content":"yes\\n"}' }]),
      textTurn('done'),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({ task: 'w', cwd: workDir, provider, requestApproval: ACCEPT });
    expect(readFileSync(join(workDir, 'y.txt'), 'utf8')).toBe('yes\n');
  });

  test('malformed arguments feed an error result back instead of crashing', async () => {
    const provider = new StubProvider('spycore', true, [
      toolTurn([{ id: 'c1', name: 'read_file', arguments: '{not valid json' }]),
      textTurn('recovered'),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 't', cwd: workDir, provider, requestApproval: ACCEPT, onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'read_file', ok: false });
    expect(provider.calls[1]!.toolResults![0]!.content).toMatch(/not valid JSON/i);
    expect(result.finalText).toContain('recovered');
  });

  test('parallel calls dispatch sequentially in index order', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'AAA');
    writeFileSync(join(workDir, 'b.txt'), 'BBB');
    const provider = new StubProvider('spycore', true, [
      toolTurn([
        { id: 'c0', name: 'read_file', arguments: '{"path":"a.txt"}' },
        { id: 'c1', name: 'read_file', arguments: '{"path":"b.txt"}' },
      ]),
      textTurn('done'),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({ task: 't', cwd: workDir, provider, requestApproval: ACCEPT, onEvent: (e) => events.push(e) });
    const calls = events.filter((e) => e.type === 'tool_call') as Array<{ index: number }>;
    expect(calls.map((c) => c.index)).toEqual([0, 1]);
    const results = provider.calls[1]!.toolResults!;
    expect(results.map((r) => r.id)).toEqual(['c0', 'c1']);
    expect(results[0]!.content).toContain('AAA');
    expect(results[1]!.content).toContain('BBB');
  });

  test('plan mode declares ONLY read-only tools; execute re-declares the full set', async () => {
    const planProvider = new StubProvider('spycore', true, [textTurn('1. read files\n2. edit')]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({ task: 'plan', cwd: workDir, provider: planProvider, planMode: true, requestApproval: ACCEPT });
    const planTools = planProvider.calls[0]!.tools!.map((t) => t.name);
    expect(planTools).toContain('read_file');
    expect(planTools).not.toContain('write_file');
    expect(planTools).not.toContain('run_command');

    const execProvider = new StubProvider('spycore', true, [textTurn('done')]);
    await runAgent({ task: 'do', cwd: workDir, provider: execProvider, planMode: false, requestApproval: ACCEPT });
    const execTools = execProvider.calls[0]!.tools!.map((t) => t.name);
    expect(execTools).toContain('write_file');
    expect(execTools).toContain('run_command');
  });

  test('text-final with no tool call ends the run immediately', async () => {
    const provider = new StubProvider('spycore', true, [textTurn('Just an answer.')]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const result = await runAgent({ task: 'q', cwd: workDir, provider, requestApproval: ACCEPT });
    expect(result.finalText).toBe('Just an answer.');
    expect(result.toolCalls).toBe(0);
    expect(provider.calls).toHaveLength(1);
  });

  test('budget counts a native tool turn as a turn', async () => {
    const provider = new StubProvider('spycore', true, [
      toolTurn([{ id: 'c1', name: 'read_file', arguments: '{"path":"x"}' }]),
      textTurn('done'),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const result = await runAgent({ task: 't', cwd: workDir, provider, requestApproval: ACCEPT });
    expect(result.turns).toBe(2);
  });

  test('an EMPTY turn (no text, no tool calls) is nudged once, not accepted as final', async () => {
    // The release-bench S2 class: the backing model returned an empty
    // completion mid-run and the loop ended "final" with the task half-done.
    const provider = new StubProvider('spycore', true, [
      [...usageDone], // empty turn: done with no text and no tool calls
      textTurn('Recovered and finished.'),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 't', cwd: workDir, provider, requestApproval: ACCEPT, onEvent: (e) => events.push(e) });
    expect(result.finalText).toBe('Recovered and finished.');
    expect(result.turns).toBe(2);
    // The nudge was delivered as the next user message.
    expect(provider.calls[1]!.message).toMatch(/reply was empty/i);
    expect(events.some((e) => e.type === 'parse_error' && /empty reply/.test(e.message))).toBe(true);
  });

  test('two consecutive EMPTY turns end the run as before (single retry only)', async () => {
    const provider = new StubProvider('spycore', true, [[...usageDone], [...usageDone]]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const result = await runAgent({ task: 't', cwd: workDir, provider, requestApproval: ACCEPT });
    expect(result.finalText).toBe('');
    expect(result.turns).toBe(2);
    expect(provider.calls).toHaveLength(2);
  });
});

describe('runAgent — protocol gating', () => {
  test('old server (no capability) → fenced; system prompt keeps the fenced wire', async () => {
    writeFileSync(join(workDir, 'd.txt'), 'hi');
    const provider = new StubProvider('spycore', false, [
      textTurn(`reading\n${fenced('read_file', { path: 'd.txt' })}`),
      textTurn('done'),
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 't', cwd: workDir, provider, requestApproval: ACCEPT, onEvent: (e) => events.push(e) });
    expect(provider.systems[0]).toContain('spycore:tool'); // fenced wire present
    expect(provider.calls[0]!.tools).toBeUndefined(); // no native tools sent
    expect(result.toolCalls).toBe(1);
    // fenced feedback is a text message, not toolResults
    expect(provider.calls[1]!.toolResults).toBeUndefined();
    expect(provider.calls[1]!.message).toContain('TOOL RESULTS');
  });

  test('--tool-protocol fenced forces fenced even on a capable server', async () => {
    const provider = new StubProvider('spycore', true, [textTurn('answer')]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({ task: 't', cwd: workDir, provider, requestApproval: ACCEPT, toolProtocol: 'fenced' });
    expect(provider.systems[0]).toContain('spycore:tool');
    expect(provider.calls[0]!.tools).toBeUndefined();
  });

  test('--tool-protocol native against a non-capable server errors clearly', async () => {
    const provider = new StubProvider('spycore', false, [textTurn('x')]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await expect(
      runAgent({ task: 't', cwd: workDir, provider, requestApproval: ACCEPT, toolProtocol: 'native' }),
    ).rejects.toThrow(/native tool-use is not available/i);
  });

  test('BYOK provider stays fenced even with auto', async () => {
    const provider = new StubProvider('openai', true /* ignored: id!==spycore */, [textTurn('answer')]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({ task: 't', cwd: workDir, provider, requestApproval: ACCEPT });
    expect(provider.systems[0]).toContain('spycore:tool');
    expect(provider.calls[0]!.tools).toBeUndefined();
  });

  test('verify continuation runs in the same (native) mode', async () => {
    // A continuation (conversationId set) on a capable spycore provider must
    // still be native — tools declared, no fenced wire.
    const provider = new StubProvider('spycore', true, [textTurn('fixed it')]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({
      task: 't',
      cwd: workDir,
      provider,
      requestApproval: ACCEPT,
      conversationId: 'cnv_existing',
      continueMessage: 'verification failed; fix it',
    });
    // continuation sends the new message (system already delivered earlier) +
    // declares tools natively.
    expect(provider.calls[0]!.tools && provider.calls[0]!.tools.length).toBeGreaterThan(0);
    expect(provider.calls[0]!.message).toContain('verification failed');
  });
});

// ─────────────────────── schema mapping (unit) ───────────────────────

describe('buildToolDeclarations', () => {
  test('maps built-in scalar params to JSON Schema and respects readOnlyOnly', async () => {
    const { buildToolDeclarations } = await import('../src/lib/agent/tools.js');
    const all = buildToolDeclarations();
    const readFile = all.find((t) => t.name === 'read_file')!;
    expect(readFile.parameters).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
      required: ['path'],
    });
    expect(all.some((t) => t.name === 'write_file')).toBe(true);

    const readOnly = buildToolDeclarations({ readOnlyOnly: true }).map((t) => t.name);
    expect(readOnly).toContain('read_file');
    expect(readOnly).not.toContain('write_file');
    expect(readOnly).not.toContain('run_command');
  });

  test('passes an MCP tool through with its real JSON schema and excludes it in plan mode', async () => {
    const { buildToolDeclarations } = await import('../src/lib/agent/tools.js');
    const mcpSchema = { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] };
    const extraTools = new Map([
      [
        'mcp__weather__get',
        {
          name: 'mcp__weather__get',
          description: 'weather',
          parameters: { type: 'object' as const, properties: {} },
          jsonSchema: mcpSchema,
          mutating: true,
          externalArgs: true,
          execute: async () => ({ ok: true, summary: '', content: '' }),
        },
      ],
    ]);
    const decls = buildToolDeclarations({ extraTools });
    const mcp = decls.find((t) => t.name === 'mcp__weather__get')!;
    expect(mcp.parameters).toEqual(mcpSchema);
    // plan mode excludes MCP (all mutating)
    expect(buildToolDeclarations({ readOnlyOnly: true, extraTools }).some((t) => t.name === 'mcp__weather__get')).toBe(false);
  });

  test('drops a tool whose name violates the server charset', async () => {
    const { buildToolDeclarations } = await import('../src/lib/agent/tools.js');
    const extraTools = new Map([
      [
        'mcp__srv__bad.name',
        {
          name: 'mcp__srv__bad.name',
          description: 'd',
          parameters: { type: 'object' as const, properties: {} },
          jsonSchema: { type: 'object' },
          mutating: true,
          externalArgs: true,
          execute: async () => ({ ok: true, summary: '', content: '' }),
        },
      ],
    ]);
    expect(buildToolDeclarations({ extraTools }).some((t) => t.name === 'mcp__srv__bad.name')).toBe(false);
  });
});
