import { describe, expect, test } from 'vitest';
import { jsonSafeEvent } from '../src/commands/agent.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';
import type { VerifyEvent } from '../src/lib/agent/verify.js';

/**
 * H-2 - the `--json` event stream must not carry raw tool arguments.
 *
 * A `tool_call` event's `args` is the full parsed argument object; MCP tool
 * args can hold secrets, and nothing downstream reads the field (the human
 * renderers and the TUI use the pre-rendered `arg` summary). The ACP server
 * still consumes `e.args` in-process - the drop happens at the JSON boundary
 * only, which is what these tests pin.
 */
describe('jsonSafeEvent', () => {
  test('drops args from tool_call events, keeping the rendered summary', () => {
    const e: AgentEvent = {
      type: 'tool_call',
      turn: 1,
      index: 0,
      tool: 'mcp__srv__do_thing',
      arg: 'do_thing …',
      args: { api_key: 'hunter2', verbose: true },
    };
    const out = jsonSafeEvent(e) as Record<string, unknown>;
    expect(out).not.toHaveProperty('args');
    expect(out.tool).toBe('mcp__srv__do_thing');
    expect(out.arg).toBe('do_thing …');
    // The serialized form is what actually leaves the process.
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  test('passes every other event type through untouched', () => {
    const events: AgentEvent[] = [
      { type: 'assistant_token', turn: 1, chunk: 'hello' },
      { type: 'tool_result', turn: 1, index: 0, tool: 'read_file', ok: true, summary: '12 lines' },
      { type: 'final', text: 'done' },
      { type: 'budget_stop', reason: 'turns', cap: 25, tokensUsed: 1, turnsUsed: 2, elapsedMs: 3 },
    ];
    for (const e of events) {
      expect(jsonSafeEvent(e)).toBe(e);
    }
  });

  test('passes verify events through untouched', () => {
    const e: VerifyEvent = {
      type: 'verify_result',
      command: 'npm test',
      attempt: 1,
      attempts: 3,
      passed: false,
      blocked: false,
      exitCode: 1,
      timedOut: false,
      outputTail: 'some output',
    };
    expect(jsonSafeEvent(e)).toBe(e);
  });
});
