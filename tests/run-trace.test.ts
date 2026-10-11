/**
 * A-5 - structured trace tests: writer commits atomically, scrubs secrets,
 * and round-trips through the reader; trace ids list newest-first.
 */
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  createRunTraceWriter,
  listRunTraces,
  readRunTrace,
  runTracePath,
} from '../src/lib/agent/run-trace.js';

const DIR = join(tmpdir(), `spycode-trace-test-${process.pid}`);

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

describe('createRunTraceWriter', () => {
  test('writes header + events + result, atomically on close', () => {
    const w = createRunTraceWriter({ traceId: 'trace-1', task: 'do the thing', model: 'hermes', detached: false, configDir: DIR });
    // Nothing touches disk until close().
    expect(existsSync(runTracePath('trace-1', DIR))).toBe(false);
    w.append({ type: 'assistant_token', turn: 1, chunk: 'hello' });
    w.append({ type: 'tool_call', turn: 1, index: 0, tool: 'read_file', arg: 'x.ts', args: { path: 'x.ts' } });
    const path = w.close({
      finalText: 'done',
      turns: 1,
      toolCalls: 1,
      changedFiles: 0,
      cancelled: false,
      reachedMaxTurns: false,
      budgetStop: null,
    });
    expect(path).toBe(runTracePath('trace-1', DIR));
    expect(existsSync(path)).toBe(true);

    const lines = readRunTrace('trace-1', DIR);
    expect(lines).not.toBeNull();
    expect(lines!.length).toBe(4);
    expect(lines![0]).toMatchObject({ v: 1, traceId: 'trace-1', task: 'do the thing', model: 'hermes', detached: false });
    expect(lines![1]).toMatchObject({ type: 'assistant_token', turn: 1, chunk: 'hello' });
    expect(lines![3]).toMatchObject({ v: 1 });
    expect((lines![3] as { result: { finalText: string } }).result).toMatchObject({
      finalText: 'done',
      turns: 1,
      toolCalls: 1,
    });
  });

  test('scrubs secrets from events and the task before they touch disk', () => {
    const w = createRunTraceWriter({
      traceId: 'trace-2',
      task: 'use Bearer abcdefghijklmnop1234',
      model: 'm',
      detached: true,
      configDir: DIR,
    });
    w.append({ type: 'assistant_token', turn: 1, chunk: 'the token is Bearer abcdefghijklmnop1234 ok' });
    w.close({ finalText: 'f', turns: 1, toolCalls: 0, changedFiles: 0, cancelled: false, reachedMaxTurns: false, budgetStop: null });
    const lines = readRunTrace('trace-2', DIR)!;
    const raw = JSON.stringify(lines);
    expect(raw).not.toContain('abcdefghijklmnop1234');
    expect(raw).toContain('redacted');
  });

  test('a killed run leaves no half-written trace behind', () => {
    const w = createRunTraceWriter({ traceId: 'trace-3', task: 'x', model: 'm', detached: false, configDir: DIR });
    w.append({ type: 'assistant_token', turn: 1, chunk: 'partial' });
    // No close() - simulating a kill.
    expect(existsSync(runTracePath('trace-3', DIR))).toBe(false);
    expect(listRunTraces(DIR)).not.toContain('trace-3');
  });
});

describe('listRunTraces / readRunTrace', () => {
  test('lists newest first; readRunTrace returns null for missing', () => {
    const mk = (id: string) =>
      createRunTraceWriter({ traceId: id, task: 't', model: 'm', detached: false, configDir: DIR }).close({
        finalText: 'f',
        turns: 1,
        toolCalls: 0,
        changedFiles: 0,
        cancelled: false,
        reachedMaxTurns: false,
        budgetStop: null,
      });
    mk('aaa');
    mk('zzz');
    expect(listRunTraces(DIR)).toEqual(['zzz', 'aaa']);
    expect(readRunTrace('missing', DIR)).toBeNull();
    expect(listRunTraces(join(DIR, 'no-such-dir'))).toEqual([]);
  });
});
