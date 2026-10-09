/**
 * GOLDEN PINS FOR THE AGENT LOOP - N1 (fenced run), N2 (native run) and N3
 * (first-turn bytes).
 *
 * The decomposition of `runAgent` moves its closures into separate modules and
 * must not change anything a caller or the model can observe. These pins
 * compare a scripted run against a frozen capture of the unchanged source:
 * the whole event stream, the whole `AgentResult` (its retained `events`
 * included), every request the provider received, the approval requests, the
 * resume-state reports and the persisted journal.
 *
 * WHAT A RED GOLDEN MEANS. Something observable moved. The fixture is never
 * regenerated to make it green - the regression is found and reverted. The
 * scenarios live in `loop-golden-scenarios.ts`; the fixtures in
 * `fixtures/refactor-golden/`.
 *
 * Machine paths are replaced by `<CWD>` / `<CONFIG>`, and the engine's own
 * `JSON.parse` wording by `<ENGINE_JSON_ERROR_n>` (it differs across Node
 * versions). Everything the loop writes around them is compared byte for byte.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests } from '../src/lib/config.js';
import {
  asStored,
  decodeGolden,
  goldenFencedRun,
  goldenFencedTurnLimit,
  goldenFirstTurns,
  goldenNativeRun,
  type FirstTurnCapture,
  type RunCapture,
} from './loop-golden-scenarios.js';

function golden(name: string): unknown {
  const text = readFileSync(
    fileURLToPath(new URL(`./fixtures/refactor-golden/${name}.json`, import.meta.url)),
    'utf8',
  ).replace(/\r\n/g, '\n');
  return decodeGolden(JSON.parse(text) as { strings: Record<string, string>; value: unknown });
}

beforeEach(() => {
  freshConfigDir();
});

afterEach(() => {
  __resetConfigForTests();
});

/** Compare every facet separately first, so a red names the facet that moved. */
function expectSameRun(actual: RunCapture, expected: RunCapture): void {
  expect(actual.events, 'the event stream onEvent saw').toEqual(expected.events);
  expect(actual.result, 'the AgentResult (retained events included)').toEqual(expected.result);
  expect(actual.turns, 'the requests the provider received').toEqual(expected.turns);
  expect(actual.opened, 'the conversations the provider opened').toEqual(expected.opened);
  expect(actual.approvals, 'the approval requests').toEqual(expected.approvals);
  expect(actual.runStates, 'the onRunState reports').toEqual(expected.runStates);
  expect(actual.journal, 'the persisted journal').toEqual(expected.journal);
  expect(actual, 'the whole capture').toEqual(expected);
}

describe('N1 golden fenced run', () => {
  test('N1 narration, a read-only batch, an approved write, a rule-denied command, a malformed turn, an empty turn, a final answer', async () => {
    const expected = golden('fenced-run') as { run: RunCapture };
    expect(expected.run.events.length, 'the fixture is empty - this pin would compare nothing').toBeGreaterThan(15);
    const actual = asStored({ run: await goldenFencedRun() }) as { run: RunCapture };
    expectSameRun(actual.run, expected.run);
  });

  test('N1 a run that ends at maxTurns on a malformed turn', async () => {
    const expected = golden('fenced-turn-limit') as { run: RunCapture };
    expect(expected.run.result.reachedMaxTurns, 'the fixture does not end at the turn limit').toBe(true);
    const actual = asStored({ run: await goldenFencedTurnLimit() }) as { run: RunCapture };
    expectSameRun(actual.run, expected.run);
  });
});

describe('N2 golden native run', () => {
  test('N2 malformed and non-object arguments, a read-only batch, a write, the per-turn cap and its note, an empty-reply nudge, a final answer', async () => {
    const expected = golden('native-run') as { run: RunCapture };
    expect(
      expected.run.events.some((e) => e.type === 'tool_call_cap'),
      'the fixture never fires the per-turn cap - this pin would not cover it',
    ).toBe(true);
    const actual = asStored({ run: await goldenNativeRun() }) as { run: RunCapture };
    expectSameRun(actual.run, expected.run);
  });
});

describe('N3 first-turn bytes', () => {
  test('N3 system and message for every protocol × mode × provider case, the whitespace-only variants and the clamp path', async () => {
    const expected = golden('first-turns') as Record<string, FirstTurnCapture>;
    const names = Object.keys(expected).sort();
    expect(names.length, 'the first-turn matrix shrank - cases would go unpinned').toBe(20);
    const actual = asStored(await goldenFirstTurns()) as Record<string, FirstTurnCapture>;
    expect(Object.keys(actual).sort(), 'the case list moved').toEqual(names);
    for (const name of names) {
      const a = actual[name]!;
      const e = expected[name]!;
      expect(a.system, `${name}: system`).toEqual(e.system);
      expect(a.message, `${name}: message`).toEqual(e.message);
      expect(a.attachments, `${name}: attachments`).toEqual(e.attachments);
      expect(a.events, `${name}: context_clamped events`).toEqual(e.events);
    }
    expect(
      expected['clamp/spycore']!.events.length,
      'the clamp case no longer clamps - the clamp path would go unpinned',
    ).toBe(1);
    expect(expected['clamp/byok-unclamped']!.events, 'the bring-your-own-key case clamps').toEqual([]);
  });
});
