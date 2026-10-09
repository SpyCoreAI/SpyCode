/**
 * RUN-SCOPED SEAMS OF `runAgent` - the refactor pins N4, N5, N9, N11, N12,
 * N13, N16, N17, N18, N20, N21 and N22.
 *
 * Decomposing `runAgent` turns its closures into factories in separate
 * modules. Each test here pins one seam that such a move can break without a
 * type error: run-scoped state hoisted to module scope, a counter threaded
 * through the wrong object, a context field dropped, a live read turned into
 * a copy, a notice level or text shifted. Every test drives the real loop
 * through a scripted provider; the only module mocks are the web API client
 * (so a web tool never leaves the process) and the MCP bridge (so a test can
 * register a probe tool - the default passes straight through).
 *
 * Each test was mutation-verified against the unchanged source: the mutation
 * named in its comment turns it red, and reverting turns it green again.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests } from '../src/lib/config.js';
import {
  CONTINUE_HINT,
  MAX_RETAINED_EVENTS,
  runAgent,
  type AgentEvent,
  type RunAgentOptions,
} from '../src/lib/agent/loop.js';
import { listSessions, type RecordedChange } from '../src/lib/agent/checkpoint.js';
import { createBudget } from '../src/lib/agent/budget.js';
import { DEFAULT_LIMITS, type ToolContext } from '../src/lib/agent/tools.js';
import { SpycoreCliError } from '../src/lib/errors.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';
import type { McpBridge, SetupMcpOptions } from '../src/lib/agent/mcp.js';
import type { CommandRule } from '../src/lib/agent/command-rules.js';
import type { ProviderEvent } from '../src/lib/providers/types.js';
import { seedUserSkill } from './loop-golden-scenarios.js';
import {
  ACCEPT,
  BYOK_ID,
  ScriptProvider,
  block,
  byTurn,
  deferred,
  extraTool,
  fakeBridge,
  nativeCalls,
  removeDir,
  say,
  tempDir,
  type ScriptStep,
} from './loop-pin-harness.js';

const api = vi.hoisted(() => ({
  posts: [] as Array<{ path: string; opts: Record<string, unknown> }>,
}));
vi.mock('../src/lib/api.js', () => {
  const post = (path: string, opts: Record<string, unknown>) => {
    api.posts.push({ path, opts });
    return Promise.resolve([]);
  };
  return { api: { get: post, post, put: post, patch: post, delete: post } };
});

const mcp = vi.hoisted(() => ({
  bridge: null as null | ((opts: SetupMcpOptions) => Promise<McpBridge | null>),
}));
vi.mock('../src/lib/agent/mcp.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/agent/mcp.js')>();
  return {
    ...real,
    setupMcpBridge: (opts: SetupMcpOptions) => (mcp.bridge ? mcp.bridge(opts) : real.setupMcpBridge(opts)),
  };
});

const dirs: string[] = [];
function workspace(prefix: string): string {
  const cwd = tempDir(prefix);
  dirs.push(cwd);
  writeFileSync(join(cwd, 'alpha.txt'), 'alpha line\n');
  writeFileSync(join(cwd, 'beta.txt'), 'beta one\nbeta two\n');
  writeFileSync(join(cwd, 'gamma.txt'), 'gamma\n');
  return cwd;
}

beforeEach(() => {
  freshConfigDir();
  api.posts.length = 0;
  mcp.bridge = null;
});

afterEach(() => {
  __resetConfigForTests();
  for (const d of dirs.splice(0)) removeDir(d);
});

const read = (path: string): string => block('read_file', { path });
const write = (path: string, content = `${path}\n`): string => block('write_file', { path, content });
const lines = (...parts: string[]): string => parts.join('\n');

/** Approve file writes, reject commands - no process is spawned. */
const WRITES_ONLY: RequestApproval = (req) =>
  Promise.resolve(req.kind === 'command' ? { approved: false, reason: 'rejected by user' } : { approved: true });

const OBSERVATION_OFF = 'workspace observation is off';

function only<T extends AgentEvent['type']>(events: AgentEvent[], type: T): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

async function drive(
  provider: ScriptProvider,
  opts: Omit<RunAgentOptions, 'provider' | 'onEvent'>,
): Promise<{ result: Awaited<ReturnType<typeof runAgent>>; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const result = await runAgent({ ...opts, provider, onEvent: (e) => events.push(e) });
  return { result, events };
}

// ─────────────────────────── N4 ───────────────────────────

describe('N4 per-run isolation', () => {
  // Mutations: hoist `saidUnobserved`, `emptyFinalRetried` or `persisted` to module scope.
  test('N4 two sequential runs in one process each warn once, each get their own nudge, each persist their own journal once', async () => {
    for (const n of [1, 2]) {
      const cwd = workspace('spycli-n4-');
      const provider = new ScriptProvider({
        script: byTurn([
          say(lines(write(`run${n}.txt`), block('run_command', { command: 'true' }), block('run_command', { command: 'true' }))),
          say(''),
          say(`Run ${n} done.`),
        ]),
      });
      const { result, events } = await drive(provider, { task: `isolation run ${n}`, cwd, requestApproval: WRITES_ONLY });
      expect(
        only(events, 'hook_notice').filter((e) => e.text.startsWith(OBSERVATION_OFF)).length,
        `run ${n}: the "observation is off" notice must fire exactly once per run`,
      ).toBe(1);
      expect(
        only(events, 'parse_error').filter((e) => e.message === 'empty reply - nudging once').length,
        `run ${n}: every run gets its own empty-reply nudge`,
      ).toBe(1);
      expect(result.finalText).toBe(`Run ${n} done.`);
      expect(
        listSessions(cwd).map((s) => [s.task, s.changes.map((c) => basename(c.path))]),
        `run ${n}: every run persists its own journal exactly once`,
      ).toEqual([[`isolation run ${n}`, [`run${n}.txt`]]]);
    }
  });
});

// ─────────────────────────── N5 ───────────────────────────

const capNote = (cap: number, skipped: number): string =>
  `Tool-call cap reached (${cap} calls this turn) - ${skipped} further call${skipped === 1 ? '' : 's'} skipped. Continue with the results so far.`;

describe('N5 per-turn cap and the tool-call counters', () => {
  // Mutations: drop the `turnCallStart` reset; `>=` → `>` in the cap check; drop the fenced cap-note push.
  test('N5 fenced serial calls: the cap stops the turn, resets on the next turn, and its note reaches the model', async () => {
    const cwd = workspace('spycli-n5s-');
    const provider = new ScriptProvider({
      script: byTurn([say(lines(write('a.txt'), write('b.txt'), write('c.txt'))), say(lines(write('d.txt'), write('e.txt'))), say('Done.')]),
    });
    const { result, events } = await drive(provider, { task: 'cap', cwd, requestApproval: ACCEPT, maxToolCallsPerTurn: 2 });
    const calls = only(events, 'tool_call');
    expect(calls.map((c) => [c.turn, c.args.path]), 'which calls ran').toEqual([
      [1, 'a.txt'],
      [1, 'b.txt'],
      [2, 'd.txt'],
      [2, 'e.txt'],
    ]);
    expect(result.toolCalls, 'AgentResult.toolCalls equals the tool_call events').toBe(calls.length);
    expect(only(events, 'tool_call_cap'), 'the cap fired once, on turn 1').toEqual([{ type: 'tool_call_cap', turn: 1, cap: 2, skipped: 1 }]);
    expect(provider.turns[1]!.message.endsWith(`${capNote(2, 1)}\n\n${CONTINUE_HINT}`), 'the cap note is the last block of the fenced continuation').toBe(true);
    expect(provider.turns[2]!.message, 'no stale cap note on a turn the cap did not fire').not.toContain('Tool-call cap reached');
  });

  // Mutation: `slice(0, remaining + 1)`.
  test('N5 fenced batch: a batch never starts more calls than the remaining allowance', async () => {
    const cwd = workspace('spycli-n5b-');
    const provider = new ScriptProvider({
      script: byTurn([say(lines(write('x.txt'), read('alpha.txt'), read('beta.txt'), read('gamma.txt'))), say('Done.')]),
    });
    const { result, events } = await drive(provider, { task: 'cap', cwd, requestApproval: ACCEPT, maxToolCallsPerTurn: 3 });
    const calls = only(events, 'tool_call');
    expect(calls.map((c) => c.args.path), 'the batch was cut to the remaining allowance').toEqual(['x.txt', 'alpha.txt', 'beta.txt']);
    expect(result.toolCalls).toBe(3);
    expect(only(events, 'tool_call_cap')).toEqual([{ type: 'tool_call_cap', turn: 1, cap: 3, skipped: 1 }]);
    expect(provider.turns[1]!.message).toContain(capNote(3, 1));
  });

  test('N5 native: malformed, serial and batched calls all count, and the cap note is the next message', async () => {
    const cwd = workspace('spycli-n5n-');
    const provider = new ScriptProvider({
      id: 'spycore',
      native: true,
      script: byTurn([
        nativeCalls([
          { id: 'c1', name: 'read_file', arguments: '{"path":' },
          { id: 'c2', name: 'write_file', arguments: '{"path":"w.txt","content":"w\\n"}' },
          { id: 'c3', name: 'read_file', arguments: '{"path":"alpha.txt"}' },
          { id: 'c4', name: 'read_file', arguments: '{"path":"beta.txt"}' },
        ]),
        say('Done.'),
      ]),
    });
    const { result, events } = await drive(provider, { task: 'cap', cwd, requestApproval: ACCEPT, maxToolCallsPerTurn: 3 });
    const calls = only(events, 'tool_call');
    expect(calls.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(result.toolCalls, 'malformed + serial + batched calls all count').toBe(3);
    expect(only(events, 'tool_call_cap')).toEqual([{ type: 'tool_call_cap', turn: 1, cap: 3, skipped: 1 }]);
    expect(provider.turns[1]!.message, 'native: the cap note is the next message').toBe(capNote(3, 1));
    expect(provider.turns[1]!.toolResults?.map((r) => r.id)).toEqual(['c1', 'c2', 'c3']);
  });
});

// ─────────────────────────── N9 ───────────────────────────

describe('N9 retained events', () => {
  // Mutations: change the splice bound; splice before push.
  test('N9 a run emitting more than 10,000 events retains exactly the last 10,000 while onEvent sees all', async () => {
    expect(MAX_RETAINED_EVENTS).toBe(10_000);
    const cwd = workspace('spycli-n9-');
    const chunks = 10_050;
    const provider = new ScriptProvider({
      script: () => [
        ...Array.from({ length: chunks }, (_, i): ScriptStep => ({ type: 'text', text: i % 2 === 0 ? 'a' : 'b' })),
        { type: 'usage', input: 1, output: 1 },
        { type: 'done' },
      ],
    });
    const { result, events } = await drive(provider, { task: 'flood', cwd });
    expect(events.length, 'onEvent sees every event').toBe(chunks + 1);
    expect(result.events.length, 'the retained log is capped').toBe(10_000);
    expect(result.events[0], 'the oldest events are the ones dropped').toBe(events[events.length - 10_000]);
    expect(result.events[result.events.length - 1]).toBe(events[events.length - 1]);
    expect(result.events).toEqual(events.slice(-10_000));
  });
});

// ─────────────────────────── N11 ───────────────────────────

describe('N11 budget payloads', () => {
  // Mutations: drop the `hasCaps` check; put another value in `turnsUsed`; drop `elapsedMs` from budget_stop.
  test('N11 budget and budget_stop carry tokensUsed, turnsUsed and elapsedMs', async () => {
    const cwd = workspace('spycli-n11-');
    let now = 0;
    const budget = createBudget({ maxTurns: 3 }, () => now);
    const tick: ScriptStep = () => {
      now += 1000;
    };
    const provider = new ScriptProvider({
      script: () => [tick, { type: 'text', text: read('alpha.txt') }, { type: 'usage', input: 3, output: 2 }, { type: 'done' }],
    });
    const { result, events } = await drive(provider, { task: 'budget', cwd, budget });
    expect(events.filter((e) => e.type === 'budget' || e.type === 'budget_stop')).toEqual([
      { type: 'budget', tokensUsed: 5, turnsUsed: 1, elapsedMs: 1000 },
      { type: 'budget', tokensUsed: 10, turnsUsed: 2, elapsedMs: 2000 },
      { type: 'budget', tokensUsed: 15, turnsUsed: 3, elapsedMs: 3000 },
      { type: 'budget_stop', reason: 'turns', cap: 3, tokensUsed: 15, turnsUsed: 3, elapsedMs: 3000 },
    ]);
    expect(result).toMatchObject({ turns: 3, budgetStop: 'turns', reachedMaxTurns: false });
  });

  test('N11 a budget with no caps emits no budget events', async () => {
    const cwd = workspace('spycli-n11b-');
    const budget = createBudget({});
    const provider = new ScriptProvider({ script: byTurn([say(read('alpha.txt')), say('Done.')]) });
    const { events } = await drive(provider, { task: 'budget', cwd, budget });
    expect(events.filter((e) => e.type === 'budget' || e.type === 'budget_stop')).toEqual([]);
  });
});

// ─────────────────────────── N12 ───────────────────────────

describe('N12 journal routing of the observation window', () => {
  const touch = (name: string): ScriptStep[] => say(block('run_command', { command: `touch ${name}` }));

  // Mutation: skip pushing the delta into `changes`.
  test('N12 a window record reaches the per-record sink and changedFiles', async () => {
    const cwd = workspace('spycli-n12a-');
    const records: RecordedChange[] = [];
    const provider = new ScriptProvider({ script: byTurn([touch('made-a.txt'), say('Done.')]) });
    const { result } = await drive(provider, {
      task: 'journal',
      cwd,
      requestApproval: ACCEPT,
      observeWorkspace: true,
      recordChange: (c) => records.push(c),
    });
    expect(records.map((c) => [basename(c.path), c.op])).toEqual([['made-a.txt', 'create']]);
    expect(result.changedFiles, 'window records count in changedFiles').toBe(1);
    expect(listSessions(cwd), 'an external recorder owns persistence').toEqual([]);
  });

  test('N12 a window delta goes to the batch sink as one batch when one is wired', async () => {
    const cwd = workspace('spycli-n12b-');
    const single: RecordedChange[] = [];
    const batches: RecordedChange[][] = [];
    const provider = new ScriptProvider({ script: byTurn([touch('made-b.txt'), say('Done.')]) });
    const { result } = await drive(provider, {
      task: 'journal',
      cwd,
      requestApproval: ACCEPT,
      observeWorkspace: true,
      recordChange: (c) => single.push(c),
      recordChanges: (d) => batches.push([...d]),
    });
    expect(batches.map((b) => b.map((c) => basename(c.path)))).toEqual([['made-b.txt']]);
    expect(single, 'the batch sink replaces the per-record sink').toEqual([]);
    expect(result.changedFiles).toBe(1);
  });

  test('N12 with no external recorder the window record is persisted with the run', async () => {
    const cwd = workspace('spycli-n12c-');
    const provider = new ScriptProvider({ script: byTurn([touch('made-c.txt'), say('Done.')]) });
    const { result } = await drive(provider, { task: 'journal', cwd, requestApproval: ACCEPT, observeWorkspace: true });
    expect(result.changedFiles).toBe(1);
    expect(listSessions(cwd).map((s) => s.changes.map((c) => basename(c.path)))).toEqual([['made-c.txt']]);
  });

  // Mutation: call the batch sink on an empty delta.
  test('N12 an empty delta makes no sink call', async () => {
    const cwd = workspace('spycli-n12d-');
    let singleCalls = 0;
    let batchCalls = 0;
    const provider = new ScriptProvider({ script: byTurn([say(block('run_command', { command: 'true' })), say('Done.')]) });
    const { result } = await drive(provider, {
      task: 'journal',
      cwd,
      requestApproval: ACCEPT,
      observeWorkspace: true,
      recordChange: () => {
        singleCalls += 1;
      },
      recordChanges: () => {
        batchCalls += 1;
      },
    });
    expect([singleCalls, batchCalls], 'a command that changes nothing reaches no sink').toEqual([0, 0]);
    expect(result.changedFiles).toBe(0);
  });
});

// ─────────────────────────── N13 ───────────────────────────

const rule = (entry: string, kind: CommandRule['kind'], scope: CommandRule['scope']): CommandRule => ({
  entry,
  tokens: entry.split(' '),
  kind,
  scope,
});

describe('N13 tool-context wiring through runAgent', () => {
  // Mutation: build the context with DEFAULT_LIMITS instead of `opts.limits`.
  test('N13 limits reach the tools', async () => {
    const cwd = workspace('spycli-n13l-');
    const provider = new ScriptProvider({ script: byTurn([say(read('alpha.txt')), say('Done.')]) });
    const { events } = await drive(provider, { task: 'limits', cwd, limits: { ...DEFAULT_LIMITS, maxFileBytes: 4 } });
    expect(only(events, 'tool_result').map((e) => [e.ok, e.summary])).toEqual([
      [false, 'file too large to read (11 B); narrow with grep or offset/li…'],
    ]);
  });

  // Mutation: drop `commandTimeoutMs` from the context.
  test('N13 commandTimeoutMs reaches run_command', async () => {
    const cwd = workspace('spycli-n13t-');
    const provider = new ScriptProvider({ script: byTurn([say(block('run_command', { command: 'sleep 3' })), say('Done.')]) });
    const { events } = await drive(provider, { task: 'timeout', cwd, requestApproval: ACCEPT, commandTimeoutMs: 1000 });
    const res = only(events, 'tool_result')[0]!;
    expect(res.ok).toBe(false);
    expect(res.summary).toMatch(/^timed out after 1s \(/);
  });

  // Mutation: drop `webToolsEnabled` from the context.
  test('N13 webTools: false makes dispatch reject a web tool', async () => {
    const cwd = workspace('spycli-n13w-');
    const provider = new ScriptProvider({ script: byTurn([say(block('web_search', { query: 'pinned query' })), say('Done.')]) });
    const { events } = await drive(provider, { task: 'web', cwd, webTools: false });
    expect(only(events, 'tool_result').map((e) => [e.ok, e.summary])).toEqual([[false, 'unknown tool']]);
    expect(api.posts, 'no web request left the process').toEqual([]);
  });

  // Mutation: drop `apiUrlOverride` from the context.
  test('N13 apiUrlOverride reaches the web tools', async () => {
    const cwd = workspace('spycli-n13a-');
    const provider = new ScriptProvider({ script: byTurn([say(block('web_search', { query: 'pinned query' })), say('Done.')]) });
    await drive(provider, { task: 'web', cwd, apiUrlOverride: 'http://127.0.0.1:9/pinned-api' });
    expect(api.posts.map((p) => [p.path, p.opts.apiUrlOverride])).toEqual([['/search', 'http://127.0.0.1:9/pinned-api']]);
  });

  // Mutation: give the context a fresh set instead of `opts.loadedSkills`.
  test('N13 a caller-supplied loadedSkills set is the one the tools use', async () => {
    seedUserSkill();
    const cwd = workspace('spycli-n13s-');
    const shared = new Set<string>();
    const first = new ScriptProvider({ script: byTurn([say(block('load_skill', { name: 'pin-guide' })), say('Done.')]) });
    const a = await drive(first, { task: 'skills', cwd, loadedSkills: shared });
    expect(only(a.events, 'tool_result').map((e) => e.summary)).toEqual(['2 lines']);
    expect([...shared], 'the load was recorded in the caller-supplied set').toEqual(['pin-guide']);
    const second = new ScriptProvider({ script: byTurn([say(block('load_skill', { name: 'pin-guide' })), say('Done.')]) });
    const b = await drive(second, { task: 'skills', cwd, loadedSkills: shared });
    expect(only(b.events, 'tool_result').map((e) => e.summary), 'a later phase sharing the set sees the earlier load').toEqual(['already loaded']);
  });

  // Mutations: drop `commandRules` / `onCommandRuleNotice` from the context.
  test('N13 command rules and their notices, with the exact notice texts', async () => {
    const cwd = workspace('spycli-n13r-');
    const provider = new ScriptProvider({
      script: byTurn([say(lines(block('run_command', { command: 'echo pin allowed' }), block('run_command', { command: 'touch nope.txt' }))), say('Done.')]),
    });
    const { events } = await drive(provider, {
      task: 'rules',
      cwd,
      commandRules: { allow: [rule('echo pin', 'allow', 'project')], deny: [rule('touch', 'deny', 'user')] },
    });
    expect(only(events, 'rule_notice')).toEqual([
      { type: 'rule_notice', level: 'info', text: 'auto-approved by the project allow rule "echo pin": echo pin allowed' },
      { type: 'rule_notice', level: 'warn', text: 'denied by the user deny rule "touch": touch nope.txt' },
    ]);
    expect(only(events, 'tool_result').map((e) => [e.ok, e.kind])).toEqual([
      [true, 'command'],
      [false, 'rejected'],
    ]);
    expect(existsSync(join(cwd, 'nope.txt'))).toBe(false);
  });

  // Mutation: drop `planMode` from the context.
  test('N13 plan mode reaches dispatch', async () => {
    const cwd = workspace('spycli-n13p-');
    const provider = new ScriptProvider({ script: byTurn([say(write('planned.txt')), say('1. Plan.')]) });
    const { events } = await drive(provider, { task: 'plan', cwd, planMode: true, requestApproval: ACCEPT });
    expect(only(events, 'tool_result').map((e) => [e.ok, e.summary])).toEqual([[false, 'planning mode']]);
    expect(existsSync(join(cwd, 'planned.txt'))).toBe(false);
  });
});

// ─────────────────────────── N16 ───────────────────────────

describe('N16 lifecycle-hook bridge', () => {
  type Hooks = NonNullable<RunAgentOptions['hooks']>;

  test('N16 notice levels, blocked texts, no post hook after a block, and the feedback separator', async () => {
    const cwd = workspace('spycli-n16-');
    const log: string[] = [];
    const hooks: Hooks = {
      hasAny: true,
      preTool: (name, args) => {
        log.push(`pre ${name} ${String(args.path)}`);
        if (args.path === 'with-reason.txt') return Promise.resolve({ blocked: true, reason: 'pinned reason', notices: ['pre notice'] });
        if (args.path === 'no-reason.txt') return Promise.resolve({ blocked: true, reason: null, notices: [] });
        return Promise.resolve({ blocked: false, reason: null, notices: [] });
      },
      postTool: (name, ok, summary) => {
        log.push(`post ${name} ${ok} ${summary}`);
        return Promise.resolve({ feedback: 'POST FEEDBACK', notices: ['post notice'] });
      },
    };
    const provider = new ScriptProvider({
      id: 'spycore',
      native: true,
      script: byTurn([
        nativeCalls([
          { id: 'r', name: 'read_file', arguments: '{"path":"alpha.txt"}' },
          { id: 'w1', name: 'write_file', arguments: '{"path":"with-reason.txt","content":"x"}' },
          { id: 'w2', name: 'write_file', arguments: '{"path":"no-reason.txt","content":"x"}' },
        ]),
        say('Done.'),
      ]),
    });
    const { events } = await drive(provider, { task: 'hooks', cwd, requestApproval: ACCEPT, hooks });
    // Mutations: swap the pre-tool or the post-tool notice level.
    expect(
      only(events, 'hook_notice').filter((e) => !e.text.startsWith(OBSERVATION_OFF)).map((e) => [e.level, e.text]),
      'pre-tool notices are warn, post-tool notices are info',
    ).toEqual([
      ['info', 'post notice'],
      ['warn', 'pre notice'],
    ]);
    // Mutation: run the post-tool hook after a block.
    expect(log, 'a blocked call never reaches the post-tool hook').toEqual([
      'pre read_file alpha.txt',
      'post read_file true 2 lines',
      'pre write_file with-reason.txt',
      'pre write_file no-reason.txt',
    ]);
    const results = provider.turns[1]!.toolResults!;
    // Mutation: change the feedback separator.
    expect(results[0]!.content, 'feedback is appended after a blank line').toBe('alpha line\n\n\nPOST FEEDBACK');
    // Mutations: change the blocked text with / without a reason.
    expect(results[1]!.content).toBe(
      'Error: this tool call was blocked by a user pre-tool hook - pinned reason. Do not retry the same call; adjust your approach or finish without it.',
    );
    expect(results[2]!.content).toBe(
      'Error: this tool call was blocked by a user pre-tool hook. Do not retry the same call; adjust your approach or finish without it.',
    );
    expect(only(events, 'tool_result').map((e) => [e.index, e.ok, e.summary])).toEqual([
      [0, true, '2 lines'],
      [1, false, 'blocked by a user hook'],
      [2, false, 'blocked by a user hook'],
    ]);
    expect(existsSync(join(cwd, 'with-reason.txt')) || existsSync(join(cwd, 'no-reason.txt'))).toBe(false);
  });

  // Mutations: let a throwing pre-tool or post-tool hook escape.
  test('N16 a throwing hook is isolated: the call still runs and the run finishes', async () => {
    const cwd = workspace('spycli-n16t-');
    const hooks: Hooks = {
      hasAny: true,
      preTool: () => Promise.reject(new Error('pre hook exploded')),
      postTool: () => Promise.reject(new Error('post hook exploded')),
    };
    const provider = new ScriptProvider({ script: byTurn([say(write('kept.txt')), say('Done.')]) });
    const { result, events } = await drive(provider, { task: 'hooks', cwd, requestApproval: ACCEPT, hooks });
    expect(result.finalText).toBe('Done.');
    expect(only(events, 'tool_result').map((e) => [e.ok, e.kind])).toEqual([[true, 'applied']]);
    expect(readFileSync(join(cwd, 'kept.txt'), 'utf8')).toBe('kept.txt\n');
  });
});

// ─────────────────────────── N17 ───────────────────────────

/** The (type, index) sequence of depth-0 tool events. */
function toolSequence(events: AgentEvent[]): string[] {
  return events
    .filter((e) => (e.type === 'tool_call' || e.type === 'tool_result') && e.depth === undefined)
    .map((e) => `${e.type === 'tool_call' ? 'call' : 'result'} ${(e as { index: number }).index}`);
}

describe('N17 dispatch scheduling', () => {
  // Mutation: make `delegate` parallelizable.
  test('N17 delegate runs serially: the child runs before its call is announced, between its neighbours', async () => {
    const cwd = workspace('spycli-n17d-');
    const provider = new ScriptProvider({
      script: ({ conversation, turn }) =>
        conversation === 1
          ? turn === 1
            ? say(lines(read('alpha.txt'), block('delegate', { task: 'look around' }), read('beta.txt')))
            : say('Parent done.')
          : say('Child done.'),
    });
    const { events } = await drive(provider, { task: 'delegate', cwd, model: 'byok-model' });
    expect(toolSequence(events)).toEqual(['call 0', 'result 0', 'call 1', 'result 1', 'call 2', 'result 2']);
    const childFinal = events.findIndex((e) => e.type === 'final' && e.depth === 1);
    const delegateCall = events.findIndex((e) => e.type === 'tool_call' && e.tool === 'delegate');
    expect(childFinal, 'the child ran').toBeGreaterThan(-1);
    expect(childFinal, 'a serial call is announced after it ran').toBeLessThan(delegateCall);
  });

  // Mutation: make unknown tools parallelizable.
  test('N17 an unknown tool runs serially', async () => {
    const cwd = workspace('spycli-n17u-');
    const provider = new ScriptProvider({
      script: byTurn([say(lines(read('alpha.txt'), block('no_such_tool', {}), read('beta.txt'))), say('Done.')]),
    });
    const { events } = await drive(provider, { task: 'unknown', cwd });
    expect(toolSequence(events)).toEqual(['call 0', 'result 0', 'call 1', 'result 1', 'call 2', 'result 2']);
    expect(only(events, 'tool_result')[1]).toMatchObject({ tool: 'no_such_tool', ok: false, summary: 'unknown tool' });
  });

  // Mutation: emit each batched call's result right after its call.
  test('N17 a batch announces every call before any result', async () => {
    const cwd = workspace('spycli-n17b-');
    const provider = new ScriptProvider({
      script: byTurn([say(lines(read('alpha.txt'), read('beta.txt'), read('gamma.txt'))), say('Done.')]),
    });
    const { events } = await drive(provider, { task: 'batch', cwd });
    expect(toolSequence(events)).toEqual(['call 0', 'call 1', 'call 2', 'result 0', 'result 1', 'result 2']);
  });

  // Mutations: count a malformed call zero times; change its event shape.
  test('N17 a malformed-arguments call: its event shape, and it counts as a tool call', async () => {
    const cwd = workspace('spycli-n17m-');
    const provider = new ScriptProvider({
      id: 'spycore',
      native: true,
      script: byTurn([
        nativeCalls([
          { id: 'm', name: 'read_file', arguments: '{"path":' },
          { id: 'ok', name: 'read_file', arguments: '{"path":"alpha.txt"}' },
        ]),
        say('Done.'),
      ]),
    });
    const { result, events } = await drive(provider, { task: 'malformed', cwd });
    expect(events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result').slice(0, 2)).toEqual([
      { type: 'tool_call', turn: 1, index: 0, tool: 'read_file', arg: '', args: {} },
      {
        type: 'tool_result',
        turn: 1,
        index: 0,
        tool: 'read_file',
        ok: false,
        summary: 'invalid arguments',
        kind: undefined,
        added: undefined,
        removed: undefined,
        isNew: undefined,
        command: undefined,
        outputTail: undefined,
      },
    ]);
    expect(result.toolCalls).toBe(2);
  });

  // Mutations: drop the abort check between calls; report `turn - 1` turns.
  test('N17 an abort between calls returns cancelled with the current turn', async () => {
    const cwd = workspace('spycli-n17a-');
    const controller = new AbortController();
    const approve: RequestApproval = () => {
      controller.abort();
      return Promise.resolve({ approved: true });
    };
    const provider = new ScriptProvider({ script: byTurn([say(lines(write('first.txt'), write('second.txt'))), say('Done.')]) });
    const { result } = await drive(provider, { task: 'abort', cwd, requestApproval: approve, signal: controller.signal });
    expect(result).toMatchObject({ cancelled: true, turns: 1, toolCalls: 1, finalText: '' });
    expect(existsSync(join(cwd, 'second.txt')), 'the call after the abort never ran').toBe(false);
  });

  // Mutation: hand the batch the shared context instead of a copy.
  test('N17 a hooked read-only batch runs on context copies: the shared context is never left swapped', async () => {
    const cwd = workspace('spycli-n17c-');
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    writeFileSync(join(cwd, 'b.txt'), 'b\n');
    const seen: Array<Pick<ToolContext, 'recordChange' | 'requestApproval'>> = [];
    mcp.bridge = () =>
      Promise.resolve(
        fakeBridge([
          extraTool('mcp__probe__look', (_args, ctx) => {
            seen.push({ recordChange: ctx.recordChange, requestApproval: ctx.requestApproval });
            return Promise.resolve({ ok: true, summary: 'looked', content: 'looked' });
          }),
        ]),
      );
    // The batch's two windows must overlap and close in the order they opened:
    // the first pre-tool hook waits for the second call to arrive, and the
    // second waits until the first has finished and its window has closed.
    let hooksOn = false;
    const arrivals: string[] = [];
    const secondArrived = deferred();
    const releaseSecond = deferred();
    let posts = 0;
    const hooks: NonNullable<RunAgentOptions['hooks']> = {
      get hasAny() {
        return hooksOn;
      },
      async preTool(_name, args) {
        arrivals.push(String(args.path));
        if (arrivals.length === 1) await secondArrived.promise;
        else {
          secondArrived.resolve();
          await releaseSecond.promise;
        }
        return { blocked: false, reason: null, notices: [] };
      },
      postTool() {
        posts += 1;
        if (posts === 1) setTimeout(() => releaseSecond.resolve(), 0);
        return Promise.resolve({ feedback: null, notices: [] });
      },
    };
    const records: RecordedChange[] = [];
    const provider = new ScriptProvider({
      script: byTurn([
        say(block('mcp__probe__look', {})),
        [
          () => {
            hooksOn = true;
          },
          ...say(lines(read('a.txt'), read('b.txt'))),
        ],
        [
          () => {
            hooksOn = false;
          },
          ...say(lines(block('mcp__probe__look', {}), write('after.txt'))),
        ],
        say('Done.'),
      ]),
    });
    const { events } = await drive(provider, {
      task: 'copies',
      cwd,
      requestApproval: ACCEPT,
      observeWorkspace: true,
      hooks,
      recordChange: (c) => records.push(c),
    });
    expect(arrivals.sort(), 'both batched calls went through the hooks').toEqual(['a.txt', 'b.txt']);
    expect(only(events, 'tool_result').map((e) => [e.tool, e.ok])).toEqual([
      ['mcp__probe__look', true],
      ['read_file', true],
      ['read_file', true],
      ['mcp__probe__look', true],
      ['write_file', true],
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.recordChange, 'the shared context kept its own recordChange').toBe(seen[0]!.recordChange);
    expect(seen[1]!.requestApproval, 'the shared context kept its own requestApproval').toBe(seen[0]!.requestApproval);
    expect(records.map((c) => basename(c.path)), 'a write after the hooked batch journals exactly once').toEqual(['after.txt']);
  });
});

// ─────────────────────────── N18 ───────────────────────────

describe('N18 protocol texts', () => {
  async function nativeRefusal(provider: ScriptProvider, cwd: string): Promise<SpycoreCliError> {
    const err = await runAgent({ task: 'native', cwd, provider, toolProtocol: 'native', model: 'm' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SpycoreCliError);
    return err as SpycoreCliError;
  }

  // Mutation: swap the two hint texts.
  test('N18 forcing native without server support: the SpyCore hint', async () => {
    const cwd = workspace('spycli-n18s-');
    const err = await nativeRefusal(new ScriptProvider({ id: 'spycore', native: false, script: byTurn([]) }), cwd);
    expect([err.message, err.hint]).toEqual([
      'Native tool-use is not available for this run.',
      'The server did not advertise native tool-use (older deployment). Omit --tool-protocol, or pass --tool-protocol fenced.',
    ]);
  });

  test('N18 forcing native with a bring-your-own-key provider errors with its own hint', async () => {
    const cwd = workspace('spycli-n18b-');
    const err = await nativeRefusal(new ScriptProvider({ id: BYOK_ID, native: true, script: byTurn([]) }), cwd);
    expect([err.message, err.hint]).toEqual([
      'Native tool-use is not available for this run.',
      'BYOK providers use the fenced protocol - omit --tool-protocol.',
    ]);
  });

  // Mutation: ask the capability check about something other than the conversation id.
  test('N18 the capability check is asked about the conversation the run uses', async () => {
    const cwd = workspace('spycli-n18c-');
    const fresh = new ScriptProvider({ id: 'spycore', native: true, script: byTurn([say('Done.')]) });
    await runAgent({ task: 'cap', cwd, provider: fresh });
    expect(fresh.capabilityChecks).toEqual(['cnv_1']);
    expect(fresh.turns[0]!.tools, 'native mode was negotiated').toBeDefined();
    const cont = new ScriptProvider({ id: 'spycore', native: true, script: byTurn([say('Done.')]) });
    await cont.createConversation({ model: 'charon' });
    await runAgent({ task: 'cap', cwd, provider: cont, conversationId: 'cnv_1' });
    expect(cont.capabilityChecks).toEqual(['cnv_1']);
  });

  // Mutation: change the default continuation message.
  test('N18 a continuation sends the continue message, defaulting to "Continue the task."', async () => {
    const cwd = workspace('spycli-n18m-');
    const p1 = new ScriptProvider({ script: byTurn([say('Done.')]) });
    await runAgent({ task: 'ignored', cwd, provider: p1, conversationId: 'cnv_existing' });
    expect(p1.turns.map((t) => [t.conversationId, t.message, t.system])).toEqual([['cnv_existing', 'Continue the task.', undefined]]);
    expect(p1.opened, 'a continuation opens no conversation').toEqual([]);
    const p2 = new ScriptProvider({ script: byTurn([say('Done.')]) });
    await runAgent({ task: 'ignored', cwd, provider: p2, conversationId: 'cnv_existing', continueMessage: 'Fix the failing test.' });
    expect(p2.turns.map((t) => t.message)).toEqual(['Fix the failing test.']);
  });
});

// ─────────────────────────── N20 ───────────────────────────

describe('N20 persistence and result defaults', () => {
  // Mutations: persist twice; skip persisting without a recorder.
  test('N20 without an external recorder the journal is persisted exactly once', async () => {
    const cwd = workspace('spycli-n20a-');
    const provider = new ScriptProvider({ script: byTurn([say(lines(write('one.txt'), write('two.txt'))), say('Done.')]) });
    const { result } = await drive(provider, { task: 'persist', cwd, requestApproval: ACCEPT });
    expect(result.changedFiles).toBe(2);
    expect(listSessions(cwd).map((s) => [s.task, s.changes.map((c) => basename(c.path))])).toEqual([['persist', ['one.txt', 'two.txt']]]);
  });

  test('N20 with an external recorder nothing is persisted by the loop', async () => {
    const cwd = workspace('spycli-n20b-');
    const records: RecordedChange[] = [];
    const provider = new ScriptProvider({ script: byTurn([say(write('one.txt')), say('Done.')]) });
    const { result } = await drive(provider, { task: 'persist', cwd, requestApproval: ACCEPT, recordChange: (c) => records.push(c) });
    expect(records.map((c) => basename(c.path))).toEqual(['one.txt']);
    expect(result.changedFiles).toBe(1);
    expect(listSessions(cwd)).toEqual([]);
  });

  test('N20 a run with nothing changed persists nothing', async () => {
    const cwd = workspace('spycli-n20c-');
    const provider = new ScriptProvider({ script: byTurn([say(read('alpha.txt')), say('Done.')]) });
    await drive(provider, { task: 'persist', cwd });
    expect(listSessions(cwd)).toEqual([]);
  });

  // Mutation: flip a default.
  test('N20 result defaults: not cancelled, not at the limit, no budget stop, changedFiles and the retained events', async () => {
    const cwd = workspace('spycli-n20d-');
    const provider = new ScriptProvider({ script: byTurn([say('Plain answer.')]) });
    const { result, events } = await drive(provider, { task: 'defaults', cwd });
    expect(result).toEqual({
      finalText: 'Plain answer.',
      turns: 1,
      toolCalls: 0,
      reachedMaxTurns: false,
      cancelled: false,
      events,
      changedFiles: 0,
      conversationId: 'cnv_1',
      budgetStop: null,
    });
  });
});

// ─────────────────────────── N21 ───────────────────────────

describe('N21 loop control', () => {
  // Mutation: keep `pendingSystem` (and the attachments) after turn 1.
  test('N21 the system prompt and the attachments ride turn 1 only', async () => {
    const cwd = workspace('spycli-n21s-');
    const provider = new ScriptProvider({ id: 'spycore', script: byTurn([say(read('alpha.txt')), say('Done.')]) });
    await runAgent({ task: 'once', cwd, provider, attachments: ['file_1'] });
    expect(provider.turns.map((t) => [typeof t.system, t.attachments])).toEqual([
      ['string', ['file_1']],
      ['undefined', undefined],
    ]);
  });

  // Mutation: rethrow a 'Cancelled' error.
  test("N21 a provider 'Cancelled' error ends the run as cancelled", async () => {
    const cwd = workspace('spycli-n21c-');
    const provider = new ScriptProvider({ script: byTurn([[{ type: 'error', message: 'Cancelled' }]]) });
    const { result } = await drive(provider, { task: 'cancel', cwd });
    expect(result).toMatchObject({ cancelled: true, turns: 0, finalText: '' });
  });

  test('N21 a provider throw after the signal aborted ends the run as cancelled', async () => {
    const cwd = workspace('spycli-n21a-');
    const controller = new AbortController();
    const provider = new ScriptProvider({
      script: byTurn([
        [
          () => {
            controller.abort();
            throw new Error('socket hang up');
          },
        ],
      ]),
    });
    const { result } = await drive(provider, { task: 'cancel', cwd, signal: controller.signal });
    expect(result).toMatchObject({ cancelled: true, turns: 0, finalText: '' });
  });

  test('N21 any other provider error propagates', async () => {
    const cwd = workspace('spycli-n21e-');
    const provider = new ScriptProvider({ script: byTurn([[{ type: 'error', message: 'quota exceeded' }]]) });
    await expect(runAgent({ task: 'err', cwd, provider })).rejects.toThrow('quota exceeded');
  });

  // Mutation: remove the mid-stream time check.
  test('N21 a time budget that runs out mid-stream discards the reply: nothing is dispatched', async () => {
    const cwd = workspace('spycli-n21t-');
    let now = 0;
    const budget = createBudget({ maxTimeMs: 5_000 }, () => now);
    const shouldStopSeen: boolean[] = [];
    const provider = new ScriptProvider({
      script: (_at, params) => [
        { type: 'text', text: write('never.txt') },
        () => {
          now += 10_000;
          shouldStopSeen.push(params.shouldStop?.() === true);
        },
        { type: 'usage', input: 1, output: 1 },
        { type: 'done' },
      ],
    });
    const { result, events } = await drive(provider, { task: 'time', cwd, budget, requestApproval: ACCEPT });
    expect(shouldStopSeen, 'the provider can poll the time budget mid-stream').toEqual([true]);
    expect(result).toMatchObject({ turns: 1, toolCalls: 0, budgetStop: 'time', finalText: '' });
    expect(only(events, 'tool_call'), 'the partial reply is never acted on').toEqual([]);
    expect(only(events, 'budget_stop').map((e) => [e.reason, e.cap])).toEqual([['time', 5_000]]);
    expect(existsSync(join(cwd, 'never.txt'))).toBe(false);
  });

  // Mutation: drop `onToken`.
  test('N21 streamed tokens are emitted with their turn', async () => {
    const cwd = workspace('spycli-n21k-');
    const provider = new ScriptProvider({
      script: byTurn([
        [{ type: 'text', text: 'Reading ' }, { type: 'text', text: read('alpha.txt') }, { type: 'usage', input: 1, output: 1 }, { type: 'done' }],
        say('Done.'),
      ]),
    });
    const { events } = await drive(provider, { task: 'tokens', cwd });
    expect(only(events, 'assistant_token').map((e) => [e.turn, e.chunk])).toEqual([
      [1, 'Reading '],
      [1, read('alpha.txt')],
      [2, 'Done.'],
    ]);
  });
});

// ─────────────────────────── N22 ───────────────────────────

describe('N22 native-turn edges', () => {
  // Mutation: drop the `turn < maxTurns` guard on the native nudge.
  test('N22 the native nudge needs a turn left: on the last turn an empty reply is the final answer', async () => {
    const cwd = workspace('spycli-n22n-');
    const empty: ProviderEvent[] = [{ type: 'usage', input: 1, output: 1 }, { type: 'done' }];
    const provider = new ScriptProvider({ id: 'spycore', native: true, script: byTurn([empty, say('unreached')]) });
    const { result, events } = await drive(provider, { task: 'nudge', cwd, maxTurns: 1 });
    expect(result).toMatchObject({ finalText: '', turns: 1, reachedMaxTurns: false });
    expect(only(events, 'parse_error')).toEqual([]);
    expect(only(events, 'final')).toEqual([{ type: 'final', text: '' }]);
  });

  // Mutation: drop `clampToWireMax` on native tool results.
  test('N22 native tool results are clamped to the wire maximum even with raised limits', async () => {
    const cwd = workspace('spycli-n22c-');
    writeFileSync(join(cwd, 'big.txt'), `${'y'.repeat(50_000)}\n`);
    const provider = new ScriptProvider({
      id: 'spycore',
      native: true,
      script: byTurn([nativeCalls([{ id: 'b', name: 'read_file', arguments: '{"path":"big.txt"}' }]), say('Done.')]),
    });
    await drive(provider, { task: 'clamp', cwd, limits: { ...DEFAULT_LIMITS, maxResultChars: 100_000 } });
    const content = provider.turns[1]!.toolResults![0]!.content;
    expect(content.length).toBe(32_000);
    expect(content.endsWith('\n\n[result truncated to 32000 characters]')).toBe(true);
  });

  // The turn limit applies AFTER dispatch: the last turn's calls still run.
  // Mutation: check the turn limit before dispatching.
  test('N22 on the last turn the calls are dispatched, then the run stops at the limit', async () => {
    const cwd = workspace('spycli-n22l-');
    const provider = new ScriptProvider({
      id: 'spycore',
      native: true,
      script: byTurn([nativeCalls([{ id: 'w', name: 'write_file', arguments: '{"path":"last.txt","content":"z"}' }])]),
    });
    const { result, events } = await drive(provider, { task: 'limit', cwd, maxTurns: 1, requestApproval: ACCEPT });
    expect(existsSync(join(cwd, 'last.txt')), 'the last turn was dispatched').toBe(true);
    expect(result).toMatchObject({ turns: 1, toolCalls: 1, reachedMaxTurns: true, finalText: '' });
    expect(only(events, 'max_turns')).toEqual([{ type: 'max_turns', turns: 1 }]);
    expect(provider.turns, 'no further model round-trip').toHaveLength(1);
  });

  // Mutation: report `turn - 1` turns for a native abort.
  test('N22 an abort during native dispatch returns cancelled with the current turn', async () => {
    const cwd = workspace('spycli-n22a-');
    const controller = new AbortController();
    const approve: RequestApproval = () => {
      controller.abort();
      return Promise.resolve({ approved: true });
    };
    const provider = new ScriptProvider({
      id: 'spycore',
      native: true,
      script: byTurn([
        nativeCalls([
          { id: 'w1', name: 'write_file', arguments: '{"path":"n1.txt","content":"1"}' },
          { id: 'w2', name: 'write_file', arguments: '{"path":"n2.txt","content":"2"}' },
        ]),
      ]),
    });
    const { result } = await drive(provider, { task: 'abort', cwd, requestApproval: approve, signal: controller.signal });
    expect(result).toMatchObject({ cancelled: true, turns: 1, toolCalls: 1, finalText: '' });
    expect(existsSync(join(cwd, 'n2.txt'))).toBe(false);
  });
});
