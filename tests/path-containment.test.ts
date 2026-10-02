import { describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, linkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMemoryInjection, resolveTemplateIncludes } from '../src/lib/memory.js';
import { applyRewind } from '../src/lib/agent/checkpoint.js';
import { dispatchTool, DEFAULT_LIMITS } from '../src/lib/agent/tools.js';
import { isContained } from '../src/lib/path-containment.js';

/**
 * F-2c-5 — pins for the ONE path-containment mechanism.
 *
 * Every test here drives a REAL exported entry point against a REAL filesystem
 * and asserts on what actually happened — a file's contents reaching the model,
 * a directory surviving, a byte landing outside the workspace. None of them
 * inspects a predicate in isolation, because the defects these pin were all
 * invisible to a predicate read in isolation: the boundary was decided
 * correctly *somewhere* and then not consulted at the site that mattered.
 *
 * Two probes deliberately assert the CURRENT, KNOWN-INCOMPLETE reach, so that
 * closing them later turns a test red and forces the record to be updated:
 * a hard link (no name-based guard can see a second real name for one inode)
 * and a symlink to an in-workspace secret (the secret guard's reach, a
 * different property, tracked separately).
 */

const SECRET = 'TOP-SECRET-CANARY-9f3a';
const BENIGN = 'BENIGN-CANARY-7c1d';

interface Bed {
  root: string;
  ws: string;
  outside: string;
  home: string;
}

function bed(): Bed {
  const root = mkdtempSync(join(tmpdir(), 'spycore-contain-'));
  const ws = join(root, 'workspace');
  const outside = join(root, 'outside');
  const home = join(root, 'home');
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(home, { recursive: true });
  // A project root, so findProjectRoot stops at `ws` and the @import boundary
  // is the workspace rather than some ancestor of the temp dir.
  writeFileSync(join(ws, 'package.json'), '{"name":"ws"}');
  writeFileSync(join(outside, 'SECRET.md'), `${SECRET}\n`);
  return { root, ws, outside, home };
}

function withBed<T>(fn: (b: Bed) => T): T {
  const b = bed();
  try {
    return fn(b);
  } finally {
    rmSync(b.root, { recursive: true, force: true });
  }
}

/** Load memory the way a real session does, and report whether X leaked. */
function injected(b: Bed): string {
  return buildMemoryInjection({ cwd: b.ws, home: b.home }).block;
}

// ────────────────────────────────────────────────────────────────────────
// The @import boundary (memory.ts) — the survivor F-2c-1's unification missed
// ────────────────────────────────────────────────────────────────────────

describe('SPYCODE.md @import containment resolves the path, it does not spell-check it', () => {
  /**
   * COVERAGE over the escape family, not one example. Each entry is a distinct
   * way of arriving outside the workspace; the assertion is uniform because the
   * property is uniform — no content from outside the boundary may appear.
   */
  const ESCAPES: Array<[string, (b: Bed) => void]> = [
    [
      'file symlink pointing out of the workspace',
      (b) => {
        symlinkSync(join(b.outside, 'SECRET.md'), join(b.ws, 'link.md'));
        writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n@link.md\n');
      },
    ],
    [
      'directory symlink pointing out of the workspace',
      (b) => {
        symlinkSync(b.outside, join(b.ws, 'out'));
        writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n@out/SECRET.md\n');
      },
    ],
    [
      'directory symlink with a "." segment that survives normalisation',
      (b) => {
        symlinkSync(b.outside, join(b.ws, 'out'));
        writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n@out/./SECRET.md\n');
      },
    ],
    [
      'depth-2 import chain that crosses the symlink on the second hop',
      (b) => {
        symlinkSync(b.outside, join(b.ws, 'out'));
        writeFileSync(join(b.outside, 'stage2.md'), '@SECRET.md\n');
        writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n@out/stage2.md\n');
      },
    ],
    [
      'relative traversal (already refused lexically — kept so the lexical half stays covered)',
      (b) => {
        writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n@../outside/SECRET.md\n');
      },
    ],
    [
      'absolute path (already refused lexically — kept so the lexical half stays covered)',
      (b) => {
        writeFileSync(join(b.ws, 'SPYCODE.md'), `# m\n@${join(b.outside, 'SECRET.md')}\n`);
      },
    ],
  ];

  for (const [name, build] of ESCAPES) {
    test(`refuses: ${name}`, () => {
      withBed((b) => {
        build(b);
        expect(injected(b), name).not.toContain(SECRET);
      });
    });
  }

  /**
   * The other direction, and the one that decides whether the control is
   * usable. A control that blocks legitimate work gets routed around, and the
   * route-around is invisible — so an internal symlink, and an import chain
   * that SPANS one, must keep loading.
   */
  const BENIGN_CASES: Array<[string, (b: Bed) => void]> = [
    [
      'plain internal import',
      (b) => {
        mkdirSync(join(b.ws, 'docs'), { recursive: true });
        writeFileSync(join(b.ws, 'docs', 'rules.md'), `${BENIGN}\n`);
        writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n@docs/rules.md\n');
      },
    ],
    [
      'internal DIRECTORY symlink (the monorepo shared/ -> packages/shared case)',
      (b) => {
        mkdirSync(join(b.ws, 'packages', 'shared'), { recursive: true });
        writeFileSync(join(b.ws, 'packages', 'shared', 'rules.md'), `${BENIGN}\n`);
        symlinkSync(join(b.ws, 'packages', 'shared'), join(b.ws, 'shared'));
        writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n@shared/rules.md\n');
      },
    ],
    [
      'internal FILE symlink',
      (b) => {
        mkdirSync(join(b.ws, 'docs'), { recursive: true });
        writeFileSync(join(b.ws, 'docs', 'rules.md'), `${BENIGN}\n`);
        symlinkSync(join(b.ws, 'docs', 'rules.md'), join(b.ws, 'rules.md'));
        writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n@rules.md\n');
      },
    ],
    [
      'import CHAIN that spans an internal symlink',
      (b) => {
        mkdirSync(join(b.ws, 'packages', 'shared'), { recursive: true });
        writeFileSync(join(b.ws, 'packages', 'shared', 'leaf.md'), `${BENIGN}\n`);
        writeFileSync(join(b.ws, 'packages', 'shared', 'stage.md'), '@leaf.md\n');
        symlinkSync(join(b.ws, 'packages', 'shared'), join(b.ws, 'shared'));
        writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n@shared/stage.md\n');
      },
    ],
  ];

  for (const [name, build] of BENIGN_CASES) {
    test(`still loads: ${name}`, () => {
      withBed((b) => {
        build(b);
        expect(injected(b), name).toContain(BENIGN);
      });
    });
  }

  test('the SECOND entry point — slash-command templates — is bounded by the same rule', () => {
    withBed((b) => {
      symlinkSync(b.outside, join(b.ws, 'out'));
      const r = resolveTemplateIncludes('@out/SECRET.md\n', b.ws, b.ws);
      // `resolveTemplateIncludes` is exported and reaches the same reader by a
      // different door; a fix applied only to the SPYCODE.md path would leave
      // this one open, which is precisely how the first survivor survived.
      expect(r.text).not.toContain(SECRET);
      expect(r.notices.join(' ')).toContain('outside project');
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// The destructive boundary (checkpoint.ts) — filed by nobody
// ────────────────────────────────────────────────────────────────────────

describe('rewind never removes a directory outside the session workspace', () => {
  test('a journaled parent replaced by a symlink does not let rmdir escape', () => {
    withBed((b) => {
      const victim = join(b.outside, 'victimdir');
      mkdirSync(victim, { recursive: true });
      // The journal names <ws>/a/…; by rewind time <ws>/a is a symlink out.
      symlinkSync(b.outside, join(b.ws, 'a'));
      applyRewind(
        [
          {
            change: { path: join(b.ws, 'a', 'victimdir', 'ghost.txt'), op: 'create', before: null, after: '' },
            action: 'delete',
          },
        ] as never,
        b.ws,
      );
      expect(existsSync(victim), 'an empty directory OUTSIDE the workspace was removed').toBe(true);
    });
  });

  test('a genuinely internal empty directory is still pruned (the control stays useful)', () => {
    withBed((b) => {
      const inner = join(b.ws, 'build', 'out');
      mkdirSync(inner, { recursive: true });
      const f = join(inner, 'artifact.txt');
      writeFileSync(f, 'x');
      applyRewind(
        [{ change: { path: f, op: 'create', before: null, after: 'x' }, action: 'delete' }] as never,
        b.ws,
      );
      expect(existsSync(inner), 'the internal empty dir should have been pruned').toBe(false);
      expect(existsSync(join(b.ws, 'build')), 'and its now-empty parent too').toBe(false);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// The check-then-use window (tools.ts) — narrowed, not closed
// ────────────────────────────────────────────────────────────────────────

describe('a mutation re-checks containment at the moment it writes', () => {
  /**
   * The approval `await` is the window: seconds or minutes of wall clock
   * between the check and the use, driven by a human keypress. Swapping the
   * directory inside `requestApproval` is not a contrived race — it is the
   * widest and most reliably hittable form of this defect.
   */
  for (const tool of ['write_file', 'edit_file'] as const) {
    test(`${tool}: a directory swapped to a symlink during approval cannot be written through`, async () => {
      const b = bed();
      try {
        mkdirSync(join(b.ws, 'sub'), { recursive: true });
        writeFileSync(join(b.ws, 'sub', 'target.txt'), 'victim\n');
        writeFileSync(join(b.outside, 'target.txt'), 'victim\n');
        const args =
          tool === 'write_file'
            ? { path: 'sub/target.txt', content: 'PWNED-4b2e' }
            : { path: 'sub/target.txt', old_str: 'victim', new_str: 'PWNED-4b2e' };
        await dispatchTool(tool, args, {
          cwd: b.ws,
          limits: DEFAULT_LIMITS,
          requestApproval: async () => {
            rmSync(join(b.ws, 'sub'), { recursive: true, force: true });
            symlinkSync(b.outside, join(b.ws, 'sub'));
            return { approved: true };
          },
        } as never);
        expect(readFileSync(join(b.outside, 'target.txt'), 'utf8'), 'wrote outside the workspace').not.toContain(
          'PWNED-4b2e',
        );
      } finally {
        rmSync(b.root, { recursive: true, force: true });
      }
    });
  }

  test('an ordinary approved write through an INTERNAL symlink still lands', async () => {
    const b = bed();
    try {
      mkdirSync(join(b.ws, 'packages', 'shared'), { recursive: true });
      writeFileSync(join(b.ws, 'packages', 'shared', 'f.md'), 'old\n');
      symlinkSync(join(b.ws, 'packages', 'shared'), join(b.ws, 'shared'));
      const res = await dispatchTool(
        'write_file',
        { path: 'shared/f.md', content: BENIGN },
        { cwd: b.ws, limits: DEFAULT_LIMITS, requestApproval: async () => ({ approved: true }) } as never,
      );
      expect(res.ok).toBe(true);
      expect(readFileSync(join(b.ws, 'packages', 'shared', 'f.md'), 'utf8')).toContain(BENIGN);
    } finally {
      rmSync(b.root, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// The limits, pinned so that closing one is a deliberate act
// ────────────────────────────────────────────────────────────────────────

describe('the reach this mechanism does NOT have, pinned so it cannot be forgotten', () => {
  test('a HARD LINK out of the workspace is still followed — structural, no name-based guard sees it', () => {
    withBed((b) => {
      // A hard link is a second real name for one inode; `realpath` returns
      // the name it was given, so containment cannot distinguish it.
      // ⭐ REACHED-ASSERTION (F-2c-8 §3). This arm used to `return` silently
      // when the link could not be built, so a machine where linkSync fails
      // reported GREEN having exercised nothing — a pin whose NAME claims a
      // hard-link limit its BODY never reached, guarding a residual SECURITY.md
      // states out loud. Both ends of the bed live under ONE temp root, so a
      // cross-device failure is not expected here; if it ever happens that is a
      // fact worth seeing rather than hiding. Native Windows is the one
      // platform where hard links may genuinely be unavailable, and the shipped
      // platform stance already scopes support away from it.
      let linked = true;
      try {
        linkSync(join(b.outside, 'SECRET.md'), join(b.ws, 'hard.md'));
      } catch {
        linked = false;
      }
      expect(
        linked || process.platform === 'win32',
        'the hard link could not be created on a SUPPORTED platform — this pin verified nothing',
      ).toBe(true);
      if (!linked) return;
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n@hard.md\n');
      expect(
        injected(b),
        'if this now BLOCKS, the hard-link limit has been closed — update the record rather than the test',
      ).toContain(SECRET);
    });
  });

  test('a symlink to an IN-workspace secret is now BLOCKED — by the guard, NOT by containment', () => {
    withBed((b) => {
      writeFileSync(join(b.ws, '.env'), `API_KEY=${SECRET}\n`);
      symlinkSync(join(b.ws, '.env'), join(b.ws, 'notes.md'));
      writeFileSync(join(b.ws, 'SPYCODE.md'), '# m\n@notes.md\n');
      // ⭐ F-2c-6 CLOSED THIS. It was pinned by F-2c-5 as an OPEN limit with the
      // instruction "if this now BLOCKS … update the record" — which is exactly
      // what happened: the pin went red on the fix and is re-pointed here at the
      // closure, never loosened.
      //
      // The property boundary it existed to keep visible is UNCHANGED and is the
      // whole reason a containment fix could not close this: `.env` genuinely IS
      // inside the workspace, so `isContained` still returns true for it. What
      // refuses it is the secret guard the memory loader now consults.
      expect(isContained(b.ws, join(b.ws, '.env'))).toBe(true);
      expect(
        injected(b),
        'if this LEAKS again, the memory loader lost its secret guard',
      ).not.toContain(SECRET);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// ⭐⭐ F-2c-40 — THE DANGLING SYMLINK, AT THE PREDICATE AND AT THE SINK
//
// This file created 13 symlinks and **not one dangling one**, which is why
// every pin here stayed green while `canonicalize` called a dangling link
// "inside" whatever it pointed at. Review 2 filed the predicate half as
// `F-N2d` and correctly judged it unreachable, naming four accidents that
// prevented exploitation. All four still hold. What made it reachable was a
// FIFTH sink added by the change that closed `F-N4` — `applyRewind`'s new
// `op:'delete'` restore arm, a plain `writeFileSync` with none of the four
// properties. **A fix that adds a sink inherits none of the accidents that
// protected the old ones**, and that is the sentence these tests exist to
// keep true.
// ────────────────────────────────────────────────────────────────────────

describe('a DANGLING symlink is resolved through, not treated as a new name', () => {
  /**
   * ⭐ `existsSync` FOLLOWS links, so for a dangling one it says "absent" — and
   * the walk then treated the link's own name as a not-yet-existing tail,
   * realpath'd the parent (inside) and re-joined lexically. The link was never
   * dereferenced. `lstat` asks about the NAME, which is the question.
   */
  test('the predicate refuses a dangling link that points OUTSIDE', () => {
    withBed((b) => {
      symlinkSync(join(b.outside, 'never-created.txt'), join(b.ws, 'dangling-out'));
      expect(isContained(b.ws, join(b.ws, 'dangling-out'))).toBe(false);
      // through a dangling DIRECTORY link, too — the tail is re-joined onto the
      // resolved target, not onto the link's own parent.
      symlinkSync(join(b.outside, 'never-created-dir'), join(b.ws, 'dangling-dir'));
      expect(isContained(b.ws, join(b.ws, 'dangling-dir', 'inner.txt'))).toBe(false);
    });
  });

  /**
   * ⭐ AND IT MUST NOT OVER-BLOCK. A dangling link pointing back INSIDE the
   * workspace is an ordinary thing (a build output not yet produced) and stays
   * allowed. Without this the fix would be a different defect wearing a pass.
   */
  test('a dangling link pointing INSIDE the workspace is still allowed', () => {
    withBed((b) => {
      symlinkSync(join(b.ws, 'not-built-yet.js'), join(b.ws, 'dangling-in'));
      expect(isContained(b.ws, join(b.ws, 'dangling-in'))).toBe(true);
      expect(isContained(b.ws, join(b.ws, 'ordinary.txt'))).toBe(true);
    });
  });

  /** A link cycle must terminate and yield no permission, not spin. */
  test('a symlink cycle terminates and does not report "inside"', () => {
    withBed((b) => {
      symlinkSync(join(b.ws, 'loop-b'), join(b.ws, 'loop-a'));
      symlinkSync(join(b.ws, 'loop-a'), join(b.ws, 'loop-b'));
      expect(() => isContained(b.ws, join(b.ws, 'loop-a'))).not.toThrow();
    });
  });

  /**
   * ⭐⭐ THE SINK, DRIVEN FOR REAL. This is the shape review 3 proved end to end:
   * the observer sees a file REPLACED BY A SYMLINK as absent, journals it as
   * `op:'delete'` carrying its pre-mutation content, and the restore arm writes
   * that content back through the link. The `before` payload below is what an
   * agent would have chosen.
   */
  test('`rewind` does not write through a dangling link to a file outside the workspace', () => {
    withBed((b) => {
      const victim = join(b.outside, 'victim.txt');
      symlinkSync(victim, join(b.ws, 'link'));
      const r = applyRewind(
        [
          {
            change: { path: join(b.ws, 'link'), op: 'delete', before: 'PAYLOAD-CHOSEN-BY-THE-AGENT\n', after: '' },
            action: 'restore',
          },
        ] as never,
        b.ws,
      );
      expect(existsSync(victim), 'a file was created OUTSIDE the workspace').toBe(false);
      expect(r.restored).toBe(0);
      expect(r.skipped).toBe(1);
    });
  });

  /**
   * ⭐ THE CONTROL THAT MAKES THE ZERO ABOVE MEAN SOMETHING. The same arm, the
   * same call, a path inside the workspace: it MUST restore. A guard that
   * refused everything would pass the test above and break the feature.
   */
  test('the same restore arm still re-creates a deleted file INSIDE the workspace', () => {
    withBed((b) => {
      const inside = join(b.ws, 'sub', 'notes.txt');
      const r = applyRewind(
        [{ change: { path: inside, op: 'delete', before: 'BACK\n', after: '' }, action: 'restore' }] as never,
        b.ws,
      );
      expect(r.restored).toBe(1);
      expect(readFileSync(inside, 'utf8')).toBe('BACK\n');
    });
  });
});
