import { describe, expect, test } from 'vitest';
import { LspFramer, encodeLspMessage, LSP_MAX_MESSAGE_BYTES } from '../src/lib/agent/lsp/protocol.js';
import { LspError } from '../src/lib/agent/lsp/types.js';

function frame(obj: unknown): Buffer {
  return encodeLspMessage(obj);
}

describe('LspFramer', () => {
  test('decodes a single complete message', () => {
    const framer = new LspFramer();
    const bodies = framer.feed(frame({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0] as string)).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(framer.bufferedBytes).toBe(0);
  });

  test('handles a message split across chunks — even mid-multibyte-character', () => {
    const framer = new LspFramer();
    const full = frame({ jsonrpc: '2.0', method: 'note', params: { text: 'héllo wörld ✓' } });
    // Split inside the UTF-8 encoding of '✓' (3 bytes) to prove byte-exactness.
    const idx = full.indexOf(Buffer.from('✓', 'utf8'));
    const a = full.subarray(0, idx + 1);
    const b = full.subarray(idx + 1);
    expect(framer.feed(a)).toEqual([]);
    expect(framer.bufferedBytes).toBeGreaterThan(0);
    const bodies = framer.feed(b);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0] as string).params.text).toBe('héllo wörld ✓');
  });

  test('decodes multiple messages arriving in one chunk', () => {
    const framer = new LspFramer();
    const bodies = framer.feed(
      Buffer.concat([frame({ id: 1 }), frame({ id: 2 }), frame({ id: 3 })]),
    );
    expect(bodies).toHaveLength(3);
    expect(bodies.map((b) => JSON.parse(b).id)).toEqual([1, 2, 3]);
  });

  test('Content-Length counts UTF-8 bytes, not characters', () => {
    const framer = new LspFramer();
    const body = JSON.stringify({ text: '✓✓✓' }); // 3 chars, 9 bytes
    const raw = Buffer.concat([
      Buffer.from(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`, 'ascii'),
      Buffer.from(body, 'utf8'),
    ]);
    const bodies = framer.feed(raw);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0] as string)).toEqual({ text: '✓✓✓' });
  });

  test('tolerates a lone-LF header terminator', () => {
    const framer = new LspFramer();
    const body = JSON.stringify({ id: 7 });
    const raw = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\n\n`, 'ascii'),
      Buffer.from(body, 'utf8'),
    ]);
    expect(framer.feed(raw)).toHaveLength(1);
  });

  test('waits for a partial body without emitting', () => {
    const framer = new LspFramer();
    const full = frame({ id: 1, big: 'x'.repeat(100) });
    const headerEnd = full.indexOf('\r\n\r\n') + 4;
    const partial = full.subarray(0, headerEnd + 10);
    expect(framer.feed(partial)).toEqual([]);
    const rest = framer.feed(full.subarray(headerEnd + 10));
    expect(rest).toHaveLength(1);
    expect(JSON.parse(rest[0] as string).id).toBe(1);
  });

  test('throws on a message without Content-Length', () => {
    const framer = new LspFramer();
    const raw = Buffer.from('Content-Type: application/json\r\n\r\n{}', 'ascii');
    expect(() => framer.feed(raw)).toThrow(LspError);
  });

  test('throws on header garbage that never terminates', () => {
    const framer = new LspFramer();
    expect(() => framer.feed(Buffer.from('x'.repeat(9 * 1024), 'ascii'))).toThrow(LspError);
  });

  test('encode→decode round-trips through the framer', () => {
    const framer = new LspFramer();
    const value = { jsonrpc: '2.0', id: 42, result: { ok: true, list: [1, 2, 3] } };
    const bodies = framer.feed(encodeLspMessage(value));
    expect(JSON.parse(bodies[0] as string)).toEqual(value);
  });

  test('LSP_MAX_MESSAGE_BYTES is a sane bound', () => {
    expect(LSP_MAX_MESSAGE_BYTES).toBe(64 * 1024 * 1024);
  });
});
