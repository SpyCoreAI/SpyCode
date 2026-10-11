import { describe, expect, test } from 'vitest';
import {
  agentModelFor,
  CHAT_MODES,
  DEFAULT_CHAT_MODE,
  isChatMode,
  modeSwitchBlockedReason,
  nextChatMode,
} from '../src/lib/chat-mode.js';

describe('chat modes', () => {
  test('the mode set and the default', () => {
    expect(CHAT_MODES).toEqual(['ask', 'plan', 'agent']);
    expect(DEFAULT_CHAT_MODE).toBe('ask');
  });

  test('isChatMode accepts exactly the three modes', () => {
    expect(isChatMode('ask')).toBe(true);
    expect(isChatMode('plan')).toBe(true);
    expect(isChatMode('agent')).toBe(true);
    expect(isChatMode('')).toBe(false);
    expect(isChatMode('ASK')).toBe(false);
    expect(isChatMode('auto')).toBe(false);
  });

  test('nextChatMode cycles ask → plan → agent → ask', () => {
    expect(nextChatMode('ask')).toBe('plan');
    expect(nextChatMode('plan')).toBe('agent');
    expect(nextChatMode('agent')).toBe('ask');
  });
});

describe('modeSwitchBlockedReason', () => {
  test('no run active → allowed', () => {
    expect(modeSwitchBlockedReason(false)).toBeNull();
  });

  test('run active → blocked with the default action label', () => {
    const msg = modeSwitchBlockedReason(true);
    expect(msg).toBe('A run is in progress - mode switching is disabled until it finishes.');
  });

  test('run active → custom action label is interpolated', () => {
    const msg = modeSwitchBlockedReason(true, '/compact');
    expect(msg).toBe('A run is in progress - /compact is disabled until it finishes.');
  });
});

describe('agentModelFor', () => {
  test('agent slugs pass through unclamped', () => {
    for (const m of ['charon', 'styx', 'hermes', 'minos'] as const) {
      expect(agentModelFor(m)).toEqual({ model: m, clamped: false });
    }
  });

  test('styx_max clamps to styx', () => {
    expect(agentModelFor('styx_max')).toEqual({ model: 'styx', clamped: true });
  });

  test('hephaestus (unreachable in chat) clamps defensively', () => {
    expect(agentModelFor('hephaestus')).toEqual({ model: 'styx', clamped: true });
  });
});
