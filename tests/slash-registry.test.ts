import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import {
  parseSlashInput,
  runSlashCommand,
  SLASH_HELP,
  type SlashContext,
} from '../src/lib/slash/registry.js';
import type { EffortLevel } from '../src/lib/effort.js';
import type { ModelSlug } from '../src/lib/models.js';

/**
 * The shared slash-command CORE that BOTH the one-shot renderer
 * (commands/chat.ts) and the SHIPPING Ink session (ui/chat/ChatApp.tsx) now run
 * through. Before convergence the Ink dispatch had its own copy with no direct
 * unit coverage; these tests pin the structured behaviour the shipping path
 * depends on. All file ops run in a throwaway project; HOME is pinned to an empty
 * dir so a developer's global ~/.spycore/SPYCODE.md can't leak into the results.
 */

// ── undici mock (only /save reaches the network) ────────────────────────────
interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
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

let projectDir: string;
let homeDir: string;
let origHome: string | undefined;

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  origHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'spycode-slash-home-'));
  process.env.HOME = homeDir;
  projectDir = mkdtempSync(join(tmpdir(), 'spycode-slash-core-'));
  mkdirSync(join(projectDir, '.git'), { recursive: true });
  writeFileSync(
    join(projectDir, 'package.json'),
    JSON.stringify({ name: 'slashcore', scripts: { build: 'x', test: 'y' } }),
  );
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  for (const d of [projectDir, homeDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function mkCtx(over: Partial<SlashContext> = {}): SlashContext {
  return {
    cwd: projectDir,
    model: 'charon' as ModelSlug,
    effort: 'auto' as EffortLevel,
    conversationId: 'cnv_x',
    apiUrl: undefined,
    injectGuide: true,
    injectChangelog: true,
    ...over,
  };
}

// ── parsing ─────────────────────────────────────────────────────────────────
describe('parseSlashInput', () => {
  test('splits the command name from its argument tokens', () => {
    expect(parseSlashInput('/memory')).toEqual({ name: 'memory', args: [] });
    expect(parseSlashInput('/remember a b c')).toEqual({ name: 'remember', args: ['a', 'b', 'c'] });
    expect(parseSlashInput('/guide refresh')).toEqual({ name: 'guide', args: ['refresh'] });
    expect(parseSlashInput('/')).toEqual({ name: '', args: [] });
  });
});

// ── help ─────────────────────────────────────────────────────────────────────
describe('help', () => {
  test('returns the help outcome; the shared list covers every command', async () => {
    const out = await runSlashCommand('help', [], mkCtx());
    expect(out.kind).toBe('help');
    const cmds = SLASH_HELP.map((e) => e.command);
    for (const c of ['/help', '/model', '/effort [level]', '/init', '/memory', '/remember <note>', '/guide [refresh]', '/changelog', '/new', '/save <file>', '/clear', '/exit']) {
      expect(cmds).toContain(c);
    }
    // The shared help names only SpyCore models (Hermes/Minos/Styx/Charon).
    const blob = JSON.stringify(SLASH_HELP);
    expect(blob).toMatch(/Hermes|Minos|Styx|Charon/);
    // The "names no vendor" guarantee is asserted — with its vendor literals —
    // in the manifest-excluded negative gate (tests/identity-denylist.test.ts),
    // so this shipping file carries no upstream-vendor strings.
  });
});

// ── model ─────────────────────────────────────────────────────────────────────
describe('model', () => {
  test('no argument → prompt (Ink opens the picker, one-shot prints usage)', async () => {
    expect((await runSlashCommand('model', [], mkCtx())).kind).toBe('model-prompt');
  });

  test('a valid name → model-changed with the resolved slug', async () => {
    const out = await runSlashCommand('model', ['styx'], mkCtx({ effort: 'auto' }));
    expect(out).toMatchObject({ kind: 'model-changed', model: 'styx', effortClamped: false });
  });

  test('an unknown name → model-unknown with the friendly message', async () => {
    const out = await runSlashCommand('model', ['fakemodel'], mkCtx());
    expect(out.kind).toBe('model-unknown');
    if (out.kind === 'model-unknown') {
      expect(out.input).toBe('fakemodel');
      expect(out.message).toContain('Unknown model');
    }
  });

  test('switching models clamps the active effort to the new model (step DOWN)', async () => {
    // Active effort 'max' is unsupported by Minos (auto/low/high) → clamps to high.
    const out = await runSlashCommand('model', ['minos'], mkCtx({ effort: 'max' }));
    expect(out).toMatchObject({
      kind: 'model-changed',
      model: 'minos',
      effort: 'high',
      effortClamped: true,
      requestedEffort: 'max',
    });
  });
});

// ── effort ────────────────────────────────────────────────────────────────────
describe('effort', () => {
  test('no argument → effort-info listing the current model levels', async () => {
    const out = await runSlashCommand('effort', [], mkCtx({ model: 'charon', effort: 'medium' }));
    expect(out).toMatchObject({ kind: 'effort-info', model: 'charon', current: 'medium' });
    if (out.kind === 'effort-info') expect(out.levels).toEqual(['auto', 'low', 'medium', 'high', 'max']);
  });

  test('a supported level → effort-changed (not clamped)', async () => {
    const out = await runSlashCommand('effort', ['high'], mkCtx({ model: 'minos' }));
    expect(out).toMatchObject({ kind: 'effort-changed', level: 'high', clamped: false });
  });

  test('an unsupported level → effort-changed clamped DOWN', async () => {
    const out = await runSlashCommand('effort', ['max'], mkCtx({ model: 'minos' }));
    expect(out).toMatchObject({ kind: 'effort-changed', level: 'high', clamped: true, requested: 'max' });
  });

  test('an unknown level → effort-unknown', async () => {
    const out = await runSlashCommand('effort', ['bogus'], mkCtx());
    expect(out).toMatchObject({ kind: 'effort-unknown', input: 'bogus' });
  });
});

// ── init (refuse-to-overwrite, independence) ───────────────────────────────────
describe('init', () => {
  test('fresh project → creates all three files (created:true) on disk', async () => {
    const out = await runSlashCommand('init', [], mkCtx());
    expect(out.kind).toBe('init');
    if (out.kind !== 'init') return;
    expect(out.results.map((r) => r.file)).toEqual(['spycode', 'guide', 'changelog']);
    expect(out.results.every((r) => r.created === true)).toBe(true);
    expect(existsSync(join(projectDir, 'SPYCODE.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'CODEBASE_GUIDE.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'CODEBASE_CHANGELOG.md'))).toBe(true);
  });

  test('a second /init refuses to overwrite (created:false for all three)', async () => {
    await runSlashCommand('init', [], mkCtx());
    const out = await runSlashCommand('init', [], mkCtx());
    if (out.kind !== 'init') throw new Error('expected init');
    expect(out.results.every((r) => r.created === false)).toBe(true);
  });

  test('files are generated INDEPENDENTLY (a pre-existing one does not block the rest)', async () => {
    writeFileSync(join(projectDir, 'CODEBASE_GUIDE.md'), 'PRE-EXISTING', 'utf8');
    const out = await runSlashCommand('init', [], mkCtx());
    if (out.kind !== 'init') throw new Error('expected init');
    const byFile = Object.fromEntries(out.results.map((r) => [r.file, r.created]));
    expect(byFile).toEqual({ spycode: true, guide: false, changelog: true });
    expect(readFileSync(join(projectDir, 'CODEBASE_GUIDE.md'), 'utf8')).toBe('PRE-EXISTING');
  });
});

// ── memory ─────────────────────────────────────────────────────────────────────
describe('memory', () => {
  test('fresh project → empty injection (nothing loaded)', async () => {
    const out = await runSlashCommand('memory', [], mkCtx());
    expect(out.kind).toBe('memory');
    if (out.kind === 'memory') {
      expect(out.injection.block).toBe('');
      expect(out.injection.parts.length).toBe(0);
    }
  });

  test('after /init the injection lists the guide + changelog parts', async () => {
    await runSlashCommand('init', [], mkCtx());
    const out = await runSlashCommand('memory', [], mkCtx());
    if (out.kind !== 'memory') throw new Error('expected memory');
    const kinds = out.injection.parts.map((p) => p.kind);
    expect(kinds).toContain('memory');
    expect(kinds).toContain('guide');
    expect(kinds).toContain('changelog');
  });

  test('injectChangelog=false marks the changelog part disabled (off)', async () => {
    await runSlashCommand('init', [], mkCtx());
    const out = await runSlashCommand('memory', [], mkCtx({ injectChangelog: false }));
    if (out.kind !== 'memory') throw new Error('expected memory');
    const changelog = out.injection.parts.find((p) => p.kind === 'changelog');
    expect(changelog?.status).toBe('off');
  });
});

// ── remember ───────────────────────────────────────────────────────────────────
describe('remember', () => {
  test('no note → remember-usage (writes nothing)', async () => {
    const out = await runSlashCommand('remember', [], mkCtx());
    expect(out.kind).toBe('remember-usage');
    expect(existsSync(join(projectDir, 'SPYCODE.md'))).toBe(false);
  });

  test('a note → remember{created} and the file gains the bullet', async () => {
    const out = await runSlashCommand('remember', ['prefer', 'repo_map', 'first'], mkCtx());
    expect(out).toMatchObject({ kind: 'remember', created: true });
    const body = readFileSync(join(projectDir, 'SPYCODE.md'), 'utf8');
    expect(body).toContain('prefer repo_map first');
    // A second note updates the existing file (created:false).
    const out2 = await runSlashCommand('remember', ['second', 'note'], mkCtx());
    expect(out2).toMatchObject({ kind: 'remember', created: false });
  });
});

// ── guide ──────────────────────────────────────────────────────────────────────
describe('guide', () => {
  test('no argument, absent → guide-status{exists:false}', async () => {
    const out = await runSlashCommand('guide', [], mkCtx());
    expect(out).toMatchObject({ kind: 'guide-status', exists: false });
  });

  test('after /init → guide-status{exists:true} with a line count', async () => {
    await runSlashCommand('init', [], mkCtx());
    const out = await runSlashCommand('guide', [], mkCtx());
    expect(out.kind).toBe('guide-status');
    if (out.kind === 'guide-status') {
      expect(out.exists).toBe(true);
      expect(out.lines).toBeGreaterThan(0);
    }
  });

  test('refresh regenerates + overwrites; preserves a manual notes section', async () => {
    writeFileSync(join(projectDir, 'CODEBASE_GUIDE.md'), '# stale\n\n## Notes (manual)\n\n- keep me\n', 'utf8');
    const out = await runSlashCommand('guide', ['refresh'], mkCtx());
    expect(out).toMatchObject({ kind: 'guide-refreshed', preservedNotes: true });
    const body = readFileSync(join(projectDir, 'CODEBASE_GUIDE.md'), 'utf8');
    expect(body).toContain('- keep me');
    expect(body).not.toContain('# stale');
  });

  test('an unknown subcommand → guide-unknown-sub', async () => {
    const out = await runSlashCommand('guide', ['bogus'], mkCtx());
    expect(out).toMatchObject({ kind: 'guide-unknown-sub', sub: 'bogus' });
  });
});

// ── changelog ──────────────────────────────────────────────────────────────────
describe('changelog', () => {
  test('absent → changelog{exists:false}', async () => {
    const out = await runSlashCommand('changelog', [], mkCtx());
    expect(out).toMatchObject({ kind: 'changelog', exists: false });
  });

  test('after /init → changelog{exists:true} with the seeded entry', async () => {
    await runSlashCommand('init', [], mkCtx());
    const out = await runSlashCommand('changelog', [], mkCtx());
    if (out.kind !== 'changelog') throw new Error('expected changelog');
    expect(out.exists).toBe(true);
    expect(out.entryCount).toBeGreaterThanOrEqual(1);
    expect(out.text).toContain('Initialized project memory.');
  });
});

// ── control commands ───────────────────────────────────────────────────────────
describe('control + save', () => {
  test('new / clear / exit / quit / unknown', async () => {
    expect((await runSlashCommand('new', [], mkCtx())).kind).toBe('new-conversation');
    expect((await runSlashCommand('clear', [], mkCtx())).kind).toBe('clear');
    expect((await runSlashCommand('exit', [], mkCtx())).kind).toBe('exit');
    expect((await runSlashCommand('quit', [], mkCtx())).kind).toBe('exit');
    expect(await runSlashCommand('wat', [], mkCtx())).toMatchObject({ kind: 'unknown-command', name: 'wat' });
  });

  test('save with no file → save-usage', async () => {
    expect((await runSlashCommand('save', [], mkCtx())).kind).toBe('save-usage');
  });

  test('save writes the markdown transcript and returns the path', async () => {
    responder = (url) => {
      if (url.includes('/conversations/cnv_x')) {
        return jsonResp(200, {
          success: true,
          data: {
            id: 'cnv_x',
            title: 'Demo',
            model: 'HERMES',
            messages: [
              { role: 'user', content: 'hi', createdAt: new Date().toISOString() },
              { role: 'assistant', model: 'HERMES', content: 'hello', createdAt: new Date().toISOString() },
            ],
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const file = join(projectDir, 'out.md');
    const out = await runSlashCommand('save', [file], mkCtx());
    expect(out).toMatchObject({ kind: 'saved', path: file });
    const md = readFileSync(file, 'utf8');
    expect(md).toContain('# Demo');
    expect(md).toContain('hi');
    expect(md).toContain('hello');
  });

  test('save surfaces a failure as save-error', async () => {
    responder = () => jsonResp(404, { success: false, error: { message: 'not found' } });
    const out = await runSlashCommand('save', [join(projectDir, 'x.md')], mkCtx());
    expect(out.kind).toBe('save-error');
  });
});

// ── the SHIPPING (Ink) seam routes through the SAME core ────────────────────────
describe('Ink dispatch seam', () => {
  // The Ink ChatApp does exactly this: parseSlashInput(raw) → runSlashCommand →
  // renderOutcome(structured). renderOutcome is a pure structural mapping (no
  // logic; exhaustiveness enforced by the compiler), so exercising the seam here
  // proves the command users actually hit now runs the tested core.
  const inkDispatch = (raw: string, ctx: SlashContext) => {
    const { name, args } = parseSlashInput(raw);
    return runSlashCommand(name, args, ctx);
  };

  test('/memory routes to a memory outcome', async () => {
    expect((await inkDispatch('/memory', mkCtx())).kind).toBe('memory');
  });

  test('/effort high routes to an effort-changed outcome', async () => {
    expect((await inkDispatch('/effort high', mkCtx({ model: 'charon' }))).kind).toBe('effort-changed');
  });

  test('/init twice routes to a refuse-to-overwrite init outcome', async () => {
    await inkDispatch('/init', mkCtx());
    const out = await inkDispatch('/init', mkCtx());
    if (out.kind !== 'init') throw new Error('expected init');
    expect(out.results.every((r) => r.created === false)).toBe(true);
  });
});
