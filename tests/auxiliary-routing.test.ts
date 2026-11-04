/**
 * H-17 - auxiliary routing: every auxiliary LLM job gets its own pinned
 * provider/model. The session title keeps its minos pin (now sourced from
 * the table - one source of truth); skill generation gets its own pin.
 */
import { describe, expect, test } from 'vitest';
import { AUXILIARY_ROUTES, resolveAuxiliaryModel } from '../src/lib/agent/auxiliary-routing.js';
import { SESSION_TITLE_MODEL } from '../src/lib/agent/session-title.js';

describe('H-17 auxiliary routing', () => {
  test('every job has a pinned SpyCore model and a reason', () => {
    for (const [job, route] of Object.entries(AUXILIARY_ROUTES)) {
      expect(route.spycoreModel.length, `${job}: model`).toBeGreaterThan(0);
      expect(route.why.length, `${job}: why`).toBeGreaterThan(0);
    }
    expect(Object.keys(AUXILIARY_ROUTES).sort()).toEqual(['compaction-summary', 'session-title', 'skill-generation']);
  });

  test('H-9: the compaction-summary pin is minos (cheap compression, not reasoning)', () => {
    expect(AUXILIARY_ROUTES['compaction-summary'].spycoreModel).toBe('minos');
    expect(resolveAuxiliaryModel('compaction-summary', 'spycore', 'charon')).toBe('minos');
  });

  test('the session-title pin is still minos, from the table', () => {
    expect(SESSION_TITLE_MODEL).toBe('minos');
    expect(SESSION_TITLE_MODEL).toBe(AUXILIARY_ROUTES['session-title'].spycoreModel);
  });

  test('on the SpyCore provider the pin wins over the fallback', () => {
    expect(resolveAuxiliaryModel('session-title', 'spycore', 'charon')).toBe('minos');
    expect(resolveAuxiliaryModel('skill-generation', 'spycore', 'charon')).toBe('hermes');
  });

  test('on a BYOK provider the caller model is kept (a SpyCore slug is meaningless there)', () => {
    expect(resolveAuxiliaryModel('session-title', 'openai', 'gpt-4o')).toBe('gpt-4o');
    expect(resolveAuxiliaryModel('skill-generation', 'anthropic', 'claude-x')).toBe('claude-x');
  });
});
