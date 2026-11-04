/**
 * F-2c-6 - THE SECRET GUARD'S REACH.
 *
 * The property: EVERY path by which file content reaches the model's context
 * must consult the always-on secret guard. Containment cannot close this, and
 * the distinction is load-bearing - a `.env` is a perfectly legal target that
 * genuinely IS inside the workspace, so `isContained` permits it correctly.
 * Only the guard refuses it.
 *
 * Each test drives the REAL entry point end-to-end against a real filesystem and
 * asserts on whether a secret's CONTENTS appear in what reaches the model. None
 * of these reads a predicate and infers.
 */
import { describe, expect, test } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildContextInjection,
  resolveTemplateIncludes,
} from '../src/lib/memory.js';
import { discoverSkills } from '../src/lib/agent/skills.js';
import { loadUserCommands } from '../src/lib/slash/user-commands.js';
import { scanRepo } from '../src/lib/repo-scan.js';
import { generateCodebaseGuide } from '../src/lib/codebase-guide.js';
import { dispatchTool, DEFAULT_LIMITS } from '../src/lib/agent/tools.js';
import { isContained } from '../src/lib/path-containment.js';
import { loadSecretGuardSync, loadSecretGuard } from '../src/lib/agent/secrets.js';

const SECRET = 'SENTINEL_SECRET_A1B2C3_DO_NOT_LEAK';

interface Bed {
  ws: string;
  home: string;
}

/** A real workspace with a real `.env` INSIDE it. */
function withBed(fn: (b: Bed) => void | Promise<void>): Promise<void> | void {
  const root = mkdtempSync(join(tmpdir(), 'spy-reach-'));
  const ws = join(root, 'ws');
  const home = join(root, 'home');
  mkdirSync(join(ws, '.git'), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(ws, 'package.json'), '{"name":"probe"}');
  writeFileSync(join(ws, '.env'), `API_KEY=${SECRET}\n`);
  const done = (): void => rmSync(root, { recursive: true, force: true });
  let out: void | Promise<void>;
  try {
    out = fn({ ws, home });
  } catch (e) {
    done();
    throw e;
  }
  if (out && typeof (out as Promise<void>).then === 'function') {
    return (out as Promise<void>).finally(done);
  }
  done();
  return undefined;
}

const injected = (b: Bed): string =>
  buildContextInjection({ cwd: b.ws, home: b.home }).block;

// ─────────────────────────────────────────────────────────────────────────
// The property that makes this group DIFFERENT from containment
// ─────────────────────────────────────────────────────────────────────────

describe('containment and secrecy are different properties', () => {
  test('the secret is INSIDE the workspace - containment permits it, and must', () => {
    withBed((b) => {
      // If this ever returns false, these tests would be green because of
      // CONTAINMENT rather than the guard, and would prove nothing.
      expect(isContained(b.ws, join(b.ws, '.env'))).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Every counted reach site - the contents must not appear
// ─────────────────────────────────────────────────────────────────────────

describe('no context-assembly reader hands the model a secret file', () => {
  test('@import naming the secret directly', () => {
    withBed((b) => {
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n\n@.env\n');
      expect(injected(b)).not.toContain(SECRET);
    });
  });

  test('@import through an innocuously-named in-workspace symlink', () => {
    withBed((b) => {
      symlinkSync(join(b.ws, '.env'), join(b.ws, 'notes.md'));
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n\n@notes.md\n');
      expect(injected(b)).not.toContain(SECRET);
    });
  });

  test('a depth-2 import CHAIN reaching the secret', () => {
    withBed((b) => {
      symlinkSync(join(b.ws, '.env'), join(b.ws, 'notes.md'));
      writeFileSync(join(b.ws, 'mid.md'), '@notes.md\n');
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n\n@mid.md\n');
      expect(injected(b)).not.toContain(SECRET);
    });
  });

  test('an import chain crossing an INTERNAL DIRECTORY symlink to the secret', () => {
    withBed((b) => {
      mkdirSync(join(b.ws, 'real'), { recursive: true });
      writeFileSync(join(b.ws, 'real', '.env'), `k=${SECRET}\n`);
      symlinkSync(join(b.ws, 'real'), join(b.ws, 'link'));
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n\n@link/.env\n');
      expect(injected(b)).not.toContain(SECRET);
    });
  });

  test('the SECOND entry point - a slash-command template @import', () => {
    withBed((b) => {
      symlinkSync(join(b.ws, '.env'), join(b.ws, 'notes.md'));
      const out = resolveTemplateIncludes('do this:\n@notes.md\n', b.ws, b.ws);
      expect(out.text).not.toContain(SECRET);
    });
  });

  test('SPYCODE.md ITSELF symlinked at the secret (no @import involved)', () => {
    withBed((b) => {
      symlinkSync(join(b.ws, '.env'), join(b.ws, 'SPYCODE.md'));
      expect(injected(b)).not.toContain(SECRET);
    });
  });

  test('CODEBASE_GUIDE.md symlinked at the secret', () => {
    withBed((b) => {
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n\nhello\n');
      symlinkSync(join(b.ws, '.env'), join(b.ws, 'CODEBASE_GUIDE.md'));
      expect(injected(b)).not.toContain(SECRET);
    });
  });

  test('CODEBASE_CHANGELOG.md symlinked at the secret', () => {
    withBed((b) => {
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n\nhello\n');
      // The payload satisfies the reader's ENTRY GRAMMAR on purpose. A flat
      // `.env` is dropped by the entry parser, which would make this pin green
      // for a parsing reason instead of a guard reason.
      writeFileSync(join(b.ws, '.env'), `## 2026-01-01\n\nTOKEN=${SECRET}\n`);
      symlinkSync(join(b.ws, '.env'), join(b.ws, 'CODEBASE_CHANGELOG.md'));
      expect(injected(b)).not.toContain(SECRET);
    });
  });

  test('the skills CATALOG - a description parsed from a symlinked SKILL.md', () => {
    withBed((b) => {
      const sk = join(b.ws, '.spycore', 'skills', 'helper');
      mkdirSync(sk, { recursive: true });
      symlinkSync(join(b.ws, '.env'), join(sk, 'SKILL.md'));
      // This reaches the SYSTEM PROMPT before the model can call any tool.
      expect(JSON.stringify(discoverSkills(b.ws))).not.toContain(SECRET);
    });
  });

  test('load_skill on a symlinked SKILL.md', async () => {
    await withBed(async (b) => {
      const sk = join(b.ws, '.spycore', 'skills', 'helper');
      mkdirSync(sk, { recursive: true });
      symlinkSync(join(b.ws, '.env'), join(sk, 'SKILL.md'));
      const skills = new Map(
        discoverSkills(b.ws).map((s) => [s.name, s] as const),
      );
      let text: string;
      try {
        const r = await dispatchTool(
          'load_skill',
          { name: 'helper' },
          { cwd: b.ws, limits: DEFAULT_LIMITS, skills, loadedSkills: new Set() },
        );
        text = JSON.stringify(r);
      } catch (e) {
        text = `threw: ${(e as Error).message}`;
      }
      expect(text).not.toContain(SECRET);
    });
  });

  test('load_skill refuses ON ITS OWN, with discovery bypassed', async () => {
    await withBed(async (b) => {
      const sk = join(b.ws, '.spycore', 'skills', 'helper');
      mkdirSync(sk, { recursive: true });
      symlinkSync(join(b.ws, '.env'), join(sk, 'SKILL.md'));
      // The pin above uses discoverSkills, which ALSO skips this file - so it
      // would stay green with `load_skill`'s own guard deleted, i.e. green for
      // an adjacent mechanism's reason. Here the skills map is built BY HAND so
      // the entry exists and reaches the executor; the only thing that can
      // refuse it is the guard inside load_skill itself.
      const skills = new Map([
        [
          'helper',
          {
            name: 'helper',
            description: 'planted',
            source: 'project' as const,
            path: join(sk, 'SKILL.md'),
          },
        ],
      ]);
      let text: string;
      try {
        const r = await dispatchTool(
          'load_skill',
          { name: 'helper' },
          { cwd: b.ws, limits: DEFAULT_LIMITS, skills, loadedSkills: new Set() },
        );
        text = JSON.stringify(r);
      } catch (e) {
        text = `threw: ${(e as Error).message}`;
      }
      // The entry really did reach the executor - otherwise this proves nothing.
      expect(text).not.toContain('no skills are installed');
      expect(text).not.toContain('unknown skill');
      expect(text).not.toContain(SECRET);
    });
  });

  test('a project slash-command file symlinked at the secret, in a TRUSTED workspace', async () => {
    await withBed(async (b) => {
      const { trustWorkspace } = await import('../src/lib/config.js');
      const cmds = join(b.ws, '.spycore', 'commands');
      mkdirSync(cmds, { recursive: true });
      symlinkSync(join(b.ws, '.env'), join(cmds, 'deploy.md'));
      // Trust FIRST: an untrusted workspace skips the scan entirely, which
      // would make this pin green for the trust gate's reason, not the guard's.
      trustWorkspace(b.ws);
      const r = loadUserCommands(b.ws);
      const text =
        JSON.stringify([...r.commands.values()]) + JSON.stringify(r.notices);
      expect(text).not.toContain(SECRET);
    });
  });

  test('README.md symlinked at the secret, via the GENERATED codebase guide', async () => {
    await withBed(async (b) => {
      symlinkSync(join(b.ws, '.env'), join(b.ws, 'README.md'));
      // The summary lands in a file the user is told to COMMIT as well as in
      // the injected context - two exfiltration routes from one read.
      expect(generateCodebaseGuide(await scanRepo(b.ws))).not.toContain(SECRET);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The benign direction - a guard users route around is worse than none
// ─────────────────────────────────────────────────────────────────────────

describe('legitimate context still loads', () => {
  test('an ordinary @import', () => {
    withBed((b) => {
      writeFileSync(join(b.ws, 'style.md'), 'BENIGN_ORDINARY\n');
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n\n@style.md\n');
      expect(injected(b)).toContain('BENIGN_ORDINARY');
    });
  });

  test('memory that MENTIONS .env and credentials in prose', () => {
    withBed((b) => {
      writeFileSync(
        join(b.ws, 'SPYCODE.md'),
        '# m\n\nCopy .env.example to .env and set API_KEY. Never commit credentials.json.\n',
      );
      expect(injected(b)).toContain('Never commit credentials.json');
    });
  });

  test('an import chain spanning an INTERNAL directory symlink', () => {
    withBed((b) => {
      mkdirSync(join(b.ws, 'packages', 'shared'), { recursive: true });
      writeFileSync(join(b.ws, 'packages', 'shared', 'rules.md'), 'BENIGN_SHARED\n');
      symlinkSync(join(b.ws, 'packages', 'shared'), join(b.ws, 'shared'));
      writeFileSync(join(b.ws, 'mid.md'), '@shared/rules.md\n');
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n\n@mid.md\n');
      expect(injected(b)).toContain('BENIGN_SHARED');
    });
  });

  test('a file merely NAMED like a secret is not blocked', () => {
    withBed((b) => {
      writeFileSync(join(b.ws, 'environment.md'), 'BENIGN_ENVDOC\n');
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n\n@environment.md\n');
      expect(injected(b)).toContain('BENIGN_ENVDOC');
    });
  });

  test('an ordinary skill still loads its whole body', async () => {
    await withBed(async (b) => {
      const { trustWorkspace } = await import('../src/lib/config.js');
      const sk = join(b.ws, '.spycore', 'skills', 'helper');
      mkdirSync(sk, { recursive: true });
      writeFileSync(
        join(sk, 'SKILL.md'),
        '---\nname: helper\ndescription: helps\n---\nBENIGN_SKILL\n',
      );
      // Trust FIRST: an untrusted workspace skips project skills entirely,
      // which would make this pin green for the trust gate's reason, not the
      // guard's.
      trustWorkspace(b.ws);
      const skills = new Map(
        discoverSkills(b.ws).map((s) => [s.name, s] as const),
      );
      const r = await dispatchTool(
        'load_skill',
        { name: 'helper' },
        { cwd: b.ws, limits: DEFAULT_LIMITS, skills, loadedSkills: new Set() },
      );
      expect(String(r.content)).toContain('BENIGN_SKILL');
    });
  });

  test('an ordinary GUIDE and CHANGELOG still load', () => {
    withBed((b) => {
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n\nhello\n');
      writeFileSync(join(b.ws, 'CODEBASE_GUIDE.md'), '# Guide\n\nBENIGN_GUIDE\n');
      writeFileSync(
        join(b.ws, 'CODEBASE_CHANGELOG.md'),
        '## 2026-01-01\n\nBENIGN_CHANGELOG\n',
      );
      const block = injected(b);
      expect(block).toContain('BENIGN_GUIDE');
      expect(block).toContain('BENIGN_CHANGELOG');
    });
  });

  test('an ordinary project slash-command still loads', async () => {
    await withBed(async (b) => {
      const { trustWorkspace } = await import('../src/lib/config.js');
      const cmds = join(b.ws, '.spycore', 'commands');
      mkdirSync(cmds, { recursive: true });
      writeFileSync(join(cmds, 'deploy.md'), 'BENIGN_CMD\n');
      trustWorkspace(b.ws);
      const r = loadUserCommands(b.ws);
      expect(JSON.stringify([...r.commands.values()])).toContain('BENIGN_CMD');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// ONE MECHANISM - the two loaders must not become two decisions
// ─────────────────────────────────────────────────────────────────────────

describe('the sync and async guards are one decision mechanism', () => {
  test('both agree on every built-in denylist form', async () => {
    await withBed(async (b) => {
      const sync = loadSecretGuardSync(b.ws);
      const async_ = await loadSecretGuard(b.ws);
      const forms = [
        '.env', '.env.local', '.ENV', 'id_rsa', 'id_ed25519.pub',
        'server.pem', 'client.key', '.npmrc', '.netrc', 'credentials.json',
        'secrets.json', '.ssh/config', '.aws/credentials', '.git/config',
        'notes.md', 'src/index.ts', 'environment.md', 'README.md',
      ];
      for (const f of forms) {
        expect(sync(join(b.ws, f)), f).toBe(async_(join(b.ws, f)));
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// LIMITS - pinned so a later reader cannot describe them as closed
// ─────────────────────────────────────────────────────────────────────────

describe('the reach this mechanism does NOT have, pinned so it cannot be forgotten', () => {
  test('the SYNC guard does NOT carry the project .spycoreignore layer', async () => {
    await withBed(async (b) => {
      writeFileSync(join(b.ws, '.spycoreignore'), 'internal-notes.md\n');
      writeFileSync(join(b.ws, 'internal-notes.md'), `note=${SECRET}\n`);
      const target = join(b.ws, 'internal-notes.md');

      // The ASYNC guard (used by the agent's file tools) honours it …
      expect((await loadSecretGuard(b.ws))(target)).toBe(true);
      // … the SYNC one cannot: `.spycoreignore` is matched by globby, which is
      // ESM-only, so it is reachable only through `await import`. Every
      // context-assembly reader is synchronous, one on a React render path.
      expect(
        loadSecretGuardSync(b.ws)(target),
        'if this is now TRUE, the sync guard gained the ignore layer - update the record rather than the test',
      ).toBe(false);

      // Consequence, measured end-to-end rather than asserted about a predicate:
      // a USER-DECLARED ignore entry does not bound the @import reader. The
      // always-on denylist (.env, keys, .ssh, credentials) still does. → 
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n\n@internal-notes.md\n');
      expect(injected(b)).toContain(SECRET);
    });
  });

  test('an ACCEPTED RESIDUAL: the check-then-use race stays DISCLOSED in SECURITY.md', () => {
    // Ruling 1 (F-2c-6) ACCEPTED this residual with its reasoning: closing it
    // needs `openat(2)`, which Node does not expose, and putting a native
    // dependency into the write path would raise total risk rather than lower
    // it. Accepting is not ignoring - an accepted residual with no pin becomes
    // an assumed closure within two batches.
    //
    // So this pin guards the DISCLOSURE, which is the thing a later reader
    // would have to falsify in order to claim the race is closed. It is
    // deliberately NOT a grep for an implementation spelling: a derivation
    // keyed on a spelling is a hand-list with extra steps.
    const doc = readFileSync(
      new URL('../SECURITY.md', import.meta.url),
      'utf8',
    );
    // The first form of this pin asserted only /accepted/i and a mutation
    // that stripped the acceptance RATIONALE passed it - the word survived
    // elsewhere in the file. The pin was weak, so the pin was replaced. Each
    // clause below is independently removable, so dropping any one reddens it.

    // 1. The limit itself, and why this runtime cannot close it.
    expect(doc, 'the openat rationale is gone').toMatch(/openat/);
    expect(doc, 'the race itself is no longer named').toMatch(/\brace\b/i);
    // 2. Its threat model - what an attacker must ALREADY have.
    expect(doc, 'the threat model is gone').toMatch(/hostile (local )?process|concurrent process/i);
    // 3. That it was ACCEPTED as a decision, not merely mentioned.
    expect(doc, 'the residual is no longer classified as accepted').toMatch(
      /accepted residual/i,
    );
    // 4. Why the alternative was DECLINED - the substance of the decision, and
    // the clause a false "we closed it" edit would have to remove.
    expect(
      doc,
      'the reason the native-dependency alternative was declined is gone - either the race was truly closed (update this pin AND the record) or a false closure is shipping',
    ).toMatch(/raises total risk|rather than lowering it/i);
    // 5. That the wide deterministic window IS closed, so the disclosure cannot
    // be softened into "the whole thing is open" either.
    expect(doc, 'the pre-write re-check is no longer claimed').toMatch(
      /pre-write re-check/i,
    );
  });
});

describe('secret guard realpath cache', () => {
  test('a cached guard judges identically to an uncached one', async () => {
    await withBed(async ({ ws }) => {
      // A symlink inside the workspace pointing at the secret, plus a plain
      // file and a missing path: the interesting shapes for the realpath
      // logic (plain / resolved-differently / unresolvable).
      symlinkSync(join(ws, '.env'), join(ws, 'notes.md'));
      writeFileSync(join(ws, 'plain.txt'), 'hello\n');
      const plain = await loadSecretGuard(ws);
      const cached = await loadSecretGuard(ws, { realPathCache: new Map() });
      const targets = [
        join(ws, '.env'),
        join(ws, 'notes.md'),
        join(ws, 'plain.txt'),
        join(ws, 'nope.txt'),
      ];
      // Judge twice through the cached guard: the second pass must come from
      // the memo and still agree.
      for (const pass of [1, 2]) {
        for (const t of targets) {
          expect(cached(t), `pass ${pass}: ${t}`).toBe(plain(t));
        }
      }
      // The memo actually memoized: every judged path is in it.
      // (Reached indirectly: judging again with a frozen map still agrees.)
      const frozen = new Map<string, string | null>();
      const first = await loadSecretGuard(ws, { realPathCache: frozen });
      for (const t of targets) first(t);
      // `.env` matches the name denylist before realpath is consulted, so it
      // is correctly ABSENT from the memo; the other three resolved exactly
      // once each.
      expect(frozen.size).toBe(targets.length - 1);
      expect(frozen.has(join(ws, '.env'))).toBe(false);
      expect(frozen.has(join(ws, 'notes.md'))).toBe(true);
      const second = await loadSecretGuard(ws, { realPathCache: frozen });
      for (const t of targets) {
        expect(second(t), t).toBe(plain(t));
      }
    });
  });
});
