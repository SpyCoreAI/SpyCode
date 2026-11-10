import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import type { ProviderEvent } from '../src/lib/providers/types.js';

/**
 * H8 - a mid-stream error poisoned the Anthropic/Google session: the
 * adapters returned without appending the partial assistant message, while
 * the user message was already pushed. The next streamChat on the session
 * sent two user messages in a row and the API rejected it with 400.
 * Errored turns now settle the history - partial assistant reply kept when
 * one exists, otherwise the user message rolled back - so the next turn
 * always sends alternating roles.
 */
interface CapturedRequest {
  url: string;
  body?: string | undefined;
}
let requests: CapturedRequest[] = [];
let responder:
  | ((url: string) => { statusCode: number; headers: Record<string, string>; body: unknown })
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { body?: string } = {}) => {
    requests.push({ url, body: init.body });
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url);
  }),
}));

beforeEach(() => {
  freshConfigDir();
  requests = [];
  responder = null;
});
afterEach(() => {
  vi.resetModules();
});

function sseResp(lines: string[]) {
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: Readable.from([Buffer.from(lines.join(''), 'utf8')]),
  };
}

async function collect(stream: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const ev = (name: string, data: unknown): string =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

function anthropicSse(deltas: string[]) {
  return sseResp([
    ev('message_start', { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }),
    ...deltas.map((t) =>
      ev('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: t } }),
    ),
    ev('message_delta', { type: 'message_delta', usage: { output_tokens: 1 } }),
    ev('message_stop', { type: 'message_stop' }),
  ]);
}

function googleSse(deltas: string[]) {
  const chunk = (text: string): string =>
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
  return sseResp(deltas.map(chunk));
}

const lastBody = (): Record<string, unknown> =>
  JSON.parse(requests[requests.length - 1]?.body ?? '{}') as Record<string, unknown>;

describe('AnthropicProvider: errored turn settles the session', () => {
  const make = async () => {
    const { AnthropicProvider } = await import('../src/lib/providers/anthropic.js');
    return new AnthropicProvider({ baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-SECRET' });
  };

  test('mid-stream error event keeps the partial reply; next turn alternates', async () => {
    responder = () =>
      sseResp([
        ev('content_block_delta', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial' } }),
        ev('error', { type: 'error', error: { message: 'overloaded' } }),
      ]);
    const p = await make();
    const id = await p.createConversation({ model: 'm' });
    const first = await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }));
    expect(first[0]).toEqual({ type: 'text', text: 'partial' });
    expect(first[first.length - 1]?.type).toBe('error');

    responder = () => anthropicSse(['second-reply']);
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    expect(lastBody().messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'partial' },
      { role: 'user', content: 'second' },
    ]);
  });

  test('HTTP 400 before any reply rolls the user message back; next turn is clean', async () => {
    responder = () => ({
      statusCode: 400,
      headers: {},
      body: { text: async () => JSON.stringify({ error: { message: 'bad request' } }) },
    });
    const p = await make();
    const id = await p.createConversation({ model: 'm' });
    const first = await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }));
    expect(first[0]?.type).toBe('error');

    responder = () => anthropicSse(['second-reply']);
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    expect(lastBody().messages).toEqual([{ role: 'user', content: 'second' }]);
  });

  test('a 302 redirect and a non-SSE 200 body are errors, not empty turns', async () => {
    const p = await make();
    const id = await p.createConversation({ model: 'm' });

    responder = () => ({ statusCode: 302, headers: { location: 'https://elsewhere.example/x' }, body: { text: async () => '' } });
    const redirected = await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }));
    expect(redirected[0]?.type).toBe('error');
    expect(redirected[0]).toMatchObject({ message: expect.stringContaining('302') });

    responder = () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Readable.from([Buffer.from('<html>proxy error page</html>', 'utf8')]),
    });
    const html = await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    expect(html[0]?.type).toBe('error');
    expect(html[0]).toMatchObject({ message: expect.stringContaining('text/html') });

    // Both turns failed before any reply, so the history is still clean.
    responder = () => anthropicSse(['third-reply']);
    await collect(p.streamChat({ conversationId: id, message: 'third', model: 'm' }));
    expect(lastBody().messages).toEqual([{ role: 'user', content: 'third' }]);
  });
});

describe('GoogleProvider: errored turn settles the session', () => {
  const make = async () => {
    const { GoogleProvider } = await import('../src/lib/providers/google.js');
    return new GoogleProvider({ baseURL: 'https://generativelanguage.googleapis.com', apiKey: 'SECRET' });
  };

  test('mid-stream error object keeps the partial reply; next turn alternates', async () => {
    responder = () =>
      sseResp([
        `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'partial' }] } }] })}\n\n`,
        `data: ${JSON.stringify({ error: { message: 'internal' } })}\n\n`,
      ]);
    const p = await make();
    const id = await p.createConversation({ model: 'm' });
    const first = await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }));
    expect(first[0]).toEqual({ type: 'text', text: 'partial' });
    expect(first[first.length - 1]?.type).toBe('error');

    responder = () => googleSse(['second-reply']);
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    const contents = lastBody().contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents.map((c) => [c.role, c.parts[0]?.text])).toEqual([
      ['user', 'first'],
      ['model', 'partial'],
      ['user', 'second'],
    ]);
  });

  test('a 302 redirect and a non-SSE 200 body are errors, not empty turns', async () => {
    const p = await make();
    const id = await p.createConversation({ model: 'm' });

    responder = () => ({ statusCode: 302, headers: { location: 'https://elsewhere.example/x' }, body: { text: async () => '' } });
    const redirected = await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }));
    expect(redirected[0]?.type).toBe('error');
    expect(redirected[0]).toMatchObject({ message: expect.stringContaining('302') });

    responder = () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Readable.from([Buffer.from('<html>proxy error page</html>', 'utf8')]),
    });
    const html = await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    expect(html[0]?.type).toBe('error');
    expect(html[0]).toMatchObject({ message: expect.stringContaining('text/html') });

    responder = () => googleSse(['third-reply']);
    await collect(p.streamChat({ conversationId: id, message: 'third', model: 'm' }));
    const contents = lastBody().contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents.map((c) => [c.role, c.parts[0]?.text])).toEqual([['user', 'third']]);
  });
});

describe('OpenAICompatibleProvider: errored turn settles the session too', () => {
  const make = async () => {
    const { OpenAICompatibleProvider } = await import('../src/lib/providers/openai-compatible.js');
    return new OpenAICompatibleProvider({ baseURL: 'https://local.example', apiKey: 'SECRET' });
  };

  test('HTTP 400 before any reply rolls the user message back; next turn is clean', async () => {
    responder = () => ({
      statusCode: 400,
      headers: {},
      body: { text: async () => JSON.stringify({ error: { message: 'bad request' } }) },
    });
    const p = await make();
    const id = await p.createConversation({ model: 'm' });
    const first = await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }));
    expect(first[0]?.type).toBe('error');

    responder = () =>
      sseResp([
        'data: {"choices":[{"delta":{"content":"second-reply"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    expect(lastBody().messages).toEqual([{ role: 'user', content: 'second' }]);
  });

  test('stream that throws mid-way keeps the partial reply; next turn alternates', async () => {
    responder = () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: (async function* () {
        yield Buffer.from('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 'utf8');
        throw new Error('connection reset');
      })(),
    });
    const p = await make();
    const id = await p.createConversation({ model: 'm' });
    const first = await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }));
    expect(first[0]).toEqual({ type: 'text', text: 'partial' });
    expect(first[first.length - 1]?.type).toBe('error');

    responder = () =>
      sseResp([
        'data: {"choices":[{"delta":{"content":"second-reply"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    expect(lastBody().messages).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'partial' },
      { role: 'user', content: 'second' },
    ]);
  });

  test('a 302 redirect and a non-SSE 200 body are errors, not empty turns', async () => {
    const p = await make();
    const id = await p.createConversation({ model: 'm' });

    responder = () => ({ statusCode: 302, headers: { location: 'https://elsewhere.example/x' }, body: { text: async () => '' } });
    const redirected = await collect(p.streamChat({ conversationId: id, message: 'first', model: 'm' }));
    expect(redirected[0]?.type).toBe('error');
    expect(redirected[0]).toMatchObject({ message: expect.stringContaining('302') });

    responder = () => ({
      statusCode: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: Readable.from([Buffer.from('<html>proxy error page</html>', 'utf8')]),
    });
    const html = await collect(p.streamChat({ conversationId: id, message: 'second', model: 'm' }));
    expect(html[0]?.type).toBe('error');
    expect(html[0]).toMatchObject({ message: expect.stringContaining('text/html') });

    responder = () =>
      sseResp([
        'data: {"choices":[{"delta":{"content":"third-reply"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    await collect(p.streamChat({ conversationId: id, message: 'third', model: 'm' }));
    expect(lastBody().messages).toEqual([{ role: 'user', content: 'third' }]);
  });
});
