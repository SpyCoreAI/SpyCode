import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import type { Provider, ProviderEvent, StreamChatParams } from '../src/lib/providers/types.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';

/**
 * PHASE-1 1.8 - the single assembly-time wire clamp, closing the 1.2 latent
 * finding (the ~80K-char context READ budget vs the server's hard 32,000-char
 * `message` cap).
 *
 * Pinned here:
 *  - the HARD INVARIANT: the assembled wire message NEVER exceeds 32,000
 *    chars - property-style across representative part sizes, for BOTH the
 *    chat and the agent assembly shapes;
 *  - priority order: user content > attached files > project-context tail;
 *  - EXPLICIT truncation: an in-band marker at every cut + a one-line
 *    warning naming the trimmed part - nothing is ever dropped silently;
 *  - byte-identity when nothing clamps (the exact historical assembly);
 *  - the pre-fix HARD-BRICK case: a chat send from a workspace whose
 *    project context alone overflows the cap now SENDS successfully, and an
 *    agent run with the same context starts instead of 400ing.
 */

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    const captured = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
    };
    calls.push(captured);
    return responder(url, captured);
  }),
}));

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
type MockResp = {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: (AsyncIterable<Buffer> & { json?: () => Promise<unknown> }) | { json: () => Promise<unknown> };
};
let responder: ((url: string, init: { method: string }) => MockResp) | null = null;
let calls: CapturedCall[] = [];

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}
function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buffers = events.map((e) => Buffer.from(`data: ${JSON.stringify(e)}\n\n`, 'utf8'));
  const body = Readable.from(buffers) as unknown as MockResp['body'];
  (body as { json?: () => Promise<unknown> }).json = async () => ({});
  return { statusCode: 200, headers: {}, body };
}

const WIRE_MAX = 32_000;

let workDir: string;
let stderrChunks: string[] = [];
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origCwd = process.cwd();

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  calls = [];
  stderrChunks = [];
  workDir = mkdtempSync(join(tmpdir(), 'spycli-clamp-'));
  writeFileSync(join(workDir, 'package.json'), JSON.stringify({ name: 'fixture' }));
  mkdirSync(join(workDir, '.git'), { recursive: true });
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  process.stderr.write = origStderrWrite;
  process.chdir(origCwd);
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ───────────────────────────── unit: the clamp ─────────────────────────────

describe('clampWireAssembly - invariant + priority + markers', () => {
  const chatParts = (injection: string, user: string, blocks: string) => {
    const parts = [];
    if (injection.length > 0) {
      parts.push({ body: injection, post: '\n\n', kind: 'injection' as const, label: 'project context' });
    }
    parts.push({ body: user, kind: 'user' as const, label: 'message' });
    if (blocks.length > 0) {
      parts.push({ pre: '\n\n[Attached files]\n', body: blocks, kind: 'attachments' as const, label: 'attached files' });
    }
    return parts;
  };

  test('under the cap: the wire is byte-identical to the historical assembly', async () => {
    const { clampWireAssembly } = await import('../src/lib/wire-clamp.js');
    const injection = '<spycode-context>ctx</spycode-context>';
    const user = 'hello';
    const blocks = '---- attached file: a.md ----\nA\n---- end attached file: a.md ----';
    const r = clampWireAssembly(chatParts(injection, user, blocks));
    expect(r.clamped).toBe(false);
    expect(r.warning).toBeNull();
    expect(r.wire).toBe(`${injection}\n\n${user}\n\n[Attached files]\n${blocks}`);
  });

  test('PROPERTY: the assembled wire NEVER exceeds 32,000 chars (chat shape)', async () => {
    const { clampWireAssembly } = await import('../src/lib/wire-clamp.js');
    const sizes = [0, 500, 10_000, 24_000, 31_000, 48_000, 80_000];
    for (const inj of sizes) {
      for (const usr of [1, 500, 10_000, 31_000, 40_000]) {
        for (const att of [0, 500, 24_000, 48_000]) {
          const r = clampWireAssembly(chatParts('C'.repeat(inj), 'U'.repeat(usr), 'A'.repeat(att)));
          expect(r.wire.length).toBeLessThanOrEqual(WIRE_MAX);
          // texts always reassemble to the wire (the agent seam depends on it)
          expect(r.texts.join('')).toBe(r.wire);
        }
      }
    }
  });

  test('priority 1: the injection tail is cut FIRST - user text + attachments intact', async () => {
    const { clampWireAssembly } = await import('../src/lib/wire-clamp.js');
    const user = 'U'.repeat(1_000);
    const blocks = 'A'.repeat(5_000);
    const r = clampWireAssembly(chatParts('C'.repeat(80_000), user, blocks));
    expect(r.clamped).toBe(true);
    expect(r.wire.length).toBeLessThanOrEqual(WIRE_MAX);
    expect(r.wire).toContain(user);
    expect(r.wire).toContain(blocks);
    expect(r.wire).toContain('[project context truncated to fit the message limit]');
    expect(r.warning).toContain('project context');
    // The injection keeps its HEAD (tail cut).
    expect(r.wire.startsWith('CCCC')).toBe(true);
  });

  test('priority 2: attachments are cut only after the injection is exhausted', async () => {
    const { clampWireAssembly } = await import('../src/lib/wire-clamp.js');
    const user = 'U'.repeat(20_000);
    const r = clampWireAssembly(chatParts('C'.repeat(3_000), user, 'A'.repeat(30_000)));
    expect(r.wire.length).toBeLessThanOrEqual(WIRE_MAX);
    // User text fully intact; injection reduced to its omission marker;
    // attachments tail-cut with the explicit marker.
    expect(r.wire).toContain(user);
    expect(r.wire).toContain('[project context omitted to fit the message limit]');
    expect(r.wire).toContain('[attached files truncated to fit the message limit]');
    expect(r.warning).toContain('attached files');
    expect(r.warning).toContain('project context');
  });

  test('priority 3 (last resort): oversized user text alone clamps with a marker - never a bricked send', async () => {
    const { clampWireAssembly } = await import('../src/lib/wire-clamp.js');
    const r = clampWireAssembly(chatParts('', 'U'.repeat(40_000), ''));
    expect(r.wire.length).toBeLessThanOrEqual(WIRE_MAX);
    expect(r.wire).toContain('[message truncated to fit the message limit]');
    expect(r.warning).toContain('message');
  });

  test('agent shape: the fixed system prompt is never cut; the context tail is', async () => {
    const { clampWireAssembly } = await import('../src/lib/wire-clamp.js');
    const system = 'S'.repeat(6_000);
    const task = `TASK: ${'T'.repeat(2_000)}`;
    const parts = [
      { body: system, kind: 'fixed' as const, label: 'system prompt' },
      { pre: '\n\n', body: 'C'.repeat(80_000), kind: 'injection' as const, label: 'project context' },
      { pre: '\n\n', body: task, kind: 'user' as const, label: 'task' },
      { pre: '\n\n', body: 'A'.repeat(10_000), kind: 'attachments' as const, label: 'attached files' },
    ];
    const r = clampWireAssembly(parts);
    expect(r.wire.length).toBeLessThanOrEqual(WIRE_MAX);
    expect(r.texts[0]).toBe(system); // fixed part untouched
    expect(r.wire).toContain(task); // user content untouched
    expect(r.wire).toContain('[project context truncated to fit the message limit]');
    // The seam reassembly the agent loop performs: system side + message side.
    expect(r.texts.slice(0, 2).join('') + r.texts.slice(2).join('')).toBe(r.wire);
  });
});

// ───────────── E2E: the pre-fix HARD-BRICK case now sends (chat) ─────────────

async function runChat(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerChatCommand } = await import('../src/commands/chat.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: false, color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerChatCommand(program);
  await program.parseAsync(['node', 'spycore', ...argv]);
}

function chatResponder(): (url: string, init: { method: string }) => MockResp {
  return (url, init) => {
    if (url.endsWith('/conversations') && init.method === 'POST') {
      return jsonResp(201, { success: true, data: { id: 'cnv_1', title: 'New', model: 'HERMES' } });
    }
    if (url.endsWith('/api/chat/stream')) {
      return sseResp([{ type: 'text', content: 'ok' }, { type: 'done' }]);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

describe('chat one-shot: oversized project context sends clamped (pre-fix: bricked)', () => {
  test('48K SPYCODE injection + message → ONE stream call, ≤32,000, markers + warning', async () => {
    // A SPYCODE.md at the READ budget (48K after its own cap) - alone it
    // overflows the 32,000-char wire cap, the exact 1.2 latent finding.
    writeFileSync(join(workDir, 'SPYCODE.md'), `# Project memory\n${'M'.repeat(60_000)}`, 'utf8');
    process.chdir(workDir);
    responder = chatResponder();
    await runChat(['--no-color', 'chat', '--raw', 'use the project context please']);
    const streamCall = calls.find((c) => c.url.endsWith('/api/chat/stream'));
    expect(streamCall).toBeDefined();
    const body = JSON.parse(String(streamCall!.body)) as { message: string };
    // The HARD invariant on the real wire…
    expect(body.message.length).toBeLessThanOrEqual(WIRE_MAX);
    // …with the user's text intact and the cut explicit in-band…
    expect(body.message).toContain('use the project context please');
    expect(body.message).toContain('[project context truncated to fit the message limit]');
    // …and the one-line warning naming the trimmed part on stderr.
    expect(stderrChunks.join('')).toMatch(/Trimmed to fit the 32,000-character message limit: project context/);
  });

  test('oversized context + a text attachment: attachment survives, context is cut, send succeeds', async () => {
    writeFileSync(join(workDir, 'SPYCODE.md'), `# Project memory\n${'M'.repeat(60_000)}`, 'utf8');
    const attPath = join(workDir, 'notes.md');
    writeFileSync(attPath, `NOTES-HEAD\n${'N'.repeat(5_000)}`, 'utf8');
    process.chdir(workDir);
    responder = chatResponder();
    await runChat(['--no-color', 'chat', '--raw', '--attach', attPath, 'summarize the notes']);
    const streamCall = calls.find((c) => c.url.endsWith('/api/chat/stream'));
    expect(streamCall).toBeDefined();
    const body = JSON.parse(String(streamCall!.body)) as { message: string };
    expect(body.message.length).toBeLessThanOrEqual(WIRE_MAX);
    expect(body.message).toContain('summarize the notes');
    // Attachments outrank the injection: the whole block is present…
    expect(body.message).toContain('NOTES-HEAD');
    expect(body.message).toContain('---- end attached file: notes.md ----');
    // …while the project context absorbed the whole cut.
    expect(body.message).toContain('[project context truncated to fit the message limit]');
  });

  test('no overflow → no warning, wire byte-identical to the plain assembly', async () => {
    writeFileSync(join(workDir, 'SPYCODE.md'), '# Project memory\nSMALL', 'utf8');
    process.chdir(workDir);
    responder = chatResponder();
    await runChat(['--no-color', 'chat', '--raw', 'hi there']);
    const streamCall = calls.find((c) => c.url.endsWith('/api/chat/stream'));
    const body = JSON.parse(String(streamCall!.body)) as { message: string };
    expect(body.message).toContain('SMALL');
    expect(body.message).toContain('hi there');
    expect(body.message).not.toContain('truncated to fit the message limit');
    expect(stderrChunks.join('')).not.toMatch(/Trimmed to fit/);
  });
});

// ───────────── E2E: the agent first turn clamps at assembly (loop) ─────────────

class SpycoreStubProvider implements Provider {
  readonly id = 'spycore' as const;
  params: StreamChatParams[] = [];
  createConversation(): Promise<string> {
    return Promise.resolve('cnv_stub');
  }
  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    this.params.push(params);
    yield { type: 'text', text: 'All done.' };
    yield { type: 'usage', input: 1, output: 1 };
    yield { type: 'done' };
  }
}

describe('agent first turn: system+context+task clamps to the wire cap (pre-fix: 400 at run start)', () => {
  test('oversized projectContext → run starts, wire ≤32,000, task intact, context_clamped emitted', async () => {
    const provider = new SpycoreStubProvider();
    const events: AgentEvent[] = [];
    const { runChatAgentTurn } = await import('../src/lib/chat-agent-run.js');
    await runChatAgentTurn({
      cwd: workDir,
      task: 'inspect the fixture project',
      mode: 'agent',
      model: 'styx',
      provider,
      projectContext: `<spycode-context>${'C'.repeat(80_000)}</spycode-context>`,
      io: {
        notify: () => {},
        renderEvent: (e) => void events.push(e),
        presentPlan: () => {},
        ask: async () => 'c',
        readText: async () => '',
        requestApproval: async () => 'reject',
      },
    });
    expect(provider.params.length).toBeGreaterThan(0);
    const first = provider.params[0]!;
    // The SpyCore provider re-joins `${system}\n\n${message}` - THAT is the
    // wire the server caps, and it must obey the invariant.
    const wire = `${first.system ?? ''}\n\n${first.message}`;
    expect(wire.length).toBeLessThanOrEqual(WIRE_MAX);
    // The task (user content) is intact; the context absorbed the cut.
    expect(first.message).toContain('TASK: inspect the fixture project');
    expect(first.system).toContain('[project context truncated to fit the message limit]');
    // The cut was surfaced as an event - never silent.
    const clampEvents = events.filter((e) => e.type === 'context_clamped');
    expect(clampEvents).toHaveLength(1);
    expect((clampEvents[0] as { text: string }).text).toContain('project context');
  });

  test('small projectContext → byte-identical historical assembly, no clamp event', async () => {
    const provider = new SpycoreStubProvider();
    const events: AgentEvent[] = [];
    const { runChatAgentTurn } = await import('../src/lib/chat-agent-run.js');
    await runChatAgentTurn({
      cwd: workDir,
      task: 'small task',
      mode: 'agent',
      model: 'styx',
      provider,
      projectContext: '<spycode-context>tiny</spycode-context>',
      io: {
        notify: () => {},
        renderEvent: (e) => void events.push(e),
        presentPlan: () => {},
        ask: async () => 'c',
        readText: async () => '',
        requestApproval: async () => 'reject',
      },
    });
    const first = provider.params[0]!;
    // Exactly the historical shape: context appended after the core system
    // prompt; the message starts with the TASK line (no stray joiner).
    expect(first.system?.endsWith('<spycode-context>tiny</spycode-context>')).toBe(true);
    expect(first.message.startsWith('TASK: small task')).toBe(true);
    expect(events.some((e) => e.type === 'context_clamped')).toBe(false);
  });
});
