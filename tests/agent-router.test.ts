import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import {
  parseTier,
  resolveAllowedModels,
  clampModel,
  routingLine,
  routeAgentModel,
  resolvePlanMode,
} from '../src/lib/agent/router.js';
import type { AgentModelSlug } from '../src/lib/agent/loop.js';

// ───────────────────────── pure helpers ─────────────────────────

describe('parseTier', () => {
  test('reads STANDARD / COMPLEX, case-insensitive, anywhere', () => {
    expect(parseTier('COMPLEX')).toBe('complex');
    expect(parseTier('standard')).toBe('standard');
    expect(parseTier('This looks COMPLEX to me')).toBe('complex');
    expect(parseTier('Answer: Standard.')).toBe('standard');
  });
  test('returns null when neither word is present', () => {
    expect(parseTier("I'm Hermes, how can I help?")).toBeNull();
    expect(parseTier('')).toBeNull();
  });
});

describe('resolveAllowedModels', () => {
  test('free → HERMES only', () => {
    expect([...(resolveAllowedModels('free') ?? [])]).toEqual(['hermes']);
    expect(resolveAllowedModels('free_trial')?.has('styx')).toBe(false);
  });
  test('paid plans → all models', () => {
    for (const p of ['starter', 'pro', 'max', 'team']) {
      const a = resolveAllowedModels(p);
      expect(a?.has('styx')).toBe(true);
      expect(a?.has('charon')).toBe(true);
    }
  });
  test('unknown plan → null (no clamp)', () => {
    expect(resolveAllowedModels(undefined)).toBeNull();
  });
});

describe('clampModel', () => {
  const all = new Set<AgentModelSlug>(['hermes', 'minos', 'styx', 'charon']);
  const free = new Set<AgentModelSlug>(['hermes']);
  test('free clamps everything to HERMES', () => {
    expect(clampModel('charon', free)).toBe('hermes');
    expect(clampModel('styx', free)).toBe('hermes');
  });
  test('allowed model passes through; null = no clamp', () => {
    expect(clampModel('charon', all)).toBe('charon');
    expect(clampModel('styx', all)).toBe('styx');
    expect(clampModel('charon', null)).toBe('charon');
  });
  test('clamps down to the most capable allowed model below the pick', () => {
    expect(clampModel('charon', new Set<AgentModelSlug>(['hermes', 'minos', 'styx']))).toBe('styx');
  });
});

describe('resolvePlanMode', () => {
  test('--plan forces on, --no-plan forces off, else auto-on for complex', () => {
    expect(resolvePlanMode(undefined, 'complex')).toBe(true);
    expect(resolvePlanMode(undefined, 'standard')).toBe(false);
    expect(resolvePlanMode(undefined, null)).toBe(false);
    expect(resolvePlanMode(true, 'standard')).toBe(true); // --plan forces a standard task on
    expect(resolvePlanMode(false, 'complex')).toBe(false); // --no-plan forces a complex task off
  });
});

describe('routingLine', () => {
  test('formats triage vs override, identity-safe', () => {
    expect(routingLine({ model: 'styx', reason: 'coding task', viaOverride: false })).toBe(
      'Routing → Styx (coding task)',
    );
    expect(routingLine({ model: 'charon', reason: '--model', viaOverride: true })).toBe(
      'Model: Charon (--model)',
    );
  });
});

// ───────────────────────── routeAgentModel (mocked network) ─────────────────────────

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown>; [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> };
}
let responder: ((url: string, init: { method: string }) => MockResp) | null = null;
let chatCalls = 0;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET' });
  }),
}));

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}
function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: { json: async () => ({}), [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator]() },
  };
}

/** Responder for triage: conversation create + a classifier reply. */
function classifierResponder(reply: string | 'error') {
  return (url: string, init: { method: string }) => {
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return jsonResp(200, { success: true, data: { id: 'cnv_triage' } });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      chatCalls += 1;
      return reply === 'error'
        ? sseResp([{ type: 'error', message: 'boom' }])
        : sseResp([{ type: 'text', content: reply }, { type: 'done' }]);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  chatCalls = 0;
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});
afterEach(() => {
  vi.resetModules();
});

describe('routeAgentModel', () => {
  test('--model override skips triage entirely', async () => {
    responder = () => {
      throw new Error('triage must not run for an explicit --model');
    };
    const d = await routeAgentModel({ explicitModel: 'charon', task: 'whatever' });
    expect(d).toEqual({ model: 'charon', reason: '--model', viaOverride: true, tier: null });
    expect(chatCalls).toBe(0);
  });

  test('standard task → STYX', async () => {
    responder = classifierResponder('STANDARD');
    const d = await routeAgentModel({ task: 'add a flag to the CLI', plan: 'starter' });
    expect(d.model).toBe('styx');
    expect(d.reason).toBe('coding task');
    expect(d.viaOverride).toBe(false);
    expect(chatCalls).toBe(1);
  });

  test('complex task → CHARON', async () => {
    responder = classifierResponder('COMPLEX');
    const d = await routeAgentModel({ task: 'refactor the whole module', plan: 'pro' });
    expect(d.model).toBe('charon');
    expect(d.reason).toBe('complex task');
  });

  test('triage failure falls back to STYX', async () => {
    responder = classifierResponder('error');
    const d = await routeAgentModel({ task: 'do a thing', plan: 'starter' });
    expect(d.model).toBe('styx');
    expect(d.reason).toBe('default');
  });

  test('free plan clamps a CHARON pick down to HERMES', async () => {
    responder = classifierResponder('COMPLEX');
    const d = await routeAgentModel({ task: 'big refactor', plan: 'free' });
    expect(d.model).toBe('hermes');
    expect(d.reason).toMatch(/limited by plan/);
  });

  test('fetches the plan from whoami when not supplied (free → HERMES)', async () => {
    responder = (url, init) => {
      if (init.method === 'GET' && url.includes('/auth/cli/whoami')) {
        return jsonResp(200, { success: true, data: { plan: 'free', planDisplay: 'Free' } });
      }
      return classifierResponder('COMPLEX')(url, init);
    };
    const d = await routeAgentModel({ task: 'big refactor' });
    expect(d.model).toBe('hermes');
  });
});
