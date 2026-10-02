import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Command, Option } from 'commander';
import { freshConfigDir } from './helpers.js';
import { DEFAULT_LIMITS, dispatchTool, type ToolContext } from '../src/lib/agent/tools.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';

/**
 * `skills create` (prompt-to-skill) + `skills remove`: name derivation and
 * validation, fence-stripping, the content validation floor with its single
 * auto-retry, every collision source (official ledger / user / project),
 * write targeting (user-global vs --project), provider resolution + the
 * spycore-only login gate, and remove's ownership rules. The provider wire is
 * the mocked undici spycore wire (conversation create + SSE chat stream),
 * exactly like the part-1 loop tests.
 */
interface CapturedRequest {
  url: string;
  body?: string | undefined;
}
let requests: CapturedRequest[] = [];
let responder:
  | ((url: string) => { statusCode: number; headers: Record<string, string | string[]>; body: unknown })
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { body?: string } = {}) => {
    requests.push({ url, body: init.body });
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url);
  }),
}));

const hoisted = vi.hoisted(() => ({ authed: true }));
vi.mock('../src/lib/auth.js', async (orig) => {
  const actual = await orig<typeof import('../src/lib/auth.js')>();
  return { ...actual, isAuthenticated: () => Promise.resolve(hoisted.authed) };
});

let configDir: string;
let workDir: string;

beforeEach(() => {
  configDir = freshConfigDir(); // user-global root = <configDir>/skills
  requests = [];
  responder = null;
  hoisted.authed = true;
  workDir = mkdtempSync(join(tmpdir(), 'spycli-skillsc-'));
});
afterEach(() => {
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function sseResp(lines: string[]) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Readable.from([Buffer.from(lines.join(''), 'utf8')]),
  };
}
const dataLine = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

/** Responder: conversation create + a scripted sequence of generation replies. */
function createResponder(streamReplies: string[][]) {
  let i = 0;
  return (url: string) => {
    if (url.endsWith('/conversations')) {
      return {
        statusCode: 200,
        headers: {},
        body: { json: async () => ({ success: true, data: { id: 'cnv_gen' } }) },
      };
    }
    if (url.includes('/api/chat/stream')) {
      const chunks = streamReplies[Math.min(i, streamReplies.length - 1)] ?? [];
      i += 1;
      return sseResp([...chunks.map((c) => dataLine({ type: 'text', content: c })), dataLine({ type: 'done' })]);
    }
    throw new Error(`unexpected ${url}`);
  };
}

const streamCalls = (): CapturedRequest[] => requests.filter((r) => r.url.includes('/api/chat/stream'));

/** A well-formed generated SKILL.md (≥ the 20-non-empty-line floor by default). */
function genSkillMd(name: string, opts: { bodyLines?: number; fact?: string } = {}): string {
  const n = opts.bodyLines ?? 24;
  const lines = Array.from({ length: n }, (_, k) => `- guidance line ${k + 1}: handle this case carefully.`);
  if (opts.fact) lines.push(opts.fact);
  return [
    '---',
    `name: ${name}`,
    'description: Covers the topic end to end. Load when the task mentions the topic keywords.',
    '---',
    '# Overview',
    'Practical guidance for the topic.',
    '## When to use',
    ...lines,
    '## Pitfalls',
    '- Avoid the obvious mistake.',
  ].join('\n');
}

/** Create `<root>/skills/<dir>/SKILL.md` (pre-existing skill fixtures). */
function writeSkill(root: string, dir: string, content: string): void {
  const d = join(root, 'skills', dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), content, 'utf8');
}
const SKILL = (name: string, desc: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`;

/** Invoke the skills command in-process from workDir, capturing output. */
async function runSkills(argv: string[], opts: { json?: boolean } = {}) {
  const { configureOutput } = await import('../src/lib/output.js');
  const { registerSkillsCommand } = await import('../src/commands/skills/index.js');
  const program = new Command();
  program.exitOverride();
  program.addOption(new Option('--api-url <url>')).addOption(new Option('--json'));
  configureOutput({ json: Boolean(opts.json), color: false });
  registerSkillsCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origExit = process.exitCode;
  (process.stdout.write as unknown) = (c: string | Uint8Array) =>
    (out.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
  (process.stderr.write as unknown) = (c: string | Uint8Array) =>
    (err.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
  const origCwd = process.cwd();
  process.chdir(workDir);
  let error: unknown;
  try {
    await program.parseAsync(['skills', ...argv], { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    process.chdir(origCwd);
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    process.exitCode = origExit;
    configureOutput({ json: false, color: true });
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

const userSkillFile = (name: string): string => join(configDir, 'skills', name, 'SKILL.md');

// ───────────────────────── pure helpers ─────────────────────────

describe('deriveSkillName', () => {
  test('kebab-cases the description', async () => {
    const { deriveSkillName } = await import('../src/lib/skills-create.js');
    expect(deriveSkillName('redis caching patterns for our api')).toBe('redis-caching-patterns-for-our-api');
    expect(deriveSkillName('Use Redis (v7) for caching!!')).toBe('use-redis-v7-for-caching');
  });

  test('truncates at a word boundary at 40 chars', async () => {
    const { deriveSkillName } = await import('../src/lib/skills-create.js');
    const name = deriveSkillName('how to design accessible color systems for enterprise dashboards');
    expect(name).toBe('how-to-design-accessible-color-systems');
    expect(name.length).toBeLessThanOrEqual(40);
  });

  test('no usable words → empty; single overlong word → hard truncate', async () => {
    const { deriveSkillName } = await import('../src/lib/skills-create.js');
    expect(deriveSkillName('!!! ***')).toBe('');
    expect(deriveSkillName('x'.repeat(60))).toBe('x'.repeat(40));
  });
});

describe('validateSkillName', () => {
  test('accepts kebab-case names', async () => {
    const { validateSkillName } = await import('../src/lib/skills-create.js');
    for (const n of ['redis-caching', 'a', 'a1-b2-c3', 'x'.repeat(64)]) {
      expect(validateSkillName(n), n).toBeNull();
    }
  });

  test('rejects reserved/invalid shapes', async () => {
    const { validateSkillName } = await import('../src/lib/skills-create.js');
    for (const n of ['', 'Foo', 'two words', 'has_underscore', '-lead', 'trail-', 'double--dash', 'a.b', 'a/b', '..', 'x'.repeat(65)]) {
      expect(validateSkillName(n), JSON.stringify(n)).not.toBeNull();
    }
  });
});

describe('stripFences', () => {
  test('strips one outer fence pair (any info string), keeps inner fences', async () => {
    const { stripFences } = await import('../src/lib/skills-create.js');
    const file = '---\nname: x\n---\nBody with\n```js\ncode();\n```\ninside.';
    expect(stripFences('```markdown\n' + file + '\n```')).toBe(file);
    expect(stripFences('```\n' + file + '\n```\n')).toBe(file);
  });

  test('content without an outer fence passes through (trimmed)', async () => {
    const { stripFences } = await import('../src/lib/skills-create.js');
    expect(stripFences('\n---\nname: x\n---\nBody.\n')).toBe('---\nname: x\n---\nBody.');
    // Unbalanced opening fence: left alone for validation to catch.
    expect(stripFences('```markdown\n---\nname: x')).toBe('```markdown\n---\nname: x');
  });
});

describe('validateSkillContent', () => {
  test('well-formed content passes and parses', async () => {
    const { validateSkillContent } = await import('../src/lib/skills-create.js');
    const v = validateSkillContent(genSkillMd('good-one'), 'good-one');
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.parsed.description).toContain('Covers the topic');
  });

  test('missing frontmatter / missing description / name mismatch / short body all fail', async () => {
    const { validateSkillContent } = await import('../src/lib/skills-create.js');
    const noFm = validateSkillContent('# Just a doc\nwith no frontmatter\n', 'x');
    expect(noFm).toMatchObject({ ok: false, error: expect.stringContaining('frontmatter') });

    const noDesc = validateSkillContent('---\nname: x\n---\n# B\nbody\n', 'x');
    expect(noDesc).toMatchObject({ ok: false, error: expect.stringContaining('description') });

    const wrongName = validateSkillContent(genSkillMd('other-name'), 'x');
    expect(wrongName).toMatchObject({ ok: false, error: expect.stringContaining('"x"') });

    // No name in frontmatter cannot masquerade as a match (sentinel fallback).
    const noName = validateSkillContent('---\ndescription: d\n---\nbody\n', 'x');
    expect(noName.ok).toBe(false);

    const short = validateSkillContent(genSkillMd('x', { bodyLines: 3 }), 'x');
    expect(short).toMatchObject({ ok: false, error: expect.stringContaining('too short') });
  });
});

// ───────────────────────── skills create (command) ─────────────────────────

describe('skills create', () => {
  test('round-trip: generation → parse → write; frontmatter + body land; immediately discoverable + loadable', async () => {
    responder = createResponder([[genSkillMd('redis-caching-patterns-for-our-api')]]);
    const r = await runSkills(['create', 'redis caching patterns for our api']);
    expect(r.error).toBeUndefined();

    // Derived name targeted the user-global dir; content is intact.
    const file = userSkillFile('redis-caching-patterns-for-our-api');
    expect(existsSync(file)).toBe(true);
    const written = readFileSync(file, 'utf8');
    expect(written.startsWith('---\nname: redis-caching-patterns-for-our-api\n')).toBe(true);
    expect(written).toContain('## Pitfalls');
    expect(written.endsWith('\n')).toBe(true);

    // The wire: conversation created with the default model, then ONE stream
    // call whose first message carries the generation system prompt + topic.
    const convo = requests.find((q) => q.url.endsWith('/conversations'));
    expect(JSON.parse(convo?.body ?? '{}')).toMatchObject({ model: 'STYX' });
    expect(streamCalls()).toHaveLength(1);
    const msg = (JSON.parse(streamCalls()[0]?.body ?? '{}') as { message?: string }).message ?? '';
    expect(msg).toContain('expert technical writer');
    expect(msg).toContain('redis caching patterns for our api');
    expect(msg).toContain('EXACTLY this): redis-caching-patterns-for-our-api');

    expect(r.stdout).toContain('created');

    // Discoverable: catalog lists it; load_skill returns the body.
    const { discoverSkills, buildSkillsCatalog } = await import('../src/lib/agent/skills.js');
    const skills = discoverSkills(workDir);
    const mine = skills.find((s) => s.name === 'redis-caching-patterns-for-our-api');
    expect(mine).toMatchObject({ source: 'user' });
    expect(buildSkillsCatalog(skills)).toContain('redis-caching-patterns-for-our-api: Covers the topic');
    const ctx: ToolContext = {
      cwd: workDir,
      limits: DEFAULT_LIMITS,
      skills: new Map(skills.map((s) => [s.name, s])),
      loadedSkills: new Set<string>(),
    };
    const res = await dispatchTool('load_skill', { name: 'redis-caching-patterns-for-our-api' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('## Pitfalls');
  });

  test('streamed chunks accumulate and surrounding fences are stripped', async () => {
    const file = genSkillMd('fenced-skill');
    const mid = Math.floor(file.length / 2);
    responder = createResponder([['```markdown\n' + file.slice(0, mid), file.slice(mid) + '\n```']]);
    const r = await runSkills(['create', 'whatever topic', '--name', 'fenced-skill']);
    expect(r.error).toBeUndefined();
    const written = readFileSync(userSkillFile('fenced-skill'), 'utf8');
    expect(written.startsWith('---\n')).toBe(true);
    expect(written).not.toContain('```markdown');
  });

  test('--name overrides derivation; --project targets ./.spycore/skills; --json reports it', async () => {
    responder = createResponder([[genSkillMd('custom-name')]]);
    const r = await runSkills(['create', 'redis caching patterns', '--name', 'custom-name', '--project'], { json: true });
    expect(r.error).toBeUndefined();
    const file = join(workDir, '.spycore', 'skills', 'custom-name', 'SKILL.md');
    expect(existsSync(file)).toBe(true);
    expect(existsSync(userSkillFile('custom-name'))).toBe(false);
    const parsed = JSON.parse(r.stdout) as { name: string; path: string; source: string; retried: boolean };
    expect(parsed).toMatchObject({ name: 'custom-name', source: 'project', retried: false });
    // macOS realpath (/var → /private/var): compare by suffix, not byte-equal.
    expect(parsed.path.endsWith(join('.spycore', 'skills', 'custom-name', 'SKILL.md'))).toBe(true);
  });

  test('invalid --name → error BEFORE any network call; nothing written', async () => {
    responder = () => {
      throw new Error('no network expected');
    };
    for (const bad of ['Not-Kebab', 'two words', '../escape']) {
      const r = await runSkills(['create', 'topic', '--name', bad]);
      expect(String((r.error as Error)?.message)).toMatch(/Invalid skill name/);
    }
    expect(requests).toHaveLength(0);
    const r2 = await runSkills(['create', '!!! ***']); // underivable
    expect(String((r2.error as Error)?.message)).toMatch(/Could not derive/);
    expect(requests).toHaveLength(0);
  });

  test('collisions: existing user skill, project skill, and official LEDGER entry (even with no file) all refuse', async () => {
    responder = () => {
      throw new Error('no network expected');
    };
    writeSkill(configDir, 'taken-user', SKILL('taken-user', 'D', 'B'));
    writeSkill(join(workDir, '.spycore'), 'taken-project', SKILL('taken-project', 'D', 'B'));
    const { writeSyncState, emptySyncState } = await import('../src/lib/skills-sync.js');
    const state = emptySyncState();
    state.skills['ghost-official'] = { sha256: 'abc' }; // ledger-owned, file missing
    writeSyncState(state);

    const user = await runSkills(['create', 'topic', '--name', 'taken-user']);
    expect(String((user.error as Error)?.message)).toMatch(/user skill named "taken-user" already exists/);
    const project = await runSkills(['create', 'topic', '--name', 'taken-project']);
    expect(String((project.error as Error)?.message)).toMatch(/project skill named "taken-project" already exists/);
    const official = await runSkills(['create', 'topic', '--name', 'ghost-official']);
    expect(String((official.error as Error)?.message)).toMatch(/official skill/);
    expect((official.error as { hint?: string })?.hint ?? String((official.error as Error)?.message)).toBeTruthy();

    expect(requests).toHaveLength(0);
    expect(existsSync(userSkillFile('ghost-official'))).toBe(false);
  });

  test('validation floor: ONE auto-retry with the error fed back, then success', async () => {
    responder = createResponder([
      [genSkillMd('retry-skill', { bodyLines: 3 })], // too short → retry
      [genSkillMd('retry-skill')],
    ]);
    const r = await runSkills(['create', 'a topic', '--name', 'retry-skill'], { json: true });
    expect(r.error).toBeUndefined();
    expect(streamCalls()).toHaveLength(2);
    const retryMsg = (JSON.parse(streamCalls()[1]?.body ?? '{}') as { message?: string }).message ?? '';
    expect(retryMsg).toContain('failed validation');
    expect(retryMsg).toContain('too short');
    expect(JSON.parse(r.stdout)).toMatchObject({ name: 'retry-skill', retried: true });
    expect(existsSync(userSkillFile('retry-skill'))).toBe(true);
  });

  test('validation floor: still invalid after the single retry → clear failure, nothing written', async () => {
    responder = createResponder([
      [genSkillMd('bad-skill', { bodyLines: 2 })],
      ['not a skill file at all'],
    ]);
    const r = await runSkills(['create', 'a topic', '--name', 'bad-skill']);
    expect(String((r.error as Error)?.message)).toMatch(/failed validation after a retry/);
    expect(streamCalls()).toHaveLength(2); // exactly one retry — no third attempt
    expect(existsSync(userSkillFile('bad-skill'))).toBe(false);
  });

  test('spycore requires login; a BYOK provider must name a model (same resolution as agent)', async () => {
    responder = () => {
      throw new Error('no network expected');
    };
    hoisted.authed = false;
    const gated = await runSkills(['create', 'topic', '--name', 'needs-auth']);
    expect(String((gated.error as Error)?.message)).toMatch(/Not logged in/);

    const byok = await runSkills(['create', 'topic', '--name', 'byok-skill', '--provider', 'openai']);
    expect(String((byok.error as Error)?.message)).toMatch(/--model <id>` is required/);
    expect(requests).toHaveLength(0);
  });

  test('unknown spycore --model is rejected with the allowed list', async () => {
    responder = () => {
      throw new Error('no network expected');
    };
    const r = await runSkills(['create', 'topic', '--name', 'model-check', '--model', 'gpt-4o']);
    expect(String((r.error as Error)?.message)).toMatch(/Unknown model/);
    expect(requests).toHaveLength(0);
  });
});

// ───────────────────────── created skill in a real loop ─────────────────────────

describe('created skill is live for agent runs', () => {
  test('runAgent sees it in the catalog and loads it via load_skill', async () => {
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    responder = createResponder([[genSkillMd('cache-rules', { fact: 'The cache TTL is 42 seconds.' })]]);
    const created = await runSkills(['create', 'cache rules', '--name', 'cache-rules']);
    expect(created.error).toBeUndefined();

    // Fresh wire for the agent run: load_skill turn, then a final answer.
    requests = [];
    let turn = 0;
    responder = (url: string) => {
      if (url.endsWith('/conversations')) {
        return { statusCode: 200, headers: {}, body: { json: async () => ({ success: true, data: { id: 'cnv_run' } }) } };
      }
      if (url.includes('/api/chat/stream')) {
        turn += 1;
        const content =
          turn === 1
            ? '```spycore:tool\n{"tool":"load_skill","args":{"name":"cache-rules"}}\n```'
            : 'Per the skill, the cache TTL is 42 seconds.';
        return sseResp([dataLine({ type: 'text', content }), dataLine({ type: 'done' })]);
      }
      throw new Error(`unexpected ${url}`);
    };
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'what is the cache ttl?', cwd: workDir, onEvent: (e) => events.push(e) });

    const firstMsg = (JSON.parse(streamCalls()[0]?.body ?? '{}') as { message?: string }).message ?? '';
    expect(firstMsg).toContain('cache-rules: Covers the topic');
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'load_skill', ok: true });
    expect(result.finalText).toContain('42 seconds');
  });
});

// ───────────────────────── skills remove ─────────────────────────

describe('skills remove', () => {
  test('removes a user-created skill with --yes (and reports it)', async () => {
    writeSkill(configDir, 'mine', SKILL('mine', 'Mine', 'B'));
    const r = await runSkills(['remove', 'mine', '--yes'], { json: true });
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 'mine', source: 'user' });
    expect(existsSync(join(configDir, 'skills', 'mine'))).toBe(false);
  });

  test('removes a project skill with --yes', async () => {
    writeSkill(join(workDir, '.spycore'), 'proj-skill', SKILL('proj-skill', 'P', 'B'));
    const r = await runSkills(['remove', 'proj-skill', '--yes']);
    expect(r.error).toBeUndefined();
    expect(existsSync(join(workDir, '.spycore', 'skills', 'proj-skill'))).toBe(false);
  });

  test('REFUSES to remove an official (ledger-owned) skill, pointing at sync', async () => {
    const { writeSyncState, writeSyncedSkill, emptySyncState } = await import('../src/lib/skills-sync.js');
    writeSyncedSkill('official-one', SKILL('official-one', 'O', 'B'));
    const state = emptySyncState();
    state.skills['official-one'] = { sha256: 'abc' };
    writeSyncState(state);

    const r = await runSkills(['remove', 'official-one', '--yes']);
    expect(String((r.error as Error)?.message)).toMatch(/official skill/);
    expect(String((r.error as Error)?.message + (r.error as { hint?: string })?.hint)).toMatch(/sync/);
    expect(existsSync(join(configDir, 'skills', 'official-one', 'SKILL.md'))).toBe(true);
  });

  test('a PROJECT skill shadowing an official name IS removable (user content wins)', async () => {
    const { writeSyncState, writeSyncedSkill, emptySyncState } = await import('../src/lib/skills-sync.js');
    writeSyncedSkill('shadowed', SKILL('shadowed', 'Official', 'B'));
    const state = emptySyncState();
    state.skills['shadowed'] = { sha256: 'abc' };
    writeSyncState(state);
    writeSkill(join(workDir, '.spycore'), 'shadowed', SKILL('shadowed', 'Project copy', 'B'));

    const r = await runSkills(['remove', 'shadowed', '--yes']);
    expect(r.error).toBeUndefined();
    expect(existsSync(join(workDir, '.spycore', 'skills', 'shadowed'))).toBe(false);
    expect(existsSync(join(configDir, 'skills', 'shadowed', 'SKILL.md'))).toBe(true); // official copy untouched
  });

  test('unknown skill errors with the installed list; non-TTY without --yes refuses', async () => {
    writeSkill(configDir, 'keepme', SKILL('keepme', 'K', 'B'));
    const unknown = await runSkills(['remove', 'ghost']);
    expect(String((unknown.error as Error)?.message)).toMatch(/No skill named "ghost"/);

    const noYes = await runSkills(['remove', 'keepme']); // stdin is non-TTY in tests
    expect(String((noYes.error as Error)?.message)).toMatch(/non-interactive/);
    expect((noYes.error as { hint?: string })?.hint).toMatch(/--yes/);
    expect(existsSync(join(configDir, 'skills', 'keepme', 'SKILL.md'))).toBe(true);
  });
});
