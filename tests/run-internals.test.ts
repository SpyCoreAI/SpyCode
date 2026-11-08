import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { checkEvidenceClaims, type EvidenceCall } from '../src/lib/agent/evidence-check.js';
import {
  MAX_RETAINED_EVENTS,
  createBudgetReporter,
  createEventSink,
} from '../src/lib/agent/run-events.js';
import {
  createRunJournal,
  createToolContext,
  loadRunSkills,
  trackApprovalInFlight,
} from '../src/lib/agent/run-context.js';
import { createDelegator, resolveDelegateDepth } from '../src/lib/agent/run-delegate.js';
import { openRunSession } from '../src/lib/agent/run-session.js';
import { createRunDispatcher, type TurnCounters } from '../src/lib/agent/run-dispatch.js';
import { createBudget } from '../src/lib/agent/budget.js';
import type { AgentEvent, AgentResult, RunAgentOptions } from '../src/lib/agent/loop.js';
import type { Provider, ProviderEvent } from '../src/lib/providers/types.js';
import type { ToolContext } from '../src/lib/agent/tools.js';

/**
 * H14 - direct tests for `evidence-check.ts` and the `run-*` internals
 * (`run-context`, `run-delegate`, `run-dispatch`, `run-events`,
 * `run-session`). All five were previously covered only indirectly through
 * `runAgent` in `loop.ts`, so a regression in any one of them could hide
 * behind a green suite.
 */

let workDir: string;

beforeEach(() => {
  freshConfigDir();
  workDir = mkdtempSync(join(tmpdir(), 'spycode-run-int-'));
});

afterEach(() => {
  vi.resetModules();
  rmSync(workDir, { recursive: true, force: true });
});

describe('checkEvidenceClaims', () => {
  const noCalls: EvidenceCall[] = [];
  const testCall: EvidenceCall = { tool: 'run_command', ok: true, command: 'pnpm vitest run' };
  const buildCall: EvidenceCall = { tool: 'run_command', ok: true, command: 'pnpm build' };
  const lintCall: EvidenceCall = { tool: 'run_command', ok: true, command: 'pnpm lint' };

  test('no claim, no warning - even with no tool calls', () => {
    expect(checkEvidenceClaims('Refactored the parser.', noCalls)).toEqual([]);
  });

  test('an unbacked "tests passed" claim warns', () => {
    const warnings = checkEvidenceClaims('All tests passed.', noCalls);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"tests passed"');
  });

  test('a matching successful test command backs the claim', () => {
    expect(checkEvidenceClaims('All tests passed.', [testCall])).toEqual([]);
    expect(checkEvidenceClaims('Test suite all green.', [testCall])).toEqual([]);
  });

  test('a failed test command does not back the claim', () => {
    const failed: EvidenceCall = { ...testCall, ok: false };
    expect(checkEvidenceClaims('All tests passed.', [failed])).toHaveLength(1);
  });

  test('a non-run_command tool does not back the claim', () => {
    const other: EvidenceCall = { tool: 'write_file', ok: true };
    expect(checkEvidenceClaims('All tests passed.', [other])).toHaveLength(1);
  });

  test('build and lint claims are checked independently', () => {
    const warnings = checkEvidenceClaims('Build succeeded and lint passed.', [buildCall]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"lint passed"');
    expect(checkEvidenceClaims('Build succeeded and lint passed.', [buildCall, lintCall])).toEqual([]);
  });

  test('one warning per unbacked claim', () => {
    const warnings = checkEvidenceClaims('Tests passed. Build succeeded. Lint passed.', noCalls);
    expect(warnings).toHaveLength(3);
  });
});

describe('run-events', () => {
  test('createEventSink retains events and forwards them live', () => {
    const seen: AgentEvent[] = [];
    const { events, emit } = createEventSink({ onEvent: (e) => seen.push(e) });
    emit({ type: 'final', text: 'done' } as AgentEvent);
    expect(events).toHaveLength(1);
    expect(seen).toEqual(events);
  });

  test('createEventSink drops the oldest events past the retained cap', () => {
    const { events, emit } = createEventSink({});
    for (let i = 0; i < MAX_RETAINED_EVENTS + 2; i += 1) {
      emit({ type: 'assistant_token', turn: 1, chunk: String(i) } as AgentEvent);
    }
    expect(events).toHaveLength(MAX_RETAINED_EVENTS);
    expect((events[0] as { chunk: string }).chunk).toBe('2');
  });

  test('createBudgetReporter reports budget and budget_stop', () => {
    const seen: AgentEvent[] = [];
    const budget = createBudget({ maxTurns: 2 });
    const { hasTurnBudget, emitBudget, emitBudgetStop } = createBudgetReporter(budget, (e) =>
      seen.push(e),
    );
    expect(hasTurnBudget).toBe(true);
    emitBudget();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.type).toBe('budget');
    emitBudgetStop('turns');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ type: 'budget_stop', reason: 'turns', cap: 2 });
  });

  test('createBudgetReporter with no budget emits nothing', () => {
    const seen: AgentEvent[] = [];
    const { hasTurnBudget, emitBudget, emitBudgetStop } = createBudgetReporter(undefined, (e) =>
      seen.push(e),
    );
    expect(hasTurnBudget).toBe(false);
    emitBudget();
    emitBudgetStop('tokens');
    expect(seen).toEqual([]);
  });
});

describe('run-context', () => {
  function baseOpts(overrides: Partial<RunAgentOptions> = {}): RunAgentOptions {
    return { task: 'do the thing', cwd: workDir, ...overrides };
  }

  test('createRunJournal records locally and forwards to the external recorder', () => {
    const external: unknown[] = [];
    const { changes, record } = createRunJournal(baseOpts({ recordChange: (c) => external.push(c) }));
    const change = { path: join(workDir, 'a.txt'), op: 'create' as const, before: null, after: 'x\n' };
    record(change);
    expect(changes).toEqual([change]);
    expect(external).toEqual([change]);
  });

  test('createRunJournal recordDelta prefers the batch sink', () => {
    const batches: unknown[][] = [];
    const singles: unknown[] = [];
    const { changes, recordDelta } = createRunJournal(
      baseOpts({
        recordChange: (c) => singles.push(c),
        recordChanges: (d) => batches.push([...d]),
      }),
    );
    const delta = [
      { path: join(workDir, 'a.txt'), op: 'create' as const, before: null, after: 'x\n' },
      { path: join(workDir, 'b.txt'), op: 'modify' as const, before: 'a\n', after: 'b\n' },
    ];
    recordDelta(delta);
    expect(changes).toEqual(delta);
    expect(batches).toEqual([delta]);
    expect(singles).toEqual([]);
    recordDelta([]);
    expect(batches).toHaveLength(1);
  });

  test('createRunJournal persist writes the session once, and never with an external recorder', async () => {
    const { getConfigPath } = await import('../src/lib/config.js');
    const { dirname } = await import('node:path');
    const checkpoints = join(dirname(getConfigPath()), 'checkpoints');
    const countFiles = (): number => {
      if (!existsSync(checkpoints)) return 0;
      return readdirSync(checkpoints, { recursive: true }).length;
    };
    const change = { path: join(workDir, 'a.txt'), op: 'create' as const, before: null, after: 'x\n' };
    const owned = createRunJournal(baseOpts());
    owned.record(change);
    owned.persist();
    owned.persist();
    expect(countFiles()).toBeGreaterThan(0);
    const before = countFiles();
    const external = createRunJournal(baseOpts({ recordChange: () => {} }));
    external.record(change);
    external.persist();
    expect(countFiles()).toBe(before);
  });

  test('loadRunSkills on an empty workspace returns no skills and no notice', () => {
    const seen: AgentEvent[] = [];
    const { skillsByName, skillsSection } = loadRunSkills(workDir, (e) => seen.push(e));
    expect(skillsByName.size).toBe(0);
    expect(skillsSection).toBe('');
    expect(seen).toEqual([]);
  });

  test('loadRunSkills withholds untrusted project skills and says so', () => {
    const skillDir = join(workDir, '.spycore', 'skills', 'demo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: demo\ndescription: A demo skill for testing.\n---\n\nBody.\n',
    );
    const seen: AgentEvent[] = [];
    const { skillsByName } = loadRunSkills(workDir, (e) => seen.push(e));
    expect(skillsByName.size).toBe(0);
    expect(seen.some((e) => e.type === 'skill_notice' && e.level === 'warn')).toBe(true);
  });

  test('createToolContext gives a depth-0 run the orchestrator role, a child the leaf role', () => {
    const ctx = createToolContext(baseOpts(), {
      emit: () => {},
      record: () => {},
      skillsByName: new Map(),
      webEnabled: true,
    });
    expect(ctx.role).toBe('orchestrator');
    expect(ctx.cwd).toBe(workDir);
    const child = createToolContext(baseOpts({ delegateDepth: 1 }), {
      emit: () => {},
      record: () => {},
      skillsByName: new Map(),
      webEnabled: true,
    });
    expect(child.role).toBe('leaf');
  });

  test('trackApprovalInFlight reports the flag only while a prompt is open', async () => {
    let seenDuring: boolean | undefined;
    let reader: (() => boolean) | undefined;
    const ctx = createToolContext(
      baseOpts({
        requestApproval: (async () => {
          seenDuring = reader?.();
          return 'allow';
        }) as unknown as RunAgentOptions['requestApproval'],
      }),
      { emit: () => {}, record: () => {}, skillsByName: new Map(), webEnabled: true },
    );
    reader = trackApprovalInFlight(ctx);
    expect(reader()).toBe(false);
    await ctx.requestApproval!({} as never);
    expect(seenDuring).toBe(true);
    expect(reader()).toBe(false);
  });
});

describe('run-delegate', () => {
  test('resolveDelegateDepth clamps to a non-negative integer', () => {
    expect(resolveDelegateDepth(undefined)).toBe(0);
    expect(resolveDelegateDepth(0)).toBe(0);
    expect(resolveDelegateDepth(2)).toBe(2);
    expect(resolveDelegateDepth(2.7)).toBe(2);
    expect(resolveDelegateDepth(-3)).toBe(0);
    expect(resolveDelegateDepth(Number.NaN)).toBe(0);
    expect(resolveDelegateDepth(Number.POSITIVE_INFINITY)).toBe(0);
  });

  function fakeProvider(id: Provider['id']): Provider {
    return {
      id,
      createConversation: async () => 'cnv-fake',
      streamChat: async function* () {
        yield { type: 'text', text: 'hi' } as ProviderEvent;
      },
    };
  }

  function stubResult(overrides: Partial<AgentResult> = {}): AgentResult {
    return {
      ok: true,
      finalText: 'child done',
      turns: 1,
      toolCalls: 0,
      tokensUsed: 0,
      turnsUsed: 0,
      budgetStop: null,
      reachedMaxTurns: false,
      cancelled: false,
      stopNote: null,
      error: null,
      events: [],
      ...overrides,
    } as AgentResult;
  }

  test('spawnChild refuses past the max depth without calling runAgent', async () => {
    const seen: AgentEvent[] = [];
    const runAgent = vi.fn(async () => stubResult());
    const ctx = createToolContext(
      { task: 't', cwd: workDir },
      { emit: () => {}, record: () => {}, skillsByName: new Map(), webEnabled: true },
    );
    const delegator = createDelegator({
      opts: { task: 't', cwd: workDir },
      ctx,
      emit: (e) => seen.push(e),
      provider: fakeProvider('openai'),
      model: 'gpt-x',
      apiUrlOverride: undefined,
      budget: undefined,
      delegateDepth: 2,
      runAgent: runAgent as unknown as (opts: RunAgentOptions) => Promise<AgentResult>,
    });
    const res = await delegator.spawnChild({ task: 'child task', maxTurns: 5 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/delegation depth limit reached \(max depth 2\)/);
    expect(runAgent).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });

  test('spawnChild rejects an unknown model on the SpyCore provider', async () => {
    const runAgent = vi.fn(async () => stubResult());
    const ctx = createToolContext(
      { task: 't', cwd: workDir },
      { emit: () => {}, record: () => {}, skillsByName: new Map(), webEnabled: true },
    );
    const delegator = createDelegator({
      opts: { task: 't', cwd: workDir },
      ctx,
      emit: () => {},
      provider: fakeProvider('spycore'),
      model: 'styx',
      apiUrlOverride: undefined,
      budget: undefined,
      delegateDepth: 0,
      runAgent: runAgent as unknown as (opts: RunAgentOptions) => Promise<AgentResult>,
    });
    const res = await delegator.spawnChild({ task: 'child task', model: 'nope', maxTurns: 5 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown model "nope"/);
    expect(runAgent).not.toHaveBeenCalled();
  });

  test('spawnChild on BYOK inherits the parent model, tags child depth, swallows context_full', async () => {
    const seen: AgentEvent[] = [];
    let captured: RunAgentOptions | undefined;
    const budget = createBudget({ maxTokens: 1000 });
    const runAgent = vi.fn(async (opts: RunAgentOptions) => {
      captured = opts;
      opts.onEvent?.({ type: 'text', text: 'child' } as unknown as AgentEvent);
      opts.onEvent?.({ type: 'context_full' } as AgentEvent);
      budget.addTokens(5, 7);
      return stubResult({ finalText: 'child done', turns: 1, toolCalls: 2 });
    });
    const ctx = createToolContext(
      { task: 't', cwd: workDir },
      { emit: () => {}, record: () => {}, skillsByName: new Map(), webEnabled: true },
    );
    const delegator = createDelegator({
      opts: { task: 't', cwd: workDir, budget },
      ctx,
      emit: (e) => seen.push(e),
      provider: fakeProvider('openai'),
      model: 'gpt-x',
      apiUrlOverride: undefined,
      budget,
      delegateDepth: 0,
      runAgent: runAgent as unknown as (opts: RunAgentOptions) => Promise<AgentResult>,
    });
    const res = await delegator.spawnChild({ task: 'child task', maxTurns: 5 });
    expect(res.ok).toBe(true);
    expect(res.finalText).toBe('child done');
    expect(res.tokensUsed).toBe(12);
    expect(captured?.model).toBe('gpt-x');
    expect(captured?.delegateDepth).toBe(1);
    expect(captured?.task).toContain('child task');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'text', depth: 1 });
  });
});

describe('run-session', () => {
  function fakeProvider(id: Provider['id'], nativeCapable = false): Provider {
    return {
      id,
      createConversation: async () => 'cnv-fake',
      streamChat: async function* () {
        yield { type: 'text', text: 'hi' } as ProviderEvent;
      },
      supportsNativeTools: () => nativeCapable,
    };
  }

  function toolContext(): ToolContext {
    return createToolContext(
      { task: 't', cwd: workDir },
      { emit: () => {}, record: () => {}, skillsByName: new Map(), webEnabled: true },
    );
  }

  test('openRunSession in plan mode opens a conversation without an MCP bridge', async () => {
    const seen: AgentEvent[] = [];
    const states: unknown[] = [];
    const session = await openRunSession({
      opts: { task: 't', cwd: workDir, planMode: true, onRunState: (s) => states.push(s) },
      ctx: toolContext(),
      emit: (e) => seen.push(e),
      provider: fakeProvider('openai'),
      model: 'gpt-x',
      apiUrlOverride: undefined,
      webEnabled: true,
      delegateEnabled: true,
    });
    expect(session.mcpBridge).toBeNull();
    expect(session.conversationId).toBe('cnv-fake');
    expect(session.nativeMode).toBe(false);
    expect(session.toolDecls).toBeUndefined();
    expect(states).toEqual([{ conversationId: 'cnv-fake', nativeTools: false, turnsCompleted: 0 }]);
    expect(seen.some((e) => e.type === 'mcp_notice')).toBe(false);
  });

  test('openRunSession with forced native tools and no capable server errors', async () => {
    await expect(
      openRunSession({
        opts: { task: 't', cwd: workDir, toolProtocol: 'native' },
        ctx: toolContext(),
        emit: () => {},
        provider: fakeProvider('spycore', false),
        model: 'styx',
        apiUrlOverride: undefined,
        webEnabled: true,
        delegateEnabled: true,
      }),
    ).rejects.toThrow(/Native tool-use is not available for this run/);
  });
});

describe('run-dispatch', () => {
  function dispatcher(maxToolCallsPerTurn: number) {
    const seen: AgentEvent[] = [];
    const counters: TurnCounters = { toolCalls: 0, turnCallStart: 0, toolCallCapNote: null };
    const ctx = createToolContext(
      { task: 't', cwd: workDir },
      { emit: () => {}, record: () => {}, skillsByName: new Map(), webEnabled: true },
    );
    const { dispatchTurnCalls } = createRunDispatcher({
      opts: { task: 't', cwd: workDir },
      ctx,
      emit: (e) => seen.push(e),
      recordDelta: () => {},
      maxToolCallsPerTurn,
      counters,
    });
    return { seen, counters, dispatchTurnCalls };
  }

  test('a call with malformed arguments is never dispatched and gets an inline error', async () => {
    const { seen, counters, dispatchTurnCalls } = dispatcher(5);
    const results = await dispatchTurnCalls(1, [
      { tool: 'read_file', args: {}, argError: 'args must be an object', index: 0 },
    ]);
    expect(results).not.toBeNull();
    expect(results!).toHaveLength(1);
    expect(results![0]).toMatchObject({ ok: false, summary: 'invalid arguments' });
    expect(results![0]!.content).toContain('args must be an object');
    expect(counters.toolCalls).toBe(1);
    expect(seen.map((e) => e.type)).toEqual(['tool_call', 'tool_result']);
  });

  test('the per-turn cap skips later calls and emits tool_call_cap', async () => {
    const { seen, counters, dispatchTurnCalls } = dispatcher(1);
    const results = await dispatchTurnCalls(1, [
      { tool: 'no_such_tool', args: {}, argError: null, index: 0 },
      { tool: 'no_such_tool', args: {}, argError: null, index: 1 },
    ]);
    expect(results).not.toBeNull();
    expect(results!).toHaveLength(2);
    expect(results![0]).toMatchObject({ ok: false });
    expect(results![1]).toBeNull();
    expect(counters.toolCallCapNote).toMatch(/Tool-call cap reached \(1 calls this turn\)/);
    const cap = seen.find((e) => e.type === 'tool_call_cap') as { skipped?: number } | undefined;
    expect(cap?.skipped).toBe(1);
  });

  test('an aborted run mid-turn returns null', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const seen: AgentEvent[] = [];
    const counters: TurnCounters = { toolCalls: 0, turnCallStart: 0, toolCallCapNote: null };
    const ctx = createToolContext(
      { task: 't', cwd: workDir, signal: ctl.signal },
      { emit: () => {}, record: () => {}, skillsByName: new Map(), webEnabled: true },
    );
    const { dispatchTurnCalls } = createRunDispatcher({
      opts: { task: 't', cwd: workDir, signal: ctl.signal },
      ctx,
      emit: (e) => seen.push(e),
      recordDelta: () => {},
      maxToolCallsPerTurn: 5,
      counters,
    });
    const results = await dispatchTurnCalls(1, [
      { tool: 'read_file', args: { path: 'x.txt' }, argError: null, index: 0 },
    ]);
    expect(results).toBeNull();
  });
});
