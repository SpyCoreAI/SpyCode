import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import {
  DEFAULT_LIMITS,
  dispatchTool,
  type ToolContext,
} from '../src/lib/agent/tools.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';

const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });

// ───────────────────── mocked undici ─────────────────────

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown>; [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> };
}
let responder: ((url: string, init: { method: string }) => MockResp) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET' });
  }),
}));

let workDir: string;
let origCwd: string;
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  origCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), 'spycli-plan-'));
  stdoutChunks = [];
  stderrChunks = [];
  process.stdout.write = ((c: unknown) => {
    stdoutChunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    stderrChunks.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  try {
    process.chdir(origCwd);
  } catch {
    /* ignore */
  }
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
    body: { json: async () => ({}), [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator]() },
  };
}
const toolBlock = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

/** A responder where each /api/chat/stream call returns the next scripted reply. */
function scripted(replies: string[], plan = 'free') {
  let i = 0;
  return (url: string, init: { method: string }): MockResp => {
    if (init.method === 'GET' && url.includes('/auth/cli/whoami')) {
      return jsonResp(200, { success: true, data: { plan, planDisplay: plan } });
    }
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return jsonResp(200, { success: true, data: { id: `cnv_${i}` } });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      const reply = replies[i] ?? 'Done.';
      i += 1;
      return sseResp([{ type: 'text', content: reply }, { type: 'done' }]);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

// ───────────────────── A. dispatch blocks mutations in plan mode ─────────────────────

describe('plan mode blocks mutating tools at dispatch', () => {
  const ctx = (planMode: boolean): ToolContext => ({
    cwd: workDir,
    limits: DEFAULT_LIMITS,
    planMode,
    requestApproval: ACCEPT,
  });

  test('write_file is blocked (no file written) with a planning error', async () => {
    const r = await dispatchTool('write_file', { path: 'x.txt', content: 'hi' }, ctx(true));
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/planning mode/i);
    expect(existsSync(join(workDir, 'x.txt'))).toBe(false);
  });
  test('edit_file and run_command are blocked too', async () => {
    writeFileSync(join(workDir, 'f.txt'), 'a\n');
    const e = await dispatchTool('edit_file', { path: 'f.txt', old_str: 'a', new_str: 'b' }, ctx(true));
    expect(e.ok).toBe(false);
    expect(readFileSync(join(workDir, 'f.txt'), 'utf8')).toBe('a\n');
    const c = await dispatchTool('run_command', { command: 'echo hi > made.txt' }, ctx(true));
    expect(c.ok).toBe(false);
    expect(existsSync(join(workDir, 'made.txt'))).toBe(false);
  });
  test('read-only tools still work in plan mode', async () => {
    writeFileSync(join(workDir, 'r.txt'), 'hello\n');
    const r = await dispatchTool('read_file', { path: 'r.txt' }, ctx(true));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('hello');
    const ls = await dispatchTool('list_dir', {}, ctx(true));
    expect(ls.ok).toBe(true);
  });
});

// ───────────────────── B. runAgent: plan phase vs execute phase ─────────────────────

describe('runAgent plan/execute phases', () => {
  test('plan phase: a write attempt is blocked, file untouched; the final text is the plan', async () => {
    responder = scripted([
      toolBlock('write_file', { path: 'should_not.txt', content: 'nope' }),
      '1. Create greeting.txt\n2. Done',
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const res = await runAgent({
      task: 'build a thing',
      cwd: workDir,
      planMode: true,
      requestApproval: ACCEPT,
      onEvent: (e) => events.push(e),
    });
    const toolRes = events.find((e) => e.type === 'tool_result');
    expect(toolRes).toMatchObject({ tool: 'write_file', ok: false });
    expect(existsSync(join(workDir, 'should_not.txt'))).toBe(false);
    expect(res.finalText).toMatch(/Create greeting\.txt/);
  });

  test('execute phase: with an approved plan, mutating tools run', async () => {
    responder = scripted([toolBlock('write_file', { path: 'done.txt', content: 'built\n' }), 'Done.']);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const res = await runAgent({
      task: 'build a thing',
      cwd: workDir,
      approvedPlan: '1. Create done.txt',
      requestApproval: ACCEPT,
    });
    expect(readFileSync(join(workDir, 'done.txt'), 'utf8')).toBe('built\n');
    expect(res.toolCalls).toBe(1);
  });
});

// ───────────────────── D. headless command: plan auto-on, --yes gates execution ─────────────────────

async function runAgentCli(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerAgentCommand } = await import('../src/commands/agent.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: false, color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerAgentCommand(program);
  process.chdir(workDir);
  await program.parseAsync(['node', 'spycore', 'agent', ...argv]);
}

describe('headless plan mode (command)', () => {
  test('a COMPLEX task without --yes prints the plan and does NOT execute', async () => {
    // classify → COMPLEX (auto plan); plan phase → a plan that mentions a file.
    responder = scripted(['COMPLEX', '1. Create PLANMARKER.txt with the text hi'], 'pro');
    await runAgentCli(['write a marker file']);
    expect(stdoutChunks.join('')).toMatch(/PLANMARKER\.txt/); // plan printed
    expect(stderrChunks.join('')).toMatch(/Plan only/); // not executed note
    expect(existsSync(join(workDir, 'PLANMARKER.txt'))).toBe(false); // nothing executed
  }, 30_000); // full in-process command loop — generous cap so a loaded box can't flake the gate

  test('a COMPLEX task with --yes plans then executes', async () => {
    responder = scripted(
      [
        'COMPLEX', // classify
        '1. Create PLANMARKER.txt', // plan phase
        toolBlock('write_file', { path: 'PLANMARKER.txt', content: 'hi\n' }), // execute turn 1
        'Done.', // execute turn 2
      ],
      'pro',
    );
    await runAgentCli(['write a marker file', '--yes']);
    expect(existsSync(join(workDir, 'PLANMARKER.txt'))).toBe(true);
    expect(readFileSync(join(workDir, 'PLANMARKER.txt'), 'utf8')).toBe('hi\n');
  }, 30_000); // plan + execute phases in one run — see above

  test('one EMPTY plan reply is recovered by the loop nudge (no phase rerun needed)', async () => {
    // Observed live (release bench): the backing model occasionally returns
    // an empty completion. Layer 1: the agent loop nudges once in-run.
    responder = scripted(['COMPLEX', '', '1. Create PLANMARKER.txt with the text hi'], 'pro');
    await runAgentCli(['write a marker file']);
    expect(stdoutChunks.join('')).toMatch(/PLANMARKER\.txt/); // recovered plan printed
    expect(stderrChunks.join('')).not.toMatch(/Empty plan returned/); // layer 2 not needed
    expect(stderrChunks.join('')).toMatch(/Plan only/); // still no execution without --yes
    expect(existsSync(join(workDir, 'PLANMARKER.txt'))).toBe(false);
  }, 30_000);

  test('a doubly-EMPTY plan phase falls back to the planFeedback rerun (layer 2)', async () => {
    // Loop nudge consumed (empty, empty) → phase returns '' → the command
    // reruns the plan phase once with explicit feedback.
    responder = scripted(['COMPLEX', '', '', '1. Create PLANMARKER.txt with the text hi'], 'pro');
    await runAgentCli(['write a marker file']);
    expect(stderrChunks.join('')).toMatch(/Empty plan returned — retrying once/);
    expect(stdoutChunks.join('')).toMatch(/PLANMARKER\.txt/);
    expect(stderrChunks.join('')).toMatch(/Plan only/);
    expect(existsSync(join(workDir, 'PLANMARKER.txt'))).toBe(false);
  }, 30_000);

  test('both layers exhausted by persistent empties → unchanged flow, no crash', async () => {
    responder = scripted(['COMPLEX', '', '', '', ''], 'pro');
    await runAgentCli(['write a marker file']);
    expect(stderrChunks.join('')).toMatch(/Empty plan returned — retrying once/);
    expect(stderrChunks.join('')).toMatch(/Plan only/);
    expect(existsSync(join(workDir, 'PLANMARKER.txt'))).toBe(false);
  }, 30_000);
});
