import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * ⭐⭐ F-14 §F3 — THE DEADLINE CLASS PINNED AS A CLASS, NOT AT FOUR SITES.
 *
 * F-13 sized one file's deadline and the class went stale within one batch:
 * the next run put a DIFFERENT test over the same cap. Measured across 24
 * `CLI Build` job logs (every matrix leg at four consecutive shas), the tests
 * that have already exceeded the global 10 000 ms cap are not one, and not two:
 *
 *   d8ce83f8 windows/Node 20   display-sink-reach.test.ts  P1   13 532 ms
 *   5972f29d windows/Node 20   portable-paths.test.ts      W1   10 270 ms
 *   5972f29d windows/Node 22   mirror-dirty-tree.test.ts        11 780 ms
 *   5972f29d macOS/Node 20     mirror-dirty-tree.test.ts        10 101 ms
 *   9d4a79d9 windows/Node 20   portable-line-endings.ts    L1   10 639 ms
 *
 * ⭐⭐ THREE DIFFERENT WINNERS IN FOUR DRAWS. Which member goes red is decided
 * by contention, not by any change to the test — so a member that is green
 * today is green by luck. **A test whose pass depends on what else is running
 * is not pinned.** This file pins the remedy so it cannot rot back.
 *
 * ⭐⭐ WHAT THIS GATE CANNOT DO, STATED PLAINLY RATHER THAN IMPLIED.
 * It cannot notice a NEW slow test. The only evidence for that is per-test
 * duration on the slowest CI leg, and no local gate can reach it: the durations
 * live in GitHub job logs, this suite runs with no network and no credential in
 * CI, and a committed snapshot of them would go stale silently — a freshness
 * guard fed by the thing it polices proves nothing (F-2c-48). So membership is
 * still established by READING CI, which is a procedure and not a mechanism,
 * and that limit is recorded here rather than left for a reader to discover.
 * What this gate DOES close is the two ways the remedy dies quietly: the global
 * cap being raised, and a member's explicit deadline being dropped or shrunk.
 *
 * ⭐⭐ AND ONE MORE THING A READER MUST NOT ASSUME — A DEADLINE ON A
 * SYNCHRONOUS TEST IS A DETECTOR, NOT A BOUND.
 *
 * Measured with a planted pair under a 1 000 ms deadline: an ASYNC body that
 * sleeps 3 s is interrupted and reported at **1 004 ms**; a SYNC body that
 * busy-waits 3 s blocks the event loop, runs to completion, and is failed
 * retroactively at **3 002 ms**. Two of the four members below (`W1`, `L1`) are
 * synchronous, so their 60 s deadline stops a slow test being reported as a
 * failed one — it does NOT bound wall-clock, and neither does the global 10 s
 * cap. A genuinely hung synchronous test runs until the runner kills the job.
 * Said here rather than left to be rediscovered.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The measured exposed set. `floorMs` is the justified minimum from
 * `audits/f14-deadline-class.md`: the worst NON-TRUNCATED duration measured on
 * any leg, multiplied by the worst same-leg run-to-run swing measured anywhere
 * in this suite (7.39x), rounded down to the value actually shipped.
 *
 * ⭐ `chat` is deliberately the exception and carries its reason: its cost is a
 * fixed 7 s of retry backoff with a measured swing of 1.01x, so the load factor
 * does not apply to it and a smaller deadline is the honest one.
 */
interface Member {
  readonly file: string;
  readonly fragment: string;
  readonly floorMs: number;
  readonly worstMeasuredMs: number;
}

const MEMBERS: readonly Member[] = [
  { file: 'display-sink-reach.test.ts', fragment: 'P1 THE PROPERTY', floorMs: 60_000, worstMeasuredMs: 13_532 },
  { file: 'portable-line-endings.test.ts', fragment: 'L1 THE INSTRUMENT FIRST', floorMs: 60_000, worstMeasuredMs: 10_639 },
  { file: 'portable-paths.test.ts', fragment: 'W1 THE INSTRUMENT FIRST', floorMs: 60_000, worstMeasuredMs: 10_270 },
  { file: 'chat.test.ts', fragment: 'error event surfaces as', floorMs: 20_000, worstMeasuredMs: 7_139 },
];

/** ⭐ A floor, not a target — a corpus that silently empties must not pass. */
const MEMBER_FLOOR = 4;

/** The global cap ruling 1 refuses to raise. */
const GLOBAL_CAP_MS = 10_000;

/**
 * Find the explicit deadline on the `test(...)` call whose name contains
 * `fragment`. Returns null when the call carries no options object.
 */
function explicitDeadline(source: string, fragment: string): number | null {
  const idx = source.indexOf(fragment);
  if (idx < 0) return null;
  // The options object, when present, follows the closing quote of the name.
  const tail = source.slice(idx, idx + 4000);
  const m = /^[^\n]*?['"`]\s*,\s*\{[^}]*\btimeout\s*:\s*([0-9_]+)/.exec(tail);
  const raw = m?.[1];
  return raw === undefined ? null : Number(raw.replace(/_/g, ''));
}

describe('§F3 the deadline class — the remedy cannot rot back', () => {
  /**
   * ⭐⭐ THE INSTRUMENT FIRST. A scanner that cannot see a deadline that IS
   * there, or that reports one where there is none, makes every assertion
   * below meaningless. Both directions are driven against synthetic sources so
   * the control does not depend on the very files it is about to judge.
   */
  test('D1 THE INSTRUMENT FIRST: the scanner sees a real deadline and refuses to invent one', () => {
    const withDeadline = `  test('X1 something slow', { timeout: 60_000 }, () => {\n    expect(1).toBe(1);\n  });\n`;
    expect(
      explicitDeadline(withDeadline, 'X1 something slow'),
      'the scanner cannot see an explicit deadline that is present — every check below is blind',
    ).toBe(60_000);

    const withoutDeadline = `  test('X2 something slow', () => {\n    expect(1).toBe(1);\n  });\n`;
    expect(
      explicitDeadline(withoutDeadline, 'X2 something slow'),
      'the scanner reported a deadline on a test that has none — it would pass over the whole class',
    ).toBeNull();

    // ⭐ and it must not read a NEIGHBOUR's deadline as this test's own.
    const neighbour = `  test('X3 plain', () => {});\n  test('X4 slow', { timeout: 30_000 }, () => {});\n`;
    expect(
      explicitDeadline(neighbour, 'X3 plain'),
      'the scanner walked past the end of the call and read the next test’s deadline',
    ).toBeNull();

    expect(explicitDeadline('nothing here', 'X5 absent'), 'an absent test reported a deadline').toBeNull();
  });

  /**
   * ⭐⭐ RULING 1, PINNED. Raising the global cap is the cheap-looking remedy
   * and it is the wrong one: it would relax the deadline for all 1 722 tests to
   * accommodate 4. Of those, only 109 were ever observed at or above 1 000 ms on
   * any of the 24 legs measured, and 1 613 never were — for them a 10 s cap is
   * real information, and this arm keeps it.
   */
  test('D2 the GLOBAL cap is unchanged — the class is fixed per test, never everywhere', () => {
    const cfg = readFileSync(join(PKG_ROOT, 'vitest.config.ts'), 'utf8');
    expect(cfg.length, 'read no config — vacuous').toBeGreaterThan(500);
    const m = /testTimeout\s*:\s*([0-9_]+)/.exec(cfg);
    expect(m, 'no testTimeout in the vitest config — the global cap has been removed entirely').not.toBeNull();
    expect(
      Number((m?.[1] ?? '0').replace(/_/g, '')),
      'the GLOBAL testTimeout moved. Ruling 1: raise the deadline where the cost is, never everywhere. ' +
        'If a new test genuinely needs longer, give that test an explicit { timeout } and add it to MEMBERS.',
    ).toBe(GLOBAL_CAP_MS);
  });

  /**
   * ⭐ Every measured member still carries a deadline, and it is still at least
   * the figure the measurement justified. Shrinking one back under the cap is
   * the same defect as never having added it.
   */
  test('D3 every measured member of the deadline class still carries its explicit deadline', () => {
    expect(
      MEMBERS.length,
      'the member list emptied — this gate would then assert nothing at all',
    ).toBeGreaterThanOrEqual(MEMBER_FLOOR);

    const failures: string[] = [];
    for (const m of MEMBERS) {
      const source = readFileSync(join(HERE, m.file), 'utf8');
      expect(source.length, `read no source for ${m.file} — vacuous`).toBeGreaterThan(500);
      expect(
        source.includes(m.fragment),
        `${m.file} no longer contains a test named like "${m.fragment}" — the member list is stale, ` +
          'which is worse than absent because it reports green over a test that no longer exists',
      ).toBe(true);

      const got = explicitDeadline(source, m.fragment);
      if (got === null) {
        failures.push(`${m.file} :: ${m.fragment} — explicit deadline REMOVED (measured worst ${m.worstMeasuredMs} ms)`);
      } else if (got < m.floorMs) {
        failures.push(`${m.file} :: ${m.fragment} — deadline ${got} ms is below the justified floor ${m.floorMs} ms`);
      } else if (got <= GLOBAL_CAP_MS) {
        failures.push(`${m.file} :: ${m.fragment} — deadline ${got} ms is not above the global cap, so it is inert`);
      }
    }
    expect(
      failures,
      'a member of the measured deadline class lost the deadline that keeps it off the cap. ' +
        'Each figure is justified in audits/f14-deadline-class.md from CI job logs, not from habit.',
    ).toEqual([]);
  });
});
