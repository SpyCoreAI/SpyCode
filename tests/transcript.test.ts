import { describe, expect, test } from 'vitest';
import { conversationToMarkdown } from '../src/lib/transcript.js';
import { REDACTED } from '../src/lib/redact.js';

describe('transcript export (S2: secret redaction)', () => {
  const base = {
    id: 'c_1',
    title: 'Test',
    model: 'test-model',
    createdAt: '2026-10-06T00:00:00Z',
  };

  test('redacts API keys in message content', () => {
    const md = conversationToMarkdown({
      ...base,
      messages: [
        {
          role: 'user',
          content: 'my key is sk-abcdefghijklmnop123456',
          createdAt: '2026-10-06T00:00:01Z',
        },
      ],
    });
    expect(md).not.toContain('sk-abcdefghijklmnop123456');
    expect(md).toContain(REDACTED);
  });

  test('redacts Bearer tokens in assistant messages', () => {
    const md = conversationToMarkdown({
      ...base,
      messages: [
        {
          role: 'assistant',
          content: 'use Bearer abcdef1234567890XYZ for auth',
          model: 'test-model',
          createdAt: '2026-10-06T00:00:02Z',
        },
      ],
    });
    expect(md).not.toContain('abcdef1234567890XYZ');
  });

  test('leaves normal conversation intact', () => {
    const md = conversationToMarkdown({
      ...base,
      messages: [
        {
          role: 'user',
          content: 'How do I write a for loop in Python?',
          createdAt: '2026-10-06T00:00:01Z',
        },
        {
          role: 'assistant',
          content: 'Here is an example:\n```python\nfor i in range(10):\n    print(i)\n```',
          model: 'test-model',
          createdAt: '2026-10-06T00:00:02Z',
        },
      ],
    });
    expect(md).toContain('How do I write a for loop in Python?');
    expect(md).toContain('for i in range(10):');
    expect(md).not.toContain(REDACTED);
  });
});
