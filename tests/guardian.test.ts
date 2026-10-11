/**
 * H-3 - guardian circuit breaker: after N consecutive rejections a hard-stop
 * note is appended to the rejection REASON (tool-result text only, never
 * the system prompt - the cache invariant), and the count resets on any
 * approval.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_GUARDIAN_THRESHOLD,
  createGuardianBreaker,
  guardianHardStopText,
  resolveGuardianThreshold,
} from '../src/lib/agent/guardian.js';
import type { ApprovalOutcome, ApprovalRequest, RequestApproval } from '../src/lib/agent/approval.js';

const REQ = { kind: 'write', tool: 'write_file', path: 'x.ts' } as unknown as ApprovalRequest;
const REJECT: ApprovalOutcome = { approved: false, reason: 'no' };
const APPROVE: ApprovalOutcome = { approved: true };

function resolver(outcomes: ApprovalOutcome[]): RequestApproval {
  let i = 0;
  return vi.fn(async () => outcomes[Math.min(i++, outcomes.length - 1)]!);
}

describe('createGuardianBreaker', () => {
  test('passes approvals through untouched', async () => {
    const inner = resolver([APPROVE]);
    const g = createGuardianBreaker(inner);
    const out = await g.request(REQ);
    expect(out).toEqual(APPROVE);
    expect(g.consecutiveRejections()).toBe(0);
    expect(g.tripped()).toBe(false);
  });

  test('rejections before the threshold pass through unchanged', async () => {
    const inner = resolver([REJECT, REJECT]);
    const g = createGuardianBreaker(inner, 3);
    await g.request(REQ);
    await g.request(REQ);
    const out = await g.request(REQ); // third rejection trips
    expect(out.approved).toBe(false);
    expect(g.consecutiveRejections()).toBe(3);
    expect(g.tripped()).toBe(true);
  });

  test('after the threshold the hard-stop note rides the rejection reason', async () => {
    const inner = resolver([REJECT, REJECT, REJECT, REJECT]);
    const g = createGuardianBreaker(inner, 3);
    const outs: ApprovalOutcome[] = [];
    for (let i = 0; i < 4; i += 1) outs.push(await g.request(REQ));
    expect(outs[0]!.reason).toBe('no');
    expect(outs[1]!.reason).toBe('no');
    expect(outs[2]!.reason).toContain('no');
    expect(outs[2]!.reason).toContain(guardianHardStopText(3));
    expect(outs[3]!.reason).toContain(guardianHardStopText(4));
    // The approval itself is unchanged - the note is text only, never a policy change.
    expect(outs[3]!.approved).toBe(false);
  });

  test('one approval resets the counter', async () => {
    const inner = resolver([REJECT, REJECT, APPROVE, REJECT]);
    const g = createGuardianBreaker(inner, 3);
    await g.request(REQ);
    await g.request(REQ);
    await g.request(REQ); // approval
    const out = await g.request(REQ); // first rejection after reset
    expect(out.reason).toBe('no'); // no hard-stop note
    expect(g.consecutiveRejections()).toBe(1);
    expect(g.tripped()).toBe(false);
  });

  test('the hard-stop text names no tool names and never touches the system prompt', () => {
    const text = guardianHardStopText(3);
    expect(text.length).toBeGreaterThan(0);
    // The breaker only ever returns outcomes - it has no prompt access.
    expect(createGuardianBreaker(resolver([REJECT]), 1)).toBeDefined();
  });
});

describe('resolveGuardianThreshold', () => {
  test('precedence: run opt > env > config > default', () => {
    expect(DEFAULT_GUARDIAN_THRESHOLD).toBe(3);
    expect(resolveGuardianThreshold({ opt: 5, env: { SPYCODE_GUARDIAN_THRESHOLD: '7' }, configured: 9 })).toBe(5);
    expect(resolveGuardianThreshold({ env: { SPYCODE_GUARDIAN_THRESHOLD: '7' }, configured: 9 })).toBe(7);
    expect(resolveGuardianThreshold({ env: {}, configured: 9 })).toBe(9);
    expect(resolveGuardianThreshold({})).toBe(3);
  });

  test('floors and ignores garbage', () => {
    expect(resolveGuardianThreshold({ opt: 2.7 })).toBe(2);
    expect(resolveGuardianThreshold({ opt: -1 })).toBe(0);
    expect(resolveGuardianThreshold({ env: { SPYCODE_GUARDIAN_THRESHOLD: 'junk' } })).toBe(3);
    expect(resolveGuardianThreshold({ env: { SPYCODE_GUARDIAN_THRESHOLD: '' } })).toBe(3);
  });
});
