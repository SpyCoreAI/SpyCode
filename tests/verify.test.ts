import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runVerifyLoop, clampVerifyAttempts, type VerifyEvent } from '../src/lib/agent/verify.js';
import type { AgentResult } from '../src/lib/agent/loop.js';

let workDir: string;
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
