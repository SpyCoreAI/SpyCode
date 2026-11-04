import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';

/**
 * PHASE-1 1.8 - /compact: in-place conversation condense over the EXISTING
 * `POST /api/conversations/:id/summarize` endpoint (uncharged, gated).
 *
 * Pinned here:
 *  - registry surface: SLASH_HELP row + the `compact-flow` control signal;
 *  - the REWRITTEN INVARIANT in the confirm-gated preview copy: nothing is
 *    DELETED - archived flag only, same conversation id, recoverable;
 *  - happy path: summarize called with the RIGHT conversation id and an
 *    empty body (ratio handling = the server's own 0.8 default), success
 *    notice carries archivedCount + a summary snippet;
 *  - cancel at the preview: ZERO server calls - state byte-identical;
 *  - failure paths (403 / 400 "too short" / 429 rate limit / network):
 *    clean error notice, nothing thrown out of the flow, state unchanged;
 *  - mid-run block through the 1.7 helper (modeSwitchBlockedReason), with
 *    the 1.7 default wording byte-identical;
 *  - one-shot /compact prints the TUI pointer (TUI-only v1).
 */

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}
type MockResp = { statusCode: number; headers: Record<string, string | string[]>; body: { json: () => Promise<unknown> } };
let responder: ((url: string, init: { method: string }) => MockResp) | null = null;
let calls: CapturedCall[] = [];

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    const captured = {
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
    };
    calls.push(captured);
    return responder(url, captured);
  }),
}));

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

interface NotifyRecord {
  kind: string;
  text: string;
}

function fakeIo(answer: string): {
  notices: NotifyRecord[];
  asked: string[];
  io: { notify: (kind: 'info' | 'success' | 'warning' | 'error', text: string) => void; ask: (q: string) => Promise<string> };
} {
  const notices: NotifyRecord[] = [];
  const asked: string[] = [];
  return {
    notices,
    asked,
    io: {
      notify: (kind, text) => void notices.push({ kind, text }),
      ask: async (q) => {
        asked.push(q);
        return answer;
      },
    },
  };
}

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  calls = [];
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  vi.resetModules();
});

// ───────────────────────── registry surface ─────────────────────────

describe('/compact registry surface', () => {
  test('registered in SLASH_HELP with the archived-recoverable wording', async () => {
    const { SLASH_HELP } = await import('../src/lib/slash/registry.js');
    const row = SLASH_HELP.find((e) => e.command === '/compact');
    expect(row).toBeDefined();
    expect(row!.summary).toContain('archived');
    expect(row!.summary).toContain('recoverable');
  });

  test('runSlashCommand → the compact-flow control signal (surface-owned)', async () => {
    const { runSlashCommand } = await import('../src/lib/slash/registry.js');
    const outcome = await runSlashCommand('compact', [], {
      cwd: process.cwd(),
      model: 'hermes',
      effort: 'auto',
      conversationId: 'cnv_x',
      apiUrl: undefined,
      injectGuide: true,
      injectChangelog: true,
    });
    expect(outcome).toEqual({ kind: 'compact-flow' });
  });

  test('one-shot /compact prints the interactive-session pointer (TUI-only v1)', async () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      chunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { handleSlashCommand } = await import('../src/commands/chat.js');
      const r = await handleSlashCommand('/compact', {
        json: false,
        color: false,
        currentConvo: 'cnv_x',
        apiUrl: undefined,
      });
      expect(r.consumed).toBe(true);
    } finally {
      process.stderr.write = orig;
    }
    const out = chunks.join('');
    expect(out).toContain('spycore chat');
    expect(out).toContain('/compact');
    expect(out).toContain('archived and recoverable');
    // No server call from the pointer path.
    expect(calls).toHaveLength(0);
  });
});

// ───────────────────────── the flow core ─────────────────────────

describe('runCompactFlow - preview invariant + happy path', () => {
  test('the confirm-gated preview states the REWRITTEN invariant verbatim', async () => {
    const { COMPACT_PREVIEW_TEXT } = await import('../src/lib/slash/compact-flow.js');
    expect(COMPACT_PREVIEW_TEXT).toContain('Nothing is deleted');
    expect(COMPACT_PREVIEW_TEXT).toContain('archived');
    expect(COMPACT_PREVIEW_TEXT).toContain('recoverable');
    expect(COMPACT_PREVIEW_TEXT).toContain('continues in place');
    expect(COMPACT_PREVIEW_TEXT).toContain('same id');
    expect(COMPACT_PREVIEW_TEXT).toContain('~80%');
  });

  test('yes → POST /conversations/:id/summarize with an EMPTY body; success notice carries archivedCount + snippet', async () => {
    responder = (url, init) => {
      if (url.endsWith('/conversations/cnv_42/summarize') && init.method === 'POST') {
        return jsonResp(201, {
          success: true,
          data: {
            summaryMessageId: 'msg_sum',
            summary: 'The user explored the fixture project and fixed two bugs.',
            archivedCount: 12,
          },
        });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    const h = fakeIo('y');
    const { runCompactFlow, COMPACT_PREVIEW_TEXT } = await import('../src/lib/slash/compact-flow.js');
    const result = await runCompactFlow({ conversationId: 'cnv_42', io: h.io });

    expect(result).toEqual({ compacted: true, archivedCount: 12 });
    // Exactly one server call, to the RIGHT conversation id…
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/conversations\/cnv_42\/summarize$/);
    expect(calls[0]!.method).toBe('POST');
    // …with an empty JSON body - ratio handling is the server's 0.8 default.
    expect(JSON.parse(String(calls[0]!.body))).toEqual({});
    // Preview shown before the ask; success notice carries count + snippet.
    expect(h.notices[0]).toEqual({ kind: 'info', text: COMPACT_PREVIEW_TEXT });
    expect(h.asked).toHaveLength(1);
    const success = h.notices.find((n) => n.kind === 'success');
    expect(success).toBeDefined();
    expect(success!.text).toContain('12 messages archived (recoverable)');
    expect(success!.text).toContain('continues in place');
    expect(success!.text).toContain('fixed two bugs');
  });

  test('cancel at the preview → ZERO server calls, state byte-identical', async () => {
    responder = () => {
      throw new Error('no call may happen on cancel');
    };
    const h = fakeIo('n');
    const { runCompactFlow } = await import('../src/lib/slash/compact-flow.js');
    const result = await runCompactFlow({ conversationId: 'cnv_42', io: h.io });
    expect(result).toEqual({ compacted: false });
    expect(calls).toHaveLength(0);
    expect(h.notices.some((n) => n.text.includes('nothing changed'))).toBe(true);
    // Esc in the TUI resolves the choice to 'c' - also a cancel.
    const h2 = fakeIo('c');
    const r2 = await runCompactFlow({ conversationId: 'cnv_42', io: h2.io });
    expect(r2.compacted).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('runCompactFlow - failure paths (clean errors, state unchanged)', () => {
  const failCase = async (resp: MockResp): Promise<NotifyRecord[]> => {
    responder = () => resp;
    const h = fakeIo('yes');
    const { runCompactFlow } = await import('../src/lib/slash/compact-flow.js');
    const result = await runCompactFlow({ conversationId: 'cnv_42', io: h.io });
    expect(result).toEqual({ compacted: false });
    return h.notices;
  };

  test('403 (waitlisted / plan gate) → clean error notice, no throw', async () => {
    const notices = await failCase(jsonResp(403, { success: false, error: 'Access not yet enabled', code: 'waitlisted' }));
    const err = notices.find((n) => n.kind === 'error');
    expect(err).toBeDefined();
    expect(err!.text).toContain('Compact failed:');
    expect(err!.text).toContain('Permission denied');
    expect(err!.text).toContain('Access not yet enabled');
  });

  test('400 "too short" → the server message surfaces verbatim', async () => {
    const notices = await failCase(jsonResp(400, { success: false, error: 'Conversation is too short to summarize' }));
    const err = notices.find((n) => n.kind === 'error');
    expect(err!.text).toContain('Conversation is too short to summarize');
  });

  test('429 rate limit (the new 10/hour route limit) → clean rate-limit error', async () => {
    const notices = await failCase(jsonResp(429, { success: false, error: 'Rate limit exceeded, retry in 1 hour' }));
    const err = notices.find((n) => n.kind === 'error');
    expect(err!.text).toContain('Rate limit exceeded');
  });

  test('network failure → clean error, nothing thrown out of the flow', async () => {
    responder = () => {
      throw new Error('socket hang up');
    };
    const h = fakeIo('y');
    const { runCompactFlow } = await import('../src/lib/slash/compact-flow.js');
    const result = await runCompactFlow({ conversationId: 'cnv_42', io: h.io });
    expect(result).toEqual({ compacted: false });
    const err = h.notices.find((n) => n.kind === 'error');
    expect(err).toBeDefined();
    expect(err!.text).toContain('Compact failed:');
  });
});

// ───────────────────────── mid-run gate (1.7 helper) ─────────────────────────

describe('mid-run /compact - blocked through modeSwitchBlockedReason', () => {
  test('active run → the /compact-labeled block message; idle → null', async () => {
    const { modeSwitchBlockedReason } = await import('../src/lib/chat-mode.js');
    expect(modeSwitchBlockedReason(true, '/compact')).toBe(
      'A run is in progress - /compact is disabled until it finishes.',
    );
    expect(modeSwitchBlockedReason(false, '/compact')).toBeNull();
  });

  test('the 1.7 default wording stays byte-identical (no caller drift)', async () => {
    const { modeSwitchBlockedReason } = await import('../src/lib/chat-mode.js');
    expect(modeSwitchBlockedReason(true)).toBe(
      'A run is in progress - mode switching is disabled until it finishes.',
    );
  });
});
