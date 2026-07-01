import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshConfigDir } from './helpers.js';
import { runAgent, type AgentEvent } from '../src/lib/agent/loop.js';
import { writeScope } from '../src/lib/agent/mcp-config.js';
import { isWorkspaceTrusted, trustWorkspace } from '../src/lib/config.js';
import type { Provider, ProviderEvent, StreamChatParams } from '../src/lib/providers/types.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/mcp-echo-server.mjs', import.meta.url));
const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });

const block = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

/** A scripted provider that records the system prompt it is handed on turn 1. */
class StubProvider implements Provider {
  readonly id = 'openai' as const;
  systems: string[] = [];
  private turn = 0;
  constructor(private readonly replies: string[]) {}
  createConversation(): Promise<string> {
    return Promise.resolve('cnv_stub');
  }
  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    if (params.system !== undefined) this.systems.push(params.system);
    const reply = this.replies[this.turn++] ?? 'Done.';
    yield { type: 'text', text: reply };
    yield { type: 'usage', input: 1, output: 1 };
    yield { type: 'done' };
  }
}

let cwd: string;

beforeEach(() => {
  freshConfigDir();
  cwd = mkdtempSync(join(tmpdir(), 'spycli-mcp-loop-'));
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

describe('runAgent + MCP bridging', () => {
  test('zero config: no MCP section in the system prompt (wire-pinned)', async () => {
    const provider = new StubProvider(['This is the answer.']);
    await runAgent({ task: 'hello', cwd, provider, requestApproval: ACCEPT });
    expect(provider.systems).toHaveLength(1);
    expect(provider.systems[0]).toContain('# Tools');
    expect(provider.systems[0]).not.toContain('# MCP tools');
    expect(provider.systems[0]).not.toContain('mcp__');
  });

  test('the model calls an MCP tool end-to-end; catalog appears in the prompt', async () => {
    writeScope('project', cwd, [{ name: 'fix', command: process.execPath, args: [FIXTURE] }]);
    trustWorkspace(cwd); // trusted dev workspace — gate covered separately below
    const provider = new StubProvider([block('mcp__fix__echo', { text: 'loop-mcp' }), 'All done.']);
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'use the echo tool',
      cwd,
      provider,
      requestApproval: ACCEPT,
      onEvent: (e) => events.push(e),
    });

    // Prompt carried the MCP catalog.
    expect(provider.systems[0]).toContain('# MCP tools');
    expect(provider.systems[0]).toContain('mcp__fix__echo');

    // The tool actually ran through tools/call and returned the echoed text.
    const res = events.find((e) => e.type === 'tool_result');
    expect(res).toMatchObject({ tool: 'mcp__fix__echo', ok: true });
    expect(result.toolCalls).toBe(1);
    expect(result.finalText).toContain('All done.');

    // A ready summary was emitted.
    expect(events.some((e) => e.type === 'mcp_notice')).toBe(true);
  }, 15000);

  test('plan mode does NOT bridge MCP (mutating tools are blocked there)', async () => {
    writeScope('project', cwd, [{ name: 'fix', command: process.execPath, args: [FIXTURE] }]);
    const provider = new StubProvider(['1. Do the thing.']);
    await runAgent({ task: 'plan it', cwd, provider, planMode: true, requestApproval: ACCEPT });
    expect(provider.systems[0]).not.toContain('# MCP tools');
  });

  test('CL1: untrusted workspace with NO trust resolver skips project MCP (no catalog, warning)', async () => {
    writeScope('project', cwd, [{ name: 'fix', command: process.execPath, args: [FIXTURE] }]);
    const provider = new StubProvider(['Done.']);
    const events: AgentEvent[] = [];
    await runAgent({
      task: 'use the echo tool',
      cwd,
      provider,
      requestApproval: ACCEPT,
      // No confirmProjectMcpTrust → headless → fail closed.
      onEvent: (e) => events.push(e),
    });
    // The project server was NOT bridged.
    expect(provider.systems[0]).not.toContain('# MCP tools');
    expect(provider.systems[0]).not.toContain('mcp__fix__echo');
    // A warn-level notice explained the skip, and trust was NOT auto-granted.
    expect(
      events.some((e) => e.type === 'mcp_notice' && e.level === 'warn' && /trust/i.test(e.text)),
    ).toBe(true);
    expect(isWorkspaceTrusted(cwd)).toBe(false);
  }, 15000);

  test('CL1: an interactive grant bridges project MCP and persists trust', async () => {
    writeScope('project', cwd, [{ name: 'fix', command: process.execPath, args: [FIXTURE] }]);
    const provider = new StubProvider([block('mcp__fix__echo', { text: 'trusted' }), 'All done.']);
    const result = await runAgent({
      task: 'use the echo tool',
      cwd,
      provider,
      requestApproval: ACCEPT,
      confirmProjectMcpTrust: async () => true,
    });
    expect(provider.systems[0]).toContain('mcp__fix__echo');
    expect(result.toolCalls).toBe(1);
    expect(isWorkspaceTrusted(cwd)).toBe(true);
  }, 15000);
});
