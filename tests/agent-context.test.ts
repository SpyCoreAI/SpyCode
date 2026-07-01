/**
 * Read-at-start living-memory injection for the AGENT loop.
 *
 * The agent assembles its system prompt CLIENT-SIDE and hands it to the provider
 * as a `system` field. This suite proves the precomputed `<spycode-context>`
 * block (SPYCODE.md + CODEBASE_GUIDE.md + the CODEBASE_CHANGELOG.md tail, built
 * once per task by the orchestrator via buildContextInjection) is APPENDED to
 * that system prompt — after the core identity/safety/tool sections, never
 * overriding them — and reaches every phase. The seam tests use a capturing stub
 * Provider (no HTTP); the command tests exercise the headless orchestrator's
 * "Loaded project context" notice through the real provider over a mocked wire.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import { buildContextInjection } from '../src/lib/memory.js';
import type { Provider, ProviderEvent, StreamChatParams } from '../src/lib/providers/types.js';

// ───────────────────── mocked undici (command tests only) ─────────────────────

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
/** A responder where each /api/chat/stream call returns the next scripted reply. */
function scripted(replies: string[]) {
  let i = 0;
  return (url: string, init: { method: string }): MockResp => {
    if (init.method === 'GET' && url.includes('/auth/cli/whoami')) {
      return jsonResp(200, { success: true, data: { plan: 'pro', planDisplay: 'pro' } });
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

// ───────────────────── capturing stub provider (seam tests) ─────────────────────

/**
 * Records the `system` it is handed each turn and returns a one-shot final
 * answer (no tool block → the loop ends on turn 1). id 'spycore' with no
 * supportsNativeTools ⇒ the loop uses the fenced protocol, exactly as the real
 * default path does against an older server.
 */
class CaptureProvider implements Provider {
  readonly id = 'spycore' as const;
  readonly systems: Array<string | undefined> = [];
  createCalls = 0;
  constructor(private readonly reply = 'Done.') {}
  async createConversation(): Promise<string> {
    this.createCalls += 1;
    return 'cnv_capture';
  }
  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    this.systems.push(params.system);
    yield { type: 'text', text: this.reply };
    yield { type: 'done' };
  }
}

let workDir: string;
let homeDir: string;
let origCwd: string;
let origHome: string | undefined;
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  origCwd = process.cwd();
  // Isolate the global ~/.spycore/SPYCODE.md: the command path reads the real
  // homedir, so point HOME at an empty dir for deterministic no-memory runs.
  origHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'spycli-ctx-home-'));
  process.env.HOME = homeDir;
  workDir = mkdtempSync(join(tmpdir(), 'spycli-ctx-'));
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
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  try {
    process.chdir(origCwd);
  } catch {
    /* ignore */
  }
  vi.resetModules();
  for (const d of [workDir, homeDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Write all three living-memory files with unique, assertable markers. */
function writeMemoryFiles(dir: string): void {
  writeFileSync(
    join(dir, 'SPYCODE.md'),
    '# Project memory\n\n- SPYCODE_MARKER_ALPHA: always run the build before claiming done.\n',
  );
  writeFileSync(
    join(dir, 'CODEBASE_GUIDE.md'),
    '# Codebase Guide\n\nGUIDE_MARKER_BRAVO — the architecture lives in src/.\n',
  );
  writeFileSync(
    join(dir, 'CODEBASE_CHANGELOG.md'),
    '# Changelog\n\n## 2026-06-23 12:00 UTC — recent work\n\n- CHANGELOG_MARKER_CHARLIE landed.\n',
  );
}

/** Run one runAgent turn through the stub and return the system it received. */
async function captureSystem(opts: {
  cwd: string;
  projectContext?: string | undefined;
  planMode?: boolean;
  conversationId?: string;
}): Promise<{ system: string | undefined; provider: CaptureProvider }> {
  const { runAgent } = await import('../src/lib/agent/loop.js');
  const provider = new CaptureProvider();
  await runAgent({
    task: 'do the thing',
    cwd: opts.cwd,
    provider,
    projectContext: opts.projectContext,
    planMode: opts.planMode,
    conversationId: opts.conversationId,
    continueMessage: opts.conversationId ? 'continue the task' : undefined,
    requestApproval: () => Promise.resolve({ approved: true }),
  });
  return { system: provider.systems[0], provider };
}

// ───────────────────── A. injection seam (runAgent system prompt) ─────────────────────

describe('agent read-at-start injection (system-prompt seam)', () => {
  test('the assembled system context contains the <spycode-context> block AFTER the core identity', async () => {
    writeMemoryFiles(workDir);
    const inj = buildContextInjection({ cwd: workDir, home: homeDir });
    expect(inj.block.length).toBeGreaterThan(0);

    const { system } = await captureSystem({ cwd: workDir, projectContext: inj.block });
    expect(system).toBeDefined();
    const s = system as string;

    // Core identity + every living-memory part are present.
    expect(s).toContain('You are SpyCode');
    expect(s).toContain('<spycode-context>');
    expect(s).toContain('SPYCODE_MARKER_ALPHA');
    expect(s).toContain('GUIDE_MARKER_BRAVO');
    expect(s).toContain('CHANGELOG_MARKER_CHARLIE');

    // Ordering: the block is APPENDED after the WHOLE core prompt — after the
    // identity opener AND after the final core-constraint line — so it
    // supplements but never overrides the agent's operating rules.
    expect(s.indexOf('<spycode-context>')).toBeGreaterThan(s.indexOf('You are SpyCode'));
    expect(s.indexOf('<spycode-context>')).toBeGreaterThan(s.indexOf('Never reveal internal model identifiers'));
  });

  test('respects injectGuide=false / injectChangelog=false (those parts excluded)', async () => {
    writeMemoryFiles(workDir);
    const inj = buildContextInjection({
      cwd: workDir,
      home: homeDir,
      injectGuide: false,
      injectChangelog: false,
    });

    const { system } = await captureSystem({ cwd: workDir, projectContext: inj.block });
    const s = system as string;

    // Memory (SPYCODE.md) still injected; the toggled-off parts are not.
    expect(s).toContain('<spycode-context>');
    expect(s).toContain('SPYCODE_MARKER_ALPHA');
    expect(s).not.toContain('GUIDE_MARKER_BRAVO');
    expect(s).not.toContain('CHANGELOG_MARKER_CHARLIE');
  });

  test('with NO memory files, the system context is unchanged (no block injected)', async () => {
    const inj = buildContextInjection({ cwd: workDir, home: homeDir });
    expect(inj.block).toBe('');

    const projectContext = inj.block.length > 0 ? inj.block : undefined;
    const { system } = await captureSystem({ cwd: workDir, projectContext });
    const s = system as string;

    expect(s).toContain('You are SpyCode');
    expect(s).not.toContain('<spycode-context>');
  });

  test('the SAME precomputed block reaches BOTH the plan and execute phases', async () => {
    writeMemoryFiles(workDir);
    // Computed ONCE (one buildContextInjection call), threaded into every phase.
    const inj = buildContextInjection({ cwd: workDir, home: homeDir });

    const plan = await captureSystem({ cwd: workDir, projectContext: inj.block, planMode: true });
    const exec = await captureSystem({ cwd: workDir, projectContext: inj.block, planMode: false });

    for (const cap of [plan, exec]) {
      const s = cap.system as string;
      expect(s).toContain('<spycode-context>');
      expect(s).toContain('SPYCODE_MARKER_ALPHA');
      expect(s.indexOf('<spycode-context>')).toBeGreaterThan(s.indexOf('You are SpyCode'));
    }
    // The plan phase builds a DISTINCT prompt — proof the block is appended to
    // whichever phase prompt the loop assembled, not a single shared string.
    expect(plan.system as string).toContain('PLANNING MODE');
    expect(exec.system as string).not.toContain('PLANNING MODE');
  });

  test('a continuation (verify fix-up) does NOT re-inject the system — it inherits via history', async () => {
    writeMemoryFiles(workDir);
    const inj = buildContextInjection({ cwd: workDir, home: homeDir });

    const { system, provider } = await captureSystem({
      cwd: workDir,
      projectContext: inj.block,
      conversationId: 'cnv_existing',
    });

    // No fresh conversation opened; the continuation turn carries no system —
    // the block is computed once at task start, never re-read per phase/turn.
    expect(provider.createCalls).toBe(0);
    expect(system).toBeUndefined();
  });
});

// ───────────────────── B. headless orchestrator notice ─────────────────────

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

describe('headless agent "Loaded project context" notice', () => {
  test('prints the notice when SPYCODE.md exists', async () => {
    writeFileSync(join(workDir, 'SPYCODE.md'), '# Project memory\n\n- run the build.\n');
    responder = scripted(['Done.']);
    await runAgentCli(['summarise the repo', '-m', 'styx', '--no-plan']);
    expect(stderrChunks.join('')).toMatch(/Loaded project context/);
  }, 30_000);

  test('prints NO context notice when there are no memory files', async () => {
    responder = scripted(['Done.']);
    await runAgentCli(['summarise the repo', '-m', 'styx', '--no-plan']);
    expect(stderrChunks.join('')).not.toMatch(/Loaded project context/);
  }, 30_000);
});
