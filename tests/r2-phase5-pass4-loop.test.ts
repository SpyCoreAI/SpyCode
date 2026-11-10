import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import {
  runAgent,
  type AgentEvent,
} from '../src/lib/agent/loop.js';
import type { McpBridge, SetupMcpOptions } from '../src/lib/agent/mcp.js';
import {
  ACCEPT,
  byTurn,
  nativeCalls,
  removeDir,
  say,
  ScriptProvider,
  tempDir,
} from './loop-pin-harness.js';

/**
 * Phase 5 pass 4, R2-12: the fenced agent loop discards BYOK native
 * `tool_calls`. A BYOK model answering in wire format (tool_calls-only
 * turn, no text) used to get zero dispatches and an "empty reply" nudge,
 * while the identical script on a native-capable SpyCore stub dispatched.
 * The loop now treats a non-empty replyToolCalls as actionable in fenced
 * mode too, feeding results back in the fenced continuation shape.
 *
 * The test below fails on the pre-fix tree (zero tool_call events, final
 * text '' after the nudge is exhausted - verified by stashing the loop
 * fix; see the fix log).
 */

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
  return cwd;
}

function only<T extends AgentEvent['type']>(events: AgentEvent[], type: T): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

beforeEach(() => {
  freshConfigDir();
  api.posts = [];
  mcp.bridge = null;
});
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe('R2-12 fenced loop dispatches BYOK native tool_calls', () => {
  test('a BYOK tool_calls-only turn dispatches read_file and the run completes', async () => {
    const cwd = workspace('spycli-r2p4-12-');
    // BYOK stub: id 'openai', native capability false → fenced mode.
    // Turn 1 yields ONLY a tool_calls event for read_file (+ usage + done);
    // turn 2 yields the final text.
    const provider = new ScriptProvider({
      script: byTurn([
        nativeCalls([{ id: 'call-1', name: 'read_file', arguments: '{"path":"alpha.txt"}' }]),
        say('Done.'),
      ]),
    });
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'read alpha',
      cwd,
      provider,
      requestApproval: ACCEPT,
      onEvent: (e) => events.push(e),
    });
    const calls = only(events, 'tool_call');
    expect(calls.map((c) => [c.turn, c.args.path])).toEqual([[1, 'alpha.txt']]);
    expect(result.finalText).toBe('Done.');
    expect(result.toolCalls).toBe(1);
    expect(
      only(events, 'parse_error').filter((e) => e.message === 'empty reply - nudging once'),
    ).toEqual([]);
    // The dispatched result reached the model as the fenced continuation:
    // turn 2's message carries the file content.
    expect(provider.turns[1]?.message).toContain('alpha line');
  });

  test('a BYOK turn with malformed native arguments feeds the error back instead of dispatching', async () => {
    const cwd = workspace('spycli-r2p4-12b-');
    const provider = new ScriptProvider({
      script: byTurn([
        nativeCalls([{ id: 'call-1', name: 'read_file', arguments: '{not json' }]),
        say('Done.'),
      ]),
    });
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'read alpha',
      cwd,
      provider,
      requestApproval: ACCEPT,
      onEvent: (e) => events.push(e),
    });
    // The malformed call is recorded (a tool_call event, args {}) but never
    // executed: its tool_result is ok:false / 'invalid arguments', exactly
    // as the native branch handles malformed arguments.
    const results = only(events, 'tool_result');
    expect(results.map((r) => [r.turn, r.tool, r.ok, r.summary])).toEqual([
      [1, 'read_file', false, 'invalid arguments'],
    ]);
    expect(result.finalText).toBe('Done.');
    // The argument error was fed back in-band, so turn 2's message says so.
    expect(provider.turns[1]?.message).toContain('not valid JSON');
  });
});
