import { describe, expect, test } from 'vitest';
import {
  clip,
  connectionErrorMessage,
  errText,
  extractCode,
  readErrorDetail,
} from '../src/lib/providers/wire.js';

describe('errText', () => {
  test('errors yield their message, anything else is stringified', () => {
    expect(errText(new Error('boom'))).toBe('boom');
    expect(errText('plain')).toBe('plain');
    expect(errText(42)).toBe('42');
    expect(errText(null)).toBe('null');
  });
});

describe('extractCode', () => {
  test('finds the errno code on the error itself', () => {
    const err = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(extractCode(err)).toBe('ECONNREFUSED');
  });

  test('walks the cause chain', () => {
    const inner = Object.assign(new Error('inner'), { code: 'ENOTFOUND' });
    const outer = new Error('outer', { cause: inner });
    expect(extractCode(outer)).toBe('ENOTFOUND');
  });

  test('stops after 5 levels and ignores non-string codes', () => {
    let cur: unknown = new Error('deep');
    for (let i = 0; i < 10; i += 1) cur = new Error('wrap', { cause: cur });
    expect(extractCode(cur)).toBeUndefined();
    expect(extractCode(new Error('x'))).toBeUndefined();
    expect(extractCode(Object.assign(new Error('x'), { code: 42 }))).toBeUndefined();
    expect(extractCode(null)).toBeUndefined();
  });
});

describe('connectionErrorMessage', () => {
  test('refused and DNS failures get tailored wording', () => {
    const refused = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    expect(connectionErrorMessage(refused, 'http://localhost:11434')).toContain('connection refused');
    expect(connectionErrorMessage(refused, 'http://localhost:11434')).toContain('http://localhost:11434');

    const dns = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    expect(connectionErrorMessage(dns, 'http://nope.invalid')).toContain('Cannot resolve');
  });

  test('other failures fall back to the error text', () => {
    expect(connectionErrorMessage(new Error('timeout of 5000ms exceeded'), 'http://x')).toBe(
      'Cannot reach the model endpoint at http://x: timeout of 5000ms exceeded',
    );
  });

  test('userinfo credentials in the base URL never reach the message (R2 L5)', () => {
    const refused = Object.assign(new Error('x'), { code: 'ECONNREFUSED' });
    const msg = connectionErrorMessage(refused, 'https://user:s3cret@example.com:8443/v1');
    expect(msg).toContain('example.com:8443/v1');
    expect(msg).not.toContain('s3cret');
    expect(msg).not.toContain('user:');
    const dns = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
    const msg2 = connectionErrorMessage(dns, 'https://user:s3cret@example.com/v1');
    expect(msg2).not.toContain('s3cret');
    // A URL without userinfo is untouched.
    expect(connectionErrorMessage(refused, 'http://localhost:11434')).toContain('http://localhost:11434');
  });
});

describe('clip', () => {
  test('trims and collapses whitespace, clips at 200 chars', () => {
    expect(clip('  a\n  b  ')).toBe('a b');
    const long = 'x'.repeat(300);
    expect(clip(long)).toBe(`${'x'.repeat(200)}…`);
    expect(clip('short')).toBe('short');
  });
});

describe('readErrorDetail', () => {
  test('prefers the { error: { message } } shape', async () => {
    const body = { text: async () => JSON.stringify({ error: { message: 'bad key' } }) };
    expect(await readErrorDetail(body)).toBe('bad key');
  });

  test('accepts a bare { error: "string" } shape', async () => {
    const body = { text: async () => JSON.stringify({ error: 'nope' }) };
    expect(await readErrorDetail(body)).toBe('nope');
  });

  test('non-JSON bodies come back as a clipped raw snippet', async () => {
    const body = { text: async () => '  Service\nUnavailable  ' };
    expect(await readErrorDetail(body)).toBe('Service Unavailable');
  });

  test('empty bodies yield undefined', async () => {
    expect(await readErrorDetail({ text: async () => '' })).toBeUndefined();
    expect(await readErrorDetail(null)).toBeUndefined();
  });

  test('async-iterable bodies are decoded', async () => {
    async function* chunks(): AsyncGenerator<Buffer> {
      yield Buffer.from('{"error":{"message":"');
      yield Buffer.from('chunked"}}');
    }
    expect(await readErrorDetail(chunks())).toBe('chunked');
  });

  test('a throwing body never throws out', async () => {
    const body = {
      text: async () => {
        throw new Error('gone');
      },
    };
    expect(await readErrorDetail(body)).toBeUndefined();
  });

  test('a multi-MB error body is capped, not fully buffered (R2 L4)', async () => {
    // Async-iterable body: the read must stop at the 1 MB bound instead
    // of accumulating the whole body.
    let chunksYielded = 0;
    async function* huge(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 40; i += 1) {
        chunksYielded += 1;
        yield Buffer.alloc(64 * 1024, 'x');
      }
    }
    const detail = await readErrorDetail(huge());
    expect(detail).toBe(`${'x'.repeat(200)}…`);
    expect(chunksYielded).toBeLessThan(40);
    // .text() body: already buffered by the transport, but the parse/clip
    // work must still be bounded to the cap.
    const bigText = { text: async () => 'y'.repeat(2 * 1024 * 1024) };
    expect(await readErrorDetail(bigText)).toBe(`${'y'.repeat(200)}…`);
  });

  test('a body exposing BOTH .text() and the async iterator is read via the capped stream (R2-2)', async () => {
    // Real undici bodies expose both, and the old code checked .text()
    // first - so the capped branch was unreachable in production and a
    // multi-MB error page was buffered in full. The iterator must win.
    let chunksYielded = 0;
    async function* huge(): AsyncGenerator<Buffer> {
      for (let i = 0; i < 40; i += 1) {
        chunksYielded += 1;
        yield Buffer.alloc(64 * 1024, 'x');
      }
    }
    const dual = {
      text: async () => JSON.stringify({ error: { message: 'via-text' } }),
      [Symbol.asyncIterator]: () => huge(),
    };
    const detail = await readErrorDetail(dual);
    expect(detail).toBe(`${'x'.repeat(200)}…`);
    expect(detail).not.toContain('via-text');
    expect(chunksYielded).toBeLessThan(40);
  });

  test('a small dual body still prefers the iterator content (R2-2)', async () => {
    async function* chunks(): AsyncGenerator<Buffer> {
      yield Buffer.from('{"error":{"message":"via-stream"}}');
    }
    const dual = {
      text: async () => JSON.stringify({ error: { message: 'via-text' } }),
      [Symbol.asyncIterator]: () => chunks(),
    };
    expect(await readErrorDetail(dual)).toBe('via-stream');
  });
});
