/**
 * A-10 - prompt assembly is pure: `planFirstTurn` builds the candidate from
 * plain inputs only (no provider, no events, no I/O), and the runtime
 * (`assembleFirstTurn`) commits it.
 *
 * A-6 + H-1 - the cache-sacred invariant: the system prompt is byte-stable
 * for the whole conversation, so the provider's KV-cache prefix stays warm.
 * The guard commits the turn-1 bytes and trips on any mid-conversation
 * rebuild.
 */
import { describe, expect, test } from 'vitest';
import { planFirstTurn } from '../src/lib/agent/run-prompt.js';
import { createPromptCacheGuard, hashPrompt } from '../src/lib/agent/prompt-cache.js';

const BASE = {
  cwd: '/repo',
  maxTurns: 25,
  planMode: false,
  nativeMode: false,
  skillsSection: '',
  mcpSection: '',
  webEnabled: true,
  delegateEnabled: true,
  task: 'fix the bug',
};

function joinedParts(): string {
  const { parts } = planFirstTurn(BASE);
  return parts.map((p) => `${p.pre ?? ''}${p.body}${p.post ?? ''}`).join('');
}

describe('A-10 pure prompt assembly', () => {
  test('identical inputs produce byte-identical parts', () => {
    expect(joinedParts()).toBe(joinedParts());
  });

  test('the part structure is stable: system, then TASK, in order', () => {
    const { parts, taskPartIdx } = planFirstTurn(BASE);
    expect(parts[0]!.label).toBe('system prompt');
    expect(parts[taskPartIdx]!.label).toBe('task');
    expect(parts[taskPartIdx]!.body).toBe('TASK: fix the bug');
    expect(taskPartIdx).toBe(1);
  });

  test('optional parts only appear when given', () => {
    const bare = planFirstTurn(BASE).parts.map((p) => p.label);
    expect(bare).toEqual(['system prompt', 'task']);
    const full = planFirstTurn({
      ...BASE,
      projectContext: '<ctx/>',
      attachedContext: 'file text',
      approvedPlan: '1. do it',
      planEdited: true,
    }).parts.map((p) => p.label);
    expect(full).toEqual(['system prompt', 'project context', 'task', 'attached files', 'approved plan']);
  });

  test('the approved-plan marker names an edited plan, and stays silent otherwise', () => {
    const edited = planFirstTurn({ ...BASE, approvedPlan: '1. do it', planEdited: true }).parts;
    expect(edited[edited.length - 1]!.body).toContain(', EDITED, and APPROVED');
    const plain = planFirstTurn({ ...BASE, approvedPlan: '1. do it' }).parts;
    expect(plain[plain.length - 1]!.body).toContain('reviewed and APPROVED');
    expect(plain[plain.length - 1]!.body).not.toContain('EDITED');
  });

  test('plan feedback only lands in plan mode', () => {
    const off = planFirstTurn({ ...BASE, planFeedback: 'nope' }).parts.map((p) => p.label);
    expect(off).not.toContain('plan feedback');
    const on = planFirstTurn({ ...BASE, planMode: true, planFeedback: 'nope' }).parts.map((p) => p.label);
    expect(on).toContain('plan feedback');
  });

  test('plan mode picks the plan prompt, not the execute prompt', () => {
    const executeText = joinedParts();
    const planMode = planFirstTurn({ ...BASE, planMode: true });
    const planText = planMode.parts.map((p) => p.body).join('');
    expect(planText).toContain('PLANNING MODE');
    expect(executeText).not.toContain('PLANNING MODE');
  });
});

describe('A-6 + H-1 prompt-cache invariant', () => {
  test('hashPrompt is stable and sensitive to a single byte', () => {
    expect(hashPrompt('abc')).toBe(hashPrompt('abc'));
    expect(hashPrompt('abc')).not.toBe(hashPrompt('abd'));
  });

  test('commit then verify passes on identical bytes', () => {
    const guard = createPromptCacheGuard();
    guard.commit('system v1');
    expect(() => guard.verify('system v1')).not.toThrow();
    expect(guard.hash).toBe(hashPrompt('system v1'));
  });

  test('verify trips on any mid-conversation rebuild', () => {
    const guard = createPromptCacheGuard();
    guard.commit('system v1');
    expect(() => guard.verify('system v1 ')).toThrow(/prompt-cache invariant violated/);
    expect(() => guard.verify('system v2')).toThrow(/prompt-cache invariant violated/);
  });

  test('verify without a commit behaves as a commit (continued conversations)', () => {
    const guard = createPromptCacheGuard();
    expect(guard.hash).toBeNull();
    expect(() => guard.verify('continued')).not.toThrow();
    expect(guard.hash).toBe(hashPrompt('continued'));
    expect(() => guard.verify('changed')).toThrow(/prompt-cache invariant violated/);
  });
});
