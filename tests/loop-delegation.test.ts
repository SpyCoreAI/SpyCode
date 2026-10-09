/**
 * THE DELEGATION CONTRACT AND THE LSP TEARDOWN - refactor pins N6 and N8.
 *
 * The `delegate` back-end is a closure inside `runAgent` that calls `runAgent`
 * again for the child. The decomposition moves it into its own module and
 * injects `runAgent`, so every option the child inherits is re-threaded by
 * hand - and a dropped option is silent: the child simply runs with a default.
 * Each inherited option is pinned here by an effect the child can only show if
 * it really received it, and each non-inherited one by the effect of sharing it.
 *
 * Two module mocks: the MCP bridge (recording what each run hands to it - the
 * child's bridge call is the most direct witness of its approval gate, signal,
 * timeout and trust resolver - and able to register a probe tool that reaches
 * the run's `Delegator`), and the LSP manager (counting shutdowns).
 *
 * Each test was mutation-verified against the unchanged source: the mutation
 * named in its comment turns it red, and reverting turns it green again.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests } from '../src/lib/config.js';
import { runAgent, type AgentEvent, type AgentRunState, type RunAgentOptions } from '../src/lib/agent/loop.js';
import { createBudget } from '../src/lib/agent/budget.js';
import { DEFAULT_LIMITS } from '../src/lib/agent/tools.js';
import type { DelegateChildResult } from '../src/lib/agent/delegate.js';
import type { RecordedChange } from '../src/lib/agent/checkpoint.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';
import type { McpBridge, SetupMcpOptions } from '../src/lib/agent/mcp.js';
import type { CommandRule } from '../src/lib/agent/command-rules.js';
import { seedUserSkill } from './loop-golden-scenarios.js';
import {
  BYOK_ID,
  ScriptProvider,
  block,
  byTurn,
  extraTool,
  fakeBridge,
  removeDir,
  say,
  tempDir,
  type Script,
} from './loop-pin-harness.js';

const mcp = vi.hoisted(() => ({
  calls: [] as SetupMcpOptions[],
  bridge: null as null | ((opts: SetupMcpOptions) => Promise<McpBridge | null>),
}));
vi.mock('../src/lib/agent/mcp.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/agent/mcp.js')>();
  return {
    ...real,
    setupMcpBridge: (opts: SetupMcpOptions) => {
      mcp.calls.push(opts);
      return mcp.bridge ? mcp.bridge(opts) : real.setupMcpBridge(opts);
    },
  };
});

const lsp = vi.hoisted(() => ({ shutdowns: 0 }));
vi.mock('../src/lib/agent/lsp/manager.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/agent/lsp/manager.js')>();
  return {
    ...real,
    shutdownLspManagers: () => {
      lsp.shutdowns += 1;
      return Promise.resolve();
    },
  };
});

const dirs: string[] = [];
function workspace(prefix: string): string {
  const cwd = tempDir(prefix);
  dirs.push(cwd);
  writeFileSync(join(cwd, 'alpha.txt'), 'alpha line\n');
  return cwd;
}

beforeEach(() => {
  freshConfigDir();
  mcp.calls.length = 0;
  mcp.bridge = null;
  lsp.shutdowns = 0;
});

afterEach(() => {
  __resetConfigForTests();
  for (const d of dirs.splice(0)) removeDir(d);
});

const lines = (...parts: string[]): string => parts.join('\n');
const delegate = (task: string, extra: Record<string, unknown> = {}): string => block('delegate', { task, ...extra });

/** Conversation 1 is the parent, 2 the child, 3 the grandchild. */
function family(parent: string[], child: string[], grandchild: string[] = []): Script {
  const byConversation = [parent, child, grandchild];
  return ({ conversation, turn }) => say(byConversation[conversation - 1]?.[turn - 1] ?? `Done ${conversation}.`);
}

function at<T extends AgentEvent['type']>(events: AgentEvent[], type: T, depth: number | undefined): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type && e.depth === depth);
}

async function drive(
  provider: ScriptProvider,
  opts: Omit<RunAgentOptions, 'provider' | 'onEvent'>,
): Promise<{ result: Awaited<ReturnType<typeof runAgent>>; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const result = await runAgent({ ...opts, provider, onEvent: (e) => events.push(e) });
  return { result, events };
}

/** The system prompt the child (conversation 2) received. */
function childSystem(provider: ScriptProvider): string {
  const t = provider.turns.find((x) => x.conversationId === 'cnv_2' && x.system !== undefined);
  expect(t, 'the child never started').toBeDefined();
  return t!.system!;
}

const rule = (entry: string, kind: CommandRule['kind'], scope: CommandRule['scope']): CommandRule => ({
  entry,
  tokens: entry.split(' '),
  kind,
  scope,
});

describe('N6 delegation contract', () => {
  // Mutation: drop `planMode` from the child's options.
  test('N6 plan mode is inherited: the child plans and cannot write', async () => {
    const cwd = workspace('spycli-n6p-');
    const provider = new ScriptProvider({
      script: family([delegate('plan the work')], [block('write_file', { path: 'child.txt', content: 'x' })]),
    });
    const { events } = await drive(provider, { task: 'plan', cwd, planMode: true, model: 'm', requestApproval: () => Promise.resolve({ approved: true }) });
    expect(childSystem(provider)).toContain('in PLANNING MODE');
    expect(at(events, 'tool_result', 1).map((e) => [e.tool, e.ok, e.summary])).toEqual([['write_file', false, 'planning mode']]);
    expect(existsSync(join(cwd, 'child.txt'))).toBe(false);
  });

  test('N6 the child inherits the permission model and the run settings; it gets a fresh skill set and no run-state hook', async () => {
    seedUserSkill();
    const cwd = workspace('spycli-n6i-');
    const controller = new AbortController();
    const approvals: string[] = [];
    const approve: RequestApproval = (req) => {
      approvals.push(req.kind === 'command' ? req.command : req.kind);
      return Promise.resolve({ approved: true });
    };
    const trust = (): Promise<boolean> => Promise.resolve(false);
    const hookLog: string[] = [];
    const hooks: NonNullable<RunAgentOptions['hooks']> = {
      hasAny: true,
      preTool: (name, args) => {
        hookLog.push(`${name} ${JSON.stringify(args)}`);
        return Promise.resolve({ blocked: false, reason: null, notices: [] });
      },
      postTool: () => Promise.resolve({ feedback: null, notices: [] }),
    };
    const runStates: AgentRunState[] = [];
    const loaded = new Set<string>(['pin-guide']);
    const provider = new ScriptProvider({
      id: 'spycore',
      native: true,
      script: family(
        [delegate('do the child work')],
        [
          lines(
            block('read_file', { path: 'alpha.txt' }),
            block('run_command', { command: 'touch denied.txt' }),
            block('run_command', { command: 'true' }),
            block('load_skill', { name: 'pin-guide' }),
          ),
        ],
      ),
    });
    const { events } = await drive(provider, {
      task: 'inherit',
      cwd,
      toolProtocol: 'fenced',
      webTools: false,
      hooks,
      limits: { ...DEFAULT_LIMITS, maxFileBytes: 4 },
      commandRules: { allow: [], deny: [rule('touch', 'deny', 'user')] },
      commandTimeoutMs: 4321,
      observeWorkspace: true,
      projectContext: 'PARENT PROJECT CONTEXT',
      confirmProjectMcpTrust: trust,
      requestApproval: approve,
      signal: controller.signal,
      loadedSkills: loaded,
      onRunState: (s) => runStates.push({ ...s }),
    });
    const system = childSystem(provider);
    // Mutation: drop `projectContext`.
    expect(system, 'project context').toContain('PARENT PROJECT CONTEXT');
    // Mutation: drop `webTools`.
    expect(system, 'web switch').not.toContain('web_search');
    // Mutation: drop `toolProtocol` - the native-capable provider would then speak native to the child.
    expect(provider.turns.filter((t) => t.conversationId === 'cnv_2').map((t) => t.tools), 'protocol').toEqual([undefined, undefined]);
    // Mutation: drop `hooks`.
    expect(hookLog, 'hooks run around the child calls').toContain('read_file {"path":"alpha.txt"}');
    const childResults = at(events, 'tool_result', 1).map((e) => [e.tool, e.ok, e.summary]);
    expect(childResults).toEqual([
      // Mutation: drop `limits`.
      ['read_file', false, 'file too large to read (11 B); narrow with grep or offset/li…'],
      // Mutation: drop `commandRules`.
      ['run_command', false, 'denied by a command rule'],
      ['run_command', true, expect.stringMatching(/^exit 0 \(/) as unknown as string],
      // Mutation: share the parent's `loadedSkills` - the child would be told the skill is already loaded.
      ['load_skill', true, '2 lines'],
    ]);
    expect(existsSync(join(cwd, 'denied.txt'))).toBe(false);
    // Mutation: drop `observeWorkspace` - the child's opaque command would announce that observation is off.
    expect(at(events, 'hook_notice', 1), 'observe switch').toEqual([]);
    // Mutation: drop `requestApproval` - the allowed command would be refused for want of a gate.
    expect(approvals, 'the child asks the parent gate').toEqual(['true']);
    // The child's bridge call witnesses the rest of what it was handed.
    expect(mcp.calls).toHaveLength(2);
    const child = mcp.calls[1]!;
    expect(child.callTimeoutMs, 'commandTimeoutMs').toBe(4321);
    expect(child.confirmProjectMcpTrust, 'the MCP trust resolver').toBe(trust);
    expect(child.requestApproval, 'the approval gate itself').toBe(approve);
    expect(child.signal, 'the abort signal').toBe(controller.signal);
    // Mutation: hand the child `onRunState` - its own conversation id would masquerade as the parent's.
    expect([...new Set(runStates.map((s) => s.conversationId))], 'resume bookkeeping sees the parent only').toEqual(['cnv_1']);
    expect([...loaded], "the parent's skill set is untouched by the child").toEqual(['pin-guide']);
  });

  // Mutation: remove the depth clamp.
  test.each([
    ['NaN', Number.NaN, 1],
    ['-1', -1, 1],
    ['1.7', 1.7, 2],
  ])('N6 a delegateDepth of %s is clamped (raw %s): the child runs at depth %s', async (_label, raw, childDepth) => {
    const cwd = workspace('spycli-n6d-');
    const provider = new ScriptProvider({ script: family([delegate('nested')], ['Child answer.']) });
    const { events } = await drive(provider, { task: 'depth', cwd, model: 'm', delegateDepth: raw });
    expect(provider.turns[0]!.system, 'the parent may delegate').toContain('- delegate(');
    expect(events.filter((e) => e.type === 'final').map((e) => e.depth)).toEqual([childDepth, undefined]);
    const childCatalogue = childSystem(provider);
    if (childDepth === 2) expect(childCatalogue, 'a run at the max depth is not offered delegate').not.toContain('- delegate(');
    else expect(childCatalogue).toContain('- delegate(');
  });

  // Mutation: break the empty-model fallback.
  test('N6 a bring-your-own-key child takes an explicit model, and falls back to the parent model when it is empty', async () => {
    const cwd = workspace('spycli-n6m-');
    const provider = new ScriptProvider({
      id: BYOK_ID,
      script: ({ conversation, turn }) =>
        conversation === 1 && turn === 1
          ? say(lines(delegate('one', { model: 'child-explicit' }), delegate('two', { model: '' })))
          : say(`Done ${conversation}.`),
    });
    await drive(provider, { task: 'models', cwd, model: 'parent-model' });
    expect(provider.opened.map((o) => o.model)).toEqual(['parent-model', 'child-explicit', 'parent-model']);
  });

  // Mutation: overwrite the depth tag unconditionally.
  test('N6 child events carry depth 1 and a grandchild keeps depth 2', async () => {
    const cwd = workspace('spycli-n6g-');
    const provider = new ScriptProvider({ script: family([delegate('child')], [delegate('grandchild')], ['Grandchild answer.']) });
    const { events } = await drive(provider, { task: 'nesting', cwd, model: 'm' });
    expect(events.filter((e) => e.type === 'final').map((e) => [e.depth, e.type === 'final' ? e.text : ''])).toEqual([
      [2, 'Grandchild answer.'],
      [1, 'Done 2.'],
      [undefined, 'Done 1.'],
    ]);
    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.depth)).toEqual([1, undefined]);
  });

  // Mutation: drop the `context_full` filter.
  test("N6 a child's context_full is swallowed", async () => {
    const childTurns: Script = ({ turn }) =>
      turn === 1
        ? [{ type: 'text', text: block('read_file', { path: 'alpha.txt' }) }, { type: 'usage', input: 260_000, output: 1 }, { type: 'done' }]
        : say('Child done.');
    // Control: the same conversation run at the top level does reach the threshold.
    const controlCwd = workspace('spycli-n6c0-');
    const control = new ScriptProvider({ id: 'spycore', script: childTurns });
    const direct = await drive(control, { task: 'control', cwd: controlCwd, model: 'hermes' });
    expect(direct.events.filter((e) => e.type === 'context_full'), 'the control run never filled its context - this test would prove nothing').toHaveLength(1);

    const cwd = workspace('spycli-n6c-');
    const provider = new ScriptProvider({
      id: 'spycore',
      script: (at, params) => (at.conversation === 1 ? (at.turn === 1 ? say(delegate('fill it')) : say('Parent done.')) : childTurns(at, params)),
    });
    const { events } = await drive(provider, { task: 'context', cwd });
    expect(at(events, 'final', 1), 'the child ran to completion').toHaveLength(1);
    expect(events.filter((e) => e.type === 'context_full')).toEqual([]);
  });

  // Mutations: route the child's batch through the parent's batch sink; read the parent's sink once instead of live.
  test("N6 with a parent observation window open, each of the child's changes is journaled exactly once", async () => {
    const cwd = workspace('spycli-n6j-');
    const records: RecordedChange[] = [];
    const provider = new ScriptProvider({
      script: family(
        [delegate('change things')],
        [lines(block('write_file', { path: 'child-write.txt', content: 'w\n' }), block('run_command', { command: 'touch child-shell.txt' }))],
      ),
    });
    await drive(provider, {
      task: 'journal',
      cwd,
      model: 'm',
      observeWorkspace: true,
      requestApproval: () => Promise.resolve({ approved: true }),
      hooks: {
        hasAny: true,
        preTool: () => Promise.resolve({ blocked: false, reason: null, notices: [] }),
        postTool: () => Promise.resolve({ feedback: null, notices: [] }),
      },
      recordChange: (c) => records.push(c),
      recordChanges: (delta) => records.push(...delta),
    });
    expect(records.map((c) => basename(c.path)).sort()).toEqual(['child-shell.txt', 'child-write.txt']);
  });

  // Mutations: report the child's absolute budget turns instead of its delta; drop the stop note.
  test("N6 the child's budget spend is reported as a delta, with the stop note", async () => {
    const cwd = workspace('spycli-n6b-');
    let now = 0;
    const budget = createBudget({ maxTurns: 3 }, () => now);
    const spawned: DelegateChildResult[] = [];
    mcp.bridge = () =>
      Promise.resolve(
        fakeBridge([
          extraTool('mcp__probe__spawn', async (_args, ctx) => {
            spawned.push(await ctx.delegator!.spawnChild({ task: 'spend', maxTurns: 5 }));
            return { ok: true, summary: 'spawned', content: 'spawned' };
          }),
        ]),
      );
    const provider = new ScriptProvider({
      script: ({ conversation, turn }) => [
        () => {
          now += 1000;
        },
        ...say(conversation === 1 ? (turn === 1 ? block('mcp__probe__spawn', {}) : 'Parent done.') : block('read_file', { path: 'alpha.txt' }), 2, 3),
      ],
    });
    await drive(provider, { task: 'budget', cwd, model: 'm', budget });
    expect(spawned).toEqual([
      {
        ok: true,
        finalText: '',
        turns: 2,
        toolCalls: 2,
        tokensUsed: 10,
        turnsUsed: 2,
        budgetStop: 'turns',
        reachedMaxTurns: false,
        cancelled: false,
        stopNote: 'turn limit reached (3 / 3)',
      },
    ]);
  });
});

describe('N8 LSP teardown', () => {
  // Mutations: remove the depth guard; remove the shutdown call.
  test('N8 language servers are shut down once for a top-level run and never by a child run', async () => {
    const cwd = workspace('spycli-n8-');
    const provider = new ScriptProvider({ script: family([delegate('child')], ['Child answer.']) });
    const { events } = await drive(provider, { task: 'lsp', cwd, model: 'm' });
    expect(at(events, 'final', 1), 'the child ran').toHaveLength(1);
    expect(lsp.shutdowns).toBe(1);
  });

  test('N8 a run that never delegates also shuts them down exactly once', async () => {
    const cwd = workspace('spycli-n8b-');
    const provider = new ScriptProvider({ script: byTurn([say('Done.')]) });
    await drive(provider, { task: 'lsp', cwd, model: 'm' });
    expect(lsp.shutdowns).toBe(1);
  });
});
