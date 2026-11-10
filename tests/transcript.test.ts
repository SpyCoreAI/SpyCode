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

describe('transcript export (4c: server-controlled header fields)', () => {
  const base = {
    id: 'c_1',
    title: 'Test',
    model: 'test-model',
    createdAt: '2026-10-06T00:00:00Z',
  };

  test('a crafted title cannot inject markdown headings or newlines', () => {
    const md = conversationToMarkdown({
      ...base,
      title: 'Evil\n## Forged heading\n[click](https://example.com)',
      messages: [
        { role: 'user', content: 'hi', createdAt: '2026-10-06T00:00:01Z' },
      ],
    });
    const firstLine = md.split('\n')[0] as string;
    // The forged text is flattened into the H1 line - it never becomes
    // its own heading line.
    expect(md.split('\n')).not.toContain('## Forged heading');
    expect(md).not.toContain('\n## Forged heading\n');
    expect(firstLine.startsWith('# ')).toBe(true);
  });

  test('backticks in id/model cannot break out of the code span', () => {
    const md = conversationToMarkdown({
      ...base,
      id: 'c_1` + injected',
      model: 'model`x',
      messages: [
        {
          role: 'assistant',
          content: 'hi',
          model: 'model`x',
          createdAt: '2026-10-06T00:00:02Z',
        },
      ],
    });
    expect(md).not.toContain('` + injected');
    expect(md).not.toContain('model`x');
  });

  test('an overlong title is capped', () => {
    const md = conversationToMarkdown({
      ...base,
      title: 't'.repeat(500),
      messages: [],
    });
    const firstLine = md.split('\n')[0] as string;
    expect(firstLine.length).toBeLessThan(250);
    expect(firstLine).toContain('…');
  });

  test('a missing title/model renders empty instead of throwing (live export omits them)', () => {
    // The /save fixture (and the live export) can omit title/model even
    // though the type declares them strings; the exporter must not throw.
    const md = conversationToMarkdown({
      id: 'cnv_x',
      messages: [{ role: 'user', content: 'hi', createdAt: '2026-10-06T00:00:01Z' }],
    } as never);
    expect(md.split('\n')[0]).toBe('# (untitled)');
    expect(md).toContain('hi');
  });
});
