import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LIMITS,
  dispatchTool,
  matchesCatastrophic,
  SAFE_DEVICES,
  type ToolContext,
  type ToolLimits,
} from '../src/lib/agent/tools.js';
import { SHELL_OPERATORS } from '../src/lib/agent/shell-parse.js';
import type { CommandRule } from '../src/lib/agent/command-rules.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';

const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });
const REJECT: RequestApproval = () => Promise.resolve({ approved: false, reason: 'rejected by user' });

// ───────────────────────── catastrophic denylist (pure) ─────────────────────────

/**
 * The blocked corpus, named so the boundary pins below can DERIVE from it.
 * A hand-written list of "the same commands but with a semicolon" would be a
 * sample; deriving means a shape added here is automatically covered for every
 * boundary, and an omission turns a test red instead of passing silently.
 */
const CATASTROPHIC_CORPUS = [
  'rm -rf /',
  'rm -fr /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf $HOME',
  'rm -rf /usr',
  'rm --recursive --force /',
  'rm -rf / --no-preserve-root',
  ':(){ :|:& };:',
  'mkfs.ext4 /dev/sda',
  'dd if=/dev/zero of=/dev/sda bs=1M',
  'echo boom > /dev/sda',
];

describe('matchesCatastrophic', () => {
  test('blocks obviously destructive commands', () => {
    for (const c of CATASTROPHIC_CORPUS) {
      expect(matchesCatastrophic(c), c).not.toBeNull();
    }
  });

  // F-2c-1: one trailing separator defeated the whole net — the target stopped
  // matching because no shell separator was in the terminator class.
  //
  // ⭐ HONEST LABEL (F-2c-4b). This derives over the corpus, but `TAILS` is a
  // HAND-TYPED list, so it asserts COVERAGE of the corpus and only a SAMPLE of
  // the boundary class — which is why it missed `>` `>>` `<` `2>` and `$(`
  // entirely. It is kept for its compound tails (`; echo done`, `&& echo ok`);
  // the pin below derives from the parser's own operator table and is the one
  // that actually asserts boundary coverage.
  test('blocks EVERY corpus member followed by a SAMPLE of compound tails', () => {
    const TAILS = [';', '&', '|', ' ;', ';;', ' &', ')', '\n', '; echo done', ' && echo ok', ' || true'];
    for (const c of CATASTROPHIC_CORPUS) {
      for (const tail of TAILS) {
        expect(matchesCatastrophic(`${c}${tail}`), `${c}${tail}`).not.toBeNull();
      }
    }
  });

  // ...and preceded by a leading separator, so the target sits mid-command.
  test('blocks EVERY corpus member preceded by a shell separator', () => {
    const HEADS = ['true; ', 'true && ', 'echo x | ', '( ', 'true & '];
    for (const c of CATASTROPHIC_CORPUS) {
      for (const head of HEADS) {
        expect(matchesCatastrophic(`${head}${c}`), `${head}${c}`).not.toBeNull();
      }
    }
  });

  // F-2a #29: the LEADING word boundary. Segmentation structurally cannot reach
  // these — neither a backslash nor an empty quote pair starts a new command —
  // so fixing only the separator half would have left every one of these open.
  test('blocks the leading-boundary bypasses (alias escape, empty quotes, backtick)', () => {
    for (const c of [
      '\\rm -rf /',
      '\\rm -rf /;',
      '\\rm -rf ~',
      'rm"" -rf /',
      "rm'' -rf /",
      'rm"""" -rf $HOME',
      '`rm -rf /`',
      'echo x; \\rm -rf ~',
      'true && \\rm -rf /usr',
    ]) {
      expect(matchesCatastrophic(c), c).not.toBeNull();
    }
  });

  // The parser must not interpret `#`: it only begins a comment at the start
  // of a word, so stripping from every `#` would delete a real payload.
  //
  // ⭐⭐ F-2c-4b — THIS PIN WAS GREEN FOR THE WRONG REASON, TWICE OVER.
  //
  // At `a391ee88` the three original cases passed only because `;` was ABSENT
  // from the target-terminator character class — i.e. because of the very
  // defect F-2a #9 names. Widening that class (measured) flipped two of them
  // red. They were never observing quoting.
  //
  // Under the word-based screen they pass again — but a mutation run proved
  // they STILL do not observe quoting: with quote-awareness disabled they stay
  // green, because what saves them is COMMAND-WORD ATTRIBUTION (`echo` is the
  // command, not `rm`). A title that claims one property while the body
  // observes another is a false-labelled gate (F-2a #40), so both halves are
  // now named and each is pinned by cases that can actually see it.
  //
  // The first group survives on command-word attribution; the second group is
  // ALLOWED with quote-awareness and BLOCKED without it — the separator sits
  // before the payload inside the quotes, so ignoring the quotes makes `rm`
  // the head of a real command. Verified in both directions by mutation.
  test('a benign command is not condemned by the text of its own arguments', () => {
    for (const c of ['echo "rm -rf /; safe"', "echo 'rm -rf ~; safe'", 'echo "rm -rf /usr; ok"']) {
      expect(matchesCatastrophic(c), c).toBeNull();
    }
  });

  test('a separator inside quotes does not split the command (observes QUOTING alone)', () => {
    for (const c of [
      'echo "; rm -rf / ; true"',
      "echo '; rm -rf ~ ; true'",
      'echo "; rm -rf /usr ; ok"',
      'git commit -m "; rm -rf / ; done"',
    ]) {
      expect(matchesCatastrophic(c), c).toBeNull();
    }
  });

  // ── F-2a #9: the net must see what the SHELL executes ──
  // DERIVED over the corpus × the parser's OWN operator table, so adding an
  // operator to `SHELL_OPERATORS` extends this pin automatically. A hand-typed
  // copy of that table would be a hand-list with extra steps — which is exactly
  // how the previous boundary pin missed `>` `>>` `<` `2>` and `$(`.
  test('blocks EVERY corpus member followed by EVERY operator the parser knows', () => {
    for (const c of CATASTROPHIC_CORPUS) {
      for (const op of SHELL_OPERATORS) {
        expect(matchesCatastrophic(`${c}${op}`), `${c}${op}`).not.toBeNull();
      }
    }
  });

  test('blocks a target terminated by a redirection or an expansion (F-2a #9)', () => {
    for (const c of [
      'rm -rf />/dev/null',
      'rm -rf />out.txt',
      'rm -rf />>log',
      'rm -rf /<in',
      'rm -rf /2>/dev/null',
      'rm -rf /1>x',
      'rm -rf ~>x',
      'rm -rf $HOME>x',
      'rm -rf ${HOME}>x',
      'rm -rf /usr>x',
      'rm -rf /$(true)',
      'rm -rf /${x}',
      'rm -rf ~$(id)',
      'sh -c "rm -rf />/dev/null"',
    ]) {
      expect(matchesCatastrophic(c), c).not.toBeNull();
    }
  });

  // ── F-2a #29: splicing INSIDE the word, not only at its ends ──
  test('blocks intra-word splicing of the command and flag words (F-2a #29)', () => {
    for (const c of [
      'r\\m -rf /',
      'r"m" -rf /',
      "r'm' -rf /",
      "r''m -rf /",
      '"r"m -rf /',
      'r""m -rf /',
      'r\\m -rf ~',
      'r\\m -rf $HOME',
      '"r"m -rf /usr',
      'rm -r"f" /',
      'rm -\\r\\f /',
      'rm "-rf" /',
      "bash -c 'r\\m -rf /'",
    ]) {
      expect(matchesCatastrophic(c), c).not.toBeNull();
    }
  });

  // ── F-2a #19: the device list, INVERTED ──
  // The unsafe side names the families measured ALLOWED at `a391ee88`; the safe
  // side is DERIVED from the allowlist itself, so a device added to
  // SAFE_DEVICES must keep working and one removed from it must start blocking.
  test('blocks writes to any /dev node that is not on the safe allowlist (F-2a #19)', () => {
    for (const dev of [
      '/dev/sda',
      '/dev/xvda',
      '/dev/mmcblk0',
      '/dev/md0',
      '/dev/mapper/vg-lv',
      '/dev/dm-0',
      '/dev/loop0',
      '/dev/nbd0',
      '/dev/nvme0n1',
      '/dev/vda',
    ]) {
      expect(matchesCatastrophic(`dd if=/dev/zero of=${dev} bs=1M`), dev).not.toBeNull();
      expect(matchesCatastrophic(`echo boom > ${dev}`), dev).not.toBeNull();
    }
  });

  test('still allows the safe character devices, derived from the allowlist', () => {
    for (const dev of SAFE_DEVICES) {
      expect(matchesCatastrophic(`echo x > ${dev}`), dev).toBeNull();
    }
    expect(matchesCatastrophic('echo x > /dev/fd/3')).toBeNull();
  });

  // ⭐ THE OTHER SIDE OF THE AXIS. A control that over-blocks is how a safety
  // control gets disabled by its users, and it is the direction nobody files
  // bugs about. Every one of these was measured BLOCKED at `a391ee88`.
  test('does not condemn a benign command that merely MENTIONS a destroyer', () => {
    for (const c of [
      'echo "rm -rf /" >> notes.md',
      'echo "rm -rf /" > notes.md',
      "echo 'rm -rf ~' >> notes.md",
      'grep -n "rm -rf /" notes.md',
      'git commit -m "docs: warn about rm -rf /"',
      'echo "never run rm -rf / on prod"',
      'echo "rm -rf /" is dangerous to run',
    ]) {
      expect(matchesCatastrophic(c), c).toBeNull();
    }
  });

  test('commentary never hides a payload from the segmenter', () => {
    for (const c of [
      'X=1#; rm -rf /;',
      'echo hi #; rm -rf ~;',
      'A=b#; rm -rf $HOME;',
      'X=1#; rm -rf /usr;',
    ]) {
      expect(matchesCatastrophic(c), c).not.toBeNull();
    }
  });

  test('allows ordinary commands (approval still gates them)', () => {
    for (const c of [
      'ls -la',
      'git status',
      'npm test',
      'pnpm build',
      'rm -rf node_modules',
      'rm -rf build/',
      'rm -rf ./tmp',
      'rm file.txt',
      'echo hello > out.txt',
      'cat /dev/null',
      'git rm -rf src/old',
      // segmentation must not create new over-matches out of ordinary compounds
      'rm -rf node_modules && pnpm install',
      'rm -rf dist; pnpm build',
      '(cd sub && rm -rf ./tmp)',
      'git log --oneline | head -20',
      'echo "a;b" > f.txt',
      'psql -c "SELECT 1;"',
      'for f in *.ts; do echo $f; done',
      'find . -name "*.log" -delete',
      'chmod -R 755 ./scripts',
    ]) {
      expect(matchesCatastrophic(c), c).toBeNull();
    }
  });
});

// ───────────────────────── run_command (real spawn) ─────────────────────────

describe('run_command', () => {
  let workDir: string;
  const ctx = (req: RequestApproval = ACCEPT, over: Partial<ToolContext> = {}): ToolContext => ({
    cwd: workDir,
    limits: DEFAULT_LIMITS,
    requestApproval: req,
    ...over,
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-cmd-'));
  });
  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('captures stdout and a zero exit code', async () => {
    const r = await dispatchTool('run_command', { command: 'echo hi' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('command');
    expect(r.exitCode).toBe(0);
    expect(r.content).toContain('hi');
    expect(r.summary).toMatch(/exit 0/);
  });

  // ── F-2c-1: the net THROUGH the real auto-approve wiring ──
  // F-2a's finding was not only that the net missed a separator: it was that
  // under `--yes` the net is the SOLE control, because headlessApproval(true)
  // approves unconditionally with no metachar gate. A pin that screens only the
  // predicate cannot see that — it is weak-pin form (c), a harness that omits
  // the production wiring — which is exactly why the defect reached npm.
  test('--yes cannot run a separator-terminated catastrophic command (real wiring)', async () => {
    const { headlessApproval } = await import('../src/lib/agent/approval.js');
    const yes = headlessApproval(true);

    // The approver really does approve unconditionally — so any refusal below
    // comes from the NET, not from the approval gate. Without this the pin
    // could pass for the wrong reason.
    expect((await yes({ kind: 'command', command: 'anything at all' })).approved).toBe(true);

    for (const command of ['rm -rf /;', 'rm -rf ~;', '\\rm -rf /', 'true && rm -rf /;']) {
      const r = await dispatchTool('run_command', { command }, ctx(yes));
      expect(r.ok, command).toBe(false);
      expect(r.content, command).toMatch(/catastrophic/);
    }
  });

  // The same path must still RUN an ordinary command, or the pin above would
  // pass on a CLI that simply refused everything under --yes.
  test('--yes still runs an ordinary command', async () => {
    const { headlessApproval } = await import('../src/lib/agent/approval.js');
    const r = await dispatchTool('run_command', { command: 'echo fine' }, ctx(headlessApproval(true)));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('fine');
  });

  // Self-verify has NO approval gate at all, so the net is its sole control
  // unconditionally — not merely under a flag.
  test('the self-verify path refuses a separator-terminated catastrophic command', async () => {
    const { runVerifyLoop } = await import('../src/lib/agent/verify.js');
    const out = await runVerifyLoop('conv-1', {
      verifyCommand: 'rm -rf /;',
      attempts: 1,
      cwd: workDir,
      continueRun: () => {
        throw new Error('must never re-enter the agent — the command must be blocked first');
      },
    });
    expect(out.ran).toBe(false);
    expect(out.lastTail).toMatch(/catastrophic/);
  });

  test('captures a non-zero exit code', async () => {
    const r = await dispatchTool('run_command', { command: 'exit 3' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.summary).toMatch(/exit 3/);
  });

  test('captures stderr', async () => {
    const r = await dispatchTool('run_command', { command: 'echo oops 1>&2' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('oops');
  });

  test('runs in the sandbox cwd', async () => {
    const r = await dispatchTool('run_command', { command: 'echo made > made_here.txt' }, ctx());
    expect(r.ok).toBe(true);
    expect(existsSync(join(workDir, 'made_here.txt'))).toBe(true);
  });

  test('times out and kills the process group', async () => {
    const start = Date.now();
    const r = await dispatchTool(
      'run_command',
      { command: 'sleep 5 && touch marker.txt' },
      ctx(ACCEPT, { commandTimeoutMs: 700 }),
    );
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(4000); // didn't wait the full 5s
    // The process group was killed before `touch` could run.
    expect(existsSync(join(workDir, 'marker.txt'))).toBe(false);
  }, 10000);

  test('caps oversized output (model content) but keeps a tail', async () => {
    const tiny: ToolLimits = { ...DEFAULT_LIMITS, maxResultChars: 200 };
    const r = await dispatchTool(
      'run_command',
      { command: "awk 'BEGIN{for(i=1;i<=500;i++)print \"line\"i}'" },
      ctx(ACCEPT, { limits: tiny }),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/truncated to/); // dispatch byte-cap
    expect(r.outputTail ?? '').toContain('line500'); // tail keeps the last lines
  });

  test('reject (approval) does not run the command', async () => {
    const r = await dispatchTool('run_command', { command: 'echo nope > nope.txt' }, ctx(REJECT));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('rejected');
    expect(existsSync(join(workDir, 'nope.txt'))).toBe(false);
  });

  test('catastrophic commands are blocked BEFORE approval (no prompt, no run)', async () => {
    let prompted = false;
    const spy: RequestApproval = () => {
      prompted = true;
      return Promise.resolve({ approved: true }); // even an approve-all approver
    };
    const r = await dispatchTool('run_command', { command: 'rm -rf /' }, ctx(spy));
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/blocked: refusing to run a catastrophic command/);
    expect(prompted).toBe(false);
  });

  test('empty command is rejected', async () => {
    const r = await dispatchTool('run_command', { command: '   ' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/must not be empty/);
  });
});

// ───────────────── run_command × command rules (PHASE-1 1.10) ─────────────────

describe('run_command with allow/deny rules', () => {
  let workDir: string;
  const rule = (entry: string, kind: 'allow' | 'deny'): CommandRule => ({
    entry,
    tokens: entry.split(' '),
    kind,
    scope: 'user',
  });
  const ctx = (req: RequestApproval | undefined, over: Partial<ToolContext> = {}): ToolContext => ({
    cwd: workDir,
    limits: DEFAULT_LIMITS,
    requestApproval: req,
    ...over,
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-cmdrule-'));
  });
  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('allow match runs the command WITHOUT prompting and notices the rule', async () => {
    let prompted = false;
    const spy: RequestApproval = () => {
      prompted = true;
      return Promise.resolve({ approved: false, reason: 'should never be asked' });
    };
    const notices: Array<{ kind: string; entry: string }> = [];
    const r = await dispatchTool(
      'run_command',
      { command: 'touch allowed.txt' },
      ctx(spy, {
        commandRules: { allow: [rule('touch allowed.txt', 'allow')], deny: [] },
        onCommandRuleNotice: (n) => notices.push({ kind: n.kind, entry: n.rule.entry }),
      }),
    );
    expect(r.ok).toBe(true);
    expect(prompted).toBe(false);
    expect(existsSync(join(workDir, 'allowed.txt'))).toBe(true);
    expect(notices).toEqual([{ kind: 'auto_approve', entry: 'touch allowed.txt' }]);
  });

  test('METACHAR PIN: every compound construction still prompts despite a matching allow entry', async () => {
    const rules = {
      allow: [rule('git status', 'allow'), rule('echo hi', 'allow'), rule('touch x.txt', 'allow')],
      deny: [],
    };
    for (const command of [
      'git status; touch x.txt',
      'git status && touch x.txt',
      'git status || touch x.txt',
      'git status | cat',
      'echo hi $(touch x.txt)',
      'echo hi `touch x.txt`',
      'echo hi > x.txt',
      'echo hi < x.txt',
      'echo hi >> x.txt',
      'echo hi << EOF',
      'git status\ntouch x.txt',
      "git 'status'; touch x.txt",
    ]) {
      let prompted = false;
      const spy: RequestApproval = () => {
        prompted = true;
        return Promise.resolve({ approved: false, reason: 'rejected by test' });
      };
      const r = await dispatchTool('run_command', { command }, ctx(spy, { commandRules: rules }));
      expect(prompted, command).toBe(true); // the approval prompt fired
      expect(r.ok, command).toBe(false); // and the rejection held — nothing ran
    }
    expect(existsSync(join(workDir, 'x.txt'))).toBe(false);
  });

  test('deny rejects WITHOUT prompting — even with an approve-all approver (--yes analog)', async () => {
    let prompted = false;
    const yes: RequestApproval = () => {
      prompted = true;
      return Promise.resolve({ approved: true });
    };
    const notices: Array<{ kind: string; entry: string }> = [];
    const r = await dispatchTool(
      'run_command',
      { command: 'touch denied.txt' },
      ctx(yes, {
        commandRules: { allow: [], deny: [rule('touch', 'deny')] },
        onCommandRuleNotice: (n) => notices.push({ kind: n.kind, entry: n.rule.entry }),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('rejected');
    expect(r.content).toContain('denied by the user deny rule "touch"');
    expect(prompted).toBe(false);
    expect(existsSync(join(workDir, 'denied.txt'))).toBe(false);
    expect(notices).toEqual([{ kind: 'deny', entry: 'touch' }]);
  });

  test('deny beats allow when both match', async () => {
    const r = await dispatchTool(
      'run_command',
      { command: 'git status' },
      ctx(ACCEPT, {
        commandRules: { allow: [rule('git status', 'allow')], deny: [rule('git', 'deny')] },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain('deny rule "git"');
  });

  test('the built-in catastrophic guard beats an allow entry that matches it (override attempt)', async () => {
    let prompted = false;
    const spy: RequestApproval = () => {
      prompted = true;
      return Promise.resolve({ approved: true });
    };
    const notices: unknown[] = [];
    const r = await dispatchTool(
      'run_command',
      { command: 'rm -rf /' },
      ctx(spy, {
        commandRules: { allow: [rule('rm -rf /', 'allow')], deny: [] },
        onCommandRuleNotice: (n) => notices.push(n),
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/blocked: refusing to run a catastrophic command/);
    expect(prompted).toBe(false); // blocked BEFORE approval
    expect(notices).toEqual([]); // and BEFORE rule evaluation — allow never even matched
  });

  test('no commandRules in ctx → the normal prompt fires (default byte-identical)', async () => {
    let prompted = false;
    const spy: RequestApproval = () => {
      prompted = true;
      return Promise.resolve({ approved: false, reason: 'rejected by user' });
    };
    const r = await dispatchTool('run_command', { command: 'touch plain.txt' }, ctx(spy));
    expect(prompted).toBe(true);
    expect(r.kind).toBe('rejected');
  });
});
