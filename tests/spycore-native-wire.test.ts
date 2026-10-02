import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';
import type { ProviderEvent } from '../src/lib/providers/types.js';

/**
 * SpyCoreProvider native-tool-use wire, against a mocked undici (same harness
 * style as the other provider tests): capability capture at createConversation,
 * tools in the body, the two new SSE events mapped through, and a tool-result
 * continuation that OMITS `message` on the wire.
 */
interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown>; [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> };
}
let responder: ((url: string) => MockResp) | null = null;
const captured: Array<{ url: string; body?: unknown }> = [];

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
    captured.push({ url, body: init.body });
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url);
  }),
}));

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  captured.length = 0;
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});
afterEach(() => {
  vi.resetModules();
});

function jsonResp(body: unknown): MockResp {
  return { statusCode: 200, headers: {}, body: { json: async () => body } };
}
function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: { json: async () => ({}), [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator]() },
  };
}
const lastBody = (): Record<string, unknown> => JSON.parse(String(captured.at(-1)!.body)) as Record<string, unknown>;

describe('SpyCoreProvider — native tool-use wire', () => {
  test('createConversation captures capabilities.nativeTools', async () => {
    responder = () => jsonResp({ success: true, data: { id: 'cnv_1', capabilities: { nativeTools: true } } });
    const { SpyCoreProvider } = await import('../src/lib/providers/spycore.js');
    const p = new SpyCoreProvider();
    const id = await p.createConversation({ model: 'styx' });
    expect(id).toBe('cnv_1');
    expect(p.supportsNativeTools(id)).toBe(true);
  });

  test('missing capabilities → not native (old server)', async () => {
    responder = () => jsonResp({ success: true, data: { id: 'cnv_2' } });
    const { SpyCoreProvider } = await import('../src/lib/providers/spycore.js');
    const p = new SpyCoreProvider();
    const id = await p.createConversation({ model: 'styx' });
    expect(p.supportsNativeTools(id)).toBe(false);
  });

  test('streamChat sends tools and maps tool_call_started + tool_calls', async () => {
    responder = (url) =>
      url.includes('/api/chat/stream')
        ? sseResp([
            { type: 'tool_call_started', index: 0, name: 'read_file' },
            { type: 'tool_calls', calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }] },
            { type: 'usage', input: 5, output: 2 },
            { type: 'done' },
          ])
        : jsonResp({ success: true, data: { id: 'x' } });
    const { SpyCoreProvider } = await import('../src/lib/providers/spycore.js');
    const p = new SpyCoreProvider();
    const out: ProviderEvent[] = [];
    for await (const e of p.streamChat({
      conversationId: 'c',
      message: 'go',
      model: 'styx',
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
    })) {
      out.push(e);
    }
    const body = lastBody();
    expect(body.tools).toHaveLength(1);
    expect(body.message).toBe('go');
    expect(out.find((e) => e.type === 'tool_call_started')).toMatchObject({ index: 0, name: 'read_file' });
    expect(out.find((e) => e.type === 'tool_calls')).toMatchObject({
      calls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }],
    });
    expect(out.find((e) => e.type === 'usage')).toMatchObject({ input: 5, output: 2 });
  });

  test('a no-tools request is byte-identical to before (wire-pin)', async () => {
    responder = (url) =>
      url.includes('/api/chat/stream')
        ? sseResp([{ type: 'text', content: 'hi' }, { type: 'done' }])
        : jsonResp({ success: true, data: { id: 'x' } });
    const { SpyCoreProvider } = await import('../src/lib/providers/spycore.js');
    const p = new SpyCoreProvider();
    for await (const _e of p.streamChat({ conversationId: 'c', message: 'go', system: 'SYS', model: 'styx' })) void _e;
    const body = lastBody();
    expect(body).toEqual({ conversationId: 'c', model: 'STYX', message: 'SYS\n\ngo' });
    expect('tools' in body).toBe(false);
    expect('toolResults' in body).toBe(false);
  });

  test('toolResults continuation: body carries toolResults and OMITS message', async () => {
    responder = () => sseResp([{ type: 'text', content: 'ok' }, { type: 'done' }]);
    const { SpyCoreProvider } = await import('../src/lib/providers/spycore.js');
    const p = new SpyCoreProvider();
    for await (const _e of p.streamChat({
      conversationId: 'c',
      message: '',
      model: 'styx',
      tools: [{ name: 'read_file', parameters: { type: 'object', properties: {} } }],
      toolResults: [{ id: 'c1', name: 'read_file', content: 'file body' }],
    })) {
      void _e;
    }
    const body = lastBody();
    expect(body.toolResults).toHaveLength(1);
    expect('message' in body).toBe(false); // omitted, not empty-string
    expect(body.tools).toHaveLength(1);
  });
});
