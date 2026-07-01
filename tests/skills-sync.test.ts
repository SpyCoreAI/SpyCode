import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command, Option } from 'commander';
import { freshConfigDir } from './helpers.js';
import { DEFAULT_LIMITS, dispatchTool } from '../src/lib/agent/tools.js';

/**
 * `skills sync`: manifest diffing against the local ledger, downloads only
 * what changed, user-content protection, removals, --force, the official
 * list label, and the 60-skill catalog-overflow path through the part-1
 * agent mechanism.
 */
interface CapturedRequest {
  url: string;
}
let requests: CapturedRequest[] = [];
let manifest: Array<{ name: string; description: string; sha256: string }> = [];
let contents: Record<string, string> = {};

vi.mock('undici', () => ({
  request: vi.fn(async (url: string) => {
    requests.push({ url });
    if (url.includes('/v1/skills/manifest')) {
      return {
        statusCode: 200,
        headers: {},
        body: { json: async () => ({ success: true, data: { totalSkills: manifest.length, skills: manifest } }) },
      };
    }
    const m = /\/v1\/skills\/([^/]+)\/content/.exec(url);
    if (m) {
      const name = decodeURIComponent(m[1] as string);
      const content = contents[name];
      if (content === undefined) {
        return { statusCode: 404, headers: {}, body: { json: async () => ({ success: false, error: 'Skill not found' }) } };
      }
      return {
        statusCode: 200,
        headers: {},
        body: { json: async () => ({ success: true, data: { name, description: `${name} desc`, content } }) },
      };
    }
    throw new Error(`unexpected ${url}`);
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
  configDir = freshConfigDir();
  requests = [];
  manifest = [];
  contents = {};
  hoisted.authed = true;
  workDir = mkdtempSync(join(tmpdir(), 'spycli-sync-'));
});
afterEach(() => {
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const contentDownloads = (): number => requests.filter((r) => r.url.includes('/content')).length;
const skillFile = (name: string): string => join(configDir, 'skills', name, 'SKILL.md');
const setSkill = (name: string, body: string): void => {
  manifest = manifest.filter((m) => m.name !== name);
  contents[name] = body;
  manifest.push({ name, description: `${name} desc`, sha256: shaFor(body) });
};
// The test "server" computes shas the same way the real one does.
import { createHash } from 'node:crypto';
const shaFor = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

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

describe('skills sync', () => {
  test('not logged in → clear error, zero requests', async () => {
    hoisted.authed = false;
    const r = await runSkills(['sync']);
    expect(String((r.error as Error)?.message)).toMatch(/Not logged in/);
    expect(requests).toHaveLength(0);
  });

  test('fresh sync downloads all, writes files + ledger; second sync downloads nothing', async () => {
    setSkill('alpha', '---\nname: alpha\ndescription: A\n---\nAlpha body.\n');
    setSkill('beta', '---\nname: beta\ndescription: B\n---\nBeta body.\n');

    const first = await runSkills(['sync'], { json: true });
    expect(first.error).toBeUndefined();
    expect(JSON.parse(first.stdout)).toMatchObject({ added: 2, updated: 0, removed: 0, unchanged: 0, skipped: 0 });
    expect(readFileSync(skillFile('alpha'), 'utf8')).toContain('Alpha body.');
    const ledger = JSON.parse(readFileSync(join(configDir, 'skills', '.sync.json'), 'utf8')) as {
      skills: Record<string, { sha256: string }>;
    };
    expect(Object.keys(ledger.skills).sort()).toEqual(['alpha', 'beta']);
    expect(contentDownloads()).toBe(2);

    requests = [];
    const second = await runSkills(['sync'], { json: true });
    expect(JSON.parse(second.stdout)).toMatchObject({ added: 0, updated: 0, removed: 0, unchanged: 2 });
    expect(contentDownloads()).toBe(0);
  });

  test('changed sha → only that skill re-downloads', async () => {
    setSkill('alpha', 'A v1');
    setSkill('beta', 'B v1');
    await runSkills(['sync']);
    requests = [];
    setSkill('alpha', 'A v2'); // new sha
    const r = await runSkills(['sync'], { json: true });
    expect(JSON.parse(r.stdout)).toMatchObject({ added: 0, updated: 1, unchanged: 1 });
    expect(contentDownloads()).toBe(1);
    expect(readFileSync(skillFile('alpha'), 'utf8')).toBe('A v2');
    expect(readFileSync(skillFile('beta'), 'utf8')).toBe('B v1');
  });

  test('removed from the manifest + in the ledger → deleted locally', async () => {
    setSkill('alpha', 'A');
    setSkill('beta', 'B');
    await runSkills(['sync']);
    manifest = manifest.filter((m) => m.name !== 'beta');
    const r = await runSkills(['sync'], { json: true });
    expect(JSON.parse(r.stdout)).toMatchObject({ removed: 1, unchanged: 1 });
    expect(existsSync(skillFile('beta'))).toBe(false);
    expect(existsSync(skillFile('alpha'))).toBe(true);
  });

  test('user-created skill (not in the ledger) is never overwritten or deleted — collision skips + warns', async () => {
    // User creates a skill whose name collides with an official one.
    mkdirSync(join(configDir, 'skills', 'alpha'), { recursive: true });
    writeFileSync(skillFile('alpha'), 'MY OWN ALPHA — do not touch', 'utf8');
    setSkill('alpha', 'official alpha');
    setSkill('beta', 'official beta');

    const r = await runSkills(['sync'], { json: true });
    expect(JSON.parse(r.stdout)).toMatchObject({ added: 1, skipped: 1 });
    expect(readFileSync(skillFile('alpha'), 'utf8')).toBe('MY OWN ALPHA — do not touch');

    // Even under --force (text mode here so the human warning is visible —
    // json mode intentionally suppresses warn() and reports skipped:N instead).
    const forced = await runSkills(['sync', '--force']);
    expect(forced.stdout + forced.stderr).toMatch(/skipped "alpha".*your version wins/);
    expect(forced.stdout + forced.stderr).toMatch(/skipped 1/);
    expect(readFileSync(skillFile('alpha'), 'utf8')).toBe('MY OWN ALPHA — do not touch');
    manifest = manifest.filter((m) => m.name !== 'alpha');
    await runSkills(['sync']);
    expect(readFileSync(skillFile('alpha'), 'utf8')).toBe('MY OWN ALPHA — do not touch');
  });

  test('--force re-downloads every ledger-owned skill', async () => {
    setSkill('alpha', 'A');
    setSkill('beta', 'B');
    await runSkills(['sync']);
    requests = [];
    const r = await runSkills(['sync', '--force'], { json: true });
    expect(JSON.parse(r.stdout)).toMatchObject({ added: 0, updated: 2, unchanged: 0 });
    expect(contentDownloads()).toBe(2);
  });

  test('synced skills list as `official`; user + project labels intact', async () => {
    setSkill('official-one', 'O body');
    await runSkills(['sync']);
    // A user-global skill the user made themselves…
    mkdirSync(join(configDir, 'skills', 'mine'), { recursive: true });
    writeFileSync(skillFile('mine'), '---\nname: mine\ndescription: Mine\n---\nM', 'utf8');
    // …and a project skill.
    mkdirSync(join(workDir, '.spycore', 'skills', 'proj'), { recursive: true });
    writeFileSync(join(workDir, '.spycore', 'skills', 'proj', 'SKILL.md'), '---\nname: proj\ndescription: P\n---\nP', 'utf8');

    const r = await runSkills(['list'], { json: true });
    const parsed = JSON.parse(r.stdout) as { skills: Array<{ name: string; source: string }> };
    const bySource = Object.fromEntries(parsed.skills.map((s) => [s.name, s.source]));
    expect(bySource).toMatchObject({ 'official-one': 'official', mine: 'user', proj: 'project' });
  });

  test('60 synced skills: catalog overflows with the names line; an overflowed skill still loads', async () => {
    for (let i = 0; i < 60; i += 1) {
      const name = `official-${String(i).padStart(2, '0')}`;
      setSkill(name, `---\nname: ${name}\ndescription: ${'Official skill number '.repeat(4)}${i}\n---\nBody of ${name}: fact-${i}.\n`);
    }
    const r = await runSkills(['sync'], { json: true });
    expect(JSON.parse(r.stdout)).toMatchObject({ added: 60 });

    const { discoverSkills, buildSkillsCatalog } = await import('../src/lib/agent/skills.js');
    const skills = discoverSkills(workDir);
    expect(skills).toHaveLength(60);
    const catalog = buildSkillsCatalog(skills);
    expect(catalog).toContain('\n# Skills\n');
    expect(catalog).toContain('more, loadable by exact name');

    // A skill from the overflowed (names-only) tail is still loadable.
    const last = skills[skills.length - 1];
    const res = await dispatchTool(
      'load_skill',
      { name: last?.name ?? '' },
      { cwd: workDir, limits: DEFAULT_LIMITS, skills: new Map(skills.map((s) => [s.name, s])), loadedSkills: new Set() },
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain('fact-59');
  });
});

describe('skills sync — path-traversal hardening (SEC-012)', () => {
  test('isValidSkillName accepts safe slugs and rejects unsafe names', async () => {
    const { isValidSkillName } = await import('../src/lib/skills-sync.js');
    for (const ok of ['alpha', 'redis-caching', 'a1', 'x-y-z', 'a']) {
      expect(isValidSkillName(ok)).toBe(true);
    }
    for (const bad of [
      '', '..', '../evil', '../../etc/passwd', 'a/b', 'a\\b', '/abs', '.hidden',
      '-lead', 'trail-', 'a--b', 'Upper', 'with space', 'dot.name', 'a b',
      'a~b', 'node_modules', '.', '~', `${'x'.repeat(65)}`,
    ]) {
      expect(isValidSkillName(bad)).toBe(false);
    }
  });

  test('writeSyncedSkill / removeSyncedSkill refuse an unsafe name (FS backstop)', async () => {
    const { writeSyncedSkill, removeSyncedSkill } = await import('../src/lib/skills-sync.js');
    expect(() => writeSyncedSkill('../../evil', 'pwned')).toThrow(/unsafe skill name/i);
    expect(() => removeSyncedSkill('../../evil')).toThrow(/unsafe skill name/i);
    // The guard fires before any filesystem write — nothing escaped the dir.
    expect(existsSync(join(configDir, '..', 'evil'))).toBe(false);
  });

  test('a malicious manifest name is rejected — not downloaded, not written, not in the ledger', async () => {
    setSkill('safe', 'safe body');
    // The server (or a MITM) returns a traversal name in the manifest.
    const evil = '../../../../spycli-evil';
    manifest.push({ name: evil, description: 'evil', sha256: shaFor('pwned') });
    contents[evil] = 'pwned';

    const r = await runSkills(['sync'], { json: true });
    expect(r.error).toBeUndefined();
    expect(JSON.parse(r.stdout)).toMatchObject({ added: 1, rejected: 1 });
    // The evil entry never triggered a content download…
    expect(requests.some((req) => req.url.includes('spycli-evil'))).toBe(false);
    // …never landed in the ownership ledger…
    const ledger = JSON.parse(readFileSync(join(configDir, 'skills', '.sync.json'), 'utf8')) as {
      skills: Record<string, { sha256: string }>;
    };
    expect(Object.keys(ledger.skills)).toEqual(['safe']);
    // …and wrote no SKILL.md outside the skills root.
    expect(
      existsSync(join(configDir, 'skills', '..', '..', '..', '..', 'spycli-evil', 'SKILL.md')),
    ).toBe(false);
    // The safe sibling was written normally.
    expect(readFileSync(skillFile('safe'), 'utf8')).toBe('safe body');
  });
});
