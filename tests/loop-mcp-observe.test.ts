/**
 * THE MCP BRIDGE LIFECYCLE, THE OBSERVATION WINDOW'S EDGES AND THE NATIVE
 * DECLARATIONS - refactor pins N7, N15 and N19.
 *
 * The decomposition moves the bridge bring-up and the protocol negotiation into
 * one module and the observation window into another. What can break silently:
 * the bridge started in plan mode, a teardown path dropped, an option no longer
 * forwarded, a notice level or text shifted, a swapped context field not
 * restored, an observation error escaping, a declaration option lost.
 *
 * Two module mocks, both passing straight through to the real code unless a
 * test overrides a function: the MCP bridge (so a test controls the bridge the
 * run receives) and the workspace-delta primitives (so a test can make the
 * snapshot or the diff fail, or force a notice, on demand).
 *
 * Each test was mutation-verified against the unchanged source: the mutation
 * named in its comment turns it red, and reverting turns it green again.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests } from '../src/lib/config.js';
import { runAgent, type AgentEvent, type RunAgentOptions } from '../src/lib/agent/loop.js';
import { toolNames, type ToolContext } from '../src/lib/agent/tools.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';
import type { McpBridge, SetupMcpOptions } from '../src/lib/agent/mcp.js';
import type { ProviderEvent } from '../src/lib/providers/types.js';
import {
  ACCEPT,
  ScriptProvider,
  block,
  byTurn,
  extraTool,
  fakeBridge,
  removeDir,
  say,
  tempDir,
  type FakeBridge,
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

const wd = vi.hoisted(() => ({
  snapshot: null as null | (() => Promise<null>),
  diff: null as null | (() => Promise<never>),
  uncaptured: null as null | string,
}));
vi.mock('../src/lib/agent/workspace-delta.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/agent/workspace-delta.js')>();
  return {
    ...real,
    snapshotWorkspace: (cwd: string) => (wd.snapshot ? wd.snapshot() : real.snapshotWorkspace(cwd)),
    diffWorkspace: (...args: Parameters<typeof real.diffWorkspace>) => (wd.diff ? wd.diff() : real.diffWorkspace(...args)),
    uncapturedNotice: (u: readonly string[]) => (wd.uncaptured !== null ? wd.uncaptured : real.uncapturedNotice(u)),
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
  wd.snapshot = null;
  wd.diff = null;
  wd.uncaptured = null;
});

afterEach(() => {
  __resetConfigForTests();
  for (const d of dirs.splice(0)) removeDir(d);
});

const OBSERVATION_OFF = 'workspace observation is off';
const REJECT_COMMANDS: RequestApproval = (req) =>
  Promise.resolve(req.kind === 'command' ? { approved: false, reason: 'rejected by user' } : { approved: true });

async function drive(
  provider: ScriptProvider,
  opts: Omit<RunAgentOptions, 'provider' | 'onEvent'>,
): Promise<{ result: Awaited<ReturnType<typeof runAgent>>; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const result = await runAgent({ ...opts, provider, onEvent: (e) => events.push(e) });
  return { result, events };
}

const notices = (events: AgentEvent[]): Array<[string, string]> =>
  events.filter((e): e is Extract<AgentEvent, { type: 'hook_notice' }> => e.type === 'hook_notice' && e.depth === undefined).map((e) => [e.level, e.text]);

function useBridge(make: () => FakeBridge): FakeBridge[] {
  const made: FakeBridge[] = [];
  mcp.bridge = () => {
    const b = make();
    made.push(b);
    return Promise.resolve(b);
  };
  return made;
}

const looking = () => extraTool('mcp__probe__look', () => Promise.resolve({ ok: true, summary: 'looked', content: 'looked' }));

// ─────────────────────────── N7 ───────────────────────────

describe('N7 MCP bridge lifecycle', () => {
  // Mutation: remove the plan-mode skip.
  test('N7 plan mode never brings the bridge up', async () => {
    const cwd = workspace('spycli-n7p-');
    const made = useBridge(() => fakeBridge([looking()]));
    await drive(new ScriptProvider({ script: byTurn([say('1. Plan.')]) }), { task: 'plan', cwd, planMode: true, model: 'm' });
    expect(mcp.calls).toHaveLength(0);
    expect(made).toHaveLength(0);
  });

  // Mutations: change the tool plural; change the server plural.
  test.each([
    [1, 1, '1 MCP tool from 1 server'],
    [3, 2, '3 MCP tools from 2 servers'],
  ])('N7 the ready notice for %s tool(s) from %s server(s)', async (tools, servers, text) => {
    const cwd = workspace('spycli-n7n-');
    useBridge(() =>
      fakeBridge(
        Array.from({ length: tools }, (_, i) => extraTool(`mcp__s__t${i}`, () => Promise.resolve({ ok: true, summary: '', content: '' }))),
        servers,
      ),
    );
    const { events } = await drive(new ScriptProvider({ script: byTurn([say('Done.')]) }), { task: 'n', cwd, model: 'm' });
    expect(events.filter((e) => e.type === 'mcp_notice')).toEqual([{ type: 'mcp_notice', level: 'info', text }]);
  });

  test('N7 a bridge with no tools is silent', async () => {
    const cwd = workspace('spycli-n7z-');
    useBridge(() => fakeBridge([], 1));
    const { events } = await drive(new ScriptProvider({ script: byTurn([say('Done.')]) }), { task: 'n', cwd, model: 'm' });
    expect(events.filter((e) => e.type === 'mcp_notice')).toEqual([]);
  });

  // Mutations: drop the forwarded call timeout / signal / approval gate / trust resolver / warning sink.
  test('N7 the bridge receives the run cwd, signal, approval gate, call timeout, trust resolver and a warning sink', async () => {
    const cwd = workspace('spycli-n7o-');
    mcp.bridge = (opts) => {
      opts.onWarn?.('server "x" failed to start');
      return Promise.resolve(fakeBridge([]));
    };
    const controller = new AbortController();
    const trust = (): Promise<boolean> => Promise.resolve(false);
    const { events } = await drive(new ScriptProvider({ script: byTurn([say('Done.')]) }), {
      task: 'o',
      cwd,
      model: 'm',
      signal: controller.signal,
      requestApproval: ACCEPT,
      commandTimeoutMs: 7777,
      confirmProjectMcpTrust: trust,
    });
    expect(mcp.calls).toHaveLength(1);
    const o = mcp.calls[0]!;
    expect([o.cwd, o.signal, o.requestApproval, o.callTimeoutMs, o.confirmProjectMcpTrust]).toEqual([cwd, controller.signal, ACCEPT, 7777, trust]);
    expect(o.requestApproval).toBe(ACCEPT);
    expect(events.filter((e) => e.type === 'mcp_notice')).toEqual([{ type: 'mcp_notice', level: 'warn', text: 'server "x" failed to start' }]);
  });

  // Mutation: remove the `finally` shutdown.
  test('N7 the bridge shuts down after a final answer', async () => {
    const cwd = workspace('spycli-n7f-');
    const made = useBridge(() => fakeBridge([looking()]));
    await drive(new ScriptProvider({ script: byTurn([say(block('mcp__probe__look', {})), say('Done.')]) }), { task: 'f', cwd, model: 'm' });
    expect(made.map((b) => b.shutdowns)).toEqual([1]);
  });

  test('N7 the bridge shuts down when the provider throws mid-run', async () => {
    const cwd = workspace('spycli-n7e-');
    const made = useBridge(() => fakeBridge([looking()]));
    const boom: ProviderEvent[] = [{ type: 'error', message: 'provider exploded' }];
    await expect(
      runAgent({ task: 'e', cwd, model: 'm', provider: new ScriptProvider({ script: byTurn([boom]) }) }),
    ).rejects.toThrow('provider exploded');
    expect(made.map((b) => b.shutdowns)).toEqual([1]);
  });

  // Mutation: remove the shutdown in the native-unavailable branch.
  test('N7 the bridge shuts down before the native-unavailable error is thrown', async () => {
    const cwd = workspace('spycli-n7x-');
    const made = useBridge(() => fakeBridge([looking()]));
    await expect(
      runAgent({ task: 'x', cwd, toolProtocol: 'native', provider: new ScriptProvider({ id: 'spycore', native: false, script: byTurn([]) }) }),
    ).rejects.toThrow('Native tool-use is not available for this run.');
    expect(made.map((b) => b.shutdowns)).toEqual([1]);
  });

  // CHARACTERIZATION, NOT ENDORSEMENT. When opening the conversation fails, the
  // already-started bridge is NOT shut down: the try/finally that tears it down
  // begins after the conversation is open. That is a known defect, recorded for
  // a separate fix; v0.9.2 is a pure refactor and preserves it exactly. The fix
  // flips this assertion on purpose.
  // Mutation: shut the bridge down when the conversation cannot be opened.
  test('N7 (known defect, preserved) a conversation that cannot be opened leaves the bridge running', async () => {
    const cwd = workspace('spycli-n7c-');
    const made = useBridge(() => fakeBridge([looking()]));
    const provider = new ScriptProvider({ script: byTurn([]) });
    provider.createConversation = () => Promise.reject(new Error('cannot open'));
    await expect(runAgent({ task: 'c', cwd, model: 'm', provider })).rejects.toThrow('cannot open');
    expect(made.map((b) => b.shutdowns)).toEqual([0]);
  });
});

// ─────────────────────────── N15 ───────────────────────────

describe('N15 observation-window edges', () => {
  // Mutations: classify write_file / edit_file / delegate / a non-mutating extra tool as opaque.
  test('N15 self-reporting and read-only calls are not opaque: they never announce that observation is off', async () => {
    const cwd = workspace('spycli-n15o-');
    useBridge(() =>
      fakeBridge([
        looking(),
        extraTool('mcp__probe__change', () => Promise.resolve({ ok: true, summary: 'changed', content: 'changed' }), { mutating: true }),
      ]),
    );
    const run = async (reply: string): Promise<Array<[string, string]>> => {
      const provider = new ScriptProvider({
        script: ({ conversation, turn }) => (conversation === 1 && turn === 1 ? say(reply) : say('Done.')),
      });
      const { events } = await drive(provider, { task: 'opaque', cwd, model: 'm', requestApproval: REJECT_COMMANDS });
      return notices(events).filter(([, t]) => t.startsWith(OBSERVATION_OFF));
    };
    expect(await run(block('write_file', { path: 'w.txt', content: 'w' })), 'write_file').toEqual([]);
    expect(await run(block('edit_file', { path: 'alpha.txt', old_str: 'alpha', new_str: 'ALPHA' })), 'edit_file').toEqual([]);
    expect(await run(block('delegate', { task: 'answer' })), 'delegate').toEqual([]);
    expect(await run(block('mcp__probe__look', {})), 'a non-mutating extra tool').toEqual([]);
    // Controls: the opaque shapes do announce it.
    expect(await run(block('run_command', { command: 'true' })), 'run_command').toHaveLength(1);
    expect(await run(block('mcp__probe__change', {})), 'a mutating extra tool').toHaveLength(1);

    // PRECEDENCE. The self-reporting names are excluded BEFORE an extra tool's
    // `mutating` flag is consulted, so an extra tool registered under one of
    // those names is still not opaque. Bridge names are always `mcp__…`, so this
    // order is unreachable in production - which is exactly why nothing else
    // would notice if the explicit exclusions were dropped in the move.
    useBridge(() =>
      fakeBridge(
        ['write_file', 'edit_file', 'delegate'].map((name) =>
          extraTool(name, () => Promise.resolve({ ok: true, summary: 'shadow', content: 'shadow' }), { mutating: true }),
        ),
      ),
    );
    expect(await run(block('write_file', {})), 'write_file wins over a mutating extra tool of that name').toEqual([]);
    expect(await run(block('edit_file', {})), 'edit_file wins over a mutating extra tool of that name').toEqual([]);
    expect(await run(block('delegate', {})), 'delegate wins over a mutating extra tool of that name').toEqual([]);
  });

  // Mutations: drop the "too large to journal" notice; change its level; let a snapshot error escape.
  test.each([
    ['returns nothing', () => Promise.resolve(null)],
    ['throws', () => Promise.reject(new Error('snapshot failed'))],
  ])('N15 a workspace whose snapshot %s is reported, at warn, for an opaque call', async (_label, snapshot) => {
    const cwd = workspace('spycli-n15t-');
    wd.snapshot = snapshot as () => Promise<null>;
    const provider = new ScriptProvider({ script: byTurn([say(block('run_command', { command: 'true' })), say('Done.')]) });
    const { result, events } = await drive(provider, { task: 'large', cwd, model: 'm', requestApproval: ACCEPT, observeWorkspace: true });
    expect(notices(events)).toEqual([
      ['warn', 'workspace too large to journal - changes made by "run_command" are NOT undoable with `spycore rewind`'],
    ]);
    expect(result.finalText).toBe('Done.');
  });

  // Mutation: change the pause-notice level.
  test('N15 a change made while the approval prompt is open is reported at info', async () => {
    const cwd = workspace('spycli-n15p-');
    const approve: RequestApproval = () => {
      writeFileSync(join(cwd, 'alpha.txt'), 'edited by the user while deciding\n');
      return Promise.resolve({ approved: true });
    };
    const provider = new ScriptProvider({ script: byTurn([say(block('run_command', { command: 'true' })), say('Done.')]) });
    const { events } = await drive(provider, { task: 'pause', cwd, model: 'm', requestApproval: approve, observeWorkspace: true });
    const found = notices(events);
    expect(found).toHaveLength(1);
    expect(found[0]![0]).toBe('info');
    expect(found[0]![1]).toContain('alpha.txt');
  });

  // Mutation: change the uncaptured-notice level.
  test('N15 an uncaptured change is reported at warn', async () => {
    const cwd = workspace('spycli-n15u-');
    wd.uncaptured = '1 changed file could not be journaled (pinned)';
    const provider = new ScriptProvider({ script: byTurn([say(block('run_command', { command: 'true' })), say('Done.')]) });
    const { events } = await drive(provider, { task: 'uncaptured', cwd, model: 'm', requestApproval: ACCEPT, observeWorkspace: true });
    expect(notices(events)).toEqual([['warn', '1 changed file could not be journaled (pinned)']]);
  });

  // Mutation: let a diff error escape.
  test('N15 a failing diff never breaks the run', async () => {
    const cwd = workspace('spycli-n15d-');
    wd.diff = () => Promise.reject(new Error('diff failed'));
    const provider = new ScriptProvider({ script: byTurn([say(block('run_command', { command: 'true' })), say('Done.')]) });
    const { result, events } = await drive(provider, { task: 'diff', cwd, model: 'm', requestApproval: ACCEPT, observeWorkspace: true });
    expect(result.finalText).toBe('Done.');
    expect(events.filter((e) => e.type === 'tool_result').map((e) => (e.type === 'tool_result' ? e.ok : null))).toEqual([true]);
  });

  // Mutations: skip restoring recordChange; skip restoring requestApproval.
  test('N15 after a window closes, the context has its own recordChange and requestApproval back', async () => {
    const cwd = workspace('spycli-n15r-');
    const seen: Array<Pick<ToolContext, 'recordChange' | 'requestApproval'>> = [];
    useBridge(() =>
      fakeBridge([
        extraTool('mcp__probe__look', (_args, ctx) => {
          seen.push({ recordChange: ctx.recordChange, requestApproval: ctx.requestApproval });
          return Promise.resolve({ ok: true, summary: 'looked', content: 'looked' });
        }),
      ]),
    );
    const provider = new ScriptProvider({
      script: byTurn([say(block('mcp__probe__look', {})), say(block('run_command', { command: 'true' })), say(block('mcp__probe__look', {})), say('Done.')]),
    });
    await drive(provider, { task: 'restore', cwd, model: 'm', requestApproval: ACCEPT, observeWorkspace: true });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.recordChange, 'recordChange restored').toBe(seen[0]!.recordChange);
    expect(seen[1]!.requestApproval, 'requestApproval restored').toBe(seen[0]!.requestApproval);
  });
});

// ─────────────────────────── N19 ───────────────────────────

describe('N19 native declarations through the loop', () => {
  const native = (): ScriptProvider => new ScriptProvider({ id: 'spycore', native: true, script: byTurn([say('Done.')]) });

  // Mutation: drop `extraTools` from the declaration options.
  test('N19 the declarations carry the MCP tools after the built-ins', async () => {
    const cwd = workspace('spycli-n19m-');
    useBridge(() => fakeBridge([looking()]));
    const provider = native();
    await runAgent({ task: 'decl', cwd, provider });
    expect(provider.turns[0]!.tools).toEqual([...toolNames(), 'mcp__probe__look']);
  });

  // Mutation: drop `webEnabled` from the declaration options.
  test('N19 webTools: false removes the web tools from the declarations', async () => {
    const cwd = workspace('spycli-n19w-');
    const provider = native();
    await runAgent({ task: 'decl', cwd, provider, webTools: false });
    expect(provider.turns[0]!.tools).toEqual(toolNames().filter((n) => n !== 'web_search' && n !== 'fetch_url'));
  });

  // Mutation: drop `delegateEnabled` from the declaration options.
  test('N19 a run at the maximum delegation depth is not offered delegate', async () => {
    const cwd = workspace('spycli-n19d-');
    const provider = native();
    await runAgent({ task: 'decl', cwd, provider, delegateDepth: 2 });
    expect(provider.turns[0]!.tools).toEqual(toolNames().filter((n) => n !== 'delegate'));
  });

  test('N19 plan mode declares only the read-only tools', async () => {
    const cwd = workspace('spycli-n19p-');
    const provider = native();
    await runAgent({ task: 'decl', cwd, provider, planMode: true });
    expect(provider.turns[0]!.tools).toEqual(toolNames().filter((n) => !['write_file', 'edit_file', 'run_command'].includes(n)));
  });

  test('N19 every turn re-declares the same tools', async () => {
    const cwd = workspace('spycli-n19t-');
    const provider = new ScriptProvider({
      id: 'spycore',
      native: true,
      script: byTurn([
        [{ type: 'tool_calls', calls: [{ id: 'r', name: 'read_file', arguments: '{"path":"alpha.txt"}' }] }, { type: 'usage', input: 1, output: 1 }, { type: 'done' }],
        say('Done.'),
      ]),
    });
    await runAgent({ task: 'decl', cwd, provider, webTools: false });
    expect(provider.turns.map((t) => t.tools)).toEqual([provider.turns[0]!.tools, provider.turns[0]!.tools]);
    expect(provider.turns[0]!.tools).not.toContain('web_search');
  });
});

