import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import {
  deriveAlwaysAllowEntry,
  evaluateCommandRules,
  tokenizeSimpleCommand,
  validateRuleEntry,
  type CommandRule,
  type EffectiveCommandRules,
} from '../src/lib/agent/command-rules.js';
import type { AgentEvent } from '../src/lib/agent/loop.js';

/**
 * Configurable command allow/deny rules — PHASE-1 1.10.
 *
 * Pinned here:
 *  - the strict tokenizer (the METACHAR GATE): every shell metacharacter,
 *    unbalanced quotes, assignment/glob first tokens ⇒ ineligible;
 *  - the grammar truth table: first-token exact + literal-prefix continuation
 *    with a boundary character, never bare-prefix, never basename on allow;
 *  - validator rejections: empty / "*" / quotes / metachars / globs / lone
 *    shells+interpreters+runners / runner-prefixed / interpreter flags;
 *  - THE critical metachar pins: a compound command with a MATCHING allow
 *    entry still asks — for every metacharacter and quoting trick;
 *  - precedence: deny beats allow; deny is broader (basename, any offset,
 *    word-scan on compounds); catastrophic entries warn at load;
 *  - scopes: user entries active as-is; project entries double-gated
 *    (workspace trust + per-entry approval keyed to the EXACT string;
 *    changed string re-prompts; headless unapproved skipped + warned);
 *  - "always allow": derivation (null for metachar/unsafe commands), the
 *    user-file write, and the round-trip back through the loader;
 *  - loop-level pins: allow auto-runs with NO approval fn, deny still denies
 *    under --yes, a pre-tool exit-2 hook blocks an allowlisted command, and
 *    every auto-approval emits a visible rule_notice.
 */

// undici mock for the loop-level pins (same harness as agent.test.ts).
interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: {
    json: () => Promise<unknown>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
  };
}

let responder: ((url: string, init: { method: string }) => MockResp) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET' });
  }),
}));

let configDir: string;
let cwd: string;

beforeEach(() => {
  configDir = freshConfigDir();
  cwd = mkdtempSync(join(tmpdir(), 'spycli-cmdrules-'));
  responder = null;
});

afterEach(async () => {
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  vi.resetModules();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const rule = (entry: string, kind: 'allow' | 'deny', scope: 'user' | 'project' = 'user'): CommandRule => ({
  entry,
  tokens: entry.split(' '),
  kind,
  scope,
});

const rules = (allow: string[], deny: string[] = []): EffectiveCommandRules => ({
  allow: allow.map((e) => rule(e, 'allow')),
  deny: deny.map((e) => rule(e, 'deny')),
});

function writeUserRules(obj: unknown): void {
  writeFileSync(join(configDir, 'command-rules.json'), JSON.stringify(obj), 'utf8');
}

function writeProjectRules(obj: unknown): void {
  mkdirSync(join(cwd, '.spycore'), { recursive: true });
  writeFileSync(join(cwd, '.spycore', 'command-rules.json'), JSON.stringify(obj), 'utf8');
}

// ───────────────────────── tokenizer (the metachar gate) ─────────────────────────

describe('tokenizeSimpleCommand', () => {
  test('tokenizes plain commands', () => {
    expect(tokenizeSimpleCommand('git status')).toEqual(['git', 'status']);
    expect(tokenizeSimpleCommand('  npm   run   test  ')).toEqual(['npm', 'run', 'test']);
    expect(tokenizeSimpleCommand('ls')).toEqual(['ls']);
    expect(tokenizeSimpleCommand('./scripts/test.sh --fast')).toEqual(['./scripts/test.sh', '--fast']);
  });

  test('quotes group but do not split', () => {
    expect(tokenizeSimpleCommand("git commit -m 'a b c'")).toEqual(['git', 'commit', '-m', 'a b c']);
    expect(tokenizeSimpleCommand('git "status"')).toEqual(['git', 'status']);
  });

  test('every shell metacharacter is ineligible — even inside quotes', () => {
    for (const c of [
      'git status; rm x',
      'git status && rm x',
      'git status || rm x',
      'git status | tee out',
      'echo $(rm x)',
      'echo `rm x`',
      'echo hi > out.txt',
      'cat < in.txt',
      'echo hi >> out.txt',
      'cat << EOF',
      'git status\nrm x',
      'git status & rm x',
      'echo ${HOME}',
      'echo (sub)',
      'echo {a,b}',
      'echo a\\;b',
      'git commit -m "x; y"', // metachar inside quotes still ineligible
      "echo '$(rm x)'",
    ]) {
      expect(tokenizeSimpleCommand(c), c).toBeNull();
    }
  });

  test('unbalanced quotes, assignment prefixes, and glob binaries are ineligible', () => {
    expect(tokenizeSimpleCommand("git commit -m 'oops")).toBeNull();
    expect(tokenizeSimpleCommand('FOO=bar npm test')).toBeNull();
    expect(tokenizeSimpleCommand('./bin/* --run')).toBeNull();
    expect(tokenizeSimpleCommand('   ')).toBeNull();
  });
});

// ───────────────────────── grammar truth table ─────────────────────────

describe('evaluateCommandRules — matching grammar', () => {
  const R = rules(['npm run test', 'git status', 'ls']);

  test('exact and boundary-prefix continuations match', () => {
    for (const c of [
      'npm run test',
      'npm run test:unit',
      'npm run test-unit',
      'npm run test.integration',
      'npm run test -- --watch',
      'git status',
      'git status --short',
      'ls',
      'ls -la /tmp',
    ]) {
      expect(evaluateCommandRules(c, R).action, c).toBe('allow');
    }
  });

  test('non-matches ask', () => {
    for (const c of [
      'npm audit',
      'npm run testevil', // bare prefix without a boundary char
      'npm run',
      'npm',
      'lsof', // single-token entries never bare-prefix the binary
      '/usr/bin/git status', // allow first token is EXACT — no basename match
      'git push',
    ]) {
      expect(evaluateCommandRules(c, R).action, c).toBe('ask');
    }
  });

  test('a matched rule is named in the decision', () => {
    const d = evaluateCommandRules('npm run test:unit', R);
    expect(d.action).toBe('allow');
    if (d.action === 'allow') expect(d.rule.entry).toBe('npm run test');
  });
});

// ───────────────────────── THE metachar pins (critical) ─────────────────────────

describe('evaluateCommandRules — metachar ineligibility (allow can never fire)', () => {
  // A maximally-permissive allowlist for the words involved.
  const R = rules(['git status', 'git', 'echo hi', 'echo', 'cat', 'rm x', 'sleep 1']);

  test.each([
    ['semicolon', 'git status; rm x'],
    ['and-and', 'git status && rm x'],
    ['or-or', 'git status || rm x'],
    ['pipe', 'git status | cat'],
    ['command substitution', 'echo $(rm x)'],
    ['backtick', 'echo `rm x`'],
    ['redirect out', 'echo hi > /tmp/x'],
    ['redirect in', 'cat < /etc/hostname'],
    ['append', 'echo hi >> /tmp/x'],
    ['heredoc', 'cat << EOF'],
    ['newline', 'git status\nrm x'],
    ['background &', 'sleep 1 & rm x'],
    ['variable expansion', 'echo $HOME'],
    ['backslash escape', 'git\\ status'],
    ['quoting trick', "git 'status'; rm x"],
    ['quoted metachar', 'git "status; rm x"'],
  ])('%s: never auto-approves despite a matching allow entry', (_label, command) => {
    const d = evaluateCommandRules(command, R);
    expect(d.action, command).not.toBe('allow');
  });
});

// ───────────────────────── deny breadth + precedence ─────────────────────────

describe('evaluateCommandRules — deny', () => {
  test('deny beats allow when both match', () => {
    const R = rules(['git status'], ['git']);
    const d = evaluateCommandRules('git status', R);
    expect(d.action).toBe('deny');
    if (d.action === 'deny') expect(d.rule.entry).toBe('git');
  });

  test('deny matches the basename of the first token', () => {
    const R = rules([], ['rm']);
    expect(evaluateCommandRules('/bin/rm x', R).action).toBe('deny');
    expect(evaluateCommandRules('rm x', R).action).toBe('deny');
  });

  test('deny matches at any token offset (runner-prefixed forms)', () => {
    const R = rules([], ['npm install']);
    expect(evaluateCommandRules('env npm install left-pad', R).action).toBe('deny');
  });

  test('deny word-scans compound commands', () => {
    const R = rules([], ['git push']);
    expect(evaluateCommandRules('cd x && git push', R).action).toBe('deny');
    expect(evaluateCommandRules('cd x && git status', R).action).toBe('ask');
  });

  test('deny does NOT fire on a quoted argument of a simple command', () => {
    const R = rules([], ['git push']);
    expect(evaluateCommandRules('git commit -m "do not git push"', R).action).toBe('ask');
  });

  /**
   * ⭐⭐ F-2c-42 — A DENY RULE IS THE ONE GATE THE README SAYS BEATS `--yes`, AND
   * AN ESCAPE OR AN EMPTY EXPANSION IN THE COMMAND WORD WALKED AROUND IT.
   *
   * `tokenizeSimpleCommand` returns null for anything containing a metacharacter
   * — a backslash and a `$` are both metacharacters — so these land on the
   * UNCONFIDENT branch, whose stated purpose is to be BROADER. It stripped only
   * SURROUNDING quotes, so `\curl` stayed `\curl`, no deny rule matched, and the
   * decision fell through to `ask`, which `--yes` approves. Measured before the
   * fix: **60 of 60 evasions across 10 realistic entries executed in a real
   * /bin/sh**, with 10 of 10 controls firing.
   *
   * ⭐ This is the SIBLING SITE of the screen's own head-attribution defect —
   * the command word judged as WRITTEN rather than as it will RESOLVE — in the
   * second of the two modules that answer that question. Both were fixed in one
   * commit, because a class closed at one site is not closed.
   */
  test('a deny rule survives an escape or an empty expansion in the command word', () => {
    const R = rules([], ['curl']);
    // CONTROLS, in the same test as the result they qualify.
    for (const plain of ['curl http://x.test/a', '"curl" http://x.test/a', '/usr/bin/curl http://x.test/a', 'echo hi | curl http://x.test/a']) {
      expect(evaluateCommandRules(plain, R).action, `control: ${plain} must still be denied`).toBe('deny');
    }
    // THE EVASIONS — every one of these resolves to `curl` in a real shell.
    for (const evasion of [
      '\\curl http://x.test/a',
      'cu\\rl http://x.test/a',
      '$(echo)curl http://x.test/a',
      '${NOPE}curl http://x.test/a',
      '`echo`curl http://x.test/a',
      'cu$(echo)rl http://x.test/a',
    ]) {
      expect(evaluateCommandRules(evasion, R).action, `evasion: ${evasion} must be denied`).toBe('deny');
    }
  });

  /**
   * ⭐⭐ THE LOAD-BEARING CONTROL, AND IT IS THE OTHER DIRECTION. The asymmetry
   * this module documents — "a false-positive deny costs a rejection message; a
   * false-negative allow would be a hole" — only holds if an escaped spelling
   * can never WIDEN an allow. Allow matching lives exclusively inside the
   * `tokens !== null` branch, so it cannot; measured at 0 of 60 before the fix
   * and asserted here so the deny widening can never leak into it.
   */
  test('an escape or expansion NEVER widens an allow rule', () => {
    const R = rules(['curl'], []);
    for (const evasion of [
      '\\curl http://x.test/a',
      'cu\\rl http://x.test/a',
      '$(echo)curl http://x.test/a',
      '${NOPE}curl http://x.test/a',
      '`echo`curl http://x.test/a',
      'cu$(echo)rl http://x.test/a',
    ]) {
      expect(evaluateCommandRules(evasion, R).action, `${evasion} must NOT be auto-approved`).not.toBe('allow');
    }
    // and the plain spelling still IS allowed, so the rule set is live
    expect(evaluateCommandRules('curl http://x.test/a', R).action).toBe('allow');
  });

  /**
   * ⭐ THE OVER-BLOCK SIDE, AND IT IS A DELTA RATHER THAN AN ABSOLUTE.
   *
   * ⭐⭐ THE FIRST VERSION OF THIS TEST ASSERTED AN ABSOLUTE AND WAS WRONG, AND
   * MEASURING IS WHAT SETTLED IT. It listed `echo "curl is not installed" >
   * notes.md` and `grep -r "curl" docs/` as commands that must not be denied —
   * but BOTH are denied by the published 0.6.0 too, because the deny scan strips
   * quotes and word-scans, which this module documents as deliberate ("erring
   * toward denial is the safe direction"). Driven over the benign corpus × 10
   * realistic deny entries — 1,760 cells — against the pre-change file recovered
   * from git: **57 denied before, 57 denied after, 0 NEWLY denied.** The correct
   * property is the delta, so that is what is asserted here.
   */
  test('the widened deny reading adds no new denial to ordinary commands', () => {
    const R = rules([], ['curl', 'rm']);
    for (const benign of [
      'git commit -m "switch from curl to fetch"', // the entry is inside a quoted argument
      'npm install && npm test', // compound, and names no entry
      'git status',
      'node dist/index.js',
    ]) {
      expect(evaluateCommandRules(benign, R).action, `benign: ${benign}`).not.toBe('deny');
    }
    // ⭐ And the pre-existing word-scan is UNCHANGED, not quietly widened: these
    // were denied by the published 0.6.0 and must still be, or the fix has moved
    // the boundary rather than closed the escape.
    for (const preExisting of ['echo "curl is not installed" > notes.md', 'grep -r "curl" docs/']) {
      expect(evaluateCommandRules(preExisting, R).action, `pre-existing: ${preExisting}`).toBe('deny');
    }
  });

  test('multi-token deny needs the full sequence', () => {
    const R = rules([], ['git push']);
    expect(evaluateCommandRules('git status', R).action).toBe('ask');
    expect(evaluateCommandRules('git push origin main', R).action).toBe('deny');
  });
});

// ───────────────────────── validator ─────────────────────────

describe('validateRuleEntry', () => {
  test('accepts plain literal prefixes', () => {
    for (const e of [
      'npm test',
      'npm run test',
      'git status',
      'ls',
      'pnpm --filter=web test',
      './scripts/test.sh',
      '/usr/local/bin/mytool run',
      'node scripts/build.js',
      'bash scripts/test.sh',
    ]) {
      const v = validateRuleEntry(e, 'allow');
      expect(v.ok, e).toBe(true);
    }
  });

  test('rejects empty / non-string / catch-all / oversized', () => {
    for (const [raw, kind] of [
      ['', 'allow'],
      ['   ', 'allow'],
      [42, 'allow'],
      [null, 'deny'],
      ['*', 'allow'],
      ['*', 'deny'],
      [`x${'y'.repeat(300)}`, 'allow'],
    ] as const) {
      const v = validateRuleEntry(raw as never, kind);
      expect(v.ok, String(raw)).toBe(false);
    }
  });

  test('rejects metachars, quotes, and globs', () => {
    for (const e of [
      'git status; ls',
      'npm test && echo ok',
      'echo $HOME',
      "git 'status'",
      'npm run *',
      'rm -rf ?',
      'ls [ab]',
    ]) {
      expect(validateRuleEntry(e, 'allow').ok, e).toBe(false);
      expect(validateRuleEntry(e, 'deny').ok, e).toBe(false);
    }
  });

  test('rejects lone shells / interpreters / runners as allow entries', () => {
    for (const e of ['sh', 'bash', 'zsh', 'fish', 'node', 'python', 'python3', 'deno', 'env', 'sudo', 'xargs', 'eval']) {
      const v = validateRuleEntry(e, 'allow');
      expect(v.ok, e).toBe(false);
    }
  });

  test('rejects runner-prefixed allow entries at any length', () => {
    for (const e of ['env FOO=1 make', 'sudo systemctl restart app', 'xargs rm', 'eval git status', 'timeout 5 make']) {
      expect(validateRuleEntry(e, 'allow').ok, e).toBe(false);
    }
  });

  test('rejects interpreter/shell flags (inline code + stdin forms)', () => {
    for (const e of ['bash -c ls', 'sh -c', 'python -c print', 'node -e x', 'python -', 'bash -s', 'python -m pytest']) {
      expect(validateRuleEntry(e, 'allow').ok, e).toBe(false);
    }
  });

  test('rejects first tokens that are not plain words/paths', () => {
    for (const e of ['-rf x', 'FOO=bar npm test', '!cmd']) {
      expect(validateRuleEntry(e, 'allow').ok, e).toBe(false);
    }
  });

  test('deny entries may be lone shells / interpreters / runners', () => {
    for (const e of ['bash', 'node', 'sudo', 'rm', 'git push']) {
      const v = validateRuleEntry(e, 'deny');
      expect(v.ok, e).toBe(true);
    }
  });
});

// ───────────────────────── loader: scopes + gates ─────────────────────────

describe('loadCommandRules', () => {
  test('no files → empty rules, no notices, hasAny false', async () => {
    const { loadCommandRules } = await import('../src/lib/agent/command-rules.js');
    const loaded = await loadCommandRules(cwd);
    expect(loaded.rules.allow).toEqual([]);
    expect(loaded.rules.deny).toEqual([]);
    expect(loaded.notices).toEqual([]);
    expect(loaded.hasAny).toBe(false);
  });

  test('user entries load without per-entry approval; invalid ones skip + warn', async () => {
    writeUserRules({ allow: ['npm test', 'bash', 'git status; ls', 42], deny: ['git push'] });
    const { loadCommandRules } = await import('../src/lib/agent/command-rules.js');
    const loaded = await loadCommandRules(cwd);
    expect(loaded.rules.allow.map((r) => r.entry)).toEqual(['npm test']);
    expect(loaded.rules.deny.map((r) => r.entry)).toEqual(['git push']);
    expect(loaded.rules.allow[0]?.scope).toBe('user');
    expect(loaded.notices.filter((n) => n.includes('skipped')).length).toBe(3);
    expect(loaded.hasAny).toBe(true);
  });

  test('an allow entry matching the catastrophic guard loads but warns (it can never win)', async () => {
    writeUserRules({ allow: ['rm -rf /'] });
    const { loadCommandRules } = await import('../src/lib/agent/command-rules.js');
    const loaded = await loadCommandRules(cwd);
    expect(loaded.rules.allow.map((r) => r.entry)).toEqual(['rm -rf /']);
    expect(loaded.notices.some((n) => n.includes('catastrophic'))).toBe(true);
  });

  test('broken JSON degrades to a notice, never a throw', async () => {
    writeFileSync(join(configDir, 'command-rules.json'), '{nope', 'utf8');
    const { loadCommandRules } = await import('../src/lib/agent/command-rules.js');
    const loaded = await loadCommandRules(cwd);
    expect(loaded.rules.allow).toEqual([]);
    expect(loaded.notices.some((n) => n.includes('not valid JSON'))).toBe(true);
  });

  test('project entries are INERT in an untrusted workspace', async () => {
    writeProjectRules({ allow: ['npm test'] });
    const { loadCommandRules } = await import('../src/lib/agent/command-rules.js');
    const loaded = await loadCommandRules(cwd, {
      approveProjectEntry: async () => true, // even a yes-callback must not run
    });
    expect(loaded.rules.allow).toEqual([]);
    expect(loaded.notices.some((n) => n.includes('untrusted workspace'))).toBe(true);
  });

  test('trusted + unapproved + no callback (headless) → skipped with a warning', async () => {
    writeProjectRules({ allow: ['npm test'] });
    const { trustWorkspace } = await import('../src/lib/config.js');
    trustWorkspace(cwd);
    const { loadCommandRules } = await import('../src/lib/agent/command-rules.js');
    const loaded = await loadCommandRules(cwd);
    expect(loaded.rules.allow).toEqual([]);
    expect(loaded.notices.some((n) => n.includes('unapproved project allow rule'))).toBe(true);
  });

  test('trusted + interactive yes → active and persisted; a changed string re-prompts', async () => {
    writeProjectRules({ allow: ['npm test'] });
    const { trustWorkspace, isProjectCommandRuleApproved } = await import('../src/lib/config.js');
    trustWorkspace(cwd);
    const { loadCommandRules } = await import('../src/lib/agent/command-rules.js');

    let asked = 0;
    const loaded = await loadCommandRules(cwd, {
      approveProjectEntry: async () => {
        asked += 1;
        return true;
      },
    });
    expect(asked).toBe(1);
    expect(loaded.rules.allow.map((r) => r.entry)).toEqual(['npm test']);
    expect(loaded.rules.allow[0]?.scope).toBe('project');
    expect(isProjectCommandRuleApproved(cwd, 'allow', 'npm test')).toBe(true);

    // Approved exact string is honoured silently on the next load.
    const again = await loadCommandRules(cwd, {
      approveProjectEntry: async () => {
        asked += 1;
        return true;
      },
    });
    expect(asked).toBe(1);
    expect(again.rules.allow.map((r) => r.entry)).toEqual(['npm test']);

    // A CHANGED entry string is a different rule — it re-prompts.
    writeProjectRules({ allow: ['npm test:unit'] });
    await loadCommandRules(cwd, {
      approveProjectEntry: async () => {
        asked += 1;
        return false;
      },
    });
    expect(asked).toBe(2);
  });

  test('trusted + interactive no → skipped, not persisted', async () => {
    writeProjectRules({ deny: ['git push'] });
    const { trustWorkspace, isProjectCommandRuleApproved } = await import('../src/lib/config.js');
    trustWorkspace(cwd);
    const { loadCommandRules } = await import('../src/lib/agent/command-rules.js');
    const loaded = await loadCommandRules(cwd, { approveProjectEntry: async () => false });
    expect(loaded.rules.deny).toEqual([]);
    expect(isProjectCommandRuleApproved(cwd, 'deny', 'git push')).toBe(false);
    expect(loaded.notices.some((n) => n.includes('not approved'))).toBe(true);
  });
});

// ───────────────────────── "always allow" ─────────────────────────

describe('deriveAlwaysAllowEntry + appendUserAllowRule', () => {
  test('derives the exact tokenized command', () => {
    expect(deriveAlwaysAllowEntry('npm  test')).toBe('npm test');
    expect(deriveAlwaysAllowEntry('git status --short')).toBe('git status --short');
  });

  test('refuses metachar-ineligible and unsafe commands', () => {
    for (const c of [
      'git status; rm x',
      'echo hi > out.txt',
      'bash', // lone shell — validator rejects
      'sudo make install', // runner-prefixed
      'bash -c ls', // shell inline-code flag
      "git commit -m 'a b'", // quoted space — would not round-trip
    ]) {
      expect(deriveAlwaysAllowEntry(c), c).toBeNull();
    }
  });

  test('writes to the USER file only and round-trips through the loader', async () => {
    const { appendUserAllowRule, loadCommandRules, userCommandRulesPath } = await import(
      '../src/lib/agent/command-rules.js'
    );
    const saved = appendUserAllowRule('npm test');
    expect(saved).toMatchObject({ entry: 'npm test', kind: 'allow', scope: 'user' });
    expect(userCommandRulesPath()).toBe(join(configDir, 'command-rules.json'));
    const onDisk = JSON.parse(readFileSync(join(configDir, 'command-rules.json'), 'utf8')) as {
      allow: string[];
      deny: string[];
    };
    expect(onDisk.allow).toEqual(['npm test']);
    expect(onDisk.deny).toEqual([]);
    // No project file was created or touched.
    expect(existsSync(join(cwd, '.spycore', 'command-rules.json'))).toBe(false);

    const loaded = await loadCommandRules(cwd);
    expect(loaded.rules.allow.map((r) => r.entry)).toEqual(['npm test']);
    expect(evaluateCommandRules('npm test', loaded.rules).action).toBe('allow');

    // Appending again is idempotent; existing deny entries survive.
    appendUserAllowRule('npm test');
    const after = JSON.parse(readFileSync(join(configDir, 'command-rules.json'), 'utf8')) as {
      allow: string[];
    };
    expect(after.allow).toEqual(['npm test']);
  });

  test('refuses to persist an invalid entry', async () => {
    const { appendUserAllowRule } = await import('../src/lib/agent/command-rules.js');
    expect(() => appendUserAllowRule('bash')).toThrow(/invalid allow entry/);
    expect(existsSync(join(configDir, 'command-rules.json'))).toBe(false);
  });
});

// ───────────────────────── inspection ─────────────────────────

describe('inspectCommandRules', () => {
  test('reports scope, validity, and project gating state', async () => {
    writeUserRules({ allow: ['npm test', 'bash'], deny: ['git push'] });
    writeProjectRules({ allow: ['pnpm build'] });
    const { inspectCommandRules } = await import('../src/lib/agent/command-rules.js');

    // Untrusted workspace: the project entry shows as untrusted.
    let rows = inspectCommandRules(cwd);
    expect(rows).toContainEqual(
      expect.objectContaining({ scope: 'user', kind: 'allow', entry: 'npm test', status: 'active' }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ scope: 'user', kind: 'allow', entry: 'bash', status: 'invalid' }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ scope: 'user', kind: 'deny', entry: 'git push', status: 'active' }),
    );
    expect(rows).toContainEqual(
      expect.objectContaining({ scope: 'project', entry: 'pnpm build', status: 'untrusted' }),
    );

    // Trusted but unapproved → unapproved; approved → active.
    const { trustWorkspace, approveProjectCommandRule } = await import('../src/lib/config.js');
    trustWorkspace(cwd);
    rows = inspectCommandRules(cwd);
    expect(rows).toContainEqual(
      expect.objectContaining({ scope: 'project', entry: 'pnpm build', status: 'unapproved' }),
    );
    approveProjectCommandRule(cwd, 'allow', 'pnpm build');
    rows = inspectCommandRules(cwd);
    expect(rows).toContainEqual(
      expect.objectContaining({ scope: 'project', entry: 'pnpm build', status: 'active' }),
    );
  });
});

// ───────────────────────── loop-level pins ─────────────────────────

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: {
      json: async () => ({}),
      [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator](),
    },
  };
}

function makeResponder(replies: string[]): (url: string, init: { method: string }) => MockResp {
  let i = 0;
  return (url: string, init: { method: string }) => {
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return jsonResp(200, { success: true, data: { id: 'cnv_rules' } });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      const reply = replies[i] ?? 'Done.';
      i += 1;
      return sseResp([{ type: 'text', content: reply }, { type: 'done' }]);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

const block = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

describe('runAgent — rule integration', () => {
  beforeEach(async () => {
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');
  });

  test('an allow match auto-runs with NO approval fn and emits a visible rule_notice', async () => {
    responder = makeResponder([block('run_command', { command: 'touch made.txt' }), 'Done.']);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    const result = await runAgent({
      task: 'touch it',
      cwd,
      commandRules: rules(['touch made.txt']),
      onEvent: (e) => events.push(e),
    });
    expect(result.finalText).toContain('Done');
    expect(existsSync(join(cwd, 'made.txt'))).toBe(true); // ran without any approval fn
    const notice = events.find((e) => e.type === 'rule_notice');
    expect(notice).toBeDefined();
    if (notice?.type === 'rule_notice') {
      expect(notice.level).toBe('info');
      expect(notice.text).toContain('auto-approved by the user allow rule "touch made.txt"');
    }
  });

  test('deny still denies under --yes (headless auto-approve)', async () => {
    responder = makeResponder([block('run_command', { command: 'touch nope.txt' }), 'Done.']);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const { headlessApproval } = await import('../src/lib/agent/approval.js');
    const events: AgentEvent[] = [];
    await runAgent({
      task: 'touch it',
      cwd,
      requestApproval: headlessApproval(true), // --yes
      commandRules: rules([], ['touch']),
      onEvent: (e) => events.push(e),
    });
    expect(existsSync(join(cwd, 'nope.txt'))).toBe(false);
    const res = events.find((e) => e.type === 'tool_result');
    expect(res && 'kind' in res ? res.kind : null).toBe('rejected');
    const notice = events.find((e) => e.type === 'rule_notice');
    expect(notice?.type === 'rule_notice' ? notice.level : null).toBe('warn');
    expect(notice?.type === 'rule_notice' ? notice.text : '').toContain('deny rule "touch"');
  });

  test('a pre-tool exit-2 hook BLOCKS an allowlisted command (hooks beat the allowlist)', async () => {
    // A REAL exit-2 hook through the real 1.6 machinery.
    const script = join(cwd, 'block-hook.cjs');
    writeFileSync(script, 'process.stderr.write("no commands today"); process.exit(2);', 'utf8');
    writeFileSync(
      join(configDir, 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'pre-tool', command: `"${process.execPath}" "${script}"` }] }),
      'utf8',
    );
    const { loadHookSession, createAgentHooksBridge } = await import('../src/lib/hooks.js');
    const session = await loadHookSession(cwd);
    const bridge = createAgentHooksBridge(session);
    expect(bridge.hasAny).toBe(true);

    responder = makeResponder([block('run_command', { command: 'touch blocked.txt' }), 'Done.']);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({
      task: 'touch it',
      cwd,
      hooks: bridge,
      commandRules: rules(['touch blocked.txt']), // allowlisted — must still be blocked
      onEvent: (e) => events.push(e),
    });
    expect(existsSync(join(cwd, 'blocked.txt'))).toBe(false);
    const res = events.find((e) => e.type === 'tool_result');
    expect(res && 'summary' in res ? res.summary : '').toContain('blocked by a user hook');
    // The hook fired BEFORE dispatch — rule evaluation never ran, no auto-approve notice.
    expect(events.some((e) => e.type === 'rule_notice')).toBe(false);
  });

  test('no commandRules option → no rule_notice events, approval required as before', async () => {
    responder = makeResponder([block('run_command', { command: 'touch plain.txt' }), 'Done.']);
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const events: AgentEvent[] = [];
    await runAgent({
      task: 'touch it',
      cwd,
      onEvent: (e) => events.push(e),
    });
    // No approval fn and no rules: the command is rejected by the default path.
    expect(existsSync(join(cwd, 'plain.txt'))).toBe(false);
    expect(events.some((e) => e.type === 'rule_notice')).toBe(false);
  });
});
