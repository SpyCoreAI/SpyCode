/**
 * Committed regression tests for 4a2 items 1, 2, 3, 5a, 6-10, 12-19.
 *
 * 4a2 verified these with a throwaway vitest file that was deleted before
 * patch generation; only items 4, 20 and 21 have committed tests. Each test
 * below cites its 4a2 item and uses the exact verification case recorded in
 * `~/workspace/spycore-v0910-fix/work/4a2/fix-log-4a2.md`.
 *
 * INTEGRATION DEPENDENCY: this file imports functions that exist only in
 * 4a2's src changes, so it typechecks and passes ONLY with 4a2's patch
 * applied. Integrate 4a2's patch first (or alongside this one).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests } from '../src/lib/config.js';
import { discoverSkills, capSkillBody, LOAD_SKILL_BODY_CAP } from '../src/lib/agent/skills.js';
import {
  recordSkillLoad,
  findStaleSkills,
  readSkillUsage,
  DEFAULT_STALE_DAYS,
} from '../src/lib/agent/skill-curator.js';
import { validateSkillAuthoring } from '../src/lib/agent/skill-standards.js';
import { loadSecretGuardSync } from '../src/lib/agent/secrets.js';
import { checkEvidenceClaims } from '../src/lib/agent/evidence-check.js';
import { pruneTranscriptItems, COMPACT_ASSISTANT_CAP } from '../src/lib/agent/compaction.js';
import { runAgent, type AgentEvent, type RunAgentOptions } from '../src/lib/agent/loop.js';
import {
  createLoopDetector,
  MAX_SEEN_CONTENT,
  type LoopCallTrace,
  type TurnTrace,
} from '../src/lib/agent/loop-detector.js';
import { resolveAllowedModels } from '../src/lib/agent/router.js';
import { looksBinary } from '../src/lib/agent/tool-core.js';
import { validateArgs, buildToolDeclarations } from '../src/lib/agent/tools.js';
import {
  createRunTraceWriter,
  listRunTraces,
  readRunTrace,
  runTracePath,
  MAX_TRACE_EVENTS,
} from '../src/lib/agent/run-trace.js';
import { assembleFirstTurn } from '../src/lib/agent/run-prompt.js';
import { makeRunStateHook, currentGitHead } from '../src/lib/agent/resume.js';
import { createRunRecorder } from '../src/lib/agent/checkpoint.js';
import { createBudget } from '../src/lib/agent/budget.js';
import { runVerifyLoop } from '../src/lib/agent/verify.js';
import { WIRE_MESSAGE_MAX_CHARS } from '../src/lib/wire-limits.js';
import { seedUserSkill } from './loop-golden-scenarios.js';
import {
  ScriptProvider,
  block,
  byTurn,
  extraTool,
  removeDir,
  say,
  tempDir,
  type ScriptStep,
} from './loop-pin-harness.js';
import type { Provider, ProviderEvent } from '../src/lib/providers/types.js';

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
  bridge: null as null | ((opts: unknown) => Promise<unknown>),
}));
vi.mock('../src/lib/agent/mcp.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/lib/agent/mcp.js')>();
  return {
    ...real,
    setupMcpBridge: (opts: Parameters<typeof real.setupMcpBridge>[0]) =>
      mcp.bridge ? (mcp.bridge(opts) as ReturnType<typeof real.setupMcpBridge>) : real.setupMcpBridge(opts),
  };
});

const dirs: string[] = [];
function workspace(prefix: string): string {
  const cwd = tempDir(prefix);
  dirs.push(cwd);
  writeFileSync(join(cwd, 'alpha.txt'), 'alpha line\n');
  writeFileSync(join(cwd, 'beta.txt'), 'beta one\nbeta two\n');
  writeFileSync(join(cwd, 'gamma.txt'), 'gamma\n');
  return cwd;
}

beforeEach(() => {
  freshConfigDir();
  api.posts.length = 0;
  mcp.bridge = null;
});

afterEach(() => {
  __resetConfigForTests();
  vi.useRealTimers();
  for (const d of dirs.splice(0)) removeDir(d);
});

const lines = (...parts: string[]): string => parts.join('\n');

function only<T extends AgentEvent['type']>(events: AgentEvent[], type: T): Array<Extract<AgentEvent, { type: T }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
}

async function drive(
  provider: ScriptProvider,
  opts: Omit<RunAgentOptions, 'provider' | 'onEvent'>,
): Promise<{ result: Awaited<ReturnType<typeof runAgent>>; events: AgentEvent[] }> {
  const events: AgentEvent[] = [];
  const result = await runAgent({ ...opts, provider, onEvent: (e) => events.push(e) });
  return { result, events };
}

function writeSkill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`);
}

/** True when `s` contains a lone (unpaired) UTF-16 surrogate. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('4a2 item 1 — project skill discovery', () => {
  test('alphabetically-last directory wins a frontmatter-name collision', () => {
    const cwd = workspace('spycli-4a2-1-');
    writeSkill(join(cwd, '.spycore', 'skills', 'aaa'), 'dup-4a2', 'The aaa copy.');
    writeSkill(join(cwd, '.spycore', 'skills', 'zzz'), 'dup-4a2', 'The zzz copy.');
    // A fresh temp dir is untrusted: project skills stay hidden without the flag.
    expect(discoverSkills(cwd).some((s) => s.name === 'dup-4a2')).toBe(false);
    const found = discoverSkills(cwd, { includeUntrustedProject: true }).filter((s) => s.name === 'dup-4a2');
    expect(found).toHaveLength(1);
    expect(found[0]!.path.endsWith(join('zzz', 'SKILL.md'))).toBe(true);
  });

  test('capSkillBody truncates with the in-band marker', () => {
    const out = capSkillBody('a'.repeat(20_001));
    expect(out.truncated).toBe(true);
    expect(out.body).toBe(
      'a'.repeat(LOAD_SKILL_BODY_CAP) +
        `\n\n[skill body truncated at ${LOAD_SKILL_BODY_CAP} characters - the remainder was not loaded]`,
    );
    expect(capSkillBody('short').truncated).toBe(false);
  });

  test('capSkillBody never splits a surrogate pair straddling the cut', () => {
    const out = capSkillBody('a'.repeat(19_999) + '😀' + 'b'.repeat(100));
    expect(out.truncated).toBe(true);
    expect(hasLoneSurrogate(out.body)).toBe(false);
    // The pair starts at the cut, so the cut backs off before it: no emoji survives.
    expect(out.body.includes('😀')).toBe(false);
  });
});

describe('4a2 item 2 — skill curator telemetry', () => {
  test('a corrupt usage file is quarantined and telemetry keeps working', () => {
    const userDir = tempDir('skills-4a2-2-');
    dirs.push(userDir);
    writeFileSync(join(userDir, '.usage.json'), 'not json{{{');
    recordSkillLoad('s1', userDir);
    const names = readdirSync(userDir);
    expect(names.some((f) => f.startsWith('.usage.json.corrupt-'))).toBe(true);
    expect(names.filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(readSkillUsage(userDir)['s1']?.views).toBe(1);
  });

  test('a negative inactiveDays falls back to the default instead of matching everything', () => {
    expect(DEFAULT_STALE_DAYS).toBe(90);
    const userDir = tempDir('skills-4a2-2b-');
    dirs.push(userDir);
    mkdirSync(join(userDir, 'idle-skill'), { recursive: true });
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      join(userDir, '.usage.json'),
      JSON.stringify({ version: 1, skills: { 'idle-skill': { views: 3, lastActivityAt: tenDaysAgo } } }),
    );
    const now = Date.now();
    const negative = findStaleSkills({ userDir, inactiveDays: -5, now });
    const def = findStaleSkills({ userDir, inactiveDays: 90, now });
    expect(negative).toEqual(def);
    expect(negative).toEqual([]);
    // The same 10-day-idle skill IS stale under a 0-day threshold.
    expect(findStaleSkills({ userDir, inactiveDays: 0, now }).map((s) => s.name)).toEqual(['idle-skill']);
  });
});

describe('4a2 item 3 — skill authoring standards', () => {
  const base = (description: string) => ({
    name: 'x',
    description,
    body: 'body',
    frontmatter: {},
    hasScripts: false,
  });

  test('marketing words in the description are flagged', () => {
    for (const description of ['The ultimate! guide.', 'A best-in-class. helper.']) {
      const rules = validateSkillAuthoring(base(description)).map((f) => f.rule);
      expect(rules).toContain('description-marketing');
    }
  });

  test('a version number is not a second sentence', () => {
    const rules = validateSkillAuthoring(base('Ships v1.2.3 today.')).map((f) => f.rule);
    expect(rules).not.toContain('description-sentence');
  });

  test('two real sentences are still flagged', () => {
    const rules = validateSkillAuthoring(base('Does this. And that.')).map((f) => f.rule);
    expect(rules).toContain('description-sentence');
  });
});

describe('4a2 item 5a — the sync secret guard honours .spycoreignore', () => {
  test('an ignored path is blocked, a plain path is allowed', () => {
    const cwd = workspace('spycli-4a2-5a-');
    writeFileSync(join(cwd, '.spycoreignore'), 'ignored.txt\n');
    const guard = loadSecretGuardSync(cwd);
    expect(guard(join(cwd, 'ignored.txt'))).toBe(true);
    expect(guard(join(cwd, 'plain.txt'))).toBe(false);
  });
});

describe('4a2 item 6 — evidence claims need a matching successful call', () => {
  test('delegate, MCP test/build/lint tools and pnpm test back their claims', () => {
    expect(checkEvidenceClaims('Tests passed.', [{ tool: 'delegate', ok: true }])).toEqual([]);
    expect(checkEvidenceClaims('Tests passed.', [{ tool: 'mcp__srv__run_tests', ok: true }])).toEqual([]);
    expect(checkEvidenceClaims('Build succeeded.', [{ tool: 'mcp__srv__build', ok: true }])).toEqual([]);
    expect(checkEvidenceClaims('Lint passed.', [{ tool: 'mcp__srv__eslint', ok: true }])).toEqual([]);
    expect(
      checkEvidenceClaims('Tests passed.', [{ tool: 'run_command', ok: true, command: 'pnpm test' }]),
    ).toEqual([]);
  });

  test('a near-miss tool name and a failed call do not back the claim', () => {
    expect(checkEvidenceClaims('Tests passed.', [{ tool: 'mcp__srv__testify', ok: true }]).length).toBeGreaterThan(
      0,
    );
    expect(checkEvidenceClaims('Tests passed.', [{ tool: 'delegate', ok: false }]).length).toBeGreaterThan(0);
  });
});

describe('4a2 item 7 — transcript pruning caps surrogate-safe', () => {
  test('an over-cap assistant item is cut before the pair, never through it', () => {
    expect(COMPACT_ASSISTANT_CAP).toBe(800);
    const text = 'a'.repeat(799) + '😀' + 'b'.repeat(100);
    const out = pruneTranscriptItems([{ kind: 'assistant', final: false, text }]);
    expect(out.pruned).toBe(1);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]!.text).toBe('a'.repeat(799) + '… [pruned]');
    expect(out.items[0]!.text!.length).toBe(809);
    expect(hasLoneSurrogate(out.items[0]!.text!)).toBe(false);
  });
});

describe('4a2 item 12 — run trace bounds', () => {
  test('the event cap drops the 10,001st event and records it on close', () => {
    expect(MAX_TRACE_EVENTS).toBe(10_000);
    const dir = tempDir('trace-4a2-12-');
    dirs.push(dir);
    const w = createRunTraceWriter({ traceId: 'trace-cap', task: 't', model: 'm', detached: false, configDir: dir });
    for (let i = 0; i < 10_001; i += 1) {
      w.append({ type: 'assistant_token', turn: 1, chunk: 'x' });
    }
    w.close({
      finalText: 'f',
      turns: 1,
      toolCalls: 0,
      changedFiles: 0,
      cancelled: false,
      reachedMaxTurns: false,
      budgetStop: null,
    });
    const linesOut = readRunTrace('trace-cap', dir);
    expect(linesOut).not.toBeNull();
    // Header + 10,000 kept events + result line.
    expect(linesOut!.length).toBe(10_002);
    const resultLine = linesOut![linesOut!.length - 1] as { result: { droppedEvents?: number } };
    expect(resultLine.result.droppedEvents).toBe(1);
  });

  test('listRunTraces is newest-first by mtime, not by id', () => {
    const dir = tempDir('trace-4a2-12b-');
    dirs.push(dir);
    const mk = (id: string) =>
      createRunTraceWriter({ traceId: id, task: 't', model: 'm', detached: false, configDir: dir }).close({
        finalText: 'f',
        turns: 1,
        toolCalls: 0,
        changedFiles: 0,
        cancelled: false,
        reachedMaxTurns: false,
        budgetStop: null,
      });
    mk('aaa');
    mk('mmm');
    mk('zzz');
    // Mtimes ordered opposite to the names: zzz newest, aaa oldest.
    const now = Date.now();
    utimesSync(runTracePath('zzz', dir), new Date(now - 1000), new Date(now - 1000));
    utimesSync(runTracePath('mmm', dir), new Date(now - 2000), new Date(now - 2000));
    utimesSync(runTracePath('aaa', dir), new Date(now - 3000), new Date(now - 3000));
    expect(listRunTraces(dir)).toEqual(['zzz', 'mmm', 'aaa']);
  });
});

describe('4a2 item 13 — the wire clamp applies to every provider', () => {
  test('a BYOK provider with a 100,000-char skills section gets a clamped system', () => {
    const events: AgentEvent[] = [];
    const provider = { id: 'openai' } as unknown as Provider;
    const cwd = workspace('spycli-4a2-13-');
    const firstTurn = assembleFirstTurn({
      opts: { task: 't', cwd },
      emit: (e) => events.push(e),
      provider,
      maxTurns: 25,
      nativeMode: false,
      skillsSection: 's'.repeat(100_000),
      mcpSection: '',
      webEnabled: true,
      delegateEnabled: true,
    });
    expect(firstTurn.system.length).toBeLessThanOrEqual(WIRE_MESSAGE_MAX_CHARS);
    expect(events.some((e) => e.type === 'context_clamped')).toBe(true);
  });
});

describe('4a2 item 14 — the run-state hook caches the git head', () => {
  test('the head is cached for 30s, then refreshed', () => {
    vi.useFakeTimers();
    try {
      const repo = tempDir('git-4a2-14-');
      dirs.push(repo);
      execFileSync('git', ['init', '-q', repo]);
      execFileSync('git', ['-C', repo, 'config', 'user.email', 't@t.t']);
      execFileSync('git', ['-C', repo, 'config', 'user.name', 't']);
      writeFileSync(join(repo, 'f.txt'), 'one\n');
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'one']);
      const h1 = currentGitHead(repo);
      expect(h1).not.toBeNull();
      const rec = createRunRecorder({
        cwd: repo,
        task: 't',
        initial: {
          providerKind: 'spycore',
          model: 'styx',
          planMode: false,
          maxTurns: 25,
          budget: { tokensUsed: 0, turnsUsed: 0, elapsedMs: 0, caps: {} },
          gitHead: null,
        },
      });
      const hook = makeRunStateHook({ recorder: rec, budget: createBudget({}), cwd: repo, loadedSkills: new Set() });
      const state = { conversationId: 'cnv_1', nativeTools: false, turnsCompleted: 0 };
      hook(state);
      expect(rec.state().gitHead).toBe(h1);
      writeFileSync(join(repo, 'f.txt'), 'two\n');
      execFileSync('git', ['-C', repo, 'add', '.']);
      execFileSync('git', ['-C', repo, 'commit', '-qm', 'two']);
      const h2 = currentGitHead(repo);
      expect(h2).not.toBeNull();
      expect(h2).not.toBe(h1);
      hook(state);
      expect(rec.state().gitHead).toBe(h1);
      vi.advanceTimersByTime(31_000);
      hook(state);
      expect(rec.state().gitHead).toBe(h2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('4a2 item 15 — verify loop early stops report ran: false', () => {
  const fakeResult = (conversationId: string) => ({
    finalText: '',
    turns: 1,
    toolCalls: 0,
    reachedMaxTurns: false,
    cancelled: false,
    events: [],
    changedFiles: 0,
    conversationId,
    budgetStop: null,
  });

  test('an abort before the first attempt ran nothing', async () => {
    const cwd = workspace('spycli-4a2-15-');
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const out = await runVerifyLoop('c1', {
      verifyCommand: 'true',
      attempts: 3,
      cwd,
      signal: ac.signal,
      continueRun: async (cid) => {
        calls += 1;
        return fakeResult(cid);
      },
    });
    expect(out).toMatchObject({ ran: false, passed: false, attempts: 0, cancelled: true });
    expect(calls).toBe(0);
  });

  test('a budget stop before the first attempt ran nothing', async () => {
    const cwd = workspace('spycli-4a2-15b-');
    const budget = createBudget({ maxTokens: 1 }, Date.now, { tokensUsed: 5, turnsUsed: 0, elapsedMs: 0 });
    let calls = 0;
    const out = await runVerifyLoop('c1', {
      verifyCommand: 'true',
      attempts: 3,
      cwd,
      budget,
      continueRun: async (cid) => {
        calls += 1;
        return fakeResult(cid);
      },
    });
    expect(out).toMatchObject({ ran: false, passed: false, attempts: 0, stoppedByBudget: true });
    expect(calls).toBe(0);
  });
});

describe('4a2 item 16 — only the free tier clamps to Hermes', () => {
  test('slugs containing "free" that are not the free tier keep the full set', () => {
    expect(resolveAllowedModels('carefree')?.has('minos')).toBe(true);
    expect(resolveAllowedModels('pro-free-addon')?.has('minos')).toBe(true);
  });

  test('the free tier, in all its spellings, is Hermes-only', () => {
    expect(resolveAllowedModels('free')).toEqual(new Set(['hermes']));
    expect(resolveAllowedModels('free_trial')).toEqual(new Set(['hermes']));
    expect(resolveAllowedModels('free-tier')).toEqual(new Set(['hermes']));
  });

  test('an absent plan means no clamp', () => {
    expect(resolveAllowedModels(undefined)).toBeNull();
  });
});

describe('4a2 item 17 — the loop detector bounds its memory', () => {
  const read = (path: string, content: string, ok = true): LoopCallTrace => ({
    tool: 'read_file',
    argsKey: JSON.stringify({ path }),
    ok,
    content,
    mutating: false,
  });
  const turn = (n: number, calls: LoopCallTrace[]): TurnTrace => ({ turn: n, calls });

  test('re-reads inside one turn are not a loop', () => {
    const d = createLoopDetector();
    expect(
      d.observeTurn(turn(1, [read('a.txt', 'x'), read('a.txt', 'x'), read('a.txt', 'x'), read('a.txt', 'x')])),
    ).toMatchObject({ level: 'none' });
  });

  test('after the memory bound, re-reading evicted content warns once and never vetoes', () => {
    expect(MAX_SEEN_CONTENT).toBe(1024);
    const d = createLoopDetector();
    for (let i = 0; i < 1100; i += 1) {
      d.observeTurn(turn(i + 1, [read(`f${i}.txt`, `content-${i}`)]));
    }
    const verdicts = [];
    for (let j = 0; j < 12; j += 1) {
      verdicts.push(d.observeTurn(turn(1101 + j, [read(`g${j}.txt`, 'content-0')])));
    }
    expect(verdicts.filter((v) => v.level === 'warn')).toHaveLength(1);
    expect(verdicts.filter((v) => v.level === 'veto' || v.level === 'breaker')).toHaveLength(0);
  });
});

describe('4a2 item 18 — tool argument validation', () => {
  const params = {
    type: 'object' as const,
    properties: {
      s: { type: 'string' as const, description: 'a string' },
      n: { type: 'number' as const, description: 'a number' },
    },
  };

  test('null is not a valid string and NaN is not a valid number', () => {
    expect(validateArgs(params, { s: null })).toEqual(['"s" must be a string']);
    expect(validateArgs(params, { n: Number.NaN })).toEqual(['"n" must be a number']);
  });

  test('an absent optional is skipped', () => {
    expect(validateArgs(params, { s: undefined })).toEqual([]);
  });

  test('a declaration with an invalid name is dropped and reported', () => {
    const seen: string[] = [];
    const decls = buildToolDeclarations({
      extraTools: new Map([
        ['bad name!', extraTool('bad name!', () => Promise.resolve({ ok: true, summary: '', content: '' }))],
      ]),
      onInvalidName: (name) => seen.push(name),
    });
    expect(seen).toEqual(['bad name!']);
    expect(decls.some((d) => d.name === 'bad name!')).toBe(false);
  });
});

describe('4a2 item 19 — binary detection', () => {
  test('UTF-16LE text, with or without a BOM, is not binary; a PNG start is', () => {
    expect(looksBinary(Buffer.from('hello', 'ascii'))).toBe(false);
    expect(looksBinary(Buffer.from('hello', 'utf16le'))).toBe(false);
    expect(looksBinary(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello', 'utf16le')]))).toBe(false);
    // The bare 8-byte PNG signature alone scores below the 30% control-byte
    // threshold (1 suspicious byte in 8), so it is NOT binary by itself.
    expect(looksBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
    // A real PNG start — signature + IHDR length + 'IHDR' + dimensions —
    // carries NUL bytes in the width/height fields, so it is binary.
    expect(
      looksBinary(
        Buffer.from([
          0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00,
          0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00,
        ]),
      ),
    ).toBe(true);
  });
});

describe('4a2 item 8b — the moved declarations still serve finalize', () => {
  // `evidenceCalls`, `hitTurnCap` and `turnBudgetHit` moved above
  // `finalizeAnswer`/`checkLoop` (a declaration-order fix; the old order was
  // runtime-safe because the closures run after declaration). There is no
  // behavioral delta to catch — this pins the two finalize paths the moved
  // declarations feed, so a future move that breaks them turns red.
  test('a turn-cap run with evidence calls finalizes instead of throwing', async () => {
    const cwd = workspace('spycli-4a2-8b-');
    const provider = new ScriptProvider({
      script: byTurn([
        say(lines(block('read_file', { path: 'alpha.txt' }), block('read_file', { path: 'beta.txt' }))),
        say('Done.'),
      ]),
    });
    const { result } = await drive(provider, { task: 'cap', cwd, maxTurns: 1 });
    expect(result.reachedMaxTurns).toBe(true);
    expect(result.toolCalls).toBe(2);
    expect(result.finalText).toBe('Done.');
  });

  test('a plain final answer finalizes with no evidence calls', async () => {
    const cwd = workspace('spycli-4a2-8b2-');
    const provider = new ScriptProvider({ script: byTurn([say('Done.')]) });
    const { result } = await drive(provider, { task: 'plain', cwd });
    expect(result.reachedMaxTurns).toBe(false);
    expect(result.finalText).toBe('Done.');
  });
});

describe('4a2 item 8c — the no-usage estimate still trips auto-compact', () => {
  test('a ~1,050,000-char no-usage turn emits context_full on turn 2', { timeout: 60_000 }, async () => {
    const cwd = workspace('spycli-4a2-8c-');
    const big = 'x'.repeat(1_050_000) + '\n' + block('read_file', { path: 'alpha.txt' });
    const noUsageTurn: ScriptStep[] = [
      { type: 'text', text: big },
      { type: 'done' },
    ];
    const provider = new ScriptProvider({ script: byTurn([noUsageTurn, say('Done.')]) });
    const { result, events } = await drive(provider, { task: 'big', cwd, model: 'hermes' });
    const full = only(events, 'context_full');
    expect(full).toHaveLength(1);
    expect(full[0]!.turn).toBe(2);
    expect(result.finalText).toBe('Done.');
  });
});

describe('4a2 item 9 — load_skill is not parallelizable', () => {
  test('two load_skill calls for one skill in one turn serialize: the second sees already loaded', async () => {
    seedUserSkill();
    const cwd = workspace('spycli-4a2-9-');
    const provider = new ScriptProvider({
      script: byTurn([
        say(lines(block('load_skill', { name: 'pin-guide' }), block('load_skill', { name: 'pin-guide' }))),
        say('Done.'),
      ]),
    });
    const { events } = await drive(provider, { task: 'skills', cwd });
    expect(only(events, 'tool_result').map((e) => e.summary)).toEqual(['2 lines', 'already loaded']);
  });
});

describe('4a2 item 10 — a delegate child inherits the parent limits', () => {
  /**
   * Minimal scripted provider: one reply sequence per conversation, in
   * creation order (parent first, then each child as `delegate` executes).
   * Records every conversation's first-turn system+message so tests can
   * see the child's catalogue.
   */
  class FakeProvider implements Provider {
    readonly id: Provider['id'] = 'spycore';
    private convSeq = 0;
    private readonly queued: Array<Array<{ text: string }>> = [];
    private readonly turnsByConv = new Map<string, Array<{ text: string }>>();
    readonly firstTurns: string[] = [];

    get conversationCount(): number {
      return this.convSeq;
    }

    queueScript(turns: Array<{ text: string }>): void {
      this.queued.push(turns);
    }

    async createConversation(): Promise<string> {
      this.convSeq += 1;
      const id = `cnv_${this.convSeq}`;
      this.turnsByConv.set(id, [...(this.queued.shift() ?? [{ text: 'Done.' }])]);
      return id;
    }

    async *streamChat(params: Parameters<Provider['streamChat']>[0]): AsyncGenerator<ProviderEvent> {
      if (params.system !== undefined) {
        this.firstTurns.push(`${params.system}\n\n${params.message}`);
      }
      const queue = this.turnsByConv.get(params.conversationId) ?? [];
      const turn = queue.shift() ?? { text: 'Done.' };
      if (turn.text.length > 0) yield { type: 'text', text: turn.text };
      yield { type: 'usage', input: 10, output: 5 };
      yield { type: 'done' };
    }
  }

  test('the child inherits maxToolCallsPerTurn', async () => {
    const cwd = workspace('spycli-4a2-10a-');
    writeFileSync(join(cwd, 'notes.txt'), 'notes\n');
    writeFileSync(join(cwd, 'more.txt'), 'more\n');
    const provider = new FakeProvider();
    provider.queueScript([{ text: block('delegate', { task: 'read both files' }) }, { text: 'Parent done.' }]);
    provider.queueScript([
      {
        text: lines(block('read_file', { path: 'notes.txt' }), block('read_file', { path: 'more.txt' })),
      },
      { text: 'Child done.' },
    ]);
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'delegate some work',
      cwd,
      provider,
      maxToolCallsPerTurn: 1,
      onEvent: (e) => events.push(e),
    });
    expect(result.finalText).toBe('Parent done.');
    expect(provider.conversationCount).toBe(2);
    // The child's second call in the same turn was capped, not dispatched.
    const caps = only(events, 'tool_call_cap').filter((e) => e.depth === 1);
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({ cap: 1, skipped: 1 });
    const childCalls = only(events, 'tool_call').filter((e) => e.depth === 1);
    expect(childCalls).toHaveLength(1);
    expect(childCalls[0]!.tool).toBe('read_file');
  });

  test('the child inherits disabledToolsets', async () => {
    const runOnce = async (disabledToolsets?: string[]) => {
      const cwd = workspace('spycli-4a2-10b-');
      writeFileSync(join(cwd, 'notes.txt'), 'notes\n');
      const provider = new FakeProvider();
      provider.queueScript([{ text: block('delegate', { task: 'read the file' }) }, { text: 'Parent done.' }]);
      provider.queueScript([{ text: block('read_file', { path: 'notes.txt' }) }, { text: 'Child done.' }]);
      const result = await runAgent({
        task: 'delegate some work',
        cwd,
        provider,
        disabledToolsets,
        onEvent: () => {},
      });
      expect(result.finalText).toBe('Parent done.');
      return provider.firstTurns[1] ?? '';
    };
    // Control first: without the gate the child's catalogue offers web tools.
    expect(await runOnce()).toContain('web_search');
    // With the gate, the child's catalogue drops the whole web toolset.
    expect(await runOnce(['web'])).not.toContain('web_search');
  });
});
