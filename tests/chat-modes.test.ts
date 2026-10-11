import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import type { Provider, ProviderEvent, StreamChatParams } from '../src/lib/providers/types.js';
import type { ApprovalRequest } from '../src/lib/agent/approval.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';
import type { ChatAgentIo } from '../src/lib/chat-agent-run.js';

/**
 * PLAN / ASK / AGENT modes - PHASE-1 1.7.
 *
 * Pinned here:
 *  - STRUCTURAL per-mode policy: in plan mode the write/exec set (and every
 *    MCP tool) is absent from the prompt catalogue AND the native
 *    declarations, and a guessed mutating call hard-errors at dispatch
 *    BEFORE executing; ask never reaches an agent loop at all (the run core
 *    runtime-rejects it - the plain chat contract has no tool registry);
 *  - plan→agent handoff runs through the REAL runAgent path and approval
 *    pre-approves NOTHING: every write still prompts, reject blocks it,
 *    accept_all is the user's own controller semantics;
 *  - /mode registry outcomes + the cycle helper + the mid-run switch policy;
 *  - hooks fire identically in plan/agent modes (prompt-submit gates the run
 *    core; pre-tool rides the same dispatch bridge);
 *  - checkpoint/resume rules are the unchanged 1.4 rules (spot-pins).
 */

const block = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

class StubProvider implements Provider {
  readonly id = 'openai' as const;
  params: StreamChatParams[] = [];
  private turn = 0;
  constructor(private readonly replies: string[]) {}
  createConversation(): Promise<string> {
    return Promise.resolve('cnv_stub');
  }
  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    this.params.push(params);
    const reply = this.replies[this.turn++] ?? 'Done.';
    yield { type: 'text', text: reply };
    yield { type: 'usage', input: 1, output: 1 };
    yield { type: 'done' };
  }
}

let configDir: string;
let cwd: string;

beforeEach(() => {
  configDir = freshConfigDir();
  cwd = mkdtempSync(join(tmpdir(), 'spycli-modes-'));
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

interface IoHarness {
  notices: Array<{ kind: string; text: string }>;
  events: AgentEvent[];
  plans: string[];
  approvals: ApprovalRequest[];
  io: ChatAgentIo;
}

function fakeIo(overrides: Partial<ChatAgentIo> = {}): IoHarness {
  const notices: Array<{ kind: string; text: string }> = [];
  const events: AgentEvent[] = [];
  const plans: string[] = [];
  const approvals: ApprovalRequest[] = [];
  return {
    notices,
    events,
    plans,
    approvals,
    io: {
      notify: (kind, text) => void notices.push({ kind, text }),
      renderEvent: (e) => void events.push(e),
      presentPlan: (p) => void plans.push(p),
      ask: async () => 'c',
      readText: async () => '',
      requestApproval: async (req) => {
        approvals.push(req);
        return 'reject';
      },
      ...overrides,
    },
  };
}

// ───────────────────── structural per-mode tool policy ─────────────────────

describe('structural policy - plan/ask registries', () => {
  const WRITE_TOOLS = ['write_file', 'edit_file', 'run_command'];

  test('plan-mode prompt catalogue: no write/exec tool is described', async () => {
    const { describeToolsForPrompt } = await import('../src/lib/agent/tools.js');
    const readOnly = describeToolsForPrompt({ readOnlyOnly: true, webEnabled: true });
    for (const t of WRITE_TOOLS) expect(readOnly).not.toContain(t);
    expect(readOnly).toContain('read_file');
    expect(readOnly).toContain('web_search');
    const full = describeToolsForPrompt({ webEnabled: true });
    for (const t of WRITE_TOOLS) expect(full).toContain(t);
  });

  test('plan-mode declarations: write/exec AND every MCP tool are unregistered', async () => {
    const { buildToolDeclarations } = await import('../src/lib/agent/tools.js');
    const fakeMcp = new Map([
      [
        'mcp__srv__do',
        {
          name: 'mcp__srv__do',
          description: 'x',
          mutating: true,
          externalArgs: true,
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ ok: true, summary: '', content: '' }),
        },
      ],
    ]);
    const readOnly = buildToolDeclarations({
      readOnlyOnly: true,
      webEnabled: true,
      extraTools: fakeMcp as never,
    }).map((d) => d.name);
    for (const t of WRITE_TOOLS) expect(readOnly).not.toContain(t);
    expect(readOnly.some((n) => n.startsWith('mcp__'))).toBe(false);
    expect(readOnly).toContain('read_file');
    const full = buildToolDeclarations({
      webEnabled: true,
      extraTools: fakeMcp as never,
    }).map((d) => d.name);
    for (const t of WRITE_TOOLS) expect(full).toContain(t);
    expect(full).toContain('mcp__srv__do');
  });

  test('plan-mode dispatch hard-errors a guessed mutating call BEFORE it executes', async () => {
    const { dispatchTool, DEFAULT_LIMITS } = await import('../src/lib/agent/tools.js');
    const r = await dispatchTool(
      'write_file',
      { path: 'nope.txt', content: 'x' },
      {
        cwd,
        limits: DEFAULT_LIMITS,
        planMode: true,
        requestApproval: () => Promise.resolve({ approved: true }),
      },
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain('disabled in planning mode');
    expect(existsSync(join(cwd, 'nope.txt'))).toBe(false);
  });

  test('plan run E2E: read-only system prompt, mutating call rejected, nothing written', async () => {
    const provider = new StubProvider([
      block('write_file', { path: 'sneaky.txt', content: 'x' }),
      'PLAN: 1. Write sneaky.txt',
    ]);
    const h = fakeIo({ ask: async () => 'c' }); // discard the plan
    const { runChatAgentTurn } = await import('../src/lib/chat-agent-run.js');
    const result = await runChatAgentTurn({
      cwd,
      task: 'do the thing',
      mode: 'plan',
      model: 'hermes',
      provider,
      io: h.io,
    });
    expect(result.completed).toBe(false); // plan discarded
    expect(existsSync(join(cwd, 'sneaky.txt'))).toBe(false);
    // Structural prompt pin: the plan-phase system prompt CATALOGUES only the
    // read-only set - the write tools' descriptions are absent (the prompt
    // deliberately NAMES them once, in the "DISABLED" notice), and the
    // disabled notice is present.
    const planSystem = provider.params[0]?.system ?? '';
    expect(planSystem).toContain('Read-only tools (planning phase)');
    expect(planSystem).toContain('are DISABLED and will return an error');
    expect(planSystem).not.toContain('Create a new file or overwrite an existing one');
    expect(planSystem).not.toContain('Run a shell command in the working directory');
    // The guessed call bounced off the dispatch guard.
    expect(provider.params[1]?.message).toContain('disabled in planning mode');
    // Cancel = nothing executed: exactly the two plan-phase turns ran.
    expect(provider.params).toHaveLength(2);
    expect(h.notices.some((n) => n.text.includes('Plan discarded'))).toBe(true);
  });

  test('ask never reaches an agent loop: the run core runtime-rejects it', async () => {
    const provider = new StubProvider(['should never be called']);
    const h = fakeIo();
    const { runChatAgentTurn } = await import('../src/lib/chat-agent-run.js');
    const result = await runChatAgentTurn({
      cwd,
      task: 't',
      mode: 'ask' as never,
      model: 'hermes',
      provider,
      io: h.io,
    });
    expect(result.completed).toBe(false);
    expect(provider.params).toHaveLength(0);
    expect(h.notices.some((n) => n.kind === 'error' && n.text.includes('Ask mode'))).toBe(true);
  });
});

// ───────────────────── plan → agent handoff mechanics ──────────────────────

describe('plan → agent handoff (the existing runAgent path)', () => {
  test('plan approval pre-approves NOTHING: the execute write still prompts; reject blocks it', async () => {
    const provider = new StubProvider([
      'PLAN: 1. Create hello.txt',
      block('write_file', { path: 'hello.txt', content: 'hi\n' }),
      'Done.',
    ]);
    const h = fakeIo({
      ask: async () => 'a', // approve the plan
      requestApproval: async (req) => {
        h.approvals.push(req);
        return 'reject';
      },
    });
    const { runChatAgentTurn } = await import('../src/lib/chat-agent-run.js');
    const result = await runChatAgentTurn({
      cwd,
      task: 'create hello',
      mode: 'plan',
      model: 'hermes',
      provider,
      io: h.io,
    });
    expect(result.completed).toBe(true);
    expect(result.finalText).toBe('Done.');
    // The write was PROMPTED (plan approval approved nothing)…
    expect(h.approvals).toHaveLength(1);
    expect(h.approvals[0]?.kind).toBe('write');
    // …and the rejection held.
    expect(existsSync(join(cwd, 'hello.txt'))).toBe(false);
    // The execute phase ran with the FULL registry (same runAgent path).
    const executeSystem = provider.params[1]?.system ?? '';
    expect(executeSystem).toContain('write_file');
    // A changeless completed run leaves no checkpoint record (1.4 rule).
    const { listSessions } = await import('../src/lib/agent/checkpoint.js');
    expect(listSessions(cwd)).toHaveLength(0);
  });

  test('approve + per-action accept: the write lands through the normal flow; the record carries the plan', async () => {
    const provider = new StubProvider([
      'PLAN: 1. Create hello.txt',
      block('write_file', { path: 'hello.txt', content: 'hi\n' }),
      'Done.',
    ]);
    const h = fakeIo({
      ask: async () => 'a',
      requestApproval: async (req) => {
        h.approvals.push(req);
        return 'accept';
      },
    });
    const { runChatAgentTurn } = await import('../src/lib/chat-agent-run.js');
    const result = await runChatAgentTurn({
      cwd,
      task: 'create hello',
      mode: 'plan',
      model: 'hermes',
      provider,
      io: h.io,
    });
    expect(result.completed).toBe(true);
    expect(readFileSync(join(cwd, 'hello.txt'), 'utf8')).toBe('hi\n');
    // 1.4 rules unchanged: a completed run WITH changes keeps its record,
    // and the approved plan is journaled on it.
    const { listSessions, getResumeState } = await import('../src/lib/agent/checkpoint.js');
    const sessions = listSessions(cwd);
    expect(sessions).toHaveLength(1);
    const resume = getResumeState(sessions[0]!);
    expect(resume?.approvedPlan).toBe('PLAN: 1. Create hello.txt');
    expect(resume?.status).toBe('completed');
  });

  test("accept_all is the USER's controller semantics: second write auto-approves in the same run", async () => {
    const provider = new StubProvider([
      `${block('write_file', { path: 'a.txt', content: 'a' })}\n${block('write_file', { path: 'b.txt', content: 'b' })}`,
      'Done.',
    ]);
    const h = fakeIo({
      requestApproval: async (req) => {
        h.approvals.push(req);
        return 'accept_all';
      },
    });
    const { runChatAgentTurn } = await import('../src/lib/chat-agent-run.js');
    await runChatAgentTurn({
      cwd,
      task: 'write both',
      mode: 'agent',
      model: 'hermes',
      provider,
      io: h.io,
    });
    expect(h.approvals).toHaveLength(1); // prompted once; the rest is the user's accept_all
    expect(existsSync(join(cwd, 'a.txt'))).toBe(true);
    expect(existsSync(join(cwd, 'b.txt'))).toBe(true);
  });

  test('revise feeds the feedback into a fresh plan phase', async () => {
    const provider = new StubProvider([
      'PLAN: 1. big plan',
      'PLAN: 1. shorter plan',
      'Done.',
    ]);
    const answers = ['r', 'a'];
    const h = fakeIo({
      ask: async () => answers.shift() ?? 'c',
      readText: async () => 'make it shorter',
      requestApproval: async () => 'accept',
    });
    const { runChatAgentTurn } = await import('../src/lib/chat-agent-run.js');
    const result = await runChatAgentTurn({
      cwd,
      task: 't',
      mode: 'plan',
      model: 'hermes',
      provider,
      io: h.io,
    });
    expect(result.completed).toBe(true);
    expect(h.plans).toEqual(['PLAN: 1. big plan', 'PLAN: 1. shorter plan']);
    expect(JSON.stringify(provider.params[1])).toContain('make it shorter');
  });
});

// ───────────────────────── hooks in every mode ──────────────────────────────

describe('hooks fire identically in plan/agent modes', () => {
  function nodeCmd(script: string): string {
    return `"${process.execPath}" "${script}"`;
  }

  test('prompt-submit exit 2 blocks the run core BEFORE any provider call', async () => {
    const script = join(cwd, 'block.js');
    writeFileSync(script, `process.stderr.write('mode off-limits');process.exit(2);`, 'utf8');
    writeFileSync(
      join(configDir, 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'prompt-submit', command: nodeCmd(script) }] }),
      'utf8',
    );
    const { loadHookSession } = await import('../src/lib/hooks.js');
    const hooks = await loadHookSession(cwd);
    const provider = new StubProvider(['never']);
    const h = fakeIo();
    const { runChatAgentTurn } = await import('../src/lib/chat-agent-run.js');
    const result = await runChatAgentTurn({
      cwd,
      task: 'blocked task',
      mode: 'agent',
      model: 'hermes',
      provider,
      hooks,
      io: h.io,
    });
    expect(result.completed).toBe(false);
    expect(provider.params).toHaveLength(0);
    expect(h.notices.some((n) => n.text.includes('mode off-limits'))).toBe(true);
  });

  test('pre-tool hooks ride the SAME dispatch bridge in PLAN mode', async () => {
    const script = join(cwd, 'pretool.js');
    writeFileSync(script, `process.stderr.write('no reads either');process.exit(2);`, 'utf8');
    writeFileSync(
      join(configDir, 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'pre-tool', command: nodeCmd(script) }] }),
      'utf8',
    );
    writeFileSync(join(cwd, 'readable.txt'), 'data\n', 'utf8');
    const { loadHookSession } = await import('../src/lib/hooks.js');
    const hooks = await loadHookSession(cwd);
    const provider = new StubProvider([
      block('read_file', { path: 'readable.txt' }),
      'PLAN: 1. x',
    ]);
    const h = fakeIo({ ask: async () => 'c' });
    const { runChatAgentTurn } = await import('../src/lib/chat-agent-run.js');
    await runChatAgentTurn({
      cwd,
      task: 't',
      mode: 'plan',
      model: 'hermes',
      provider,
      hooks,
      io: h.io,
    });
    const toolResult = h.events.find((e) => e.type === 'tool_result') as
      | { ok: boolean; summary: string }
      | undefined;
    expect(toolResult?.ok).toBe(false);
    expect(toolResult?.summary).toContain('blocked by a user hook');
    expect(h.events.some((e) => e.type === 'hook_notice')).toBe(true);
  });
});

// ───────────────── mode helpers + /mode registry surface ───────────────────

describe('mode helpers', () => {
  test('the cycle is ask → plan → agent → ask; default is ask', async () => {
    const { nextChatMode, DEFAULT_CHAT_MODE, isChatMode, CHAT_MODES } = await import(
      '../src/lib/chat-mode.js'
    );
    expect(DEFAULT_CHAT_MODE).toBe('ask');
    expect(nextChatMode('ask')).toBe('plan');
    expect(nextChatMode('plan')).toBe('agent');
    expect(nextChatMode('agent')).toBe('ask');
    expect(CHAT_MODES).toEqual(['ask', 'plan', 'agent']);
    expect(isChatMode('plan')).toBe(true);
    expect(isChatMode('bogus')).toBe(false);
  });

  test('mid-run switch policy: REJECTED while a run is active, free when idle', async () => {
    const { modeSwitchBlockedReason } = await import('../src/lib/chat-mode.js');
    expect(modeSwitchBlockedReason(true)).toMatch(/run is in progress/);
    expect(modeSwitchBlockedReason(false)).toBeNull();
  });

  test('session-model clamp: agent slugs pass through, styx_max clamps to styx', async () => {
    const { agentModelFor } = await import('../src/lib/chat-mode.js');
    expect(agentModelFor('hermes')).toEqual({ model: 'hermes', clamped: false });
    expect(agentModelFor('charon')).toEqual({ model: 'charon', clamped: false });
    expect(agentModelFor('styx_max')).toEqual({ model: 'styx', clamped: true });
  });
});

describe('/mode registry surface', () => {
  const baseCtx = {
    cwd: '/tmp',
    model: 'hermes' as const,
    effort: 'auto' as const,
    conversationId: 'c',
    apiUrl: undefined,
    injectGuide: false,
    injectChangelog: false,
  };

  test('no argument reports the current (or default) mode', async () => {
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    expect(await runSlashCommand('mode', [], baseCtx)).toEqual({
      kind: 'mode-info',
      mode: 'ask',
      modes: ['ask', 'plan', 'agent'],
    });
    expect(await runSlashCommand('mode', [], { ...baseCtx, chatMode: 'plan' })).toEqual({
      kind: 'mode-info',
      mode: 'plan',
      modes: ['ask', 'plan', 'agent'],
    });
  });

  test('a valid argument switches; an unknown one errors clearly', async () => {
    const { runSlashCommand, SLASH_HELP } = await import('../src/lib/slash/registry.js');
    expect(await runSlashCommand('mode', ['Agent'], baseCtx)).toEqual({
      kind: 'mode-changed',
      mode: 'agent',
    });
    expect(await runSlashCommand('mode', ['bogus'], baseCtx)).toEqual({
      kind: 'mode-unknown',
      input: 'bogus',
      modes: ['ask', 'plan', 'agent'],
    });
    expect(SLASH_HELP.some((e) => e.command.startsWith('/mode'))).toBe(true);
  });

  test('the one-shot renderer prints the headless mapping', async () => {
    const stderrChunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      stderrChunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { handleSlashCommand } = await import('../src/commands/chat.js');
      const r = await handleSlashCommand('/mode', {
        json: false,
        color: false,
        currentConvo: 'c',
        apiUrl: undefined,
      });
      expect(r.consumed).toBe(true);
      expect(stderrChunks.join('')).toContain('spycore agent --plan');
    } finally {
      process.stderr.write = orig;
    }
  });
});
