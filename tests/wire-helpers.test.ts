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
});
