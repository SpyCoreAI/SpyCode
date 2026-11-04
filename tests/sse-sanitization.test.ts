import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { createElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ROUTED_EVENT_TYPE } from '../src/lib/chat-events.js';
import { ALLOWED_MODELS, isModelSlug } from '../src/lib/models.js';
import { sanitizeForDisplay } from '../src/lib/sanitize-display.js';
import { MessageView } from '../src/ui/chat/MessageView.js';

/**
 * F-2c-30 - THE SHIPPED SECURITY GUARANTEE, PROVED BY EXECUTION.
 *
 * `packages/cli/SECURITY.md` is in the npm `files` allowlist, so this sentence
 * ships in the same tarball as the code:
 *
 * "**All** untrusted strings … pass through a single sanitizer … before
 * reaching the terminal."
 *
 * It was false. Review 1 #27 filed ONE address (`title`) and it was fixed;
 * review 2's F-N8 filed four siblings; the class counted from the dispatcher is
 * **9 string-bearing extractions, 7 of them display-bound, 5 of the 7 raw**.
 *
 * THIS FILE EXISTS BECAUSE THE FIXED HALF HAD NO PIN EITHER. `title` was
 * correct at HEAD and nothing would have gone red if it were reverted - the
 * shape this arc has now caught three times. Both halves are pinned here.
 *
 * AND BECAUSE A CENSUS OF SOURCE TEXT CANNOT ANSWER THIS QUESTION. Whether a
 * string "reaches the terminal" is a property of the RENDERER, not of the call
 * site: `display-sink-reach.test.ts` never mounts the TUI, which is exactly why
 * it could not see any of this. So the last block below mounts the real
 * `MessageView` under real Ink, captures the bytes it writes, and asserts the
 * guarantee on the actual output - with the unsanitized value as the control
 * that proves the capture can SEE an escape when one is there.
 */

// ── the poison, built from char codes so this file contains no raw controls ──
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CR = String.fromCharCode(13);
/** Conceal-SGR + an OSC 0 title write + an OSC 52 clipboard write + a bare CR. */
const POISON = `A${ESC}[8mHIDDEN${ESC}[0m${ESC}]0;pwned${BEL}${ESC}]52;c;cHduZWQ=${BEL}${CR}B`;

const hasTerminalControl = (s: string): boolean => s.includes(ESC) || s.includes(CR);

vi.mock('../src/lib/api.js', () => ({ streamRequest: vi.fn() }));
// eslint-disable-next-line import/first
import { streamRequest } from '../src/lib/api.js';
// eslint-disable-next-line import/first
import { streamAssistant } from '../src/ui/chat/stream.js';

type Event = { data: Record<string, unknown> };
const feed = (events: Array<Record<string, unknown>>): void => {
  vi.mocked(streamRequest).mockImplementation((() =>
    (async function* (): AsyncGenerator<Event> {
      for (const data of events) yield { data };
    })()) as never);
};

interface Captured {
  text: string[];
  skills: string[][];
  routed: string[];
  autoSwitch: Array<[string, string, string]>;
  title: string[];
  finishReason: string[];
  search: Array<[string, number | undefined]>;
  usage: Array<[number, number]>;
}

async function drive(events: Array<Record<string, unknown>>): Promise<{ got: Captured; err: unknown }> {
  feed(events);
  const got: Captured = { text: [], skills: [], routed: [], autoSwitch: [], title: [], finishReason: [], search: [], usage: [] };
  let err: unknown = null;
  try {
    await streamAssistant(
      {
        conversationId: 'c1', message: 'hi', model: 'hermes', effort: 'auto',
        apiUrl: undefined, signal: new AbortController().signal,
      },
      {
        onText: (c) => got.text.push(c),
        onThinking: () => {},
        onSkills: (s) => got.skills.push(s),
        onSearch: (state, count) => got.search.push([state, count]),
        onRouted: (m) => got.routed.push(m),
        onAutoSwitch: (f, t, r) => got.autoSwitch.push([f, t, r]),
        onMemory: () => {},
        onUsage: (i, o) => got.usage.push([i, o]),
        onTitle: (t) => got.title.push(t),
        onFinishReason: (r) => got.finishReason.push(r),
      },
    );
  } catch (e) {
    err = e;
  }
  return { got, err };
}

describe('the SSE family reaches the TUI sanitized', () => {
  beforeEach(() => { vi.mocked(streamRequest).mockReset(); });

  /**
   * THE DETECTOR FIRST. Every "no escape reached the terminal" result below
   * is worthless if the detector cannot see one, so it is proved in both
   * directions before any subject is believed.
   */
  test('the detector is LIVE - it sees an escape in the poison and none after the sanitizer', () => {
    expect(hasTerminalControl(POISON), 'the poison must contain a terminal control').toBe(true);
    expect(hasTerminalControl(sanitizeForDisplay(POISON)), 'the sanitizer must remove it').toBe(false);
    // …and it must not simply be blind to ordinary text.
    expect(hasTerminalControl('STYX_MAX')).toBe(false);
  });

  test('every display-bound string field arrives sanitized - the five that were raw', async () => {
    const { got } = await drive([
      { type: 'text', content: POISON },
      { type: 'skills_activated', skills: [POISON, `${POISON}-2`] },
      { type: ROUTED_EVENT_TYPE, resolvedModel: POISON },
      { type: 'auto_switched', from: POISON, to: `${POISON}-to`, reason: `${POISON}-why` },
      { type: 'title', content: POISON },
      { type: 'done' },
    ]);
    const leaked: string[] = [];
    const check = (label: string, values: string[]): void => {
      expect(values.length, `${label} produced no value - this assertion would be vacuous`).toBeGreaterThan(0);
      for (const v of values) if (hasTerminalControl(v)) leaked.push(`${label}: ${JSON.stringify(v)}`);
    };
    check('text.content', got.text);
    check('skills_activated.skills[]', got.skills.flat());
    check('routed.resolvedModel', got.routed);
    check('auto_switched.from/to/reason', got.autoSwitch.flat());
    check('title.content', got.title);
    expect(leaked, `these server-authored fields reached the handler raw:\n${leaked.join('\n')}`).toEqual([]);
  });

  /**
   * F7 - BOTH HALVES, INCLUDING THE ONE THAT WAS ALREADY CORRECT. `title` and
   * `content` were the two fields already cleaned somewhere; neither had a pin,
   * so a revert was invisible. They are asserted here on the same footing as the
   * five that were broken.
   */
  test('the already-correct halves are pinned too - title and content', async () => {
    const { got } = await drive([
      { type: 'title', content: POISON },
      { type: 'text', content: POISON },
      { type: 'done' },
    ]);
    expect(got.title).toEqual([sanitizeForDisplay(POISON)]);
    expect(got.text).toEqual([sanitizeForDisplay(POISON)]);
  });

  test('the error event cannot carry a control sequence into the error surface', async () => {
    const { err } = await drive([{ type: 'error', message: `${POISON} plan limit reached` }]);
    expect(err, 'the error event must still throw').toBeInstanceOf(Error);
    expect(hasTerminalControl((err as Error).message)).toBe(false);
    // …and the classification the raw string drove must still work.
    expect((err as Error).message).toContain('Stream error:');
  });

  /**
   * THE "MEASURE FIRST" REVIEW 2 ATTACHED TO THIS FIX: does sanitizing
   * `resolvedModel` break the slug lookup it feeds? Answered over the real
   * model set rather than by inspection - the sanitizer is a no-op on every
   * legitimate slug, so `displayFor`'s `isModelSlug` path is untouched.
   */
  test('sanitizing resolvedModel does not break the model-slug lookup', async () => {
    for (const slug of ALLOWED_MODELS) {
      const wire = slug.toUpperCase();
      expect(sanitizeForDisplay(wire), `${wire} must survive the sanitizer unchanged`).toBe(wire);
      expect(isModelSlug(sanitizeForDisplay(wire).toLowerCase())).toBe(true);
    }
    const { got } = await drive([{ type: ROUTED_EVENT_TYPE, resolvedModel: 'styx_max' }, { type: 'done' }]);
    expect(got.routed).toEqual(['STYX_MAX']);
  });

  /**
   * Numbers cannot carry an escape and `finish_reason` is compared against a
   * literal and never rendered. Both exclusions are ASSERTED rather than left
   * as a comment, so widening the family later has to come past this.
   */
  test('the deliberate exclusions are the ones documented, and nothing else', async () => {
    const { got } = await drive([
      { type: 'search_completed', count: 3 },
      { type: 'usage', input: 11, output: 22 },
      { type: 'finish_reason', reason: 'length' },
      { type: 'done' },
    ]);
    expect(got.search).toEqual([['completed', 3]]);
    expect(got.usage).toEqual([[11, 22]]);
    expect(got.finishReason).toEqual(['length']);
  });
});

/** A stdout stand-in Ink will draw into, so the real bytes can be inspected. */
class CapturedStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  isTTY = false;
  buf = '';
  write(chunk: string): boolean { this.buf += chunk; return true; }
  end(): void { /* Ink calls this on unmount */ }
}

async function draw(item: unknown): Promise<string> {
  const stdout = new CapturedStdout();
  const instance = render(createElement(MessageView, { item, width: 60 } as never), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await new Promise((resolve) => { setTimeout(resolve, 80); });
  instance.unmount();
  return stdout.buf;
}

describe('the shipped SECURITY.md guarantee, proved on the bytes Ink writes', () => {
  /**
   * RENDER-SITE HARDENING (v0.9.0). MessageView now sanitizes at the render
   * boundary, so even a raw unsanitized value passed straight to the component
   * must NOT reach stdout with control sequences intact. This test pins the
   * hardened behavior: defense in depth, not producer discipline.
   */
  test('CONTROL - a RAW value passed to MessageView is sanitized at render', async () => {
    const assistant = await draw({ kind: 'assistant', id: 1, content: 'body', model: POISON, skills: [POISON] });
    const notice = await draw({ kind: 'notice', id: 2, variant: 'warning', text: POISON });
    const error = await draw({ kind: 'error', id: 3, message: POISON });
    for (const [label, out] of [['assistant header', assistant], ['notice', notice], ['error', error]] as const) {
      expect(out.length, `${label}: Ink wrote nothing - the capture is broken`).toBeGreaterThan(0);
      expect(out.includes(`${ESC}[8m`), `${label}: conceal sequence reached stdout - render-site sanitization broken`).toBe(false);
      expect(out.includes(`${ESC}]0;`), `${label}: OSC title write reached stdout`).toBe(false);
      expect(out.includes(`${ESC}]52;`), `${label}: OSC clipboard write reached stdout`).toBe(false);
    }
  });

  test('the guarantee HOLDS - the sanitized value emits no terminal control', async () => {
    const clean = sanitizeForDisplay(POISON);
    const assistant = await draw({ kind: 'assistant', id: 1, content: 'body', model: clean, skills: [clean] });
    const notice = await draw({ kind: 'notice', id: 2, variant: 'warning', text: clean });
    const error = await draw({ kind: 'error', id: 3, message: clean });
    for (const [label, out] of [['assistant header', assistant], ['notice', notice], ['error', error]] as const) {
      expect(out.includes(`${ESC}[8m`), `${label}: conceal-SGR reached stdout`).toBe(false);
      expect(out.includes(`${ESC}]0;`), `${label}: an OSC title write reached stdout`).toBe(false);
      expect(out.includes(`${ESC}]52;`), `${label}: an OSC clipboard write reached stdout`).toBe(false);
      // The visible replacements the sanitizer promises are what arrives instead.
      expect(out).toContain('HIDDEN');
    }
  });
});
