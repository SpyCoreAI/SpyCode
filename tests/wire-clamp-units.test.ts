import { describe, expect, test } from 'vitest';
import {
  clampWireAssembly,
  type WirePart,
} from '../src/lib/wire-clamp.js';
import { WIRE_MESSAGE_MAX_CHARS } from '../src/lib/wire-limits.js';

const CAP = 200;

function part(kind: WirePart['kind'], label: string, body: string): WirePart {
  return { kind, label, body };
}

describe('clampWireAssembly', () => {
  test('under-cap assembly passes through untouched', () => {
    const parts = [
      { kind: 'fixed', label: 'system', body: 'SYS', pre: 'P', post: 'Q' } as WirePart,
      part('user', 'user message', 'hello'),
      part('injection', 'project context', 'ctx'),
    ];
    const out = clampWireAssembly(parts, CAP);
    expect(out.clamped).toBe(false);
    expect(out.warning).toBeNull();
    expect(out.texts).toEqual(['PSYSQ', 'hello', 'ctx']);
    expect(out.wire).toBe('PSYSQhelloctx');
  });

  test('the hard invariant holds: wire never exceeds the cap', () => {
    const parts = [
      part('user', 'user message', 'u'.repeat(1000)),
      part('attachments', 'attached files', 'a'.repeat(1000)),
      part('injection', 'project context', 'i'.repeat(1000)),
    ];
    const out = clampWireAssembly(parts, CAP);
    expect(out.wire.length).toBeLessThanOrEqual(CAP);
    expect(out.clamped).toBe(true);
    expect(out.warning).not.toBeNull();
  });

  test('trim priority: injection is cut before attachments, attachments before user', () => {
    const injection = part('injection', 'project context', 'i'.repeat(150));
    const attachments = part('attachments', 'attached files', 'a'.repeat(150));
    const user = part('user', 'user message', 'u'.repeat(50));
    const out = clampWireAssembly([user, attachments, injection], CAP);
    expect(out.wire.length).toBeLessThanOrEqual(CAP);
    // The highest-priority part survives whole.
    expect(out.texts[0]).toBe('u'.repeat(50));
    expect(out.texts[1]).not.toBe('a'.repeat(150)); // attachments trimmed
    expect(out.texts[2]).not.toBe('i'.repeat(150)); // injection trimmed first
    expect(out.warning).toContain('project context');
    expect(out.warning).toContain('attached files');
  });

  test('user content is trimmed only as a last resort', () => {
    const injection = part('injection', 'project context', 'i'.repeat(500));
    const user = part('user', 'user message', 'u'.repeat(50));
    const out = clampWireAssembly([user, injection], 200);
    expect(out.texts[0]).toBe('u'.repeat(50)); // user intact
    expect(out.texts[1]).not.toBe('i'.repeat(500)); // injection took the cut
    expect(out.wire.length).toBeLessThanOrEqual(200);
    expect(out.warning).toContain('project context');
    expect(out.warning).not.toContain('user message');
  });

  test('every cut leaves an explicit in-band marker', () => {
    const out = clampWireAssembly([part('injection', 'project context', 'i'.repeat(500))], 60);
    expect(out.texts[0]).toContain('[project context truncated to fit the message limit]');
  });

  test('a body with no room for a useful stub is replaced by an explicit omission marker', () => {
    // 47 + 70 = 117 > 100: the injection cut keeps 0 body chars, so the whole
    // body is swapped for the (shorter) omission marker; 47 + 50 fits.
    const parts = [
      part('user', 'user message', 'u'.repeat(47)),
      part('injection', 'project context', 'i'.repeat(70)),
    ];
    const out = clampWireAssembly(parts, 100);
    expect(out.texts[0]).toBe('u'.repeat(47)); // user intact
    expect(out.texts[1]).toBe('[project context omitted to fit the message limit]');
    expect(out.wire.length).toBeLessThanOrEqual(100);
    expect(out.warning).toContain('project context');
  });

  test('fixed parts are never trimmed by the priority pass', () => {
    const out = clampWireAssembly(
      [
        { kind: 'fixed', label: 'system', body: 'F'.repeat(100) },
        part('injection', 'project context', 'i'.repeat(500)),
      ],
      150,
    );
    expect(out.texts[0]).toBe('F'.repeat(100));
    expect(out.wire.length).toBeLessThanOrEqual(150);
  });

  test('last resort: fixed parts alone above the cap are tail-cut with a marker', () => {
    const out = clampWireAssembly([{ kind: 'fixed', label: 'system', body: 'F'.repeat(500) }], 100);
    expect(out.wire.length).toBeLessThanOrEqual(100);
    expect(out.texts[0]).toContain('[system truncated to fit the message limit]');
    expect(out.warning).toContain('system');
  });

  test('empty parts list is a no-op', () => {
    const out = clampWireAssembly([], CAP);
    expect(out).toEqual({ texts: [], wire: '', clamped: false, warning: null });
  });

  test('the default cap is the server wire cap', () => {
    expect(WIRE_MESSAGE_MAX_CHARS).toBe(32_000);
    const parts = [part('user', 'user message', 'u'.repeat(WIRE_MESSAGE_MAX_CHARS + 1))];
    const out = clampWireAssembly(parts);
    expect(out.wire.length).toBeLessThanOrEqual(WIRE_MESSAGE_MAX_CHARS);
  });

  test('pre/post joiners are never trimmed', () => {
    const out = clampWireAssembly(
      [
        {
          kind: 'injection',
          label: 'project context',
          body: 'i'.repeat(500),
          pre: '<<PRE>>',
          post: '<<POST>>',
        },
      ],
      80,
    );
    expect(out.texts[0]!.startsWith('<<PRE>>')).toBe(true);
    expect(out.texts[0]!.endsWith('<<POST>>')).toBe(true);
    expect(out.wire.length).toBeLessThanOrEqual(80);
  });
});
