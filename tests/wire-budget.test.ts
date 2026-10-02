/**
 * FIX BATCH 2 / B2 — the agent's continuation turns must NEVER exceed the
 * server's 32,000-char wire cap (`z.string().max(32000)` on both `message` and
 * every `toolResults[].content`).
 *
 * The regression these tests lock down: the per-tool-result cap was an
 * independent `32 * 1024`, its truncation marker rode on top (→ 32,799 chars),
 * a post-tool hook could append 4 KB MORE after the cap, and the 1.8 wire clamp
 * only ever ran on turn 1. Everything below asserts against the REAL
 * DEFAULT_LIMITS, not a synthetic tiny limit — a synthetic limit is exactly
 * what let the two caps drift apart unnoticed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LIMITS,
  MAX_RESULT_CHARS,
  WEB_CONTENT_MAX_CHARS,
  dispatchTool,
  wrapUntrustedWebContent,
  type ToolContext,
  type ToolDefinition,
} from '../src/lib/agent/tools.js';
import {
  HOOK_FEEDBACK_APPEND_MAX_CHARS,
  HOOK_FEEDBACK_BLOCK_MAX_CHARS,
  HOOK_FEEDBACK_MAX_CHARS,
  wrapHookFeedback,
} from '../src/lib/hooks.js';
import {
  RESULT_TRUNC_MARKER_MAX_CHARS,
  WIRE_MESSAGE_MAX_CHARS,
  clampToWireMax,
} from '../src/lib/wire-limits.js';
import { CONTINUE_HINT, assembleFencedContinuation } from '../src/lib/agent/loop.js';

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'spycore-wire-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const ctx = (): ToolContext => ({ cwd, limits: DEFAULT_LIMITS });

/** The maximal post-tool hook feedback a run can append after dispatch's cap. */
const maximalHookFeedback = (): string => wrapHookFeedback('h'.repeat(HOOK_FEEDBACK_MAX_CHARS + 1));

// ───────────────────────── the budget arithmetic ─────────────────────────

describe('wire budget — derived, not coincidental', () => {
  test('result + marker + maximal hook feedback === the server wire cap', () => {
    expect(WIRE_MESSAGE_MAX_CHARS).toBe(32_000);
    expect(
      MAX_RESULT_CHARS + RESULT_TRUNC_MARKER_MAX_CHARS + HOOK_FEEDBACK_APPEND_MAX_CHARS,
    ).toBe(WIRE_MESSAGE_MAX_CHARS);
    expect(MAX_RESULT_CHARS).toBeLessThan(WIRE_MESSAGE_MAX_CHARS);
    expect(DEFAULT_LIMITS.maxResultChars).toBe(MAX_RESULT_CHARS);
  });

  test('the hook reserve is the real wrapper output, not a hand-count', () => {
    expect(maximalHookFeedback().length).toBe(HOOK_FEEDBACK_BLOCK_MAX_CHARS);
    expect(HOOK_FEEDBACK_APPEND_MAX_CHARS).toBe(2 + HOOK_FEEDBACK_BLOCK_MAX_CHARS);
    // Nothing a hook can emit exceeds the reserve.
    for (const n of [0, 1, 100, HOOK_FEEDBACK_MAX_CHARS, HOOK_FEEDBACK_MAX_CHARS * 3]) {
      expect(wrapHookFeedback('z'.repeat(n)).length).toBeLessThanOrEqual(HOOK_FEEDBACK_BLOCK_MAX_CHARS);
    }
  });
});

// ───────────────────────── native continuation ─────────────────────────

describe('NATIVE continuation — toolResults[].content ≤ 32,000', () => {
  test('a ~40,000-char read_file result fits the wire after dispatch caps it', async () => {
    writeFileSync(join(cwd, 'big.txt'), 'x'.repeat(40_000));
    const res = await dispatchTool('read_file', { path: 'big.txt' }, ctx());

    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/\[result truncated to \d+ characters\]$/);
    // The bug: this was ~32,797 and the server 400'd the whole run.
    expect(res.content.length).toBeLessThanOrEqual(WIRE_MESSAGE_MAX_CHARS);
    // What the native branch actually puts on the wire.
    expect(clampToWireMax(res.content)).toBe(res.content); // backstop is a no-op
  });

  test('…and still fits after a maximal post-tool hook-feedback append', async () => {
    writeFileSync(join(cwd, 'big.txt'), 'x'.repeat(40_000));
    const res = await dispatchTool('read_file', { path: 'big.txt' }, ctx());

    // Exactly what agent/loop.ts `dispatchWithHooks` does after the cap.
    const withFeedback = `${res.content}\n\n${maximalHookFeedback()}`;
    expect(withFeedback.length).toBeLessThanOrEqual(WIRE_MESSAGE_MAX_CHARS);
    // The appended block rides BEHIND the cut, so its closing sentinel is intact.
    expect(withFeedback.endsWith('</spycode-hook-feedback>')).toBe(true);
    expect(clampToWireMax(withFeedback)).toBe(withFeedback);
  });

  test('clampToWireMax is a hard ceiling (marker included), not a body budget', () => {
    const out = clampToWireMax('y'.repeat(80_000));
    expect(out.length).toBe(WIRE_MESSAGE_MAX_CHARS);
    expect(out).toMatch(/\[result truncated to 32000 characters\]$/);
  });
});

// ───────────────────────── fenced continuation ─────────────────────────

describe('FENCED continuation — the joined `message` ≤ 32,000', () => {
  const block = (i: number, n: number, body: string): string =>
    `Tool ${i}/${n}: read_file({"path":"f${i}"}) → OK (1 line)\n${body}`;

  test('three ~32,000-char results assemble to a message within the cap', () => {
    const blocks = [1, 2, 3].map((i) => block(i, 3, 'x'.repeat(32_000)));
    const { message, clamped } = assembleFencedContinuation(7, blocks);

    expect(clamped).toBe(true);
    expect(message.length).toBeLessThanOrEqual(WIRE_MESSAGE_MAX_CHARS);
    // Nothing dropped silently: every cut result is marked in-band…
    for (const k of [1, 2, 3]) {
      expect(message).toContain(`[tool result ${k} truncated to fit the message limit]`);
    }
    // …and the turn header + continue hint always survive.
    expect(message.startsWith('TOOL RESULTS (turn 7):\n\n')).toBe(true);
    expect(message.endsWith(CONTINUE_HINT)).toBe(true);
  });

  test('one oversized result never starves the small ones (water-fill)', () => {
    const blocks = [block(1, 3, 'a'.repeat(50)), block(2, 3, 'b'.repeat(60_000)), block(3, 3, 'c'.repeat(50))];
    const { message, clamped } = assembleFencedContinuation(2, blocks);

    expect(clamped).toBe(true);
    expect(message.length).toBeLessThanOrEqual(WIRE_MESSAGE_MAX_CHARS);
    // The two small results survive WHOLE; only the giant one is cut.
    expect(message).toContain(blocks[0]!);
    expect(message).toContain(blocks[2]!);
    expect(message).toContain('[tool result 2 truncated to fit the message limit]');
    expect(message).not.toContain('[tool result 1 truncated');
    expect(message).not.toContain('[tool result 3 truncated');
  });

  test('a pathological number of results still cannot exceed the cap', () => {
    const blocks = Array.from({ length: 400 }, (_, i) => block(i + 1, 400, 'q'.repeat(500)));
    const { message } = assembleFencedContinuation(1, blocks);
    expect(message.length).toBeLessThanOrEqual(WIRE_MESSAGE_MAX_CHARS);
  });

  test('KEEP-CURRENT: under budget the message is byte-identical to the unclamped string', () => {
    const blocks = [block(1, 2, 'small'), block(2, 2, 'also small')];
    const { message, clamped } = assembleFencedContinuation(3, blocks);

    expect(clamped).toBe(false);
    expect(message).toBe(`TOOL RESULTS (turn 3):\n\n${blocks.join('\n\n')}\n\n${CONTINUE_HINT}`);
    expect(message).not.toContain('truncated to fit');
  });
});

// ───────────────────── untrusted-web wrapper invariant ─────────────────────

describe('untrusted web content — capContent can never sever the closing sentinel', () => {
  test('a saturated wrapped block fits the result cap exactly', () => {
    const out = wrapUntrustedWebContent('x'.repeat(WEB_CONTENT_MAX_CHARS + 10_000));
    expect(out.length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(out.endsWith('</spycode-web-content>')).toBe(true);
  });

  test('the REAL dispatch cap leaves the frame intact', async () => {
    const webbish: ToolDefinition = {
      name: 'fake_web',
      description: 'returns a maximally-sized wrapped web block',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({
        ok: true,
        summary: 'fetched',
        content: wrapUntrustedWebContent('x'.repeat(WEB_CONTENT_MAX_CHARS + 10_000)),
      }),
    };
    const res = await dispatchTool('fake_web', {}, {
      ...ctx(),
      extraTools: new Map([['fake_web', webbish]]),
    });

    // capContent only cuts when length > maxChars — and it never gets there.
    expect(res.content).not.toContain('[result truncated');
    expect(res.content.endsWith('</spycode-web-content>')).toBe(true);
    // Even with a hook piling feedback on top, the whole thing rides the wire.
    expect(`${res.content}\n\n${maximalHookFeedback()}`.length).toBeLessThanOrEqual(
      WIRE_MESSAGE_MAX_CHARS,
    );
  });
});

// ───────────────────────── byte-identity guard ─────────────────────────

describe('KEEP-CURRENT — nothing to clamp ⇒ nothing changes', () => {
  test('a small tool result passes through unchanged; no marker is added', async () => {
    writeFileSync(join(cwd, 'small.txt'), 'hello\nworld');
    const res = await dispatchTool('read_file', { path: 'small.txt' }, ctx());
    expect(res.content).toBe('hello\nworld');
    expect(res.content).not.toContain('truncated');
    expect(clampToWireMax(res.content)).toBe('hello\nworld');
  });

  test('a result exactly at the budget is not truncated (cut is strictly >)', async () => {
    writeFileSync(join(cwd, 'exact.txt'), 'x'.repeat(MAX_RESULT_CHARS));
    const res = await dispatchTool('read_file', { path: 'exact.txt' }, ctx());
    expect(res.content.length).toBe(MAX_RESULT_CHARS);
    expect(res.content).not.toContain('truncated');
  });
});
