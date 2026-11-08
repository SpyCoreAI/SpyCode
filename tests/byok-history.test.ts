import { describe, expect, test } from 'vitest';
import {
  MAX_BYOK_HISTORY_MESSAGES,
  MAX_BYOK_SESSIONS,
  BYOK_SESSION_IDLE_MS,
  pruneByokSessions,
  trimHistoryMessages,
} from '../src/lib/providers/history.js';

type Msg = { role: 'user' | 'assistant'; content: string };
const msg = (role: 'user' | 'assistant', n: number): Msg => ({ role, content: `m${n}` });

describe('trimHistoryMessages', () => {
  test('a short history is untouched', () => {
    const h = [msg('user', 1), msg('assistant', 2)];
    trimHistoryMessages(h);
    expect(h).toHaveLength(2);
  });

  test('trims the oldest pair first and never drops the last message', () => {
    // MAX + 4 trims by exactly two pairs, landing on MAX.
    const h: Msg[] = [];
    for (let i = 0; i < MAX_BYOK_HISTORY_MESSAGES + 4; i += 1) {
      h.push(msg(i % 2 === 0 ? 'user' : 'assistant', i));
    }
    trimHistoryMessages(h);
    expect(h).toHaveLength(MAX_BYOK_HISTORY_MESSAGES);
    // The first surviving message is the third pair's user turn, and the
    // newest message (the last one pushed) is still there.
    expect(h[0]).toEqual(msg('user', 4));
    expect(h[h.length - 1]).toEqual(msg('assistant', MAX_BYOK_HISTORY_MESSAGES + 3));
  });

  test('keeps user/assistant alternation after trimming', () => {
    const h: Msg[] = [];
    for (let i = 0; i < MAX_BYOK_HISTORY_MESSAGES + 2; i += 1) {
      h.push(msg(i % 2 === 0 ? 'user' : 'assistant', i));
    }
    trimHistoryMessages(h);
    for (let i = 1; i < h.length; i += 1) {
      expect(h[i]!.role).not.toBe(h[i - 1]!.role);
    }
  });
});

describe('pruneByokSessions', () => {
  test('prunes idle sessions past the cap, oldest first', () => {
    const sessions = new Map<string, unknown>();
    const lastUsed = new Map<string, number>();
    const now = Date.now();
    for (let i = 0; i < MAX_BYOK_SESSIONS + 3; i += 1) {
      sessions.set(`s${i}`, {});
      lastUsed.set(`s${i}`, now - (MAX_BYOK_SESSIONS + 3 - i) * 1000);
    }
    pruneByokSessions(sessions, lastUsed);
    expect(sessions.size).toBe(MAX_BYOK_SESSIONS);
    expect(sessions.has('s0')).toBe(false);
    expect(sessions.has('s2')).toBe(false);
    expect(sessions.has(`s${MAX_BYOK_SESSIONS + 2}`)).toBe(true);
    expect(lastUsed.has('s0')).toBe(false);
  });

  test('an idle session past BYOK_SESSION_IDLE_MS is pruned even under the cap', () => {
    const sessions = new Map<string, unknown>([['old', {}], ['new', {}]]);
    const lastUsed = new Map<string, number>([
      ['old', Date.now() - BYOK_SESSION_IDLE_MS - 1000],
      ['new', Date.now()],
    ]);
    pruneByokSessions(sessions, lastUsed);
    expect([...sessions.keys()]).toEqual(['new']);
  });

  test('a session at the cap is left alone', () => {
    const sessions = new Map<string, unknown>();
    const lastUsed = new Map<string, number>();
    for (let i = 0; i < MAX_BYOK_SESSIONS; i += 1) {
      sessions.set(`s${i}`, {});
      lastUsed.set(`s${i}`, Date.now());
    }
    pruneByokSessions(sessions, lastUsed);
    expect(sessions.size).toBe(MAX_BYOK_SESSIONS);
  });
});
