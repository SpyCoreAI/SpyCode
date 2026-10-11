/**
 * A-8 - mid-turn steering: a user message arriving mid-run is folded into
 * the next turn's message at the next step boundary (message path, never the
 * system prompt), and late steers after settle are refused.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { runAgent, type AgentRunHandle } from '../src/lib/agent/loop.js';
import type { Provider, ProviderEvent } from '../src/lib/providers/types.js';

let dir = '';
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = '';
  }
});

function scriptedSteerProvider(seen: string[], onFirstTurn: () => void, fixtureFile: string): Provider {
  let turn = 0;
  return {
    id: 'openai',
    async createConversation(): Promise<string> {
      return 'cnv_steer';
    },
    async *streamChat(params: { message: string }): AsyncIterable<ProviderEvent> {
      turn += 1;
      seen.push(params.message);
      if (turn === 1) onFirstTurn(); // steer arrives mid-turn
      // Turn 1 calls a tool (so the run continues); turn 2 is the final answer.
      const text =
        turn === 1
          ? 'Reading the file first.\n```spycore:tool\n{"tool": "read_file", "args": {"path": "' +
            fixtureFile +
            '"}}\n```'
          : 'done, deadline noted';
      yield { type: 'text', text };
      yield { type: 'usage', input: 10, output: 10 };
      yield { type: 'done' };
    },
  };
}

describe('mid-turn steering', () => {
  test('a steer mid-turn folds into the next turn message as a USER STEER section', async () => {
    dir = mkdtempSync(join(tmpdir(), 'spycode-steer-'));
    const fixture = join(dir, 'notes.txt');
    writeFileSync(fixture, 'hello\n', 'utf8');
    const seen: string[] = [];
    let handle: AgentRunHandle | null = null;
    const result = await runAgent({
      task: 'write the report',
      cwd: dir,
      provider: scriptedSteerProvider(
        seen,
        () => {
          expect(handle).not.toBeNull();
          expect(handle!.steer('the deadline is friday')).toBe(true);
        },
        fixture,
      ),
      toolProtocol: 'fenced',
      maxTurns: 5,
      requestApproval: () => Promise.resolve({ approved: true }),
      onHandle: (h) => {
        handle = h;
      },
    });
    expect(result.turns).toBeGreaterThanOrEqual(2);
    // Turn 1 predates the steer; turn 2 carries it.
    expect(seen[0]).not.toContain('the deadline is friday');
    expect(seen[1]).toContain('USER STEER');
    expect(seen[1]).toContain('the deadline is friday');
    // The system prompt is untouched - the steer rides the message only.
    expect(seen[1]).not.toContain('SYSTEM');
  });

  test('empty steers are refused and late steers after settle are refused', async () => {
    dir = mkdtempSync(join(tmpdir(), 'spycode-steer-'));
    let handle: AgentRunHandle | null = null;
    await runAgent({
      task: 'hi',
      cwd: dir,
      provider: scriptedSteerProvider([], () => {}, join(dir, 'x.txt')),
      toolProtocol: 'fenced',
      maxTurns: 2,
      requestApproval: () => Promise.resolve({ approved: true }),
      onHandle: (h) => {
        handle = h;
      },
    });
    expect(handle).not.toBeNull();
    expect(handle!.steer('   ')).toBe(false);
    expect(handle!.steer('too late')).toBe(false);
  });
});
