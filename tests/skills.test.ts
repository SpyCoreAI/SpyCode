import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Command, Option } from 'commander';
import { freshConfigDir } from './helpers.js';
import { DEFAULT_LIMITS, dispatchTool, type ToolContext } from '../src/lib/agent/tools.js';
import type { DiscoveredSkill } from '../src/lib/agent/skills.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';

/**
 * Skills infrastructure: discovery + precedence, lenient frontmatter, the
 * catalog (presence/absence/cap), the load_skill tool (strict lookup, no
 * traversal, repeat notice), the skills command group, and the spycore
 * skills_activated → AgentEvent surfacing (BYOK never emits it).
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

let configDir: string;
let workDir: string;

beforeEach(() => {
  configDir = freshConfigDir(); // also the user-global root (<configDir>/skills)
  requests = [];
  responder = null;
  workDir = mkdtempSync(join(tmpdir(), 'spycli-skills-'));
});
afterEach(() => {
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

/** Create `<root>/skills/<dir>/SKILL.md`. */
function writeSkill(root: string, dir: string, content: string): void {
  const d = join(root, 'skills', dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'SKILL.md'), content, 'utf8');
}
const projectRoot = (): string => join(workDir, '.spycore');
const SKILL = (name: string, desc: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`;

function sseResp(lines: string[]) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Readable.from([Buffer.from(lines.join(''), 'utf8')]),
  };
}
const dataLine = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

// ───────────────────────── parsing ─────────────────────────

describe('parseSkillFile', () => {
  test('reads frontmatter name + description; body excludes frontmatter', async () => {
    const { parseSkillFile } = await import('../src/lib/agent/skills.js');
    const p = parseSkillFile('---\nname: my-skill\ndescription: "Does things"\n---\n# Title\nBody here\n', 'dir-name');
    expect(p.name).toBe('my-skill');
    expect(p.description).toBe('Does things');
    expect(p.body).toContain('Body here');
    expect(p.body).not.toContain('name: my-skill');
  });

  test('missing name → dir fallback; missing description → first body line', async () => {
    const { parseSkillFile } = await import('../src/lib/agent/skills.js');
    const p = parseSkillFile('---\nauthor: someone\n---\n## How to review\nSteps follow.\n', 'code-review');
    expect(p.name).toBe('code-review');
    expect(p.description).toBe('How to review');
  });

  test('YAML block-scalar description (`description: |`) reads the indented lines', async () => {
    const { parseSkillFile } = await import('../src/lib/agent/skills.js');
    const raw = '---\nname: cwv\ndescription: |\n  Core Web Vitals optimization.\n  Covers LCP and INP.\nversion: 1.0.0\n---\nBody.\n';
    const p = parseSkillFile(raw, 'dir');
    expect(p.name).toBe('cwv');
    expect(p.description).toBe('Core Web Vitals optimization. Covers LCP and INP.');
    expect(p.body).toContain('Body.');
  });

  test('no frontmatter at all → dir name + first line', async () => {
    const { parseSkillFile } = await import('../src/lib/agent/skills.js');
    const p = parseSkillFile('Just instructions, no metadata.\nMore.\n', 'bare');
    expect(p.name).toBe('bare');
    expect(p.description).toBe('Just instructions, no metadata.');
    expect(p.body).toContain('Just instructions');
  });
});

// ───────────────────────── discovery + precedence ─────────────────────────

describe('discoverSkills', () => {
  test('finds skills in both roots; project overrides user on collision; sorted', async () => {
    writeSkill(configDir, 'alpha', SKILL('alpha', 'user alpha', 'A'));
    writeSkill(configDir, 'shared', SKILL('shared', 'user version', 'U'));
    writeSkill(projectRoot(), 'shared', SKILL('shared', 'project version', 'P'));
    writeSkill(projectRoot(), 'zeta', SKILL('zeta', 'project zeta', 'Z'));
    const { discoverSkills } = await import('../src/lib/agent/skills.js');
    const skills = discoverSkills(workDir);
    expect(skills.map((s) => `${s.name}:${s.source}`)).toEqual(['alpha:user', 'shared:project', 'zeta:project']);
    expect(skills.find((s) => s.name === 'shared')?.description).toBe('project version');
  });

  test('ignores dirs without SKILL.md and returns [] when no roots exist', async () => {
    mkdirSync(join(projectRoot(), 'skills', 'not-a-skill'), { recursive: true });
    const { discoverSkills } = await import('../src/lib/agent/skills.js');
    expect(discoverSkills(workDir)).toEqual([]);
  });
});

// ───────────────────────── catalog ─────────────────────────

describe('buildSkillsCatalog', () => {
  test("'' for zero skills; entries + load_skill instruction otherwise", async () => {
    const { buildSkillsCatalog, discoverSkills } = await import('../src/lib/agent/skills.js');
    expect(buildSkillsCatalog([])).toBe('');
    writeSkill(projectRoot(), 'review', SKILL('review', 'Review code well', 'B'));
    const cat = buildSkillsCatalog(discoverSkills(workDir));
    expect(cat).toContain('# Skills');
    expect(cat).toContain('- review: Review code well');
    expect(cat).toContain('load_skill');
  });

  test('caps at ~4KB with a names-only overflow line', async () => {
    const { buildSkillsCatalog, SKILLS_CATALOG_CAP } = await import('../src/lib/agent/skills.js');
    const many: DiscoveredSkill[] = Array.from({ length: 80 }, (_, i) => ({
      name: `skill-${String(i).padStart(2, '0')}`,
      description: 'D'.repeat(150),
      source: 'user' as const,
      path: '/x/SKILL.md',
    }));
    const cat = buildSkillsCatalog(many);
    expect(cat.length).toBeLessThanOrEqual(SKILLS_CATALOG_CAP + 600); // entries cap + bounded names line
    expect(cat).toContain('more, loadable by exact name');
    expect(cat).toContain('skill-00');
  });
});

// ───────────────────────── load_skill tool ─────────────────────────

describe('load_skill tool', () => {
  const ctxWith = (skills: DiscoveredSkill[], loaded = new Set<string>()): ToolContext => ({
    cwd: workDir,
    limits: DEFAULT_LIMITS,
    skills: new Map(skills.map((s) => [s.name, s])),
    loadedSkills: loaded,
  });

  test('returns the body; repeat returns the short already-loaded notice', async () => {
    writeSkill(projectRoot(), 'codes', SKILL('codes', 'Launch codes', 'The launch code is OMEGA-9.'));
    const { discoverSkills } = await import('../src/lib/agent/skills.js');
    const loaded = new Set<string>();
    const ctx = ctxWith(discoverSkills(workDir), loaded);
    const first = await dispatchTool('load_skill', { name: 'codes' }, ctx);
    expect(first.ok).toBe(true);
    expect(first.content).toContain('OMEGA-9');
    expect(loaded.has('codes')).toBe(true);
    const second = await dispatchTool('load_skill', { name: 'codes' }, ctx);
    expect(second.ok).toBe(true);
    expect(second.summary).toBe('already loaded');
    expect(second.content).not.toContain('OMEGA-9');
  });

  test('unknown name errors and lists the available names', async () => {
    writeSkill(projectRoot(), 'a-skill', SKILL('a-skill', 'A', 'body'));
    const { discoverSkills } = await import('../src/lib/agent/skills.js');
    const res = await dispatchTool('load_skill', { name: 'nope' }, ctxWith(discoverSkills(workDir)));
    expect(res.ok).toBe(false);
    expect(res.content).toContain('unknown skill "nope"');
    expect(res.content).toContain('a-skill');
  });

  test('names are lookup keys, not paths — traversal/absolute names fail with NO fs escape', async () => {
    // A real file OUTSIDE any skill dir that must never be readable via load_skill.
    writeFileSync(join(workDir, 'outside.txt'), 'TOP-SECRET-OUTSIDE', 'utf8');
    writeSkill(projectRoot(), 'real', SKILL('real', 'R', 'real body'));
    const { discoverSkills } = await import('../src/lib/agent/skills.js');
    const ctx = ctxWith(discoverSkills(workDir));
    for (const evil of ['../outside.txt', '../../etc/passwd', join(workDir, 'outside.txt'), 'real/../../outside.txt']) {
      const res = await dispatchTool('load_skill', { name: evil }, ctx);
      expect(res.ok).toBe(false);
      expect(res.content).toContain('unknown skill');
      expect(res.content).not.toContain('TOP-SECRET-OUTSIDE');
    }
  });

  test('with zero skills installed → clear error', async () => {
    const res = await dispatchTool('load_skill', { name: 'anything' }, ctxWith([]));
    expect(res.ok).toBe(false);
    expect(res.content).toContain('no skills are installed');
  });
});

// ───────────────────────── loop integration ─────────────────────────

/** Standard spycore responder: conversation create + scripted chat turns. */
function spycoreResponder(turnBodies: Array<Array<Record<string, unknown>>>) {
  let i = 0;
  return (url: string) => {
    if (url.endsWith('/conversations')) {
      return { statusCode: 200, headers: {}, body: { json: async () => ({ success: true, data: { id: 'cnv_s' } }) } };
    }
    if (url.includes('/api/chat/stream')) {
      const events = turnBodies[Math.min(i, turnBodies.length - 1)] ?? [{ type: 'done' }];
      i += 1;
      return sseResp(events.map(dataLine));
    }
    throw new Error(`unexpected ${url}`);
  };
}

describe('agent loop + skills', () => {
  test('catalog rides in the system prompt; model loads the skill and uses the fact', async () => {
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    writeSkill(projectRoot(), 'launch-codes', SKILL('launch-codes', 'Where launch codes live', 'The launch code is OMEGA-9.'));
    responder = spycoreResponder([
      [{ type: 'text', content: '```spycore:tool\n{"tool":"load_skill","args":{"name":"launch-codes"}}\n```' }, { type: 'done' }],
      [{ type: 'text', content: 'The launch code is OMEGA-9.' }, { type: 'done' }],
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'tell me the launch code', cwd: workDir, onEvent: (e) => events.push(e) });

    // Turn-1 request carried the catalog (with the skill listed) in the system prompt.
    const firstChat = requests.find((r) => r.url.includes('/api/chat/stream'));
    const msg = (JSON.parse(firstChat?.body ?? '{}') as { message?: string }).message ?? '';
    expect(msg).toContain('\n# Skills\n');
    expect(msg).toContain('launch-codes: Where launch codes live');

    // The tool ran ok and the fact made it into the final answer.
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ tool: 'load_skill', ok: true });
    expect(result.finalText).toContain('OMEGA-9');
  });

  test('zero skills → the system prompt has NO # Skills section (byte-identical path)', async () => {
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    responder = spycoreResponder([[{ type: 'text', content: 'Done.' }, { type: 'done' }]]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    await runAgent({ task: 'simple', cwd: workDir });
    const firstChat = requests.find((r) => r.url.includes('/api/chat/stream'));
    const msg = (JSON.parse(firstChat?.body ?? '{}') as { message?: string }).message ?? '';
    // The SECTION heading must be absent ("# Skills" also appears inside the
    // load_skill tool description, which is always listed — that's fine).
    expect(msg).not.toContain('\n# Skills\n');
    expect(msg).toContain('load_skill'); // the tool itself stays registered
  });

  test('spycore skills_activated SSE → a skills AgentEvent; loop continues normally', async () => {
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    responder = spycoreResponder([
      [
        { type: 'skills_activated', skills: ['code-review', 'testing'] },
        { type: 'text', content: 'All done.' },
        { type: 'done' },
      ],
    ]);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({ task: 'x', cwd: workDir, onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === 'skills')).toMatchObject({ skills: ['code-review', 'testing'] });
    expect(result.finalText).toBe('All done.');
  });

  test('SpyCoreProvider maps skills_activated; the OpenAI adapter never emits skills', async () => {
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
    // spycore provider unit
    responder = () =>
      sseResp([
        dataLine({ type: 'skills_activated', skills: ['a'] }),
        dataLine({ type: 'text', content: 'hi' }),
        dataLine({ type: 'done' }),
      ]);
    const { SpyCoreProvider } = await import('../src/lib/providers/spycore.js');
    const sp = new SpyCoreProvider();
    const spEvents = [];
    for await (const e of sp.streamChat({ conversationId: 'c', message: 'm', model: 'styx' })) spEvents.push(e);
    expect(spEvents).toEqual([
      { type: 'skills', skills: ['a'] },
      { type: 'text', text: 'hi' },
      { type: 'done' },
    ]);

    // openai adapter: a normal stream yields NO skills event type
    responder = () =>
      sseResp([
        dataLine({ choices: [{ delta: { content: 'ok' } }] }),
        'data: [DONE]\n\n',
      ]);
    const { OpenAICompatibleProvider } = await import('../src/lib/providers/openai-compatible.js');
    const oa = new OpenAICompatibleProvider({ baseURL: 'https://api.openai.com/v1', apiKey: 'k' });
    const id = await oa.createConversation({ model: 'm' });
    const oaEvents = [];
    for await (const e of oa.streamChat({ conversationId: id, message: 'm', model: 'm' })) oaEvents.push(e);
    expect(oaEvents.some((e) => e.type === 'skills')).toBe(false);
  });
});

// ───────────────────────── skills command ─────────────────────────

async function runSkillsCmd(argv: string[], opts: { json?: boolean } = {}) {
  const { configureOutput } = await import('../src/lib/output.js');
  const { registerSkillsCommand } = await import('../src/commands/skills/index.js');
  const program = new Command();
  program.exitOverride();
  program.addOption(new Option('--json'));
  configureOutput({ json: Boolean(opts.json), color: false });
  registerSkillsCommand(program);
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (c: string | Uint8Array) => (out.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
  (process.stderr.write as unknown) = (c: string | Uint8Array) => (err.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
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
    configureOutput({ json: false, color: true });
  }
  return { stdout: out.join(''), stderr: err.join(''), error };
}

describe('skills command', () => {
  test('list shows name/source/description; show prints the body', async () => {
    writeSkill(projectRoot(), 'review', SKILL('review', 'Review code', 'Step 1: read the diff.'));
    writeSkill(configDir, 'global-one', SKILL('global-one', 'Global skill', 'G body'));
    const list = await runSkillsCmd(['list'], { json: true });
    const parsed = JSON.parse(list.stdout) as { skills: Array<Record<string, unknown>> };
    expect(parsed.skills).toEqual([
      { name: 'global-one', source: 'user', description: 'Global skill' },
      { name: 'review', source: 'project', description: 'Review code' },
    ]);
    const show = await runSkillsCmd(['show', 'review']);
    expect(show.error).toBeUndefined();
    expect(show.stdout).toContain('Step 1: read the diff.');
  });

  test('M4: list/show strip terminal-escape sequences from untrusted SKILL.md content', async () => {
    // OSC title-set (clipboard/window vector) in the description + a CSI colour,
    // an OSC, and a bare \r ("fake an approval line") in the body.
    const evilDesc = 'safe\x1b]0;PWNED\x07here';
    const evilBody = 'intro\x1b[31m\x1b]0;title\x07\rFAKE-APPROVED\nend';
    writeSkill(projectRoot(), 'evil-skill', SKILL('evil-skill', evilDesc, evilBody));

    const list = await runSkillsCmd(['list']);
    expect(list.error).toBeUndefined();
    expect(list.stdout + list.stderr).not.toContain('\x1b'); // no raw ESC reaches the terminal
    expect(list.stdout + list.stderr).not.toContain('\x07'); // BEL neutralized too

    const show = await runSkillsCmd(['show', 'evil-skill']);
    expect(show.error).toBeUndefined();
    const shown = show.stdout + show.stderr;
    expect(shown).not.toContain('\x1b');
    expect(shown).not.toContain('\x07');
    expect(shown).toContain('intro'); // printable text is preserved
    expect(shown).toContain('end');

    // --json output stays raw structurally, but JSON.stringify escapes the ESC
    // as  so it can't drive a terminal when parsed.
    const listJson = await runSkillsCmd(['list'], { json: true });
    expect(listJson.stdout).not.toContain('\x1b');
  });

  test('friendly empty state; show errors on unknown with the installed list', async () => {
    const empty = await runSkillsCmd(['list']);
    expect(empty.stdout + empty.stderr).toContain('No skills installed');
    writeSkill(projectRoot(), 'only-one', SKILL('only-one', 'O', 'B'));
    const r = await runSkillsCmd(['show', 'ghost']);
    expect(String((r.error as Error)?.message)).toMatch(/No skill named "ghost"/);
  });
});
