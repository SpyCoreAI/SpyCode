import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

// ───────────────────── mocked undici ─────────────────────

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown>; [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> };
}
type Responder = (url: string, init: { method: string; body?: unknown }) => MockResp;
let responder: Responder | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET', body: init.body });
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
  // realpath so process.cwd() after chdir() matches (macOS /var → /private/var).
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-resume-')));
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

/** One scripted stream turn: reply text (+ optional usage), or a stream error. */
interface Turn {
  reply?: string;
  usage?: { input: number; output: number };
  error?: string;
}
function turnResp(t: Turn): MockResp {
  if (t.error !== undefined) return sseResp([{ type: 'error', message: t.error }]);
  const events: Array<Record<string, unknown>> = [{ type: 'text', content: t.reply ?? 'Done.' }];
  if (t.usage) events.push({ type: 'usage', input: t.usage.input, output: t.usage.output });
  events.push({ type: 'done' });
  return sseResp(events);
}

/** Responder: /conversations create + scripted turns; captures every stream body. */
function scripted(turns: Turn[], opts: { allowCreate?: boolean; conversationId?: string } = {}) {
  const streamBodies: Array<Record<string, unknown>> = [];
  let i = 0;
  const respond: Responder = (url, init) => {
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      if (opts.allowCreate === false) throw new Error('unexpected conversation create on resume');
      return jsonResp(200, { success: true, data: { id: opts.conversationId ?? 'cnv_resume_a' } });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      streamBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const t = turns[i] ?? { reply: 'Done.' };
      i += 1;
      return turnResp(t);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
  return { respond, streamBodies };
}

async function runAgentCli(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerAgentCommand } = await import('../src/commands/agent.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: argv.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerAgentCommand(program);
  process.chdir(workDir);
  await program.parseAsync(['node', 'spycore', 'agent', ...argv]);
}

/** Interrupted first run: writes marker.txt on turn 1, stream error on turn 2. */
async function interruptedFirstRun(extraArgv: string[] = []): Promise<void> {
  const { respond } = scripted([
    { reply: toolBlock('write_file', { path: 'marker.txt', content: 'v1\n' }), usage: { input: 10_000, output: 20_000 } },
    { error: 'The stream ended unexpectedly.' },
  ]);
  responder = respond;
  await expect(
    runAgentCli(['make a marker file', '--model', 'styx', '--yes', ...extraArgv]),
  ).rejects.toThrow(/stream ended unexpectedly/);
}

// ───────────────────── recorder (checkpoint layer) ─────────────────────

describe('RunRecorder', () => {
  const initial = (over: Record<string, unknown> = {}) => ({
    providerKind: 'spycore' as const,
    model: 'styx',
    planMode: false,
    maxTurns: 25,
    budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} },
    gitHead: null,
    ...over,
  });

  test('nothing on disk until a conversation binds or a change lands', async () => {
    const { createRunRecorder, listSessions } = await import('../src/lib/agent/checkpoint.js');
    const rec = createRunRecorder({ cwd: workDir, task: 't', initial: initial() });
    rec.update({ turnsCompleted: 0 });
    expect(listSessions(workDir)).toHaveLength(0);
    rec.abandon();
    expect(listSessions(workDir)).toHaveLength(0);
  });

  test('boundary updates persist incrementally and finalize(interrupted) keeps a changeless record', async () => {
    const { createRunRecorder, listSessions, getResumeState } = await import('../src/lib/agent/checkpoint.js');
    const rec = createRunRecorder({ cwd: workDir, task: 'long task', initial: initial() });
    rec.update({ conversationId: 'cnv_1', nativeTools: true, turnsCompleted: 3 });
    const mid = listSessions(workDir);
    expect(mid).toHaveLength(1);
    const midState = getResumeState(mid[0]!)!;
    expect(midState.status).toBe('running'); // a crash right now stays resumable
    expect(midState.conversationId).toBe('cnv_1');
    expect(midState.nativeTools).toBe(true);
    expect(midState.turnsCompleted).toBe(3);
    rec.finalize('interrupted');
    const s = listSessions(workDir)[0]!;
    expect(getResumeState(s)?.status).toBe('interrupted');
    expect(s.changes).toHaveLength(0);
  });

  test('finalize(completed) with zero changes removes the file (matches legacy no-file behavior)', async () => {
    const { createRunRecorder, listSessions } = await import('../src/lib/agent/checkpoint.js');
    const rec = createRunRecorder({ cwd: workDir, task: 't', initial: initial() });
    rec.update({ conversationId: 'cnv_1' });
    expect(listSessions(workDir)).toHaveLength(1);
    rec.finalize('completed');
    expect(listSessions(workDir)).toHaveLength(0);
    rec.abandon(); // no-op after finalize
    expect(listSessions(workDir)).toHaveLength(0);
  });

  test('reopen keeps the id and appends to the SAME journal - rewind spans the resume boundary', async () => {
    const {
      createRunRecorder,
      reopenRunRecorder,
      listSessions,
      loadSession,
      planRewind,
      applyRewind,
      getResumeState,
    } = await import('../src/lib/agent/checkpoint.js');
    const a = join(workDir, 'a.txt');
    const b = join(workDir, 'b.txt');
    const rec = createRunRecorder({ cwd: workDir, task: 't', initial: initial() });
    rec.update({ conversationId: 'cnv_1', turnsCompleted: 1 });
    writeFileSync(a, 'A');
    rec.recordChange({ path: a, op: 'create', before: null, after: 'A' });
    rec.finalize('interrupted');

    const reopened = reopenRunRecorder(loadSession(workDir, rec.id)!)!;
    expect(reopened.id).toBe(rec.id);
    expect(reopened.changeCount()).toBe(1);
    expect(reopened.state().turnsCompleted).toBe(1);
    writeFileSync(b, 'B');
    reopened.recordChange({ path: b, op: 'create', before: null, after: 'B' });
    reopened.finalize('completed');

    const sessions = listSessions(workDir);
    expect(sessions).toHaveLength(1); // ONE lineage, not two
    expect(getResumeState(sessions[0]!)?.status).toBe('completed');
    expect(sessions[0]!.changes).toHaveLength(2);
    applyRewind(planRewind(sessions[0]!), workDir);
    expect(existsSync(a)).toBe(false); // pre-resume change rewound
    expect(existsSync(b)).toBe(false); // post-resume change rewound
  });

  test('old-format sessions (plain saveSession) have no resume state and never crash readers', async () => {
    const { saveSession, latestSession, getResumeState } = await import('../src/lib/agent/checkpoint.js');
    writeFileSync(join(workDir, 'x.txt'), 'X');
    saveSession({ cwd: workDir, task: 'old', changes: [{ path: join(workDir, 'x.txt'), op: 'create', before: null, after: 'X' }] });
    const s = latestSession(workDir)!;
    expect(getResumeState(s)).toBeNull();
    // Malformed resume field → treated as old-format, not a crash.
    expect(getResumeState({ ...s, resume: { version: 99 } as never })).toBeNull();
  });
});

// ───────────────────── budget: cumulative restore ─────────────────────

describe('budget resume (cumulative)', () => {
  test('carried consumption counts against the cap - a resume cannot reset spend', async () => {
    const { createBudget } = await import('../src/lib/agent/budget.js');
    let t = 1_000;
    const budget = createBudget(
      { maxTokens: 50_000, maxTimeMs: 60_000 },
      () => t,
      { tokensUsed: 30_000, turnsUsed: 4, elapsedMs: 45_000 },
    );
    expect(budget.snapshot()).toMatchObject({ tokensUsed: 30_000, turnsUsed: 4, elapsedMs: 45_000 });
    expect(budget.check()).toBeNull();
    budget.addTokens(15_000, 6_000); // 51k total - over the ORIGINAL cap
    expect(budget.check()).toBe('tokens');
    t += 16_000; // 45s carried + 16s new > 60s
    expect(budget.snapshot().elapsedMs).toBe(61_000);
  });

  test('malformed carried values degrade to zero', async () => {
    const { createBudget } = await import('../src/lib/agent/budget.js');
    const budget = createBudget({}, () => 5, { tokensUsed: Number.NaN, turnsUsed: -3, elapsedMs: Number.NaN });
    expect(budget.snapshot()).toMatchObject({ tokensUsed: 0, turnsUsed: 0, elapsedMs: 0 });
  });
});

// ───────────────────── loop: onRunState boundaries ─────────────────────

describe('runAgent onRunState', () => {
  test('fires at conversation bind and each completed turn; a hook throw never breaks the run', async () => {
    const { respond } = scripted([
      { reply: toolBlock('list_dir', { path: '.' }) },
      { reply: 'All done.' },
    ]);
    responder = respond;
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const states: Array<{ conversationId: string; nativeTools: boolean; turnsCompleted: number }> = [];
    const res = await runAgent({
      task: 'look around',
      cwd: workDir,
      onRunState: (s) => {
        states.push(s);
        throw new Error('hook exploded'); // must be swallowed
      },
    });
    expect(res.finalText).toContain('All done');
    expect(states).toEqual([
      { conversationId: 'cnv_resume_a', nativeTools: false, turnsCompleted: 0 },
      { conversationId: 'cnv_resume_a', nativeTools: false, turnsCompleted: 1 },
    ]);
  });
});

// ───────────────────── resolution + drift (lib) ─────────────────────

describe('resolveResumeTarget / detectWorkspaceDrift', () => {
  test('latest picks the newest RESUMABLE session, skipping completed/old-format/byok', async () => {
    const { createRunRecorder, saveSession } = await import('../src/lib/agent/checkpoint.js');
    const { resolveResumeTarget } = await import('../src/lib/agent/resume.js');
    const base = {
      providerKind: 'spycore' as const,
      model: 'styx',
      planMode: false,
      maxTurns: 25,
      budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} },
      gitHead: null,
    };
    const resumable = createRunRecorder({ cwd: workDir, task: 'resumable', initial: base });
    resumable.update({ conversationId: 'cnv_old', turnsCompleted: 2 });
    resumable.finalize('interrupted');
    await new Promise((r) => setTimeout(r, 5)); // distinct epoch-ms ids
    const byok = createRunRecorder({ cwd: workDir, task: 'byok', initial: { ...base, providerKind: 'byok' } });
    byok.update({ conversationId: 'local-1' });
    byok.finalize('interrupted');
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(join(workDir, 'o.txt'), 'O');
    saveSession({ cwd: workDir, task: 'old-format', changes: [{ path: join(workDir, 'o.txt'), op: 'create', before: null, after: 'O' }] });

    const target = resolveResumeTarget(workDir, true);
    expect(target.session.task).toBe('resumable');
    expect(target.state.conversationId).toBe('cnv_old');
    // Same via the literal 'latest'.
    expect(resolveResumeTarget(workDir, 'latest').session.id).toBe(target.session.id);
    // Direct-id errors are specific:
    expect(() => resolveResumeTarget(workDir, byok.id)).toThrow(/custom provider/);
  });

  test('clean errors: unknown id, old-format, completed, never-started, none-resumable', async () => {
    const { createRunRecorder, saveSession, latestSession } = await import('../src/lib/agent/checkpoint.js');
    const { resolveResumeTarget } = await import('../src/lib/agent/resume.js');
    expect(() => resolveResumeTarget(workDir, true)).toThrow(/No resumable agent session/);
    expect(() => resolveResumeTarget(workDir, 'nope-123')).toThrow(/No session "nope-123"/);

    writeFileSync(join(workDir, 'x.txt'), 'X');
    saveSession({ cwd: workDir, task: 'old', changes: [{ path: join(workDir, 'x.txt'), op: 'create', before: null, after: 'X' }] });
    const oldId = latestSession(workDir)!.id;
    expect(() => resolveResumeTarget(workDir, oldId)).toThrow(/before resume support/);

    const base = {
      providerKind: 'spycore' as const,
      model: 'styx',
      planMode: false,
      maxTurns: 25,
      budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} },
      gitHead: null,
    };
    const done = createRunRecorder({ cwd: workDir, task: 'done', initial: base });
    done.update({ conversationId: 'cnv_d' });
    done.recordChange({ path: join(workDir, 'x.txt'), op: 'modify', before: 'X', after: 'X' });
    done.finalize('completed');
    expect(() => resolveResumeTarget(workDir, done.id)).toThrow(/already completed/);
  });

  test('drift: clean → null; journaled file modified → listed; git HEAD move detected', async () => {
    const { createRunRecorder, loadSession, getResumeState } = await import('../src/lib/agent/checkpoint.js');
    const { detectWorkspaceDrift, currentGitHead } = await import('../src/lib/agent/resume.js');
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: workDir, stdio: 'ignore' });
    };
    git('init');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'base');
    const head = currentGitHead(workDir);
    expect(head).toMatch(/^[0-9a-f]{40}$/);

    const file = join(workDir, 'made.txt');
    writeFileSync(file, 'agent wrote this');
    const rec = createRunRecorder({
      cwd: workDir,
      task: 't',
      initial: {
        providerKind: 'spycore',
        model: 'styx',
        planMode: false,
        maxTurns: 25,
        budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} },
        gitHead: head,
      },
    });
    rec.update({ conversationId: 'cnv_1' });
    rec.recordChange({ path: file, op: 'create', before: null, after: 'agent wrote this' });
    rec.finalize('interrupted');
    const session = loadSession(workDir, rec.id)!;
    const target = { session, state: getResumeState(session)! };

    expect(detectWorkspaceDrift(target)).toBeNull(); // untouched workspace

    writeFileSync(file, 'user edited this afterwards');
    const drift1 = detectWorkspaceDrift(target)!;
    expect(drift1.modifiedFiles).toEqual([file]);
    expect(drift1.headMoved).toBe(false);

    writeFileSync(file, 'agent wrote this'); // restore content
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'moved');
    const drift2 = detectWorkspaceDrift(target)!;
    expect(drift2.headMoved).toBe(true);
    expect(drift2.modifiedFiles).toEqual([]);
  });
});

// ───────────────────── command surface: flag validation ─────────────────────

describe('agent --resume flag validation', () => {
  test('--resume rejects a positional task and first-turn-only options', async () => {
    await expect(runAgentCli(['do stuff', '--resume'])).rejects.toThrow(/Cannot combine --resume with a task/);
    writeFileSync(join(workDir, 'img.txt'), 'x');
    await expect(runAgentCli(['--resume', '--attach', 'img.txt'])).rejects.toThrow(/--attach cannot be combined/);
    await expect(runAgentCli(['--resume', '--plan'])).rejects.toThrow(/--plan\/--no-plan cannot be combined/);
    await expect(runAgentCli(['--resume', '--no-plan'])).rejects.toThrow(/--plan\/--no-plan cannot be combined/);
    await expect(runAgentCli(['--resume', '--provider', 'openai'])).rejects.toThrow(/Provider options cannot be combined/);
    await expect(runAgentCli(['--resume', '--tool-protocol', 'fenced'])).rejects.toThrow(/--tool-protocol cannot be combined/);
  });

  test('a bare `spycore agent` still demands a task', async () => {
    await expect(runAgentCli([])).rejects.toThrow(/Task description is required/);
  });

  test('--resume with nothing to resume errors cleanly and points at the listing surface', async () => {
    await expect(runAgentCli(['--resume'])).rejects.toThrow(/No resumable agent session/);
    const { SpycoreCliError } = await import('../src/lib/errors.js');
    const err = await runAgentCli(['--resume', 'bogus-id']).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SpycoreCliError);
    expect((err as InstanceType<typeof SpycoreCliError>).message).toMatch(/No session "bogus-id"/);
    // The unknown-id error tells the user how to discover resumable sessions.
    expect((err as InstanceType<typeof SpycoreCliError>).hint).toMatch(/rewind --list/);
  });
});

// ───────────────────── end-to-end: interrupt → resume ─────────────────────

describe('interrupt → resume (headless)', () => {
  test('restores task/plan-position/changes, continues the SAME conversation, nothing replayed', async () => {
    await interruptedFirstRun();
    expect(readFileSync(join(workDir, 'marker.txt'), 'utf8')).toBe('v1\n');

    // The interrupt left a resumable record at the last completed boundary.
    const { listSessions, getResumeState } = await import('../src/lib/agent/checkpoint.js');
    const session = listSessions(workDir)[0]!;
    const state = getResumeState(session)!;
    expect(state.status).toBe('interrupted');
    expect(state.conversationId).toBe('cnv_resume_a');
    expect(state.turnsCompleted).toBe(1);
    expect(state.model).toBe('styx');
    expect(state.budget.tokensUsed).toBe(30_000);
    expect(session.changes).toHaveLength(1);

    // Resume: NO conversation create, ONE continuation message on the same id.
    const run2 = scripted([{ reply: 'Finished the task.' }], { allowCreate: false });
    responder = run2.respond;
    stderrChunks = [];
    await runAgentCli(['--resume']);
    expect(run2.streamBodies).toHaveLength(1);
    const body = run2.streamBodies[0]!;
    expect(body.conversationId).toBe('cnv_resume_a');
    const message = String(body.message);
    expect(message).toContain('RESUMING');
    expect(message).toContain('after 1 completed tool-calling turn');
    expect(message).not.toContain('You are SpyCode'); // no system prompt replay
    expect(message).not.toContain('TASK: make a marker file'); // task not re-sent

    // Banner: restored progress + re-resolved config, all stated.
    const err = stderrChunks.join('');
    expect(err).toMatch(/Resuming agent session/);
    expect(err).toMatch(/Task: make a marker file/);
    expect(err).toMatch(/1 completed turn · 1 file changed/);
    expect(err).toMatch(/model Styx \(from session\)/);
    expect(err).toMatch(/fenced tool protocol \(pinned by session\)/);
    expect(err).toMatch(/approvals prompt fresh/);

    // Completion finalizes the SAME lineage; a second --resume has nothing left.
    const after = listSessions(workDir);
    expect(after).toHaveLength(1);
    expect(getResumeState(after[0]!)?.status).toBe('completed');
    await expect(runAgentCli(['--resume'])).rejects.toThrow(/No resumable agent session/);
    await expect(runAgentCli(['--resume', after[0]!.id])).rejects.toThrow(/already completed/);
  });

  test('budgets are CUMULATIVE: a resumed run cannot exceed the original cap by resetting', async () => {
    await interruptedFirstRun(['--max-tokens', '50000']); // consumed 30k of 50k
    const run2 = scripted(
      [{ reply: toolBlock('list_dir', { path: '.' }), usage: { input: 10_000, output: 15_000 } }, { reply: 'never reached' }],
      { allowCreate: false },
    );
    responder = run2.respond;
    stderrChunks = [];
    await runAgentCli(['--resume']); // no budget flags - caps restored from the session
    const err = stderrChunks.join('');
    // 30k carried + 25k new = 55k ≥ the ORIGINAL 50k cap → controlled stop.
    expect(err).toMatch(/stopped - token budget reached \(55,000 \/ 50,000\)/);
    expect(run2.streamBodies).toHaveLength(1); // the second turn never ran

    // The budget-stopped run is itself re-resumable with its consumption intact.
    const { listSessions, getResumeState } = await import('../src/lib/agent/checkpoint.js');
    const state = getResumeState(listSessions(workDir)[0]!)!;
    expect(state.status).toBe('interrupted');
    expect(state.budget.tokensUsed).toBe(55_000);
    expect(state.budget.caps.maxTokens).toBe(50_000);
  });

  test('approval state is NOT inherited: a resume without --yes re-prompts (headless → rejects writes)', async () => {
    await interruptedFirstRun(); // original run had --yes
    const run2 = scripted(
      [{ reply: toolBlock('write_file', { path: 'marker.txt', content: 'v2\n' }) }, { reply: 'Done.' }],
      { allowCreate: false },
    );
    responder = run2.respond;
    stderrChunks = [];
    await runAgentCli(['--resume']); // NO --yes this time
    expect(readFileSync(join(workDir, 'marker.txt'), 'utf8')).toBe('v1\n'); // write rejected
    expect(stderrChunks.join('')).toMatch(/rejected write_file/);
    // The model was told approval is required on THIS invocation.
    expect(String(run2.streamBodies[1]!.message)).toMatch(/approval required/);
  });

  test('stale workspace: drift blocks non-interactive resume without --yes, proceeds (disclosed) with it', async () => {
    await interruptedFirstRun();
    writeFileSync(join(workDir, 'marker.txt'), 'user edited this\n'); // drift

    responder = scripted([{ reply: 'unused' }]).respond;
    await expect(runAgentCli(['--resume'])).rejects.toThrow(/Workspace changed since the interrupt/);

    const run2 = scripted([{ reply: 'Adapted and finished.' }], { allowCreate: false });
    responder = run2.respond;
    stderrChunks = [];
    await runAgentCli(['--resume', '--yes']);
    expect(stderrChunks.join('')).toMatch(/Workspace changed since the interrupt.*Continuing \(--yes\)/);
    expect(String(run2.streamBodies[0]!.message)).toMatch(/modified outside this session/);
  });

  test('--json resume reports resumed:true with the session id and the SAME conversation', async () => {
    await interruptedFirstRun();
    const { listSessions } = await import('../src/lib/agent/checkpoint.js');
    const sessionId = listSessions(workDir)[0]!.id;
    const run2 = scripted([{ reply: 'Finished.' }], { allowCreate: false });
    responder = run2.respond;
    stdoutChunks = [];
    await runAgentCli(['--resume', 'latest', '--json']);
    const lines = stdoutChunks.join('').trim().split('\n');
    const summary = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
    expect(summary).toMatchObject({
      resumed: true,
      sessionId,
      conversationId: 'cnv_resume_a',
      routedVia: 'resume',
      provider: 'spycore',
      task: 'make a marker file',
    });
  });

  test('native-protocol sessions resume with the pinned protocol (tools declared, no fenced hint)', async () => {
    // Interrupted native run, recorded directly at the checkpoint layer.
    const { createRunRecorder } = await import('../src/lib/agent/checkpoint.js');
    const rec = createRunRecorder({
      cwd: workDir,
      task: 'native task',
      initial: {
        providerKind: 'spycore',
        model: 'styx',
        planMode: false,
        maxTurns: 25,
        budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} },
        gitHead: null,
      },
    });
    rec.update({ conversationId: 'cnv_native', nativeTools: true, turnsCompleted: 2 });
    rec.finalize('interrupted');

    const run2 = scripted([{ reply: 'Resumed natively.' }], { allowCreate: false });
    responder = run2.respond;
    await runAgentCli(['--resume']);
    const body = run2.streamBodies[0]!;
    expect(body.conversationId).toBe('cnv_native');
    expect(Array.isArray(body.tools)).toBe(true); // NATIVE declarations resumed
    expect((body.tools as unknown[]).length).toBeGreaterThan(0);
    expect(String(body.message)).not.toContain('spycore:tool'); // no fenced hint
  });
});

// ───────────────────── rewind interplay ─────────────────────

describe('rewind × resume records', () => {
  async function runRewind(argv: string[]): Promise<void> {
    const { Command } = await import('commander');
    const { registerRewindCommand } = await import('../src/commands/rewind.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: argv.includes('--json'), color: false });
    const program = new Command();
    program.name('spycore').option('--json').option('--no-color');
    registerRewindCommand(program);
    process.chdir(workDir);
    await program.parseAsync(['node', 'spycore', 'rewind', ...argv]);
  }

  test('a changeless interrupted record never shadows the newest change-bearing session for bare rewind', async () => {
    const { createRunRecorder, saveSession, listSessions } = await import('../src/lib/agent/checkpoint.js');
    const f = join(workDir, 'made.txt');
    writeFileSync(f, 'agent made this\n');
    saveSession({ cwd: workDir, task: 'older run with changes', changes: [{ path: f, op: 'create', before: null, after: 'agent made this\n' }] });
    await new Promise((r) => setTimeout(r, 5));
    const rec = createRunRecorder({
      cwd: workDir,
      task: 'newer interrupted, no changes yet',
      initial: {
        providerKind: 'spycore',
        model: 'styx',
        planMode: false,
        maxTurns: 25,
        budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} },
        gitHead: null,
      },
    });
    rec.update({ conversationId: 'cnv_z' });
    rec.finalize('interrupted');
    expect(listSessions(workDir)).toHaveLength(2);

    await runRewind(['--yes']);
    expect(existsSync(f)).toBe(false); // the CHANGE-bearing session was rewound
    expect(stdoutChunks.join('')).toMatch(/Rewound 1 change/);
  });

  test('rewind --list marks resumable sessions (text + json)', async () => {
    const { createRunRecorder, saveSession } = await import('../src/lib/agent/checkpoint.js');
    writeFileSync(join(workDir, 'x.txt'), 'X');
    saveSession({ cwd: workDir, task: 'legacy session', changes: [{ path: join(workDir, 'x.txt'), op: 'create', before: null, after: 'X' }] });
    await new Promise((r) => setTimeout(r, 5));
    const rec = createRunRecorder({
      cwd: workDir,
      task: 'interrupted session',
      initial: {
        providerKind: 'spycore',
        model: 'styx',
        planMode: false,
        maxTurns: 25,
        budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} },
        gitHead: null,
      },
    });
    rec.update({ conversationId: 'cnv_q' });
    rec.finalize('interrupted');

    await runRewind(['--list']);
    const out = stdoutChunks.join('');
    const resumableLine = out.split('\n').find((l) => l.includes('interrupted session'));
    const legacyLine = out.split('\n').find((l) => l.includes('legacy session'));
    expect(resumableLine).toMatch(/resumable/);
    expect(legacyLine).not.toMatch(/resumable/);

    stdoutChunks = [];
    await runRewind(['--list', '--json']);
    const parsed = JSON.parse(stdoutChunks.join('')) as { sessions: Array<{ task: string; resumable: boolean }> };
    expect(parsed.sessions.find((s) => s.task === 'interrupted session')?.resumable).toBe(true);
    expect(parsed.sessions.find((s) => s.task === 'legacy session')?.resumable).toBe(false);
  });
});
