import { describe, expect, test } from 'vitest';
import { DEVICE_WRITE_VERBS, matchesCatastrophic } from '../src/lib/agent/tools.js';
import { matchesCatastrophic060 } from './fixtures/catastrophic-screen-0.6.0.js';
import {
  DEVICE_ABBREV_RESIDUAL,
  DEVICE_ANCHOR_RESIDUAL,
  DEVICE_ATTACHED_ARCHIVE_HOSTILE,
  DEVICE_ID_HOSTILE,
  DEVICE_ID_ORDINARY_BENIGN,
  DEVICE_ID_PAIRS,
  DEVICE_ID_READ_BENIGN,
  DEVICE_BUNDLED_ARG_HOSTILE,
  DEVICE_CHAIN_HOSTILE,
  DEVICE_COMPOSED_HOSTILE,
  DEVICE_OPTION_VALUE_BENIGN,
  DEVICE_OPTION_VALUE_HOSTILE,
  DEVICE_RESOLUTION_PAIRS,
  DEVICE_MODE_CARRIED_HOSTILE,
  DEVICE_MODE_HOSTILE,
  DEVICE_MODE_READ_BENIGN,
  DEVICE_MODE_READ_PAIRS,
  DEVICE_OPERAND_HOSTILE,
  DEVICE_ORDINARY_BENIGN,
  DEVICE_READ_BENIGN,
  DEVICE_TAR_WRITE_HOSTILE,
  DEVICE_VERB_CARRIED,
  DEVICE_VERB_HOSTILE,
  DEVICE_VERB_NAMES,
  DEVICE_VERB_SAFE_BENIGN,
  DEVICE_VERB_TRAVERSAL,
  DEVICE_TERMINAL_ALREADY_BENIGN,
  DEVICE_TERMINAL_MASTER_RESIDUAL,
  DEVICE_TERMINAL_SERIAL_RESIDUAL,
  DEVICE_TERMINAL_SLAVE_BENIGN,
  TERMINAL_MASTER_TARGETS,
  TERMINAL_SLAVE_TARGETS,
  ORDINARY_OPERANDS,
  benignCorpus,
} from './fixtures/screen-corpus.js';

/**
 * ⭐⭐ F-2c-47 — THE RAW-DEVICE UNDER-BLOCK, AND `C-PR31` RE-MEASURED IN THE
 * SAME INVOCATION.
 *
 * The two are ONE predicate pulling opposite ways: `C-PR31` was 50 shapes the
 * screen refused that it should not, and this is 714 it allowed that it should
 * not. Closing this direction without re-measuring the benign one re-opens
 * `C-PR31` — so the over-block check lives in THIS file, over the corpus this
 * batch extended, and runs in the same `vitest` invocation as the tightening.
 * *A separate run is a different tree and proves nothing about this one.*
 *
 * ⭐ WHAT WAS MEASURED AT HEAD BEFORE ONE SOURCE CHARACTER CHANGED:
 *   hostile grid   714 of 714 ALLOWED   (34 verbs × 21 raw targets)
 *   traversal      136 of 136 ALLOWED   (the `..` clamp never reached)
 *   benign         0 of 2,094 refused   ⇒ the fences below were GREEN FIRST
 *
 * The benign halves being green BEFORE the fix is what makes them a fence
 * rather than a shape fitted to the outcome.
 */

const blocked = (r: string | null): boolean => r !== null;
const head = (c: string): boolean => blocked(matchesCatastrophic(c));

describe('F-2c-47 — a verb that writes to or alters a device node', () => {
  /**
   * ⭐ A ZERO MUST BE PROVED ABLE TO SEE A KNOWN INSTANCE. The screen is driven
   * on positive AND negative controls first, so neither side below can be a
   * blind constant.
   */
  test('the screen is LIVE in both directions', () => {
    for (const c of ['rm -rf /', 'mkfs.ext4 /dev/sda', 'echo x > /dev/sda']) {
      expect(head(c), `must block ${c}`).toBe(true);
    }
    for (const c of ['ls -la', 'git status', 'echo hello > /dev/null']) {
      expect(head(c), `must allow ${c}`).toBe(false);
    }
  });

  // ── the tightening ────────────────────────────────────────────────────────

  test('⭐⭐ every verb × every raw device is refused', () => {
    // floors: a corpus of zero proves nothing, and these are the two extents
    // the measurement rests on.
    expect(DEVICE_VERB_NAMES.length, 'the verb dimension must be broad').toBeGreaterThanOrEqual(30);
    expect(DEVICE_VERB_HOSTILE.length, 'the grid must be populated').toBeGreaterThanOrEqual(700);

    const escaped = DEVICE_VERB_HOSTILE.filter((c) => !head(c));
    expect(escaped, `raw-device writes still allowed:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  test('⭐ a documented READ-ONLY mode is not a licence: the destructive modes are refused', () => {
    expect(DEVICE_MODE_HOSTILE.length).toBeGreaterThanOrEqual(400);
    const escaped = DEVICE_MODE_HOSTILE.filter((c) => !head(c));
    expect(escaped, `a destructive mode slipped through a read-mode allowlist:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  test('⭐⭐ the `..` clamp reaches the new sites too', () => {
    expect(DEVICE_VERB_TRAVERSAL.length).toBeGreaterThanOrEqual(120);
    const escaped = DEVICE_VERB_TRAVERSAL.filter((c) => !head(c));
    expect(escaped, `traversal out of a role family via a verb:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  test('⭐ and it is not one reading of the plain form — every carrier is refused', () => {
    expect(DEVICE_VERB_CARRIED.length).toBeGreaterThanOrEqual(25);
    const escaped = DEVICE_VERB_CARRIED.filter((c) => !head(c));
    expect(escaped, `a carrier walked the core past the new rule:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  // ── the cost, measured in the SAME invocation ────────────────────────────

  test('⭐⭐ C-PR31 RE-MEASURED — the whole benign corpus is still refused nothing', () => {
    const corpus = benignCorpus();
    // the corpus must actually CONTAIN the class this batch newly refuses,
    // otherwise the zero is measured over a population that cannot hold one
    expect(corpus.length, 'benign corpus floor').toBeGreaterThanOrEqual(2000);
    const wrong = corpus.filter((c) => head(c));
    expect(wrong, `newly over-blocked ordinary commands:\n${wrong.slice(0, 20).join('\n')}`).toEqual([]);
  });

  test('⭐ the safe /dev roles survive the SAME 34 verbs (C-PR31 extended, not narrowed)', () => {
    expect(DEVICE_VERB_SAFE_BENIGN.length).toBeGreaterThanOrEqual(250);
    const wrong = DEVICE_VERB_SAFE_BENIGN.filter((c) => head(c));
    expect(wrong, `a safe /dev role was refused:\n${wrong.slice(0, 20).join('\n')}`).toEqual([]);
  });

  test('⭐⭐ READING a raw device stays allowed — imaging a disk is not destroying one', () => {
    expect(DEVICE_READ_BENIGN.length).toBeGreaterThanOrEqual(400);
    const wrong = DEVICE_READ_BENIGN.filter((c) => head(c));
    expect(wrong, `a legitimate device READ was refused:\n${wrong.slice(0, 20).join('\n')}`).toEqual([]);
  });

  test('⭐ and the 34 verbs doing ordinary work on ordinary paths are untouched', () => {
    expect(DEVICE_ORDINARY_BENIGN.length).toBeGreaterThanOrEqual(45);
    const wrong = DEVICE_ORDINARY_BENIGN.filter((c) => head(c));
    expect(wrong, `an ordinary command was refused:\n${wrong.slice(0, 20).join('\n')}`).toEqual([]);
  });

  /**
   * ⭐ THE DIRECTION IS PROVED, NOT ASSUMED. Every cell must be a genuine
   * `0.6.0 allow → HEAD block`, so this dimension is a GAIN against the
   * published artifact rather than a restoration of something 0.6.0 had.
   */
  test('the whole grid is a gain against the published 0.6.0', () => {
    const gains = DEVICE_VERB_HOSTILE.filter((c) => !blocked(matchesCatastrophic060(c)) && head(c));
    expect(gains.length).toBe(DEVICE_VERB_HOSTILE.length);
  });

  // ── the legs only a plant can catch ──────────────────────────────────────

  /**
   * ⭐⭐ F5 — WHICH RE-WRAP OF THIS FIX WOULD PASS EVERY LEG ABOVE?
   *
   * Adding a verb to the shipped table and no cell to the corpus. Nothing above
   * would notice, because nothing above would drive it — F-2c-46's M9 shape (a
   * new sink no test reaches) in this dimension. The corpus's verb set is
   * written independently of the table, so this comparison is a real
   * falsification rather than a tautology.
   */
  test('⭐⭐ every verb the SHIPPED table screens has a cell in the independent corpus', () => {
    const corpusVerbs = new Set(DEVICE_VERB_NAMES);
    const unexercised = [...DEVICE_WRITE_VERBS.keys()].filter((v) => !corpusVerbs.has(v));
    expect(
      unexercised,
      `these verbs are screened by the shipped table but no corpus cell drives them:\n${unexercised.join(', ')}`,
    ).toEqual([]);
    expect(DEVICE_WRITE_VERBS.size, 'the shipped table must not be silently emptied').toBeGreaterThanOrEqual(30);
  });

  /**
   * ⭐ AND THE OTHER HALF OF THE SAME LEG: a read-mode allowlist that names a
   * token which also appears in a destructive shape is the `-u` defect made
   * general. `fdisk -u` was in this allowlist while measuring, read as Linux's
   * "units in sectors"; on macOS it UPDATES THE MBR BOOT CODE.
   */
  test('⭐ no read-mode token is also a destructive mode in the hostile corpus', () => {
    const offenders: string[] = [];
    for (const [name, v] of DEVICE_WRITE_VERBS) {
      for (const mode of v.readModes ?? []) {
        const shape = DEVICE_MODE_HOSTILE.find(
          (c) => c.startsWith(`${name} `) && c.split(' ').includes(mode),
        );
        if (shape !== undefined) offenders.push(`${name}: '${mode}' appears in the destructive shape "${shape}"`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

/**
 * ⭐⭐ F-4 / SPY-302 — A POSITIONAL PROPERTY TESTED BY A SCAN OVER ALL OPERANDS
 * IS NOT A POSITIONAL PROPERTY.
 *
 * The read-mode exemption asked "does ANY argument look like a read mode?", so
 * an ordinary directory name disabled the entire raw-device screen:
 *
 *     tar cf /dev/disk0 etc   ->  ALLOWED
 *     tar cf /dev/disk0 usr   ->  refused "overwrite a block device"
 *
 * `etc` contains `t`, one of `tar`'s read letters, and `usr` does not. Nothing
 * about the spelling is unusual, which is exactly why no census, no name-level
 * diff and no count of verbs could see it — F-2c-47 closed this class at the
 * COVERAGE site and left the EXEMPTION unanchored.
 *
 * ⭐⭐ BOTH DIRECTIONS RUN HERE, IN ONE INVOCATION. The dangerous half and the
 * legitimate half are the same predicate pulled opposite ways: an anchor that
 * over-shoots refuses `tar xf /dev/rmt0`, which is `C-PR31`'s class. A separate
 * run is a different tree and proves nothing about this one.
 *
 * ⭐ MEASURED AT HEAD BEFORE ONE SOURCE CHARACTER CHANGED, over one population
 * of 1,888 dangerous and 3,102 legitimate cases:
 *     ordinary operand disables the screen   52 of 476 ALLOWED
 *     read-mode token carried destructively  44 of  56 ALLOWED
 *     legitimate read modes refused           0 of 224   ⇒ green FIRST
 */
describe('F-4 / SPY-302 — the read-mode exemption is anchored to the mode position', () => {
  /**
   * ⭐ THE CORPUS MUST BE ABLE TO DISTINGUISH. `ORDINARY_OPERANDS` is written as
   * project directory names, never as "words containing a read letter" — so the
   * floor that proves it REACHES the exemption is computed against the SHIPPED
   * table rather than restated. A list degenerate in either direction (all
   * colliding, or none colliding) cannot pass this gate.
   */
  test('⭐⭐ the ordinary-operand corpus holds both kinds, measured against the shipped table', () => {
    const letters = new Set(
      [...DEVICE_WRITE_VERBS.values()].flatMap((v) => [...(v.readLetters ?? '')]),
    );
    expect(letters.size, 'the shipped table must still define read letters').toBeGreaterThanOrEqual(1);
    const collides = ORDINARY_OPERANDS.filter((w) => [...letters].some((l) => w.includes(l)));
    const clean = ORDINARY_OPERANDS.filter((w) => ![...letters].some((l) => w.includes(l)));
    expect(collides.length, `ordinary names that collide with a read letter: ${collides.join(' ')}`).toBeGreaterThanOrEqual(8);
    expect(clean.length, `ordinary names that do not: ${clean.join(' ')}`).toBeGreaterThanOrEqual(8);
    expect(DEVICE_OPERAND_HOSTILE.length, 'the grid must be populated').toBeGreaterThanOrEqual(600);
  });

  test('⭐⭐ an ordinary operand does not disable the device screen', () => {
    const escaped = DEVICE_OPERAND_HOSTILE.filter((c) => !head(c));
    expect(escaped, `an ordinary directory name disabled the screen:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  test("⭐ every write mode tar's own synopsis defines is refused", () => {
    expect(DEVICE_TAR_WRITE_HOSTILE.length).toBeGreaterThanOrEqual(240);
    const escaped = DEVICE_TAR_WRITE_HOSTILE.filter((c) => !head(c));
    expect(escaped, `a tar write mode reached a raw device:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  test('⭐⭐ a read-mode token CARRIED by a destructive form is not a licence', () => {
    expect(DEVICE_MODE_CARRIED_HOSTILE.length).toBeGreaterThanOrEqual(200);
    const escaped = DEVICE_MODE_CARRIED_HOSTILE.filter((c) => !head(c));
    expect(escaped, `a mode word outside mode position disabled the screen:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  /** ⭐⭐ THE OTHER DIRECTION — same invocation, same predicate, opposite pull. */
  test('⭐⭐ a genuine read-mode invocation is STILL ALLOWED — the anchor must not over-shoot', () => {
    expect(DEVICE_MODE_READ_BENIGN.length).toBeGreaterThanOrEqual(1000);
    const wrong = DEVICE_MODE_READ_BENIGN.filter((c) => head(c));
    expect(wrong, `a documented READ-ONLY mode was refused:\n${wrong.slice(0, 20).join('\n')}`).toEqual([]);
  });

  /**
   * ⭐⭐ AND THE SAME DIRECTION PROVED NON-VACUOUS, BECAUSE A MUTATION CAUGHT ME.
   *
   * Anchoring the letters to argv[0] alone genuinely over-blocks `tar -v -xf DEV`
   * — and the first draft of the leg above passed that mutation 20/20, because
   * every cell in it was allowed for an unrelated reason (`-C`'s value displaces
   * the archive operand, so the device was never resolved and the exemption was
   * never consulted). A leg that cannot be reddened by a defect it exists to
   * catch is measuring nothing.
   *
   * Each pair is driven over the SAME option prefix: the write half must be
   * REFUSED, which proves the device really is resolved in that shape, and the
   * read half must then be ALLOWED, which proves the exemption is what allows it.
   */
  test('⭐⭐ each read cell is proved LOAD-BEARING by its own write twin', () => {
    expect(DEVICE_MODE_READ_PAIRS.length).toBeGreaterThanOrEqual(300);
    const vacuous = DEVICE_MODE_READ_PAIRS.filter((p) => !head(p.write));
    expect(
      vacuous.map((p) => p.write),
      `these write forms are NOT refused, so their read twin proves nothing:\n${vacuous.slice(0, 20).map((p) => p.write).join('\n')}`,
    ).toEqual([]);
    const overBlocked = DEVICE_MODE_READ_PAIRS.filter((p) => head(p.read));
    expect(
      overBlocked.map((p) => p.read),
      `a legitimate read was refused:\n${overBlocked.slice(0, 20).map((p) => p.read).join('\n')}`,
    ).toEqual([]);
  });

  /**
   * ⭐⭐ THE LEG ONLY A PLANT CAN CATCH. Which re-wrap of this fix passes
   * everything above? Adding a verb whose read modes are spelled as BARE
   * SUB-COMMAND WORDS and forgetting to say where they sit. Nothing above drives
   * it, so nothing above notices — and the exemption is unanchored again for
   * that verb, which is this very defect re-introduced under a new name.
   *
   * An option-spelled mode (`-l`, `--list`) needs no anchor: its own spelling
   * puts it in option position and an ordinary operand cannot equal it. A
   * bare-word mode is a sub-command and MUST declare `modeAt`.
   */
  test('⭐⭐ every bare-word read mode in the shipped table declares where it sits', () => {
    const unanchored: string[] = [];
    for (const [name, v] of DEVICE_WRITE_VERBS) {
      const bare = (v.readModes ?? []).filter((m) => !m.startsWith('-'));
      if (bare.length > 0 && v.modeAt === undefined) {
        unanchored.push(`${name}: bare-word read modes [${bare.join(', ')}] with no modeAt`);
      }
    }
    expect(
      unanchored,
      `these verbs exempt on a word that can appear anywhere in the argv:\n${unanchored.join('\n')}`,
    ).toEqual([]);
    // and the invariant is measured over a table that is not empty
    expect(
      [...DEVICE_WRITE_VERBS.values()].filter((v) => (v.readModes ?? []).some((m) => !m.startsWith('-'))).length,
      'no bare-word read mode is left in the table for this leg to police',
    ).toBeGreaterThanOrEqual(3);
  });

  /**
   * ⭐ THE DIRECTION IS PROVED, NOT ASSUMED. Every case this batch newly refuses
   * must be a genuine `0.6.0 allow -> HEAD block`, so the dimension is a GAIN
   * against the published artifact. This defect is a GAP, not a regression:
   * `0.6.0` allows all of these too.
   */
  test('⭐ every newly refused case is a gain against the published 0.6.0', () => {
    const newly = [...DEVICE_OPERAND_HOSTILE, ...DEVICE_MODE_CARRIED_HOSTILE];
    const gains = newly.filter((c) => !blocked(matchesCatastrophic060(c)) && head(c));
    expect(gains.length, 'a case refused here was already refused by 0.6.0').toBe(newly.length);
  });

  /**
   * ⭐⭐ THE DEBT, PINNED RATHER THAN OMITTED. Two further under-blocks were
   * DRIVEN and are NOT this defect's mechanism: a positional role shifted by an
   * option's VALUE, and `parted`'s `unit` modifier standing in for a read
   * command. They are filed, not folded in. Pinning them as ALLOWED with an
   * exact count keeps the debt loud — when either is fixed this goes red and
   * must be retired deliberately, rather than a silent omission reading as
   * "covered everything".
   */
  /**
   * ⭐⭐ THE PIN F-4 SET WENT RED, AND IT IS RETIRED DELIBERATELY — NOT LOOSENED.
   *
   * F-4 pinned seven shapes as KNOWN-ALLOWED with a literal floor, precisely so
   * that closing them would break this assertion rather than pass unnoticed.
   * F-5 closes ALL SEVEN — `tar --create --file=DEV`, `tar -C /tmp -cf DEV`,
   * `tar -X exclude.txt -cf DEV`, `parted -a optimal DEV mklabel gpt` (SPY-303)
   * and the three `parted DEV unit …` shapes (SPY-304) — so the assertion is
   * INVERTED with its new number: **147 of 147 now REFUSED, 0 remaining**.
   *
   * ⭐ Inverting rather than deleting is the point. A deleted pin would leave no
   * record that the debt was ever owed; this one now locks the debt as PAID and
   * turns red again if any of the seven ever regresses.
   */
  test('⭐⭐ F-5 — the F-4 residual pin is RETIRED: all 147 are now REFUSED, 0 remain', () => {
    expect(DEVICE_ANCHOR_RESIDUAL.length).toBeGreaterThanOrEqual(147);
    const stillAllowed = DEVICE_ANCHOR_RESIDUAL.filter((c) => !head(c));
    expect(
      stillAllowed,
      `F-4's residual was to be closed by F-5 and this one is still ALLOWED:\n${stillAllowed.slice(0, 20).join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * ⭐⭐ F-5 / SPY-303 + SPY-304 — WRITE-TARGET RESOLUTION, BOTH DIRECTIONS, ONE
 * INVOCATION.
 *
 * The two defects were filed separately and are genuinely two mechanisms — a
 * RESOLUTION that never finds the device, and an EXEMPTION that fires when it
 * should not. They are driven together because they are COUPLED, and the
 * coupling is measured rather than asserted: over the 630 composed cases,
 * closing SPY-303 alone still allows 504 (the case merely migrates to the
 * exemption) and closing SPY-304 alone still allows 630 (the device is never
 * resolved, so the exemption is never even consulted).
 *
 * ⭐ WHAT WAS MEASURED AT HEAD, BEFORE ONE SOURCE CHARACTER CHANGED, over one
 * population of 7,308 dangerous and 2,226 legitimate cases driven through the
 * shipped classifier as a PURE FUNCTION under a runtime that denied
 * child-process creation:
 *     dangerous allowed   3,087
 *     legitimate refused      0   ⇒ the fences below were GREEN FIRST
 *     INERT pairs           672   ⇒ read cells proving nothing, by SPY-303
 */
describe('F-5 / SPY-303 + SPY-304 — the write target is resolved, and a read token cannot vouch for a chain', () => {
  test("⭐⭐ an option's VALUE does not displace the device", () => {
    expect(DEVICE_OPTION_VALUE_HOSTILE.length).toBeGreaterThanOrEqual(370);
    const escaped = DEVICE_OPTION_VALUE_HOSTILE.filter((c) => !head(c));
    expect(escaped, `an option value shifted the device out of its role:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  test('⭐ every spelling of the archive flag is matched, including an ATTACHED value', () => {
    expect(DEVICE_ATTACHED_ARCHIVE_HOSTILE.length).toBeGreaterThanOrEqual(60);
    const escaped = DEVICE_ATTACHED_ARCHIVE_HOSTILE.filter((c) => !head(c));
    expect(escaped, `a long archive spelling was never matched:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  test("⭐⭐ the bundled argument ORDER is honoured — tar's own documentation", () => {
    expect(DEVICE_BUNDLED_ARG_HOSTILE.length).toBeGreaterThanOrEqual(80);
    const escaped = DEVICE_BUNDLED_ARG_HOSTILE.filter((c) => !head(c));
    expect(escaped, `the archive was resolved as another letter's argument:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  test('⭐⭐ a read token does not vouch for a destructive command chained after it', () => {
    expect(DEVICE_CHAIN_HOSTILE.length).toBeGreaterThanOrEqual(290);
    const escaped = DEVICE_CHAIN_HOSTILE.filter((c) => !head(c));
    expect(escaped, `a chained destructive command was exempted by a read token:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  /** ⭐⭐ THE CELL THAT PROVES THE TWO BELONG IN ONE BATCH. */
  test('⭐⭐ the two defects COMPOSED are refused — neither fix alone reaches these', () => {
    expect(DEVICE_COMPOSED_HOSTILE.length).toBeGreaterThanOrEqual(60);
    const escaped = DEVICE_COMPOSED_HOSTILE.filter((c) => !head(c));
    expect(escaped, `a composed case escaped — one of the two fixes is missing:\n${escaped.slice(0, 20).join('\n')}`).toEqual([]);
  });

  /** ⭐⭐ THE OTHER DIRECTION, in the SAME invocation and over the same predicate. */
  test('⭐⭐ every documented read is STILL ALLOWED — the resolution must not over-shoot', () => {
    expect(DEVICE_OPTION_VALUE_BENIGN.length).toBeGreaterThanOrEqual(500);
    const wrong = DEVICE_OPTION_VALUE_BENIGN.filter((c) => head(c));
    expect(wrong, `a documented READ-ONLY invocation was refused:\n${wrong.slice(0, 20).join('\n')}`).toEqual([]);
  });

  /**
   * ⭐⭐ AND EVERY READ CELL PROVED LOAD-BEARING BY ITS OWN WRITE TWIN.
   *
   * F-4 earned this leg when a genuine over-block passed 20/20 — every read cell
   * in its first draft was allowed for a reason UPSTREAM of the predicate. That
   * failure mode is not hypothetical here: at HEAD, 672 of the pairs below are
   * INERT, because SPY-303 stops the write half being refused. A corpus that
   * cannot reach the predicate cannot falsify it.
   */
  test('⭐⭐ each read cell is proved LOAD-BEARING by its write twin over the same prefix', () => {
    expect(DEVICE_RESOLUTION_PAIRS.length).toBeGreaterThanOrEqual(240);
    const inert = DEVICE_RESOLUTION_PAIRS.filter((p) => !head(p.write));
    expect(
      inert.map((p) => p.write),
      `these write forms are NOT refused, so their read twin measures nothing:\n${inert.slice(0, 20).map((p) => p.write).join('\n')}`,
    ).toEqual([]);
    const overBlocked = DEVICE_RESOLUTION_PAIRS.filter((p) => head(p.read));
    expect(
      overBlocked.map((p) => p.read),
      `a legitimate read was refused:\n${overBlocked.slice(0, 20).map((p) => p.read).join('\n')}`,
    ).toEqual([]);
  });

  /**
   * ⭐⭐ THE LEG ONLY A PLANT CAN CATCH.
   *
   * Which plausible re-wrap of THIS fix passes everything above? Adding a verb
   * that CHAINS — or giving an existing one a read mode — and forgetting to
   * declare what its destructive commands are. Nothing above drives a new verb,
   * so nothing above notices, and the exemption is unguarded again under a new
   * name. This walks the SHIPPED table and fails naming the verb, so it is
   * proved to have found the row rather than merely to have passed.
   */
  test('⭐⭐ every chaining verb declares what its destructive commands are', () => {
    const undeclared: string[] = [];
    for (const [name, v] of DEVICE_WRITE_VERBS) {
      if (v.chains !== true) continue;
      if ((v.destructiveCommands ?? []).length === 0) {
        undeclared.push(`${name}: chains, but declares no destructiveCommands`);
      }
    }
    expect(
      undeclared,
      `a chaining verb exempts on a read token with nothing to veto it:\n${undeclared.join('\n')}`,
    ).toEqual([]);
    // and the invariant is measured over a table that actually has chaining verbs
    expect(
      [...DEVICE_WRITE_VERBS.values()].filter((v) => v.chains === true).length,
      'no chaining verb is left in the table for this leg to police',
    ).toBeGreaterThanOrEqual(3);
  });

  /**
   * ⭐ THE SECOND PLANT-ONLY LEG. A verb whose write target is POSITIONAL and
   * which has value-taking options must declare them, or the option's value
   * silently becomes an operand again. `role: 'all'` verbs are exempt by
   * STRUCTURE — they screen every operand, so a miscounted one can only make
   * them screen more.
   */
  test('⭐⭐ every positional-role verb with a known value-taking option declares it', () => {
    const positional = new Set(['last', 'first', 'archive']);
    const missing: string[] = [];
    for (const [name, v] of DEVICE_WRITE_VERBS) {
      if (!positional.has(v.role)) continue;
      // the archive verbs and the option-bearing positional verbs measured in F-5
      if (['tar', 'pax', 'cpio', 'asr', 'parted', 'sfdisk', 'rsync', 'install', 'cp', 'mv', 'ln'].includes(name)
        && (v.valueOptions ?? []).length === 0) {
        missing.push(`${name}: role '${v.role}' with no valueOptions declared`);
      }
    }
    expect(
      missing,
      `an option's value will be counted as an operand for these verbs:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * ⭐ THE DIRECTION IS PROVED, NOT ASSUMED. Every case F-5 newly refuses must be
   * a genuine `0.6.0 allow -> HEAD block`. Both defects are a GAP against the
   * published artifact, not a regression: `0.6.0` has no device screen for any
   * of these shapes.
   */
  test('⭐ every case F-5 newly refuses is a gain against the published 0.6.0', () => {
    const newly = [
      ...DEVICE_OPTION_VALUE_HOSTILE,
      ...DEVICE_ATTACHED_ARCHIVE_HOSTILE,
      ...DEVICE_BUNDLED_ARG_HOSTILE,
      ...DEVICE_CHAIN_HOSTILE,
      ...DEVICE_COMPOSED_HOSTILE,
    ];
    const gains = newly.filter((c) => !blocked(matchesCatastrophic060(c)) && head(c));
    expect(gains.length, 'a case refused here was already refused by 0.6.0').toBe(newly.length);
  });

  /* ════════════════════════════════════════════════════════════════════════
   * ⭐⭐ F-7 / SPY-305 + SPY-306 — THE IDENTIFIER SPELLING, BOTH DIRECTIONS IN
   * THIS SAME INVOCATION.
   *
   * The screen modelled a device as *a path under `/dev/`*. Two utilities
   * declare otherwise in their own words, so 60 of 140 destructive cells were
   * ALLOWED purely because of how the device was spelled — while 20 documented
   * depth-2 READS were refused, and closing the first defect alone would have
   * taken that to 35. Both halves run here, over one population.
   * ════════════════════════════════════════════════════════════════════════ */

  test('⭐⭐ SPY-305 — a destructive command is REFUSED in EVERY spelling of its device', () => {
    const allowed = DEVICE_ID_HOSTILE.filter((c) => !head(c));
    expect(
      allowed.slice(0, 12),
      `${allowed.length} of ${DEVICE_ID_HOSTILE.length} destructive cells are ALLOWED`,
    ).toEqual([]);
    // ⭐ a literal floor, so emptying the corpus cannot make this pass
    expect(DEVICE_ID_HOSTILE.length, 'the spelling corpus shrank').toBeGreaterThanOrEqual(140);
  });

  /**
   * ⭐⭐ THE PAIRED CELL — the leg that makes the permissive side mean anything.
   * Each pair is ONE command in TWO spellings of the SAME object. A screen that
   * refuses only the `/dev/` half is spelling-blind, and that is precisely the
   * state this batch found. Neither half can pass by the subject failing to
   * arrive: the `/dev/` half proves the predicate is reached at all.
   */
  test('⭐⭐ SPY-305 — both spellings of one command agree, pair by pair', () => {
    const split = DEVICE_ID_PAIRS.filter((p) => head(p.node) !== head(p.bare));
    expect(
      split.map((p) => `${p.bare}  (node half ${head(p.node) ? 'REFUSED' : 'ALLOWED'})`),
      'a command is judged differently depending on how its device is spelled',
    ).toEqual([]);
    expect(DEVICE_ID_PAIRS.length, 'the pair corpus shrank').toBeGreaterThanOrEqual(20);
    // ⭐ and the node half must actually be REFUSED, or the pair agrees vacuously
    expect(DEVICE_ID_PAIRS.filter((p) => head(p.node)).length).toBe(DEVICE_ID_PAIRS.length);
  });

  test('⭐⭐ SPY-306 — every documented read stays ALLOWED, at BOTH depths and in BOTH spellings', () => {
    const refused = DEVICE_ID_READ_BENIGN.filter((c) => head(c));
    expect(refused, `${refused.length} documented reads are REFUSED`).toEqual([]);
    expect(DEVICE_ID_READ_BENIGN.length, 'the read corpus shrank').toBeGreaterThanOrEqual(56);
  });

  /**
   * ⭐⭐ WHAT BOUNDS THE FIX, AND THE REASON IT IS VERB-SCOPED. `disk9` is an
   * ordinary filename. Removing the scoping — letting any verb read a bare
   * identifier as a device — costs **21** of these cells, measured.
   */
  test('⭐⭐ an ordinary file named like an identifier is still ALLOWED', () => {
    const refused = DEVICE_ID_ORDINARY_BENIGN.filter((c) => head(c));
    expect(refused, `${refused.length} ordinary commands are REFUSED`).toEqual([]);
    expect(DEVICE_ID_ORDINARY_BENIGN.length, 'the ordinary corpus shrank').toBeGreaterThanOrEqual(39);
  });

  /**
   * ⭐⭐ THE LEG ONLY A PLANT CAN CATCH.
   *
   * Which plausible re-wrap of this fix passes every leg above? Add a verb whose
   * grammar accepts a bare identifier — or give an existing one a namespace —
   * and forget to declare it. Nothing else walks the shipped table looking for a
   * verb that CLAIMS a two-level vocabulary without a read set, so nothing else
   * would notice, and the exemption would be unanchored again under a new name.
   */
  test('⭐⭐ every namespace a verb declares carries a read set, and every read set is reachable', () => {
    const bad: string[] = [];
    for (const [name, v] of DEVICE_WRITE_VERBS) {
      if (v.namespaces === undefined) continue;
      if (v.modeAt !== 'first-argument') {
        bad.push(`${name}: declares namespaces but modeAt is '${String(v.modeAt)}' — they would never be consulted`);
      }
      for (const [ns, reads] of Object.entries(v.namespaces)) {
        if (reads.length === 0) bad.push(`${name}: namespace '${ns}' has an EMPTY read set`);
        for (const r of reads) {
          if (r.startsWith('-')) bad.push(`${name}: namespace '${ns}' read '${r}' is option-spelled, not a sub-verb`);
        }
      }
    }
    expect(bad, `a declared namespace cannot do its job:\n${bad.join('\n')}`).toEqual([]);
    // reached-assertion: a table with no namespaces at all would pass vacuously
    expect(
      [...DEVICE_WRITE_VERBS.values()].filter((v) => v.namespaces !== undefined).length,
      'no verb declares a namespace — this leg measured nothing',
    ).toBeGreaterThan(0);
  });

  /**
   * ⭐⭐ THE RESIDUAL, ASSERTED AS A DEBT RATHER THAN OMITTED.
   * `diskutil` documents `info[rmation]`; the long spelling is a real read this
   * screen still refuses, at both depths. Closing it turns this pin RED and
   * forces a deliberate retirement — a silent omission would read as
   * "covered everything".
   */
  test('⭐ RESIDUAL — the documented long spelling `information` is still REFUSED, and that is recorded', () => {
    const stillRefused = DEVICE_ABBREV_RESIDUAL.filter((c) => head(c));
    expect(
      stillRefused.length,
      'the `information` abbreviation was closed — retire this pin deliberately and update the count',
    ).toBe(DEVICE_ABBREV_RESIDUAL.length);
    expect(DEVICE_ABBREV_RESIDUAL.length, 'the residual corpus shrank').toBe(21);
  });

  test('⭐ every case F-7 newly refuses is a gain against the published 0.6.0', () => {
    const gains = DEVICE_ID_HOSTILE.filter((c) => !blocked(matchesCatastrophic060(c)) && head(c));
    expect(gains.length, 'a case refused here was already refused by 0.6.0').toBe(DEVICE_ID_HOSTILE.length);
  });
});

/**
 * ⭐⭐ F-9 / C44 — THE TERMINAL-DEVICE OVER-BLOCK, AND THE HALF OF IT THAT MUST STAY.
 *
 * Published `0.6.0` has no device screen at all, so every terminal node HEAD refuses
 * is a `0.6.0 allow -> HEAD block` cell — the only shape in F-8's adjudicated set where
 * HEAD is worse FOR THE USER than what they run today. Measured before one source
 * character changed: **252 of 267** distinct terminal-ish `/dev` nodes refused, with
 * **no override path** (the screen throws before approval and before the command rules).
 *
 * ⭐⭐ AND THE CLASS SPLITS, ON THE OPERATING SYSTEM'S OWN WORDS. `pty(4)`: *"anything
 * written on the primary device is given to the replica device as INPUT"*. So a write
 * to a pty PRIMARY is keystrokes into whatever runs on the replica — closing that would
 * be opening a command-injection path — while a write to a REPLICA is the ordinary
 * "display on that terminal" operation this screen ALREADY allows for `ttysN`.
 *
 * ⭐ The standing hostile corpus reports **0 escapes for every candidate**, including the
 * ones that unblock the primaries — because it is built from DISK targets and cannot
 * reach terminal injection at all. That zero is the corpus's silence, not a licence.
 */
describe('F-9 / C44 — terminal and pseudo-terminal device nodes', () => {
  test('⭐ the terminal corpus is populated and the two halves are disjoint', () => {
    expect(TERMINAL_SLAVE_TARGETS.length, 'the replica grid shrank').toBe(208);
    expect(TERMINAL_MASTER_TARGETS.length, 'the primary grid shrank').toBe(208);
    const overlap = TERMINAL_SLAVE_TARGETS.filter((t) => TERMINAL_MASTER_TARGETS.includes(t));
    expect(overlap.length, 'a node is both a replica and a primary').toBe(0);
    expect(DEVICE_TERMINAL_SLAVE_BENIGN.length).toBeGreaterThanOrEqual(1000);
  });

  test('⭐ FENCE — nodes this screen already treats as safe are allowed, before and after', () => {
    const refused = DEVICE_TERMINAL_ALREADY_BENIGN.filter((c) => head(c));
    expect(refused, 'an already-safe terminal node became refused').toEqual([]);
  });

  test('⭐⭐ a legacy pty REPLICA is an ordinary terminal and must be writable', () => {
    const refused = DEVICE_TERMINAL_SLAVE_BENIGN.filter((c) => head(c));
    expect(
      refused.length,
      'writing to a pty replica is the same role as writing to /dev/ttysNNN, which this screen allows',
    ).toBe(0);
  });

  test('⭐⭐ RESIDUAL — a pty PRIMARY stays REFUSED, because a write there is INPUT to another session', () => {
    const stillRefused = DEVICE_TERMINAL_MASTER_RESIDUAL.filter((c) => head(c));
    expect(
      stillRefused.length,
      'a pty primary became writable — that is a command-injection path, retire this pin deliberately',
    ).toBe(DEVICE_TERMINAL_MASTER_RESIDUAL.length);
    expect(DEVICE_TERMINAL_MASTER_RESIDUAL.length, 'the primary residual shrank').toBe(1040);
  });

  test('⭐ RESIDUAL — serial ports stay REFUSED: external hardware this host cannot verify', () => {
    const stillRefused = DEVICE_TERMINAL_SERIAL_RESIDUAL.filter((c) => head(c));
    expect(
      stillRefused.length,
      'a serial port became writable — decide that deliberately, it reaches hardware off this machine',
    ).toBe(DEVICE_TERMINAL_SERIAL_RESIDUAL.length);
    expect(DEVICE_TERMINAL_SERIAL_RESIDUAL.length, 'the serial residual shrank').toBe(30);
  });

  /**
   * ⭐⭐ THE LEG ONLY A PLANT CAN CATCH (F4). Which plausible re-wrap passes every leg
   * above? Widening the terminal allowlist by PREFIX — `/dev/tty` or `/dev/pty` matched
   * as a family rather than as a closed name shape — keeps every replica green and
   * silently admits every primary too. Nothing else asks the allowlist what SHAPE it is.
   */
  test('⭐⭐ the terminal allowlist admits a closed NAME SHAPE, never a /dev/pty prefix family', () => {
    const primaryProbes = ['/dev/ptyp0', '/dev/ptywf', '/dev/ptya0', '/dev/ptyef'];
    const admitted = primaryProbes.filter((t) => !head(`echo x > ${t}`));
    expect(
      admitted,
      'the allowlist matched a pty PRIMARY — it has been widened to a prefix family and now admits injection targets',
    ).toEqual([]);
    // and the replica of the SAME pair is allowed, so the leg cannot pass by refusing everything
    const replicas = primaryProbes.map((t) => t.replace('/dev/pty', '/dev/tty'));
    const refusedReplicas = replicas.filter((t) => head(`echo x > ${t}`));
    expect(refusedReplicas, 'the paired replica is refused — the leg would pass vacuously').toEqual([]);
  });

  test('⭐ every terminal cell this batch newly allows was allowed by the published 0.6.0 too', () => {
    const regressed = DEVICE_TERMINAL_SLAVE_BENIGN.filter((c) => blocked(matchesCatastrophic060(c)));
    expect(regressed, 'a cell this batch allows was REFUSED by 0.6.0 — that would be a weakening').toEqual([]);
  });

  test('⭐ the residual is a REGRESSION against 0.6.0 and is recorded as one, not hidden', () => {
    const stillWorseThan060 = [...DEVICE_TERMINAL_MASTER_RESIDUAL, ...DEVICE_TERMINAL_SERIAL_RESIDUAL]
      .filter((c) => head(c) && !blocked(matchesCatastrophic060(c)));
    expect(
      stillWorseThan060.length,
      'the residual stopped being a 0.6.0-allow -> HEAD-block set; re-derive the count',
    ).toBe(1070);
  });
});
