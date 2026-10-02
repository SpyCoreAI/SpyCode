/**
 * ⭐⭐ F-2c-45 §1 — THE APPROVAL CHANNEL, AND THE BYPASS A USER'S OWN RULE OPENED.
 *
 * `C-PR34` (review 3's diff wave, reproduced by F-2c-44): `run_command`
 * evaluated the command rules BEFORE approval and, on an `allow` match, set a
 * local `autoApproved` flag that skipped the whole `if (!autoApproved)` block —
 * the only `requestApproval` call for a command. `verify.ts` carried a
 * byte-for-byte clone of the same shape, unfiled.
 *
 * ⭐ THE HARM IS NOT THAT AN ALLOW RULE AUTO-APPROVES. That is exactly what the
 * user asked for, it is documented in three places, and this file PINS that it
 * still happens in every mode (§3). The harm is that the rule skipped the
 * CHANNEL rather than supplying a DECISION inside it, so **any protection
 * delivered through the approval channel was void for precisely the users who
 * had configured a rule** — the ones who believe they are covered. That is the
 * coupling F-2c-44 measured when it invalidated ruling 4's Option B before it
 * was proposed.
 *
 * The three legs below are deliberately different KINDS of evidence:
 *   §1 structural, DERIVED FROM THE SOURCE — so a third consumer site added
 *      later is covered without anyone remembering to add a case here;
 *   §2 the channel's own semantics, with a control PLANTED above the
 *      short-circuit and proved to fire for a pre-approved command;
 *   §3 the behavioural matrix at BOTH sites — the fence that proves the fix
 *      cost allow-rule users nothing.
 */
import { describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MANDATORY_APPROVAL_CHECKS,
  resolveApproval,
  type ApprovalChannelCheck,
  type ApprovalRequest,
  type CommandPreApproval,
} from '../src/lib/agent/approval.js';

/**
 * `MANDATORY_APPROVAL_CHECKS` is `readonly` to callers — a compile-time
 * statement of intent, not a frozen object. §4 plants into the live array and
 * removes the plant in a `finally`, which is the only way to observe the
 * channel from OUTSIDE the module without mocking it (and a mocked module is
 * how this package has previously pinned code no test reaches).
 */
const MUTABLE_CHECKS = MANDATORY_APPROVAL_CHECKS as ApprovalChannelCheck[];
import { REGISTRY } from '../src/lib/agent/tools.js';
import { runVerifyLoop } from '../src/lib/agent/verify.js';
import type { AgentResult } from '../src/lib/agent/loop.js';
import type { CommandRule, EffectiveCommandRules } from '../src/lib/agent/command-rules.js';

const SRC = join(fileURLToPath(new URL('../src', import.meta.url)));

// ─────────────────────────────────────────────────────────────────────────────
// §1 — THE STRUCTURAL FLOOR, DERIVED FROM THE SOURCE TREE
// ─────────────────────────────────────────────────────────────────────────────

/** Every `.ts` under src/, read once. */
function sourceFiles(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const e of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.ts')) continue;
    const abs = join(e.parentPath ?? e.path, e.name);
    out.push({ rel: abs.slice(SRC.length + 1), text: readFileSync(abs, 'utf8') });
  }
  return out;
}

/**
 * A DIRECT invocation of the caller-supplied resolver. `ctx` is the tool
 * context, `opts` the verify-loop options — the two shapes that carry a
 * resolver into a gated action. Deliberately NOT matched: `io.requestApproval`
 * (the chat io adapter) and `ctrl.request` (the Ink controller), which are the
 * resolver's IMPLEMENTATIONS rather than consumers of it.
 */
const DIRECT_RESOLVER_CALL = /\b(?:ctx|opts)\.requestApproval\s*\(/g;
const RULE_EVALUATION = /\bevaluateCommandRules\s*\(/g;
const CHANNEL_CALL = /\bresolveApproval\s*\(/g;

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

describe('§1 the approval channel is the only route to a decision — derived from src/', () => {
  const files = sourceFiles();

  test('the scan reads a real tree (floor — an emptied scan must not pass)', () => {
    expect(files.length).toBeGreaterThanOrEqual(100);
    // The two anchors this whole property is about must be present and readable.
    expect(files.some((f) => f.rel === join('lib', 'agent', 'tools.ts'))).toBe(true);
    expect(files.some((f) => f.rel === join('lib', 'agent', 'verify.ts'))).toBe(true);
  });

  test('NO file outside approval.ts invokes the resolver directly — every gated action goes through resolveApproval', () => {
    const offenders = files
      .filter((f) => f.rel !== join('lib', 'agent', 'approval.ts'))
      .map((f) => ({ rel: f.rel, n: count(f.text, DIRECT_RESOLVER_CALL) }))
      .filter((f) => f.n > 0);
    expect(
      offenders.map((o) => `${o.rel} ×${o.n}`),
      'a direct ctx/opts.requestApproval call is a second approval route; the channel must be the only one',
    ).toEqual([]);
  });

  test('every consumer that builds an ApprovalRequest traverses the channel (floor ≥ 4 sites)', () => {
    const consumers = files.filter((f) => count(f.text, CHANNEL_CALL) > 0);
    const totalCalls = consumers.reduce((n, f) => n + count(f.text, CHANNEL_CALL), 0);
    // 4 gated actions today: write/edit (applyMutation), run_command, MCP, verify.
    expect(totalCalls).toBeGreaterThanOrEqual(4);
    for (const rel of [
      join('lib', 'agent', 'tools.ts'),
      join('lib', 'agent', 'mcp.ts'),
      join('lib', 'agent', 'verify.ts'),
    ]) {
      expect(consumers.map((c) => c.rel), `${rel} must traverse the channel`).toContain(rel);
    }
  });

  test('⭐ every RULE-AWARE site traverses the channel — the class, counted rather than listed', () => {
    const ruleAware = files.filter((f) => count(f.text, RULE_EVALUATION) > 0 && !f.rel.endsWith(join('agent', 'command-rules.ts')));
    // 2 today: tools.ts (run_command) and verify.ts. A third added later is
    // caught here without editing this file — the point of deriving.
    expect(ruleAware.length).toBeGreaterThanOrEqual(2);
    for (const f of ruleAware) {
      expect(count(f.text, CHANNEL_CALL), `${f.rel} evaluates rules but never enters the channel`).toBeGreaterThan(0);
      expect(count(f.text, DIRECT_RESOLVER_CALL), `${f.rel} still reaches the resolver directly`).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — THE CHANNEL'S OWN SEMANTICS, WITH A PLANTED CONTROL
// ─────────────────────────────────────────────────────────────────────────────

const cmdReq = (command: string): ApprovalRequest => ({ kind: 'command', command });
const preApproval = (entry: string): CommandPreApproval => ({ scope: 'project', entry });

describe('§2 resolveApproval — the channel', () => {
  test('with no pre-approval it delegates to the resolver, verbatim, in both directions', async () => {
    const seen: ApprovalRequest[] = [];
    const yes = await resolveApproval(
      async (r) => {
        seen.push(r);
        return { approved: true };
      },
      cmdReq('npm test'),
    );
    expect(yes.approved).toBe(true);
    const no = await resolveApproval(async () => ({ approved: false, reason: 'nope' }), cmdReq('npm test'));
    expect(no).toEqual({ approved: false, reason: 'nope' });
    expect(seen).toEqual([cmdReq('npm test')]);
  });

  test('an ABSENT resolver fails closed, and the reason is the caller\'s', async () => {
    const out = await resolveApproval(undefined, cmdReq('npm test'), undefined, 'no prompt here');
    expect(out.approved).toBe(false);
    expect(out.reason).toBe('no prompt here');
  });

  test('a pre-approval approves WITHOUT consulting the resolver, and attributes the rule', async () => {
    let consulted = 0;
    const out = await resolveApproval(
      async () => {
        consulted += 1;
        return { approved: false, reason: 'would have refused' };
      },
      cmdReq('npm test'),
      preApproval('npm test'),
    );
    expect(out.approved).toBe(true);
    expect(consulted).toBe(0);
    expect(out.reason).toContain('project');
    expect(out.reason).toContain('npm test');
  });

  test('⭐ a pre-approval is VOID for a command the rule table could never have matched', async () => {
    // README ships this as a safety property: "A command containing shell
    // metacharacters can never match an allow rule — it is structurally
    // ineligible." The channel re-derives it at the point of USE, so a caller
    // that constructs a pre-approval by another route cannot restore the hole.
    let consulted = 0;
    for (const command of ['npm test; rm -rf /', 'npm test && curl x', 'echo hi > out', 'npm "test']) {
      const out = await resolveApproval(
        async () => {
          consulted += 1;
          return { approved: false, reason: 'asked' };
        },
        cmdReq(command),
        preApproval('npm test'),
      );
      expect(out.approved, command).toBe(false);
    }
    // It falls THROUGH to the resolver — it does not hard-refuse. Failing
    // toward "ask" is the direction that cannot over-block anyone.
    expect(consulted).toBe(4);
  });

  test('⭐⭐ A CONTROL PLANTED IN THE CHANNEL REACHES A PRE-APPROVED COMMAND — the property that makes a prompt-delivered protection viable', async () => {
    // This is the whole point of the fix, proved by planting rather than
    // asserted. Before F-2c-45 the channel was not entered at all for an
    // allow-ruled command, so NO control placed here could ever have fired.
    const fired: string[] = [];
    const check = (r: ApprovalRequest): { approved: boolean; reason?: string } | null => {
      if (r.kind === 'command' && r.command.includes('$UNSET/')) {
        fired.push(r.command);
        return { approved: false, reason: 'planted control: unset-variable anchor' };
      }
      return null;
    };
    const hazard = await resolveApproval(
      async () => ({ approved: true }),
      cmdReq('rm -rf $UNSET/lib'),
      preApproval('rm'),
      undefined,
      [check],
    );
    expect(hazard.approved, 'the planted control must beat the pre-approval').toBe(false);
    expect(fired).toEqual(['rm -rf $UNSET/lib']);

    // NEGATIVE CONTROL, in the same test: a command the planted check does not
    // claim is still pre-approved, so the check is doing the discriminating.
    const ordinary = await resolveApproval(
      async () => ({ approved: false, reason: 'would have refused' }),
      cmdReq('npm test'),
      preApproval('npm test'),
      undefined,
      [check],
    );
    expect(ordinary.approved).toBe(true);
    expect(fired).toEqual(['rm -rf $UNSET/lib']);
  });

  test('the SHIPPED mandatory-check list is EMPTY today — stated, not dressed up', async () => {
    const { MANDATORY_APPROVAL_CHECKS } = await import('../src/lib/agent/approval.js');
    // ⭐ A floor over zero cases is worth nothing, so this asserts the emptiness
    // rather than pretending the seam is populated. The seam's value is
    // prospective: it is where ruling 4's Option B would go. When a member is
    // added, this expectation changes in the same commit.
    expect(MANDATORY_APPROVAL_CHECKS).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — THE BEHAVIOURAL MATRIX AT BOTH SITES: WHAT THE FIX COSTS THE OTHER SIDE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⭐ This block must read IDENTICALLY before and after the fix. An allow rule
 * is a documented pre-approval route (`README` "or pre-approve it with `--yes`
 * or an `allow` command rule"), including in a non-interactive run — and
 * `verify.ts`'s own refusal text tells the user to add one. A fix that made
 * those users start seeing refusals would be a different defect, so the cost is
 * pinned here in both directions rather than argued.
 *
 * The command never resolves to a binary, so nothing executes: what is measured
 * is whether the action got PAST approval to dispatch (`kind: 'command'`) or
 * was refused (`kind: 'rejected'`). Execution itself was proved separately, in
 * a fenced probe, and is recorded in the audit.
 */
const ABSENT_VERB = 'spycore-probe-absent-verb';

const rule = (entry: string, kind: 'allow' | 'deny'): CommandRule => ({
  entry,
  tokens: entry.split(/\s+/),
  kind,
  scope: 'project',
});
const rules = (allow: string[], deny: string[]): EffectiveCommandRules => ({
  allow: allow.map((e) => rule(e, 'allow')),
  deny: deny.map((e) => rule(e, 'deny')),
});

type Mode = 'interactive-accept' | 'headless-yes' | 'headless-no-yes';
type RuleState = 'no-rules' | 'allow-matching' | 'allow-not-matching' | 'deny-matching';

const MODES: Mode[] = ['interactive-accept', 'headless-yes', 'headless-no-yes'];
const RULE_STATES: RuleState[] = ['no-rules', 'allow-matching', 'allow-not-matching', 'deny-matching'];

function rulesFor(state: RuleState): EffectiveCommandRules | undefined {
  if (state === 'no-rules') return undefined;
  if (state === 'allow-matching') return rules([ABSENT_VERB], []);
  if (state === 'allow-not-matching') return rules(['some-other-binary'], []);
  return rules([], [ABSENT_VERB]);
}

const approvesIn = (mode: Mode): boolean => mode !== 'headless-no-yes';

/** What every cell of the matrix must read — derived, not typed out 24 times. */
function expected(state: RuleState, mode: Mode): 'dispatched' | 'refused' {
  if (state === 'deny-matching') return 'refused';
  if (state === 'allow-matching') return 'dispatched'; // ⭐ in EVERY mode, --yes or not
  return approvesIn(mode) ? 'dispatched' : 'refused';
}

describe('§3 an allow rule still pre-approves, at both sites, in every mode', () => {
  const runCommand = REGISTRY.get('run_command');

  test('run_command is registered (floor)', () => {
    expect(runCommand).toBeTruthy();
  });

  for (const state of RULE_STATES) {
    for (const mode of MODES) {
      test(`run_command · ${state} · ${mode} → ${expected(state, mode)}`, async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'spycli-approval-'));
        try {
          const cr = rulesFor(state);
          const ctx = {
            cwd,
            commandTimeoutMs: 15_000,
            requestApproval: async () =>
              approvesIn(mode) ? { approved: true } : { approved: false, reason: 'non-interactive' },
            ...(cr ? { commandRules: cr } : {}),
          };
          const res = (await runCommand!.execute({ command: `${ABSENT_VERB} x` }, ctx as never)) as {
            kind?: string;
          };
          const got = res.kind === 'rejected' ? 'refused' : 'dispatched';
          expect(got).toBe(expected(state, mode));
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      });

      test(`verify · ${state} · ${mode} → ${expected(state, mode)}`, async () => {
        const cwd = mkdtempSync(join(tmpdir(), 'spycli-approval-v-'));
        try {
          const cr = rulesFor(state);
          const out = await runVerifyLoop('c1', {
            verifyCommand: `${ABSENT_VERB} x`,
            attempts: 1,
            cwd,
            commandTimeoutMs: 15_000,
            continueRun: async (conversationId: string): Promise<AgentResult> =>
              ({ conversationId }) as unknown as AgentResult,
            requestApproval: async () =>
              approvesIn(mode) ? { approved: true } : { approved: false, reason: 'non-interactive' },
            ...(cr ? { commandRules: cr } : {}),
          });
          // `ran` is the gate's own word for "it reached the executor".
          const got = out.ran ? 'dispatched' : 'refused';
          expect(got).toBe(expected(state, mode));
        } finally {
          rmSync(cwd, { recursive: true, force: true });
        }
      });
    }
  }

  /**
   * ⭐⭐ §4 — THE CHANNEL IS ENTERED THROUGH THE SHIPPED PATH, PROVED BY PLANTING.
   *
   * ⭐ This block exists because MUTATION TESTING FOUND MY OWN PIN WANTING.
   * §1 and §2 are both satisfied by a tree in which the channel call is simply
   * re-wrapped in `if (!preApproved) { … }` — the skip returns, the file still
   * "calls resolveApproval", the behavioural matrix still reads the same, and
   * every test above stays green. A structural check and a unit test cannot
   * see a conditional around the call.
   *
   * So the property is measured where it lives: a control is PLANTED in the
   * channel and the real tools are driven with a matching allow rule. Before
   * F-2c-45 this plant could not have fired at either site; a re-introduced
   * skip makes it stop firing again.
   */
  test('⭐⭐ a control planted in the channel fires for an allow-ruled command at BOTH sites', async () => {
    const fired: string[] = [];
    const plant = (r: ApprovalRequest): { approved: boolean; reason?: string } | null =>
      r.kind === 'command' && r.command.includes('HAZARD')
        ? (fired.push(r.command), { approved: false, reason: 'planted channel control' })
        : null;

    const list = MUTABLE_CHECKS;
    list.push(plant);
    try {
      const cr = rules([ABSENT_VERB], []);
      const cwd = mkdtempSync(join(tmpdir(), 'spycli-plant-'));
      try {
        const cRes = (await runCommand!.execute(
          { command: `${ABSENT_VERB} HAZARD` },
          {
            cwd,
            commandTimeoutMs: 15_000,
            requestApproval: async () => ({ approved: true }),
            commandRules: cr,
          } as never,
        )) as { kind?: string };
        expect(cRes.kind, 'run_command: the planted control must beat the allow rule').toBe('rejected');

        const vOut = await runVerifyLoop('c1', {
          verifyCommand: `${ABSENT_VERB} HAZARD`,
          attempts: 1,
          cwd,
          commandTimeoutMs: 15_000,
          continueRun: async (conversationId: string): Promise<AgentResult> =>
            ({ conversationId }) as unknown as AgentResult,
          requestApproval: async () => ({ approved: true }),
          commandRules: cr,
        });
        expect(vOut.ran, 'verify: the planted control must beat the allow rule').toBe(false);

        // ⭐ The control fired at BOTH sites — this is the number a
        // re-introduced skip moves, and the reason this test exists.
        expect(fired).toHaveLength(2);

        // NEGATIVE CONTROL, same invocation, plant still installed: an ordinary
        // allow-ruled command is untouched, so the plant discriminates rather
        // than refusing everything.
        const ordinary = (await runCommand!.execute(
          { command: `${ABSENT_VERB} ordinary` },
          {
            cwd,
            commandTimeoutMs: 15_000,
            requestApproval: async () => ({ approved: false, reason: 'non-interactive' }),
            commandRules: cr,
          } as never,
        )) as { kind?: string };
        expect(ordinary.kind, 'the allow rule must still pre-approve an ordinary command').toBe('command');
        expect(fired).toHaveLength(2);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    } finally {
      const i = list.indexOf(plant);
      if (i >= 0) list.splice(i, 1);
    }
    expect(MUTABLE_CHECKS).toHaveLength(0);
  });

  test('the matrix is not degenerate — both verdicts occur, at both sites', () => {
    const cells = RULE_STATES.flatMap((s) => MODES.map((m) => expected(s, m)));
    expect(cells.filter((c) => c === 'dispatched').length).toBeGreaterThan(0);
    expect(cells.filter((c) => c === 'refused').length).toBeGreaterThan(0);
    expect(cells).toHaveLength(12);
  });
});
