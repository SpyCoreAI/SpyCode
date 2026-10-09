import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';
import { headlessApproval, type RequestApproval } from '../src/lib/agent/approval.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: {
    json: () => Promise<unknown>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
  };
}

let responder:
  | ((url: string, init: { method: string; body?: unknown; headers?: Record<string, string> }) => MockResp)
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(
    async (
      url: string,
      init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
    ) => {
      if (!responder) throw new Error('test forgot to set responder');
      return responder(url, { method: init.method ?? 'GET', body: init.body, headers: init.headers });
    },
  ),
}));

let workDir: string;

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  workDir = mkdtempSync(join(tmpdir(), 'spycli-agent-'));
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: {
      json: async () => ({}),
      [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator](),
    },
  };
}

/** Each scripted reply becomes one /api/chat/stream turn (text + done). */
function modelTurns(replies: string[]) {
  let i = 0;
  return () => {
    const reply = replies[i] ?? 'Done.';
    i += 1;
    return sseResp([{ type: 'text', content: reply }, { type: 'done' }]);
  };
}

/** Build the standard responder: conversation create + scripted chat turns. */
function makeResponder(turns: () => MockResp, onChat?: () => void) {
  return (url: string, init: { method: string }) => {
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return jsonResp(200, { success: true, data: { id: 'cnv_agent' } });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      onChat?.();
      return turns();
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

const block = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

describe('runAgent (prompt-loop)', () => {
  test('a reply with no tool block is the final answer', async () => {
    responder = makeResponder(modelTurns(['This project is a TypeScript CLI.']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'what is this', cwd: workDir, onEvent: (e) => events.push(e) });
    expect(result.finalText).toContain('TypeScript CLI');
    expect(result.turns).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.reachedMaxTurns).toBe(false);
    expect(events.some((e) => e.type === 'final')).toBe(true);
  });

  test('executes a tool call then finishes', async () => {
    writeFileSync(join(workDir, 'data.txt'), 'hello agent');
    let chatCalls = 0;
    responder = makeResponder(
      modelTurns([block('read_file', { path: 'data.txt' }), 'The file says hello.']),
      () => {
        chatCalls += 1;
      },
    );
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'read data.txt', cwd: workDir, onEvent: (e) => events.push(e) });

    expect(result.toolCalls).toBe(1);
    expect(result.finalText).toContain('hello');
    const call = events.find((e) => e.type === 'tool_call');
    const res = events.find((e) => e.type === 'tool_result');
    expect(call).toMatchObject({ tool: 'read_file', arg: 'data.txt' });
    expect(res).toMatchObject({ tool: 'read_file', ok: true });
    expect(chatCalls).toBe(2);
  });

  test('runs multiple tool blocks emitted in one turn', async () => {
    writeFileSync(join(workDir, 'data.txt'), 'hello');
    responder = makeResponder(
      modelTurns([`${block('list_dir', { path: '.' })}\n${block('read_file', { path: 'data.txt' })}`, 'Done.']),
    );
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'explore', cwd: workDir, onEvent: (e) => events.push(e) });
    expect(result.toolCalls).toBe(2);
    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as { tool: string }).tool)).toEqual([
      'list_dir',
      'read_file',
    ]);
  });

  test('recovers from a malformed tool block', async () => {
    responder = makeResponder(modelTurns(['```spycore:tool\n{bad json}\n```', 'Recovered - final answer.']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'oops', cwd: workDir, onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.type === 'parse_error')).toBe(true);
    expect(result.finalText).toContain('Recovered');
    expect(result.toolCalls).toBe(0);
  });

  test('an unknown tool comes back as a structured error result (no crash)', async () => {
    responder = makeResponder(modelTurns([block('shellExec', { cmd: 'rm -rf /' }), 'Okay, finishing.']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'unsafe', cwd: workDir, onEvent: (e) => events.push(e) });
    const res = events.find((e) => e.type === 'tool_result');
    expect(res).toMatchObject({ tool: 'shellExec', ok: false });
    expect(result.finalText).toContain('finishing');
  });

  test('path traversal is rejected inside the loop', async () => {
    responder = makeResponder(modelTurns([block('read_file', { path: '../../etc/passwd' }), 'Could not read it.']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({ task: 'escape', cwd: workDir, onEvent: (e) => events.push(e) });
    const res = events.find((e) => e.type === 'tool_result');
    expect(res).toMatchObject({ tool: 'read_file', ok: false });
  });

  test('stops at maxTurns when the model never finishes', async () => {
    responder = makeResponder(modelTurns(Array.from({ length: 30 }, () => block('list_dir', { path: '.' }))));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const result = await runAgent({ task: 'forever', cwd: workDir, maxTurns: 3 });
    expect(result.reachedMaxTurns).toBe(true);
    expect(result.turns).toBe(3);
  });

  test('aborts cleanly when the signal is already aborted', async () => {
    responder = makeResponder(modelTurns(['unused']));
    const controller = new AbortController();
    controller.abort();
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const result = await runAgent({ task: 'cancel', cwd: workDir, signal: controller.signal });
    expect(result.cancelled).toBe(true);
    expect(result.turns).toBe(0);
  });
});

describe('runAgent (write/edit + approval)', () => {
  const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });
  const REJECT: RequestApproval = () => Promise.resolve({ approved: false, reason: 'rejected by user' });

  test('applies write_file when approval is granted', async () => {
    responder = makeResponder(modelTurns([block('write_file', { path: 'out.txt', content: 'hi\n' }), 'done']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'write', cwd: workDir, requestApproval: ACCEPT, onEvent: (e) => events.push(e) });
    expect(readFileSync(join(workDir, 'out.txt'), 'utf8')).toBe('hi\n');
    expect(result.toolCalls).toBe(1);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'write_file', ok: true, kind: 'applied' });
  });

  test('skips write_file when approval is rejected, and feeds that back', async () => {
    responder = makeResponder(modelTurns([block('write_file', { path: 'no.txt', content: 'x' }), 'ok, stopping']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'write', cwd: workDir, requestApproval: REJECT, onEvent: (e) => events.push(e) });
    expect(existsSync(join(workDir, 'no.txt'))).toBe(false);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'write_file', ok: false, kind: 'rejected' });
    expect(result.finalText).toContain('stopping');
  });

  test('applies an exact-once edit_file', async () => {
    writeFileSync(join(workDir, 'e.txt'), 'foo\nbar\nbaz\n');
    responder = makeResponder(modelTurns([block('edit_file', { path: 'e.txt', old_str: 'bar', new_str: 'BAR' }), 'done']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({ task: 'edit', cwd: workDir, requestApproval: ACCEPT });
    expect(readFileSync(join(workDir, 'e.txt'), 'utf8')).toBe('foo\nBAR\nbaz\n');
  });

  test('edit_file with multiple matches errors back without writing or prompting', async () => {
    writeFileSync(join(workDir, 'm.txt'), 'x\nx\n');
    responder = makeResponder(modelTurns([block('edit_file', { path: 'm.txt', old_str: 'x', new_str: 'y' }), 'understood']));
    let prompted = false;
    const spy: RequestApproval = () => {
      prompted = true;
      return Promise.resolve({ approved: true });
    };
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({ task: 'edit', cwd: workDir, requestApproval: spy, onEvent: (e) => events.push(e) });
    expect(prompted).toBe(false);
    expect(readFileSync(join(workDir, 'm.txt'), 'utf8')).toBe('x\nx\n');
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'edit_file', ok: false });
  });

  test('headless --yes auto-approves; default headless auto-rejects', async () => {
    const { runAgent } = await import('../src/lib/agent/loop.js');
    responder = makeResponder(modelTurns([block('write_file', { path: 'y.txt', content: 'yes\n' }), 'done']));
    await runAgent({ task: 'w', cwd: workDir, requestApproval: headlessApproval(true) });
    expect(readFileSync(join(workDir, 'y.txt'), 'utf8')).toBe('yes\n');

    responder = makeResponder(modelTurns([block('write_file', { path: 'n.txt', content: 'no' }), 'done']));
    await runAgent({ task: 'w', cwd: workDir, requestApproval: headlessApproval(false) });
    expect(existsSync(join(workDir, 'n.txt'))).toBe(false);
  });

  test('secret-protected write is blocked even with --yes', async () => {
    writeFileSync(join(workDir, '.env'), 'SECRET\n');
    responder = makeResponder(modelTurns([block('write_file', { path: '.env', content: 'HACKED' }), 'done']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({ task: 'w', cwd: workDir, requestApproval: headlessApproval(true), onEvent: (e) => events.push(e) });
    expect(readFileSync(join(workDir, '.env'), 'utf8')).toBe('SECRET\n');
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'write_file', ok: false });
  });
});

describe('runAgent (run_command + approval)', () => {
  const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });
  const REJECT: RequestApproval = () => Promise.resolve({ approved: false, reason: 'rejected by user' });

  test('runs a command when approved and feeds output back', async () => {
    responder = makeResponder(modelTurns([block('run_command', { command: 'echo hi > ran.txt' }), 'done']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'run', cwd: workDir, requestApproval: ACCEPT, onEvent: (e) => events.push(e) });
    expect(existsSync(join(workDir, 'ran.txt'))).toBe(true);
    expect(result.toolCalls).toBe(1);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'run_command', ok: true, kind: 'command' });
  });

  test('skips a command when rejected', async () => {
    responder = makeResponder(modelTurns([block('run_command', { command: 'echo nope > nope.txt' }), 'ok']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({ task: 'run', cwd: workDir, requestApproval: REJECT, onEvent: (e) => events.push(e) });
    expect(existsSync(join(workDir, 'nope.txt'))).toBe(false);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'run_command', ok: false, kind: 'rejected' });
  });

  test('catastrophic command is blocked before approval, even under an approve-all approver', async () => {
    let prompted = false;
    const spy: RequestApproval = () => {
      prompted = true;
      return Promise.resolve({ approved: true });
    };
    responder = makeResponder(modelTurns([block('run_command', { command: 'rm -rf /' }), 'understood']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({ task: 'run', cwd: workDir, requestApproval: spy, onEvent: (e) => events.push(e) });
    expect(prompted).toBe(false);
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'run_command', ok: false });
  });

  test('headless --yes auto-approves a command', async () => {
    responder = makeResponder(modelTurns([block('run_command', { command: 'echo yes > y.txt' }), 'done']));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({ task: 'run', cwd: workDir, requestApproval: headlessApproval(true) });
    expect(existsSync(join(workDir, 'y.txt'))).toBe(true);
  });
});

describe('runAgent (continue conversation - verify fix-up)', () => {
  test('reuses an existing conversation instead of creating a new one', async () => {
    let convoPosts = 0;
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        convoPosts += 1;
        return jsonResp(200, { success: true, data: { id: 'should_not_be_used' } });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return sseResp([{ type: 'text', content: 'done fixing the issue.' }, { type: 'done' }]);
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const result = await runAgent({
      task: 'fix it',
      cwd: workDir,
      conversationId: 'cnv_existing',
      continueMessage: 'Your verification failed; fix it.',
    });
    expect(convoPosts).toBe(0); // continued - no new conversation created
    expect(result.conversationId).toBe('cnv_existing');
    expect(result.finalText).toContain('done fixing');
  });
});

describe('runAgent parallel read-only dispatch', () => {
  interface Gate {
    promise: Promise<void>;
    resolve: () => void;
  }
  const makeGate = (): Gate => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /**
   * A responder whose /chat/fetch-url calls block on per-URL gates, so the
   * test dictates completion order. Tracks in-flight overlap and completion
   * order to prove (or disprove) concurrency.
   */
  function gatedFetchResponder(
    turns: () => MockResp,
    gates: Map<string, Gate>,
    tracker: { inFlight: number; max: number; completed: string[] },
  ) {
    // NOTE: sync like the other responders - the gate waits inside body.json(),
    // which is where fetch_url actually blocks.
    return (url: string, init: { method: string; body?: unknown }) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'cnv_agent' } });
      }
      if (init.method === 'POST' && url.includes('/api/chat/stream')) {
        return turns();
      }
      if (init.method === 'POST' && url.includes('/chat/fetch-url')) {
        const target = (JSON.parse(String(init.body)) as { url: string }).url;
        tracker.inFlight += 1;
        tracker.max = Math.max(tracker.max, tracker.inFlight);
        let gate = gates.get(target);
        if (!gate) {
          gate = makeGate();
          gates.set(target, gate);
        }
        const g = gate;
        return {
          statusCode: 200,
          headers: {},
          body: {
            json: async () => {
              await g.promise;
              tracker.inFlight -= 1;
              tracker.completed.push(target);
              return { url: target, title: target, text: `text of ${target}` };
            },
          },
        };
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
  }

  const toolOf = (e: AgentEvent): string => (e as { tool: string }).tool;
  const callsOf = (events: AgentEvent[]): string[] =>
    events.filter((e) => e.type === 'tool_call').map(toolOf);

  test('two read-only calls in one turn run concurrently', async () => {
    const gates = new Map<string, Gate>();
    const tracker = { inFlight: 0, max: 0, completed: [] as string[] };
    responder = gatedFetchResponder(
      modelTurns([
        `${block('fetch_url', { url: 'https://a.example/' })}\n${block('fetch_url', { url: 'https://b.example/' })}`,
        'Both fetched.',
      ]),
      gates,
      tracker,
    );
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const runP = runAgent({ task: 'fetch both pages', cwd: workDir, onEvent: (e) => events.push(e) });
    // Both fetches must be in flight SIMULTANEOUSLY - sequential dispatch
    // could never show an overlap of 2.
    for (let i = 0; i < 200 && tracker.inFlight < 2; i += 1) await sleep(10);
    expect(tracker.inFlight).toBe(2);
    expect(tracker.max).toBe(2);
    for (const g of gates.values()) g.resolve();
    const result = await runP;
    expect(result.toolCalls).toBe(2);
    expect(callsOf(events)).toEqual(['fetch_url', 'fetch_url']);
  });

  test('results stay in call order when the later call finishes first', async () => {
    const gates = new Map<string, Gate>();
    const tracker = { inFlight: 0, max: 0, completed: [] as string[] };
    responder = gatedFetchResponder(
      modelTurns([
        `${block('fetch_url', { url: 'https://a.example/' })}\n${block('fetch_url', { url: 'https://b.example/' })}`,
        'Both fetched.',
      ]),
      gates,
      tracker,
    );
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const runP = runAgent({ task: 'fetch both pages', cwd: workDir, onEvent: (e) => events.push(e) });
    for (let i = 0; i < 200 && tracker.inFlight < 2; i += 1) await sleep(10);
    expect(tracker.inFlight).toBe(2);
    // Finish B first; A only after B's result has landed.
    gates.get('https://b.example/')!.resolve();
    for (let i = 0; i < 200 && tracker.completed.length < 1; i += 1) await sleep(10);
    expect(tracker.completed).toEqual(['https://b.example/']);
    gates.get('https://a.example/')!.resolve();
    const result = await runP;
    expect(result.toolCalls).toBe(2);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((e) => (e as { index: number }).index)).toEqual([0, 1]);
  });

  test('a mutating call runs alone between read-only calls', async () => {
    const gates = new Map<string, Gate>();
    const tracker = { inFlight: 0, max: 0, completed: [] as string[] };
    responder = gatedFetchResponder(
      modelTurns([
        `${block('fetch_url', { url: 'https://a.example/' })}\n${block('write_file', { path: 'out.txt', content: 'x' })}\n${block('fetch_url', { url: 'https://b.example/' })}`,
        'Done.',
      ]),
      gates,
      tracker,
    );
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const runP = runAgent({
      task: 'fetch, write, fetch',
      cwd: workDir,
      requestApproval: headlessApproval(true),
      onEvent: (e) => events.push(e),
    });
    // A is in flight; the mutating call must NOT start while it is.
    for (let i = 0; i < 200 && tracker.inFlight < 1; i += 1) await sleep(10);
    expect(tracker.inFlight).toBe(1);
    await sleep(150);
    expect(callsOf(events)).toEqual(['fetch_url']);
    expect(tracker.max).toBe(1);
    // Let A finish: write_file runs alone, then B starts (never overlapping A).
    gates.get('https://a.example/')!.resolve();
    for (let i = 0; i < 200 && tracker.completed.length < 1; i += 1) await sleep(10);
    // Wait for B's call to appear; A is long done, so any overlap would have
    // shown in tracker.max.
    for (let i = 0; i < 200 && callsOf(events).length < 3; i += 1) await sleep(10);
    expect(callsOf(events)).toEqual(['fetch_url', 'write_file', 'fetch_url']);
    expect(tracker.max).toBe(1);
    // B's tool_call event fires before its fetch reaches the responder (the
    // tool lazily imports the API client first), so wait for B's gate itself.
    for (let i = 0; i < 200 && !gates.has('https://b.example/'); i += 1) await sleep(10);
    gates.get('https://b.example/')!.resolve();
    const result = await runP;
    expect(result.toolCalls).toBe(3);
    expect(tracker.max).toBe(1);
    expect(callsOf(events)).toEqual(['fetch_url', 'write_file', 'fetch_url']);
  });
});
