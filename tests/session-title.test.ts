import { describe, expect, test } from 'vitest';
import {
  SESSION_TITLE_MAX_WORDS,
  buildSessionTitlePrompt,
  cleanSessionTitle,
  generateSessionTitle,
} from '../src/lib/agent/session-title.js';
import type { Provider, ProviderEvent } from '../src/lib/providers/types.js';

function fakeProvider(chunks: string[] | Error): Provider {
  return {
    id: 'spycore' as const,
    createConversation: async () => 'conv-1',
    streamChat: async function* (): AsyncIterable<ProviderEvent> {
      if (chunks instanceof Error) {
        yield { type: 'error', message: chunks.message };
        return;
      }
      for (const c of chunks) yield { type: 'text', text: c };
      yield { type: 'done' };
    },
  } as Provider;
}

describe('cleanSessionTitle', () => {
  test('takes the first line and strips wrapping quotes', () => {
    expect(cleanSessionTitle('"Fix the login bug"\nSome extra chatter')).toBe('Fix the login bug');
  });

  test('drops trailing punctuation', () => {
    expect(cleanSessionTitle('Refactor auth middleware.')).toBe('Refactor auth middleware');
  });

  test('clips to the word cap', () => {
    const words = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    const out = cleanSessionTitle(words);
    expect(out?.split(' ').length).toBe(SESSION_TITLE_MAX_WORDS);
  });

  test('returns null for empty output', () => {
    expect(cleanSessionTitle('   \n  ')).toBeNull();
    expect(cleanSessionTitle('""')).toBeNull();
  });
});

describe('buildSessionTitlePrompt', () => {
  test('states the word cap and carries the task', () => {
    const p = buildSessionTitlePrompt('migrate the billing cron to bullmq');
    expect(p.system).toContain(String(SESSION_TITLE_MAX_WORDS));
    expect(p.message).toContain('migrate the billing cron to bullmq');
  });
});

describe('generateSessionTitle', () => {
  test('returns the cleaned model output', async () => {
    const t = await generateSessionTitle({
      provider: fakeProvider(['"Migrate billing cron to BullMQ"']),
      model: 'minos',
      task: 'migrate the billing cron to bullmq',
    });
    expect(t).toBe('Migrate billing cron to BullMQ');
  });

  test('fail-soft: error events and throws become null', async () => {
    expect(
      await generateSessionTitle({
        provider: fakeProvider(new Error('boom')),
        model: 'minos',
        task: 'something',
      }),
    ).toBeNull();
    const throwing: Provider = {
      id: 'spycore' as const,
      createConversation: async () => {
        throw new Error('offline');
      },
      streamChat: async function* (): AsyncIterable<ProviderEvent> {},
    } as Provider;
    expect(
      await generateSessionTitle({ provider: throwing, model: 'minos', task: 'something' }),
    ).toBeNull();
  });

  test('blank task short-circuits without touching the provider', async () => {
    let called = false;
    const p = fakeProvider(['x']);
    const orig = p.createConversation;
    p.createConversation = async (...a: Parameters<typeof orig>) => {
      called = true;
      return orig(...a);
    };
    expect(await generateSessionTitle({ provider: p, model: 'minos', task: '  ' })).toBeNull();
    expect(called).toBe(false);
  });
});
