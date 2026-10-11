/**
 * H-11 - the child's result is never dropped: with `output_schema`, a
 * validation failure is reported as `schema_valid: false` with the raw text
 * preserved verbatim - never an error, never an empty result.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  MAX_DELEGATE_DEPTH,
  validateChildOutputSchema,
  type DelegateChildResult,
  type Delegator,
} from '../src/lib/agent/delegate.js';
import { DEFAULT_LIMITS, dispatchTool, type ToolContext } from '../src/lib/agent/tools.js';

const childOk = (over: Partial<DelegateChildResult> = {}): DelegateChildResult => ({
  ok: true,
  finalText: '{"summary":"did the thing","files":["a.ts"]}',
  turns: 2,
  toolCalls: 3,
  tokensUsed: 1250,
  turnsUsed: 2,
  budgetStop: null,
  reachedMaxTurns: false,
  cancelled: false,
  stopNote: null,
  ...over,
});

const ctxWith = (finalText: string): ToolContext => {
  const delegator: Delegator = {
    depth: 0,
    maxDepth: MAX_DELEGATE_DEPTH,
    spawnChild: async () => childOk({ finalText }),
  };
  return { cwd: mkdtempSync(join(tmpdir(), 'spycode-h11-')), limits: DEFAULT_LIMITS, delegator };
};

const SCHEMA = JSON.stringify({ type: 'object', required: ['summary'] });

describe('H-11 validateChildOutputSchema (pure)', () => {
  test('valid JSON satisfying the schema passes', () => {
    expect(validateChildOutputSchema(SCHEMA, '{"summary":"x"}').valid).toBe(true);
  });

  test('fenced JSON is accepted', () => {
    expect(validateChildOutputSchema(SCHEMA, '```json\n{"summary":"x"}\n```').valid).toBe(true);
  });

  test('non-JSON fails with a reason', () => {
    const r = validateChildOutputSchema(SCHEMA, 'just prose');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('not valid JSON');
  });

  test('missing required keys fail with the key names', () => {
    const r = validateChildOutputSchema(SCHEMA, '{"other":1}');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('summary');
  });

  test('a non-object schema is rejected', () => {
    expect(validateChildOutputSchema('[1,2]', '{}').valid).toBe(false);
  });

  test('no required list means any JSON object passes', () => {
    expect(validateChildOutputSchema('{"type":"object"}', '{"a":1}').valid).toBe(true);
  });
});

describe('H-11 delegate tool: the result is never dropped', () => {
  test('a valid result reports schema_valid:true', async () => {
    const r = await dispatchTool(
      'delegate',
      { task: 't', output_schema: SCHEMA },
      ctxWith('{"summary":"did the thing"}'),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toContain('[schema_valid: true]');
    expect(r.content).toContain('"summary":"did the thing"');
  });

  test('an invalid result reports schema_valid:false AND keeps the raw text', async () => {
    const raw = 'I did the thing but forgot the JSON';
    const r = await dispatchTool('delegate', { task: 't', output_schema: SCHEMA }, ctxWith(raw));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('[schema_valid: false');
    // The raw text is preserved verbatim - the result was not dropped.
    expect(r.content).toContain(raw);
  });

  test('no schema means no schema block - the old shape is unchanged', async () => {
    const r = await dispatchTool('delegate', { task: 't' }, ctxWith('{"summary":"x"}'));
    expect(r.ok).toBe(true);
    expect(r.content).not.toContain('schema_valid');
  });
});
