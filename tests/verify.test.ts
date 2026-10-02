import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerifyLoop, clampVerifyAttempts, type VerifyEvent } from '../src/lib/agent/verify.js';
import type { AgentResult } from '../src/lib/agent/loop.js';

let workDir: string;

/**
 * The tests below exercise the LOOP (attempts, feedback, budget), not the gate.
 * Each therefore supplies an approving resolver, exactly as a `--yes` run or an
 * interactive accept would. ⭐ This is not a loosened pin: before the gate
 * existed these seven tests drove the executor with no approval at all, and all
 * seven went RED the moment it was added — which is the fail-closed arm proving
 * itself against a corpus written before it. The gate's OWN behaviour is pinned
 * in its own describe block at the bottom of this file.
 */
const approve = async (): Promise<{ approved: boolean }> => ({ approved: true });
const fakeResult = (conversationId: string): AgentResult => ({
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

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'spycli-verify-'));
});
afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('clampVerifyAttempts', () => {
  test('defaults to 3, clamps to 1–10, and rejects degenerate input', () => {
    expect(clampVerifyAttempts(undefined)).toBe(3);
    expect(clampVerifyAttempts(5)).toBe(5); // in-range passes through
    expect(clampVerifyAttempts(99)).toBe(10); // clamps to the max
    expect(clampVerifyAttempts(-5)).toBe(1); // negatives clamp up to the min
    expect(clampVerifyAttempts(0)).toBe(3); // degenerate "0 attempts" → default
    expect(clampVerifyAttempts(Number.NaN)).toBe(3); // non-finite → default
  });
});

describe('runVerifyLoop', () => {
  test('passes on the first attempt → no fix turns', async () => {
    let calls = 0;
    const events: VerifyEvent[] = [];
    const out = await runVerifyLoop('c1', {
      verifyCommand: 'true',
      attempts: 3,
      cwd: workDir,
      requestApproval: approve,
      continueRun: async (cid) => {
        calls += 1;
        return fakeResult(cid);
      },
      onEvent: (e) => events.push(e),
    });
    expect(out.passed).toBe(true);
    expect(out.attempts).toBe(1);
    expect(calls).toBe(0);
    expect(events.some((e) => e.type === 'verify_result' && e.passed)).toBe(true);
  });

  test('fails once → injects the failure → agent "fixes" → re-verify passes', async () => {
    let calls = 0;
    let injected = '';
    // `test -f fixed.flag` exits non-zero until the "fix" creates the flag.
    const out = await runVerifyLoop('c1', {
      verifyCommand: 'test -f fixed.flag',
      attempts: 3,
      cwd: workDir,
      requestApproval: approve,
      continueRun: async (cid, msg) => {
        calls += 1;
        injected = msg;
        writeFileSync(join(workDir, 'fixed.flag'), ''); // the "fix"
        return fakeResult(cid);
      },
    });
    expect(out.passed).toBe(true);
    expect(out.attempts).toBe(2); // failed once, passed on the second
    expect(calls).toBe(1);
    expect(injected).toMatch(/verification command/i);
    expect(injected).toMatch(/test -f fixed\.flag/);
  });

  test('keeps failing → stops at N attempts and reports failure', async () => {
    let calls = 0;
    const out = await runVerifyLoop('c1', {
      verifyCommand: 'exit 1',
      attempts: 3,
      cwd: workDir,
      requestApproval: approve,
      continueRun: async (cid) => {
        calls += 1;
        return fakeResult(cid); // never actually fixes
      },
    });
    expect(out.passed).toBe(false);
    expect(out.ran).toBe(true);
    expect(out.attempts).toBe(3); // 3 verify runs
    expect(calls).toBe(2); // 2 fix cycles between the 3 verifications
  });

  test('the failure feedback carries the non-zero exit code', async () => {
    let injected = '';
    await runVerifyLoop('c1', {
      verifyCommand: 'exit 3',
      attempts: 2,
      cwd: workDir,
      requestApproval: approve,
      continueRun: async (cid, msg) => {
        injected = msg;
        return fakeResult(cid);
      },
    });
    expect(injected).toMatch(/exited with code 3/);
  });

  test('the shared executor actually runs the command in cwd', async () => {
    // A side-effecting verify proves runShellCommand executed it in the sandbox.
    await runVerifyLoop('c1', {
      verifyCommand: 'echo ran > verify_ran.txt; exit 1',
      attempts: 1,
      cwd: workDir,
      requestApproval: approve,
      continueRun: async (cid) => fakeResult(cid),
    });
    expect(existsSync(join(workDir, 'verify_ran.txt'))).toBe(true);
  });

  test('a shared budget hit between attempts stops the verify loop', async () => {
    let fixCalls = 0;
    // The budget reports "exceeded" only after the first fix re-enters the agent.
    const budget = { check: () => (fixCalls >= 1 ? ('tokens' as const) : null) };
    const out = await runVerifyLoop('c1', {
      verifyCommand: 'exit 1', // always fails → would loop to attempts without the budget
      attempts: 5,
      cwd: workDir,
      budget,
      requestApproval: approve,
      continueRun: async (cid) => {
        fixCalls += 1;
        return fakeResult(cid);
      },
    });
    expect(out.stoppedByBudget).toBe(true);
    expect(out.passed).toBe(false);
    expect(out.attempts).toBe(1); // one verify run before the budget tripped
    expect(fixCalls).toBe(1);
  });

  test('a fix that exhausts the budget stops the loop (via budgetStop on the result)', async () => {
    let fixCalls = 0;
    const out = await runVerifyLoop('c1', {
      verifyCommand: 'exit 1',
      attempts: 5,
      cwd: workDir,
      requestApproval: approve,
      continueRun: async (cid) => {
        fixCalls += 1;
        return { ...fakeResult(cid), budgetStop: 'time' as const };
      },
    });
    expect(out.stoppedByBudget).toBe(true);
    expect(out.attempts).toBe(1);
    expect(fixCalls).toBe(1);
  });

  test('a catastrophic verify command is blocked by the denylist (never runs)', async () => {
    let calls = 0;
    const events: VerifyEvent[] = [];
    const out = await runVerifyLoop('c1', {
      verifyCommand: 'rm -rf /',
      attempts: 3,
      cwd: workDir,
      requestApproval: approve,
      continueRun: async (cid) => {
        calls += 1;
        return fakeResult(cid);
      },
      onEvent: (e) => events.push(e),
    });
    expect(out.ran).toBe(false);
    expect(out.passed).toBe(false);
    expect(calls).toBe(0);
    expect(events.some((e) => e.type === 'verify_result' && e.blocked)).toBe(true);
  });
});

/**
 * F-2c-5 — the approval gate on self-verify.
 *
 * Before these, `verify.ts` had ZERO approval calls: the catastrophic screen
 * was the sole control on this path in EVERY mode, not merely under `--yes`.
 * The command text is the user's own `--verify` string, but the workspace it
 * runs against is whatever the agent has rewritten by attempt N, which is not
 * what the user authorised when they typed it.
 *
 * Each test drives the REAL loop and asserts on whether the executor actually
 * ran — via a command with an observable filesystem side effect — rather than
 * on the returned flags alone. A gate that reports "blocked" while the process
 * still spawned would pass a flags-only assertion.
 */
describe('self-verify is gated by the same approval control as run_command', () => {
  /** A verify command that leaves a trace iff it actually executed. */
  const touching = (marker: string): string => `printf x > ${marker}`;

  test('FAIL CLOSED: no resolver wired ⇒ refused, and the command never runs', async () => {
    const marker = join(workDir, 'ran-noresolver');
    const out = await runVerifyLoop('c1', {
      verifyCommand: touching(marker),
      attempts: 3,
      cwd: workDir,
      continueRun: async (cid) => fakeResult(cid),
      // requestApproval deliberately omitted — the arm that must refuse.
    });
    expect(out.ran).toBe(false);
    expect(out.passed).toBe(false);
    expect(existsSync(marker), 'the executor ran despite no approval resolver').toBe(false);
    expect(out.lastTail).toContain('not approved');
  });

  test('the auto-reject is LOUD: it names both pre-approval routes', async () => {
    // ⭐ RULING 2 (F-2c-6). The auto-reject stays, but a silent refusal is worse
    // than the interaction it replaces — this arm fires in a non-interactive run
    // where nobody is at the keyboard to infer what happened. The message must
    // tell the user what to DO, not describe the internal state that produced
    // the refusal. Asserted on the two routes by name, so a later rewrite that
    // drops the remedy turns this red.
    const out = await runVerifyLoop('c1', {
      verifyCommand: touching(join(workDir, 'ran-loud')),
      attempts: 3,
      cwd: workDir,
      continueRun: async (cid) => fakeResult(cid),
      // requestApproval omitted — the auto-reject arm.
    });
    const tail = out.lastTail ?? '';
    expect(tail, 'the refusal must name --yes').toContain('--yes');
    expect(tail, 'the refusal must name the allow-rule route').toMatch(/allow.*rule|command-rules/);
    expect(tail, 'the refusal must say WHY, in the user\'s terms').toMatch(/non-interactive/i);
  });

  test('a REFUSED approval stops the loop and the command never runs', async () => {
    const marker = join(workDir, 'ran-refused');
    const events: VerifyEvent[] = [];
    const out = await runVerifyLoop('c1', {
      verifyCommand: touching(marker),
      attempts: 3,
      cwd: workDir,
      requestApproval: async () => ({ approved: false, reason: 'rejected by user' }),
      continueRun: async (cid) => fakeResult(cid),
      onEvent: (e) => events.push(e),
    });
    expect(out.ran).toBe(false);
    expect(existsSync(marker)).toBe(false);
    // The refusal is SURFACED, not silent — a blocked verify the user cannot
    // see is indistinguishable from one that passed.
    expect(events.some((e) => e.type === 'verify_result' && e.blocked)).toBe(true);
  });

  test('an APPROVED verify runs exactly as before the gate existed', async () => {
    const marker = join(workDir, 'ran-approved');
    const out = await runVerifyLoop('c1', {
      verifyCommand: touching(marker),
      attempts: 3,
      cwd: workDir,
      requestApproval: approve,
      continueRun: async (cid) => fakeResult(cid),
    });
    expect(out.ran).toBe(true);
    expect(out.passed).toBe(true);
    expect(existsSync(marker), 'an approved verify command must still execute').toBe(true);
  });

  test('the resolver is asked with the VERIFY command, as a command request', async () => {
    const seen: Array<{ kind: string; command?: string }> = [];
    await runVerifyLoop('c1', {
      verifyCommand: 'true',
      attempts: 1,
      cwd: workDir,
      requestApproval: async (req) => {
        seen.push(req as { kind: string; command?: string });
        return { approved: true };
      },
      continueRun: async (cid) => fakeResult(cid),
    });
    // Not a bespoke request shape: the ordinary CommandApprovalRequest, so the
    // existing UI renders it and an "always allow" rule can match it.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('command');
    expect(seen[0]?.command).toBe('true');
  });

  test('a DENY rule refuses before the resolver is consulted — --yes cannot override it', async () => {
    const marker = join(workDir, 'ran-denied');
    let resolverCalls = 0;
    const out = await runVerifyLoop('c1', {
      verifyCommand: touching(marker),
      attempts: 3,
      cwd: workDir,
      commandRules: {
        allow: [],
        deny: [{ kind: 'deny', scope: 'project', entry: 'printf', tokens: ['printf'] }],
      } as never,
      // An unconditionally-approving resolver stands in for --yes; the deny
      // must win anyway, which is only true if it returns first.
      requestApproval: async () => {
        resolverCalls += 1;
        return { approved: true };
      },
      continueRun: async (cid) => fakeResult(cid),
    });
    expect(out.ran).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(resolverCalls, 'the deny rule must return BEFORE the approval resolver').toBe(0);
  });

  test('an ALLOW rule auto-approves without prompting — the escape hatch for a repeated verify', async () => {
    const marker = join(workDir, 'ran-allowed');
    let resolverCalls = 0;
    const out = await runVerifyLoop('c1', {
      // ⭐ A SIMPLE command, deliberately. An allow rule can only fire for one
      // the strict tokenizer accepts; anything carrying a metacharacter (the
      // `printf x > marker` form used above) structurally never reaches the
      // allow branch. That asymmetry is the metachar guarantee, and using a
      // redirect here would have made this test fail for a reason unrelated
      // to the property it names.
      verifyCommand: `touch ${marker}`,
      attempts: 3,
      cwd: workDir,
      commandRules: {
        allow: [{ kind: 'allow', scope: 'user', entry: 'touch', tokens: ['touch'] }],
        deny: [],
      } as never,
      requestApproval: async () => {
        resolverCalls += 1;
        return { approved: false };
      },
      continueRun: async (cid) => fakeResult(cid),
    });
    expect(out.ran).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(resolverCalls, 'an allow rule must not consult the resolver').toBe(0);
  });

  test('the catastrophic screen still fires FIRST — an approving resolver cannot unblock it', async () => {
    let resolverCalls = 0;
    const out = await runVerifyLoop('c1', {
      verifyCommand: 'rm -rf /',
      attempts: 3,
      cwd: workDir,
      requestApproval: async () => {
        resolverCalls += 1;
        return { approved: true };
      },
      continueRun: async (cid) => fakeResult(cid),
    });
    expect(out.ran).toBe(false);
    expect(out.lastTail).toContain('catastrophic');
    expect(resolverCalls, 'the screen must be immutable — never reachable past approval').toBe(0);
  });
});
