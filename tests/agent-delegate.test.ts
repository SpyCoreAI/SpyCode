/**
 * F1 sub-agent orchestration: the `delegate` tool, the depth gate, budget
 * sharing, permission inheritance, and child-event depth tagging.
 *
 * The loop tests inject a FakeProvider (no HTTP) that scripts one reply
 * sequence per conversation, in creation order: the parent's conversation is
 * always created first, then each nested child as `delegate` executes.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import {
  DEFAULT_CHILD_MAX_TURNS,
  DEFAULT_CHILD_MODEL,
  MAX_DELEGATE_DEPTH,
  type DelegateChildResult,
  type Delegator,
} from '../src/lib/agent/delegate.js';
import { createBudget, toBudgetCaps } from '../src/lib/agent/budget.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';
import {
  DEFAULT_LIMITS,
  buildToolDeclarations,
  describeCallArg,
  describeToolsForPrompt,
  dispatchTool,
  toolNames,
  type ToolContext,
} from '../src/lib/agent/tools.js';
import type {
  CreateConversationParams,
  Provider,
  ProviderEvent,
  StreamChatParams,
} from '../src/lib/providers/types.js';

const block = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

interface ScriptedTurn {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Scripts one fenced-protocol reply sequence per conversation, in creation
 * order. Records the model requested, the first-turn system+message of every
 * conversation (child model selection, sub-agent preamble, catalogue
 * filtering at the max depth), and EVERY turn message in order (so tests can
 * see tool-result content, which the event stream deliberately omits).
 */
class FakeProvider implements Provider {
  readonly id: Provider['id'];
  private convSeq = 0;
  private readonly queued: ScriptedTurn[][] = [];
  private readonly turnsByConv = new Map<string, ScriptedTurn[]>();
  readonly models: string[] = [];
  readonly firstTurns: string[] = [];
  readonly allMessages: string[] = [];

  constructor(id: Provider['id'] = 'spycore') {
    this.id = id;
  }

  /** Queue the scripted turns for the next created conversation. */
  queueScript(turns: ScriptedTurn[]): void {
    this.queued.push(turns);
  }

  async createConversation(params: CreateConversationParams): Promise<string> {
    this.convSeq += 1;
    const id = `cnv_${this.convSeq}`;
    this.models.push(params.model);
    this.turnsByConv.set(id, [...(this.queued.shift() ?? [{ text: 'Done.' }])]);
    return id;
  }

  async *streamChat(params: StreamChatParams): AsyncGenerator<ProviderEvent> {
    if (params.system !== undefined) {
      this.firstTurns.push(`${params.system}\n\n${params.message}`);
    }
    this.allMessages.push(params.message);
    const queue = this.turnsByConv.get(params.conversationId) ?? [];
    const turn = queue.shift() ?? { text: 'Done.' };
    if (turn.text.length > 0) yield { type: 'text', text: turn.text };
    yield { type: 'usage', input: turn.inputTokens ?? 10, output: turn.outputTokens ?? 5 };
    yield { type: 'done' };
  }

  get conversationCount(): number {
    return this.convSeq;
  }
}

let workDir: string;

beforeEach(() => {
  freshConfigDir();
  workDir = mkdtempSync(join(tmpdir(), 'spycode-delegate-'));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const childOk = (over: Partial<DelegateChildResult> = {}): DelegateChildResult => ({
  ok: true,
  finalText: 'did the thing',
  turns: 2,
  toolCalls: 3,
  tokensUsed: 1250,
  turnsUsed: 2,
  budgetStop: null,
  reachedMaxTurns: false,
  cancelled: false,
  stopNote: null,
  ...over,
});

function toolEvents(events: AgentEvent[], type: 'tool_call' | 'tool_result', depth?: number) {
  return events.filter((e) => e.type === type && (depth === undefined ? e.depth === undefined : e.depth === depth));
}

// ───────────────────────── registration + catalogue ─────────────────────────

describe('delegate tool registration', () => {
  test('is a registered built-in tool', () => {
    expect(toolNames()).toContain('delegate');
  });

  test('the prompt catalogue documents it with its parameters', () => {
    const doc = describeToolsForPrompt();
    expect(doc).toContain('delegate(task: string, model?: string, maxTurns?: integer)');
  });

  test('stays in the plan-mode catalogue (non-mutating; the child inherits plan mode)', () => {
    const doc = describeToolsForPrompt({ readOnlyOnly: true });
    expect(doc).toContain('delegate(');
    expect(doc).not.toContain('write_file(');
  });

  test('delegateEnabled: false withholds it from the prompt catalogue', () => {
    expect(describeToolsForPrompt({ delegateEnabled: false })).not.toContain('delegate(');
    expect(describeToolsForPrompt({ delegateEnabled: true })).toContain('delegate(');
  });

  test('delegateEnabled: false withholds it from the native declarations', () => {
    const names = (opts?: { delegateEnabled?: boolean }) =>
      buildToolDeclarations(opts).map((d) => d.name);
    expect(names()).toContain('delegate');
    expect(names({ delegateEnabled: true })).toContain('delegate');
    expect(names({ delegateEnabled: false })).not.toContain('delegate');
  });

  test('describeCallArg shows a truncated task', () => {
    expect(describeCallArg('delegate', { task: 'summarize' })).toBe('summarize');
    const long = describeCallArg('delegate', { task: 'x'.repeat(100) });
    expect(long.length).toBe(81);
    expect(long.endsWith('…')).toBe(true);
  });
});

// ───────────────────────── argument validation (unit) ─────────────────────────

describe('delegate argument validation', () => {
  const ctx = (): ToolContext => ({ cwd: workDir, limits: DEFAULT_LIMITS });

  test('missing task fails schema validation', async () => {
    const res = await dispatchTool('delegate', {}, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/missing required parameter "task"/);
  });

  test('empty task is rejected', async () => {
    const res = await dispatchTool('delegate', { task: '   ' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.summary).toBe('invalid task');
    expect(res.content).toMatch(/non-empty/);
  });

  test('non-positive maxTurns is rejected', async () => {
    for (const maxTurns of [0, -3]) {
      const res = await dispatchTool('delegate', { task: 'hi', maxTurns }, ctx());
      expect(res.ok).toBe(false);
      expect(res.summary).toBe('invalid maxTurns');
    }
  });

  test('non-integer maxTurns fails schema validation', async () => {
    const res = await dispatchTool('delegate', { task: 'hi', maxTurns: 2.5 }, ctx());
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/"maxTurns" must be an integer/);
  });

  test('no delegator on the context is a clean error, never a throw', async () => {
    const res = await dispatchTool('delegate', { task: 'hi' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.summary).toBe('delegation unavailable');
  });
});

// ───────────────────────── depth gate (unit) ─────────────────────────

describe('delegation depth gate', () => {
  test('a run at the max depth is refused without spawning', async () => {
    let spawned = 0;
    const ctx: ToolContext = {
      cwd: workDir,
      limits: DEFAULT_LIMITS,
      delegator: {
        depth: MAX_DELEGATE_DEPTH,
        maxDepth: MAX_DELEGATE_DEPTH,
        spawnChild: async () => {
          spawned += 1;
          return childOk();
        },
      },
    };
    const res = await dispatchTool('delegate', { task: 'go deeper' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toBe('delegation depth limit');
    expect(res.content).toMatch(/max depth 2/);
    expect(res.content).toMatch(/Complete the task yourself/);
    expect(spawned).toBe(0);
  });

  test('a run below the max depth spawns and reports the child result', async () => {
    const seen: Array<{ task: string; model?: string; maxTurns: number }> = [];
    const delegator: Delegator = {
      depth: 0,
      maxDepth: MAX_DELEGATE_DEPTH,
      spawnChild: async (input) => {
        seen.push({ task: input.task, model: input.model, maxTurns: input.maxTurns });
        return childOk();
      },
    };
    const ctx: ToolContext = { cwd: workDir, limits: DEFAULT_LIMITS, delegator };
    const res = await dispatchTool('delegate', { task: 'do research' }, ctx);
    expect(res.ok).toBe(true);
    expect(seen).toHaveLength(1);
    // Defaults are applied by the tool: cheaper-model defaulting is the
    // delegator's (provider-aware) job, so model passes through unset.
    expect(seen[0]).toEqual({ task: 'do research', model: undefined, maxTurns: DEFAULT_CHILD_MAX_TURNS });
    expect(res.summary).toBe('sub-agent: 2 turns, 1.3k tokens');
    expect(res.content).toContain('Sub-agent finished in 2 turns (3 tool calls, 1.3k tokens).');
    expect(res.content).toContain('did the thing');
  });

  test('a child that never started surfaces the reason', async () => {
    const delegator: Delegator = {
      depth: 0,
      maxDepth: MAX_DELEGATE_DEPTH,
      spawnChild: async () => ({ ...childOk(), ok: false, error: 'unknown model "x"' }),
    };
    const ctx: ToolContext = { cwd: workDir, limits: DEFAULT_LIMITS, delegator };
    const res = await dispatchTool('delegate', { task: 'hi', model: 'x' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.summary).toBe('sub-agent failed to start');
    expect(res.content).toMatch(/unknown model "x"/);
  });

  test('cancellation and early stops are reported, not hidden', async () => {
    const delegator: Delegator = {
      depth: 0,
      maxDepth: MAX_DELEGATE_DEPTH,
      spawnChild: async () => childOk({ finalText: '', cancelled: true }),
    };
    const ctx: ToolContext = { cwd: workDir, limits: DEFAULT_LIMITS, delegator };
    const res = await dispatchTool('delegate', { task: 'hi' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/cancelled before it finished/);
  });

  test('a turn-limit stop names the cap', async () => {
    const delegator: Delegator = {
      depth: 0,
      maxDepth: MAX_DELEGATE_DEPTH,
      spawnChild: async () => childOk({ finalText: '', reachedMaxTurns: true }),
    };
    const ctx: ToolContext = { cwd: workDir, limits: DEFAULT_LIMITS, delegator };
    const res = await dispatchTool('delegate', { task: 'hi', maxTurns: 4 }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/reached its turn limit \(4\)/);
  });

  test('a budget stop note is reported verbatim', async () => {
    const delegator: Delegator = {
      depth: 0,
      maxDepth: MAX_DELEGATE_DEPTH,
      spawnChild: async () =>
        childOk({ finalText: '', stopNote: 'token budget reached (52,300 / 50,000)', budgetStop: 'tokens' }),
    };
    const ctx: ToolContext = { cwd: workDir, limits: DEFAULT_LIMITS, delegator };
    const res = await dispatchTool('delegate', { task: 'hi' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/stopped early: token budget reached \(52,300 \/ 50,000\)/);
  });
});

// ───────────────────────── full loop: delegation ─────────────────────────

describe('runAgent with delegate (fake provider)', () => {
  test('spawns a child, returns its final answer, and tags child events with depth', async () => {
    writeFileSync(join(workDir, 'notes.txt'), 'all good');
    const provider = new FakeProvider();
    provider.queueScript([
      { text: block('delegate', { task: 'summarize the repo' }) },
      { text: 'Parent done.' },
    ]);
    provider.queueScript([
      { text: block('read_file', { path: 'notes.txt' }) },
      { text: 'Child findings: all good.' },
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'delegate some work',
      cwd: workDir,
      provider,
      onEvent: (e) => events.push(e),
    });

    expect(result.finalText).toBe('Parent done.');
    expect(provider.conversationCount).toBe(2);
    // Default model: the child runs the cheaper slug, the parent keeps charon.
    expect(provider.models).toEqual(['charon', DEFAULT_CHILD_MODEL]);

    // The child's events ride the parent's stream tagged with depth 1.
    const childCalls = toolEvents(events, 'tool_call', 1);
    expect(childCalls.map((e) => (e.type === 'tool_call' ? e.tool : ''))).toEqual(['read_file']);
    const childResults = toolEvents(events, 'tool_result', 1);
    expect(childResults.map((e) => (e.type === 'tool_result' ? e.tool : ''))).toEqual(['read_file']);
    // The parent's own delegate call/result stay at the top level (no depth).
    const parentCalls = toolEvents(events, 'tool_call');
    expect(parentCalls.map((e) => (e.type === 'tool_call' ? e.tool : ''))).toEqual(['delegate']);

    const delegateResult = events.find(
      (e) => e.type === 'tool_result' && e.tool === 'delegate' && e.depth === undefined,
    );
    expect(delegateResult?.type === 'tool_result' && delegateResult.ok).toBe(true);
    expect(delegateResult?.type === 'tool_result' && delegateResult.summary).toMatch(
      /sub-agent: 2 turns/,
    );
    // The event stream omits result bodies by design; the content rode the
    // parent's next turn - where the child's final answer is visible verbatim.
    const parentTurn2 = provider.allMessages[3] ?? '';
    expect(parentTurn2).toContain('Sub-agent finished in 2 turns');
    expect(parentTurn2).toContain('Child findings: all good.');

    // The child was told it is a sub-agent and given the parent's task.
    const childFirst = provider.firstTurns[1] ?? '';
    expect(childFirst).toContain('SUB-AGENT');
    expect(childFirst).toContain('summarize the repo');
    // ...and the parent's prompt offered the tool.
    expect(provider.firstTurns[0]).toContain('delegate(task: string, model?: string, maxTurns?: integer)');
  });

  test('explicit model and maxTurns are honoured', async () => {
    const provider = new FakeProvider();
    provider.queueScript([
      { text: block('delegate', { task: 'hard task', model: 'styx', maxTurns: 3 }) },
      { text: 'Parent done.' },
    ]);
    provider.queueScript([{ text: 'Child done.' }]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const result = await runAgent({ task: 'go', cwd: workDir, provider });
    expect(result.finalText).toBe('Parent done.');
    expect(provider.models).toEqual(['charon', 'styx']);
  });

  test('unknown model slug is a clean tool error; no child conversation is opened', async () => {
    const provider = new FakeProvider();
    provider.queueScript([
      { text: block('delegate', { task: 'x', model: 'gpt-4o' }) },
      { text: 'Parent done.' },
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({ task: 'go', cwd: workDir, provider, onEvent: (e) => events.push(e) });
    expect(provider.conversationCount).toBe(1);
    const res = events.find((e) => e.type === 'tool_result' && e.tool === 'delegate');
    expect(res?.type === 'tool_result' && res.ok).toBe(false);
    expect(res?.type === 'tool_result' && res.summary).toBe('sub-agent failed to start');
    // The reason rode the parent's next turn with the full tool-result body.
    expect(provider.allMessages[1] ?? '').toMatch(/unknown model "gpt-4o"/);
    expect(provider.allMessages[1] ?? '').toMatch(/charon, styx, hermes, minos/);
  });

  test('BYOK provider: the child inherits the parent model id', async () => {
    const provider = new FakeProvider('openai');
    provider.queueScript([
      { text: block('delegate', { task: 'x' }) },
      { text: 'Parent done.' },
    ]);
    provider.queueScript([{ text: 'Child done.' }]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({ task: 'go', cwd: workDir, provider, model: 'gpt-4o-mini' });
    // A SpyCore slug would be meaningless to the BYOK endpoint.
    expect(provider.models).toEqual(['gpt-4o-mini', 'gpt-4o-mini']);
  });

  test('depth chain: child may delegate once; the grandchild is refused', async () => {
    const provider = new FakeProvider();
    provider.queueScript([
      { text: block('delegate', { task: 'level 1' }) },
      { text: 'Parent done.' },
    ]);
    provider.queueScript([
      { text: block('delegate', { task: 'level 2' }) },
      { text: 'Child done.' },
    ]);
    provider.queueScript([
      { text: block('delegate', { task: 'level 3 - must be refused' }) },
      { text: 'Grandchild done.' },
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'go deep',
      cwd: workDir,
      provider,
      onEvent: (e) => events.push(e),
    });

    expect(result.finalText).toBe('Parent done.');
    // No fourth conversation: the grandchild's delegate call never spawned.
    expect(provider.conversationCount).toBe(3);

    // Depth tags: parent 0 (unset), child 1, grandchild 2.
    expect(toolEvents(events, 'tool_call', 1).map((e) => (e.type === 'tool_call' ? e.tool : ''))).toEqual([
      'delegate',
    ]);
    const grandchildCalls = toolEvents(events, 'tool_call', 2);
    expect(grandchildCalls.map((e) => (e.type === 'tool_call' ? e.tool : ''))).toEqual(['delegate']);
    const grandchildResult = toolEvents(events, 'tool_result', 2)[0];
    expect(grandchildResult?.type === 'tool_result' && grandchildResult.ok).toBe(false);
    expect(grandchildResult?.type === 'tool_result' && grandchildResult.summary).toBe(
      'delegation depth limit',
    );

    // The max-depth run was never OFFERED the tool; shallower runs were.
    expect(provider.firstTurns[0]).toContain('delegate(task: string, model?: string, maxTurns?: integer)');
    expect(provider.firstTurns[1]).toContain('delegate(task: string, model?: string, maxTurns?: integer)');
    expect(provider.firstTurns[2]).not.toContain('delegate(');
  });
});

// ───────────────────────── budget sharing ─────────────────────────

describe('delegate budget sharing', () => {
  test("the child's tokens accumulate into the parent's budget and are reported separately", async () => {
    const provider = new FakeProvider();
    provider.queueScript([
      { text: block('delegate', { task: 'count things' }), inputTokens: 100, outputTokens: 50 },
      { text: 'Parent done.', inputTokens: 10, outputTokens: 5 },
    ]);
    provider.queueScript([
      { text: block('read_file', { path: 'notes.txt' }), inputTokens: 200, outputTokens: 100 },
      { text: 'Child done.', inputTokens: 300, outputTokens: 150 },
    ]);
    writeFileSync(join(workDir, 'notes.txt'), 'x');
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const budget = createBudget({});
    const events: AgentEvent[] = [];
    await runAgent({ task: 'go', cwd: workDir, provider, budget, onEvent: (e) => events.push(e) });

    // Shared: parent turns (150 + 15) + child turns (300 + 450) = 915.
    expect(budget.snapshot().tokensUsed).toBe(915);
    const res = events.find((e) => e.type === 'tool_result' && e.tool === 'delegate');
    expect(res?.type === 'tool_result' && res.summary).toBe('sub-agent: 2 turns, 750 tokens');
  });

  test("a parent turn cap stops the child; the stop surfaces on the shared stream", async () => {
    const provider = new FakeProvider();
    provider.queueScript([
      { text: block('delegate', { task: 'x' }) },
      { text: 'Parent done.' },
    ]);
    provider.queueScript([{ text: 'Child would work here.' }]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const budget = createBudget(toBudgetCaps({ maxTurns: 1 }));
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'go',
      cwd: workDir,
      provider,
      budget,
      onEvent: (e) => events.push(e),
    });
    // The parent's single turn allowance is spent on the delegate call; the
    // child trips the SAME cap before its first turn, and the parent then
    // trips it before its second.
    expect(result.budgetStop).toBe('turns');
    const childStop = events.find((e) => e.type === 'budget_stop' && e.depth === 1);
    expect(childStop?.type === 'budget_stop' && childStop.reason).toBe('turns');
    // The parent's own stop stays at the top level.
    expect(events.find((e) => e.type === 'budget_stop' && e.depth === undefined)?.type).toBe(
      'budget_stop',
    );
  });
});

// ───────────────────────── permission inheritance ─────────────────────────

describe('delegate permission inheritance', () => {
  test("the child's writes go through the parent's approval gate", async () => {
    const provider = new FakeProvider();
    provider.queueScript([
      { text: block('delegate', { task: 'write a file' }) },
      { text: 'Parent done.' },
    ]);
    provider.queueScript([
      { text: block('write_file', { path: 'child.txt', content: 'written by child\n' }) },
      { text: 'Child done.' },
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const approvals: unknown[] = [];
    const result = await runAgent({
      task: 'go',
      cwd: workDir,
      provider,
      requestApproval: async (req) => {
        approvals.push(req);
        return { approved: true };
      },
    });
    expect(result.finalText).toBe('Parent done.');
    // The SAME gate the parent's own writes would hit.
    expect(approvals).toHaveLength(1);
    expect((approvals[0] as { kind: string }).kind).toBe('write');
    expect(existsSync(join(workDir, 'child.txt'))).toBe(true);
    expect(readFileSync(join(workDir, 'child.txt'), 'utf8')).toBe('written by child\n');
  });

  test('plan mode is inherited: the child cannot smuggle writes past approval', async () => {
    const provider = new FakeProvider();
    provider.queueScript([
      { text: block('delegate', { task: 'plan the work' }) },
      { text: 'Parent plan done.' },
    ]);
    provider.queueScript([
      { text: block('write_file', { path: 'sneaky.txt', content: 'x' }) },
      { text: 'Child plan.' },
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    // delegate itself stays available in plan mode (it is not mutating)...
    const result = await runAgent({
      task: 'go',
      cwd: workDir,
      provider,
      planMode: true,
      onEvent: (e) => events.push(e),
    });
    expect(result.finalText).toBe('Parent plan done.');
    // ...but the child's write is blocked at dispatch, exactly like the parent's.
    const childWrite = toolEvents(events, 'tool_result', 1).find(
      (e) => e.type === 'tool_result' && e.tool === 'write_file',
    );
    expect(childWrite?.type === 'tool_result' && childWrite.ok).toBe(false);
    // The block reason rode the child's next turn with the full result body.
    const childTurn2 = provider.allMessages[2] ?? '';
    expect(childTurn2).toMatch(/planning mode/);
    expect(existsSync(join(workDir, 'sneaky.txt'))).toBe(false);
  });

  test('a rejected approval inside the child surfaces as a normal tool error', async () => {
    const provider = new FakeProvider();
    provider.queueScript([
      { text: block('delegate', { task: 'write a file' }) },
      { text: 'Parent done.' },
    ]);
    provider.queueScript([
      { text: block('write_file', { path: 'child.txt', content: 'x' }) },
      { text: 'Child done.' },
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({
      task: 'go',
      cwd: workDir,
      provider,
      requestApproval: async () => ({ approved: false, reason: 'no' }),
      onEvent: (e) => events.push(e),
    });
    const childWrite = toolEvents(events, 'tool_result', 1).find(
      (e) => e.type === 'tool_result' && e.tool === 'write_file',
    );
    expect(childWrite?.type === 'tool_result' && childWrite.ok).toBe(false);
    expect(existsSync(join(workDir, 'child.txt'))).toBe(false);
  });
});

// ───────────────────────── constants ─────────────────────────

describe('delegation constants', () => {
  test('documented defaults', () => {
    expect(MAX_DELEGATE_DEPTH).toBe(2);
    expect(DEFAULT_CHILD_MAX_TURNS).toBe(10);
    expect(DEFAULT_CHILD_MODEL).toBe('hermes');
  });

  test('VALID_CHILD_MODELS matches the documented set', async () => {
    const { VALID_CHILD_MODELS } = await import('../src/lib/agent/delegate.js');
    expect([...VALID_CHILD_MODELS].sort()).toEqual(['charon', 'hermes', 'minos', 'styx']);
  });
});
