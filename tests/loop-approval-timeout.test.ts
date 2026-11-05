/**
 * APPROVAL TIME IS NOT DISPATCH TIME - refactor pin N14.
 *
 * Every dispatch runs under a 10-minute watchdog, and the loop tells the
 * watchdog when an approval prompt is open so a human's decision time is never
 * billed against the tool. The flag lives in a closure the decomposition moves
 * into its own module; a dropped assignment, or a copy taken at construction,
 * leaves every long approval to time out instead.
 *
 * Driven through `runAgent` under fake interval timers and a fake clock (real
 * I/O and real timeouts otherwise), so 11 minutes pass in milliseconds. The
 * control proves the fake clock really drives the watchdog through the loop -
 * without it the pin could pass simply because no time passed at all.
 *
 * Mutation-verified against the unchanged source: deleting the
 * `isApprovalInFlight` wiring turns it red, and reverting turns it green again.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests } from '../src/lib/config.js';
import { runAgent, type AgentEvent } from '../src/lib/agent/loop.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';
import type { McpBridge, SetupMcpOptions } from '../src/lib/agent/mcp.js';
import { ScriptProvider, block, byTurn, extraTool, fakeBridge, removeDir, say, tempDir } from './loop-pin-harness.js';

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

const ELEVEN_MINUTES = 11 * 60_000;
let cwd: string | undefined;

beforeEach(() => {
  freshConfigDir();
  mcp.bridge = null;
  cwd = tempDir('spycli-n14-');
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  __resetConfigForTests();
  removeDir(cwd);
});

function results(events: AgentEvent[]): Array<[string, boolean, string]> {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result')
    .map((e) => [e.tool, e.ok, e.summary]);
}

describe('N14 approval-in-flight', () => {
  test('N14 a write whose approval stays open for 11 minutes completes without a dispatch timeout', async () => {
    let decided = false;
    const approve: RequestApproval = async () => {
      await vi.advanceTimersByTimeAsync(ELEVEN_MINUTES);
      decided = true;
      return { approved: true };
    };
    const provider = new ScriptProvider({
      script: byTurn([say(block('write_file', { path: 'slow.txt', content: 'decided\n' })), say('Done.')]),
    });
    const events: AgentEvent[] = [];
    await runAgent({ task: 'slow approval', cwd: cwd!, provider, model: 'm', requestApproval: approve, onEvent: (e) => events.push(e) });
    expect(decided, 'the approval really stayed open for the whole stretch').toBe(true);
    expect(results(events)).toEqual([['write_file', true, '+1']]);
    expect(readFileSync(join(cwd!, 'slow.txt'), 'utf8')).toBe('decided\n');
  });

  test('N14 control: the same 11 minutes outside an approval prompt do trip the timeout', async () => {
    mcp.bridge = () =>
      Promise.resolve(
        fakeBridge([
          extraTool('mcp__probe__wait', async () => {
            await vi.advanceTimersByTimeAsync(ELEVEN_MINUTES);
            return { ok: true, summary: 'waited', content: 'waited' };
          }),
        ]),
      );
    const provider = new ScriptProvider({ script: byTurn([say(block('mcp__probe__wait', {})), say('Done.')]) });
    const events: AgentEvent[] = [];
    await runAgent({ task: 'slow tool', cwd: cwd!, provider, model: 'm', onEvent: (e) => events.push(e) });
    expect(results(events)).toEqual([['mcp__probe__wait', false, 'tool dispatch timed out after 600s']]);
  });
});
