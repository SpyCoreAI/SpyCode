import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASELINE_FLAGS, BASELINE_VERSION, LAST_PUBLISHED_VERSION } from './fixtures/cli-flags-published-baseline.js';

/**
 * THE `## Unreleased` SECTION'S CHECKABLE CLAIMS, BOUND TO THE CODE.
 *
 * WHY THIS EXISTS - AND WHAT THE MEASUREMENT ACTUALLY SAID, because the
 * honest reason is narrower than the one that motivated it.
 *
 * The filed claim was "three consecutive batches shipped a false sentence in
 * the unreleased notes, each caught by a human re-read". Measured across every
 * commit that touched this file since the 0.6.0 publish point (`24da8bf3`), by
 * deriving the command set, the flag set and the dependency set at each commit
 * and comparing them to that baseline:
 *
 * F-2c-6  (introduced ## Unreleased)  no new commands=TRUE  no flag changes=TRUE  no dependency changes=TRUE
 * F-2c-7                              TRUE                  TRUE                  TRUE
 * F-2c-10                             TRUE                  TRUE                  TRUE
 * F-2c-26                             TRUE                  TRUE                  TRUE
 * F-2c-27                             TRUE                  TRUE                  TRUE
 * F-2c-28                             TRUE                  (claim removed)       TRUE
 * HEAD                                TRUE                  (claim removed)       TRUE
 *
 * **NO FALSE CHECKABLE CLAIM HAS EVER SHIPPED AT A COMMIT BOUNDARY.** Both
 * documented near-misses were made false and corrected INSIDE THE SAME COMMIT:
 * F-2c-27 changed the IPv6 loopback behaviour and removed "unchanged behaviour"
 * in `7183409d`; F-2c-28 added `--no-observe` and removed "no flag changes" in
 * `2fad93ba`. So this file is a BACKSTOP for a control that currently works and
 * depends on a person remembering - not a repair for a leak. It is worth having
 * because the human re-read is 2-for-2 and unowned, not because it has failed.
 *
 * WHAT THIS CAN SEE
 * 1. If the section claims "no flag changes", no entry under it may introduce
 * a flag. This is the exact shape that went false in `2fad93ba`.
 * 2. Every `--flag` the section names must be registered somewhere in the CLI.
 * `doc-claims.test.ts` binds ONE README section; nothing bound this file,
 * so a flag documented here that does not exist was invisible - review 1
 * #11 was that defect, in the README.
 *
 * WHAT IT STRUCTURALLY CANNOT SEE, stated so it is not mistaken for more:
 * · BEHAVIOUR claims. "IPv6 loopback receives no token, which is unchanged
 * behaviour" is the other measured near-miss and NOTHING here could catch
 * it: it is a statement about what the code does, not about what surface
 * exists. Most of the section is that kind of sentence.
 * · COMPLETENESS. Review 2's F-N9 says the section OMITS the largest changes.
 * An omission has no token to key on; this file cannot count silence.
 * · Whether a documented change actually happened, or happened as described.
 * ·  NEW COMMANDS. A "no new commands" arm was WRITTEN, RUN, AND REMOVED in
 * this same batch, and the reason is worth more than the test would have
 * been: a command named inside an `### Added` entry is usually an EXISTING
 * command being used to demonstrate the new thing - `spycore agent
 * --no-observe` names `agent`, which is not new. Nothing in changelog prose
 * distinguishes "this command is new" from "this command is the example",
 * so every derivation I tried was either always-green or false-red on the
 * real file. A gate that cannot tell those apart is decoration, and
 * decoration next to three real assertions is worse than a gap: it makes
 * the file look like it covers more than it does.
 * · The dependency claim: `dependencies` is checkable, but a bundled
 * transitive move is not, and the mirror ships a lockfile regenerated from
 * the live registry (review 1 #8), so "no dependency changes" is only ever
 * true of the manifest. It is therefore NOT asserted here - a gate that
 * implied otherwise would be decoration.
 */

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
// CRLF-NORMALISED AT THE READ. On a Windows checkout this file arrives with
// `\r\n`, and every anchor below is newline-bearing (`'\n## Unreleased'`), so an
// un-normalised read makes the whole file silently vacuous there.
// `tests/portable-line-endings.test.ts` caught this file the moment it was added.
const CHANGELOG = readFileSync(join(pkgDir, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');

const MANIFEST_VERSION = (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version;

/**
 * THE SUBJECT FOLLOWS THE RELEASE - R-CLI-7, closing .
 *
 * This helper used to be `unreleased()`: it read one literal `## Unreleased` heading, and
 * three assertions required that section to exist, to exceed 200 characters and to name a
 * flag.  **A RELEASE IS PRECISELY THE ACT OF EMPTYING THAT SECTION**, so the gate could
 * not survive the one event it sits next to. Measured during release testing: the honest
 * conversion turned three of these tests RED, and the only shape that reached green was a
 * changelog whose released section said nothing while its "Unreleased" section described
 * what had been released. The repository had already named the class in `scripts/release.sh`
 * - *"a pin that a correct procedure must break is not a pin, it is a tripwire in the
 * corridor."*
 *
 * THE FIX GAINS A SUBJECT; IT NEVER GIVES ONE UP. Wherever a `## Unreleased` section
 * exists it is still read, and still held to every assertion it was held to before - so no
 * assertion is weakened, none is deleted, and no state is excused. What changes is that the
 * section BEING RELEASED is read as well, and during a release it is the only one left.
 *
 * IT IS TOTAL, NOT AN EXCLUSION. An exclusion is not a filter, it is a hole in the
 * instrument (register #154), so there is no state in which this returns nothing: the list
 * is asserted non-empty, and while a release is in preparation the heading for the version
 * `package.json` names MUST exist. A bumped manifest whose notes were never written - or
 * were written under `### 0.7.0`, which this reader cannot see - is therefore RED, where a
 * quiet fallback to the placeholder would have been green.
 *
 * The three states, each reachable, each covered:
 * · STEADY DEVELOPMENT   manifest equals the published version -> `## Unreleased` alone.
 * The released section for that version is FROZEN HISTORY and is
 * deliberately NOT policed: it describes an artifact already on the
 * registry, which no edit in this tree can change.
 * · RELEASE PREPARATION  manifest ahead of the registry -> the section for the manifest's
 * version, which MUST exist, plus `## Unreleased` if a placeholder
 * was kept.
 * · AFTER THE PUBLISH    the fixture has moved to the new version and no new `## Unreleased`
 * heading has been opened yet -> the section for the manifest's
 * version.  This branch is why the fix does not simply MOVE the
 * tripwire one step later: demanding a fresh 200-character
 * `## Unreleased` immediately after a release, when there is by
 * definition nothing yet to report, would be the same defect in a
 * different hat.
 */
function sectionSlice(re: RegExp): string | null {
  const m = CHANGELOG.match(re);
  if (!m || m.index === undefined) return null;
  const start = m.index === 0 ? 0 : m.index - 1;
  const end = CHANGELOG.indexOf('\n## ', start + 1);
  return CHANGELOG.slice(start, end === -1 ? undefined : end);
}

/**
 * `^## X.Y.Z` with a right boundary, so `0.7.0` never matches the heading `## 0.7.0-rc.1`.
 *
 * THE BOUNDARY WAS WRONG THE FIRST TIME AND AN ATTACK ON THIS OWN FIX FOUND IT. It read
 * `(?![\d.])`, which excludes digits and dots but NOT the hyphen - so a tree whose manifest
 * said `0.7.0` while its notes sat under `## 0.7.0-rc.1` matched the prerelease heading and
 * every content arm passed over it. Only the sibling pin in `version-consistency.test.ts`
 * reddened, and a gate that depends on its neighbour to notice is not doing its own job.
 * Driven as attack A7 in adversarial testing.
 */
const headingRe = (v: string): RegExp => new RegExp('^## ' + v.replace(/\./g, '\\.') + '(?![\\w.-])', 'm');

/**
 * Every section of the shipped CHANGELOG whose claims are still THIS package's claims, each
 * carrying the heading it was found under so a failure names which section is wrong.
 *
 * THE VACUITY GUARD FOR EVERY LEG THAT CONSUMES THIS LIVES HERE, in one place: a caller
 * looping over an empty list would pass over an empty world, which is precisely how the
 * fixture beside it went inert once already.
 */
function sectionsUnderScrutiny(): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];

  const unrel = sectionSlice(/^## Unreleased\b/m);
  if (unrel !== null) out.push({ name: '## Unreleased', body: unrel });

  const preparing = cmpVersion(MANIFEST_VERSION, LAST_PUBLISHED_VERSION) > 0;
  const released = sectionSlice(headingRe(MANIFEST_VERSION));

  if (preparing) {
    expect(
      released,
      `package.json is ${MANIFEST_VERSION} while ${LAST_PUBLISHED_VERSION} is the published version, so this tree is preparing ${MANIFEST_VERSION} - but the CHANGELOG carries no released heading for it. Either the notes were never written, or they sit under a heading this reader cannot see (### ${MANIFEST_VERSION}, or one indented by spaces)`,
    ).not.toBeNull();
  }
  if (released !== null && (preparing || out.length === 0)) out.push({ name: `## ${MANIFEST_VERSION}`, body: released });

  expect(
    out.length,
    'no section is under scrutiny - the CHANGELOG carries neither an Unreleased heading nor a section for the version package.json names, so every assertion below would pass over an empty world',
  ).toBeGreaterThan(0);
  return out;
}

/**
 * The section is HARD-WRAPPED, so every claim match runs against a
 * whitespace-collapsed copy. An un-normalised regex reported "no flag changes"
 * ABSENT at a commit where it was present - the measurement that produced this
 * file was itself wrong the first time for exactly this reason.
 */
const flat = (s: string): string => s.replace(/\s+/g, ' ');

/** Every flag registered anywhere in the CLI, read from the commander sources. */
function registeredFlags(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name)) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/(?:new Option|\.option)\(\s*'([^']+)'/g)) {
          for (const tok of m[1]!.split(/[,\s]+/)) {
            if (/^--[a-z]/.test(tok)) out.add(tok.replace(/[<[].*$/, ''));
          }
        }
      }
    }
  };
  walk(join(pkgDir, 'src'));
  return out;
}

/** Flag tokens named inside a chunk of changelog prose. */
const flagsIn = (s: string): string[] =>
  [...new Set(s.match(/(?<![\w-])--[a-z][a-z0-9-]{1,24}(?![\w-])/g) ?? [])];

/**
 * F-12 - THE COMPARISON, AS A PURE FUNCTION, SO IT CAN BE DRIVEN.
 *
 * It used to be inline inside the claim-conditional test, which meant the only
 * way to exercise it was to edit the shipped CHANGELOG. So it was never
 * exercised, and nothing could show it was capable of failing. As a function it
 * can be driven with a planted divergence in each direction - see the plant leg.
 */
export function flagsAddedSinceBaseline(registered: Iterable<string>, baseline: Iterable<string>): string[] {
  const base = new Set(baseline);
  return [...registered].filter((f) => !base.has(f)).sort();
}

/** Whether the section makes the checkable "no flag changes" claim. */
export const claimsNoFlagChanges = (body: string): boolean => /no flag changes/i.test(flat(body));

/**
 * THE SAME REGEX `tests/version-consistency.test.ts` AND `scripts/release.sh`
 * USE. One rule, one place to be wrong: if these ever disagree, the version pin
 * and this gate disagree about what a released heading is, and neither would
 * say so. `## Unreleased` is deliberately NOT matched - it is a placeholder,
 * not a release, which is exactly why retaining it costs nothing.
 */
const RELEASED_HEADING = /^##\s+(\d+\.\d+\.\d+(?:-[\w.]+)?)\b/gm;

/** Every released `## X.Y.Z` heading in the shipped CHANGELOG, in file order. */
export function releasedHeadings(changelog: string = CHANGELOG): string[] {
  return [...changelog.matchAll(RELEASED_HEADING)].map((m) => m[1]!);
}

/**
 * A NUMERIC `X.Y.Z` COMPARISON, WRITTEN OUT RATHER THAN DEPENDED ON. Adding
 * a semver dependency to satisfy one gate would put a package in the shipped
 * closure for a test, and the shape here is already pinned by
 * `version-consistency.test.ts` to `\d+\.\d+\.\d+(?:-[\w.]+)?`.
 *
 * Returns <0, 0 or >0. A release outranks its own prerelease (`1.0.0` >
 * `1.0.0-rc.1`), which is the only prerelease rule this repository can reach -
 * two prereleases of the same core are ordered lexically, and that is stated
 * here rather than discovered later.
 */
export function cmpVersion(a: string, b: string): number {
  const parse = (v: string): { core: number[]; pre: string } => {
    const dash = v.indexOf('-');
    const core = (dash === -1 ? v : v.slice(0, dash)).split('.').map((n) => Number(n));
    return { core, pre: dash === -1 ? '' : v.slice(dash + 1) };
  };
  const A = parse(a);
  const B = parse(b);
  for (let i = 0; i < 3; i += 1) {
    const d = (A.core[i] ?? 0) - (B.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (A.pre === B.pre) return 0;
  if (A.pre === '') return 1;
  if (B.pre === '') return -1;
  return A.pre < B.pre ? -1 : 1;
}

describe('the CHANGELOG `## Unreleased` section states nothing the code refutes', () => {
  /**
   * REACHED-ASSERTION FOR THE WHOLE FILE. Every test below is a difference
   * against a derived set; if the derivation returns nothing, all of them pass
   * over an empty world. This is the arm that makes their zeros mean something.
   */
  test('CONTROL - the section parses and the flag derivation is not empty', () => {
    const sections = sectionsUnderScrutiny();

    const registered = registeredFlags();
    expect(registered.size, 'no flags parsed out of src/ - the derivation is blind').toBeGreaterThan(20);
    // Two flags that must exist, so a derivation that silently narrowed is red.
    expect(registered.has('--no-web'), 'the derivation cannot see a known flag').toBe(true);
    expect(registered.has('--json'), 'the derivation cannot see a known global flag').toBe(true);

    for (const s of sections) {
      expect(s.body.length, `the ${s.name} section is empty - every test below would be vacuous`).toBeGreaterThan(200);
      expect(flagsIn(s.body).length, `no flag tokens in the ${s.name} section - the claim tests would be vacuous`).toBeGreaterThan(0);
    }

    // THE RE-WRAP THIS FIX'S OWN ATTACK FOUND, AND THE LEG THAT ANSWERS IT.
    // Every assertion above passes on a changelog that duplicates the SAME body under both
    // `## Unreleased` and the released heading: each section is long enough, each names
    // flags, and every flag is registered. The document then says one body of work is
    // simultaneously released and not released - the same false-document family as the stub
    // shape, wearing the opposite disguise. Driven as attack A3 in adversarial testing:
    // GREEN before this leg existed, RED after.
    if (sections.length > 1) {
      const bodies = sections.map((s) => flat(s.body.slice(s.body.indexOf('\n', 1) + 1)).trim());
      expect(
        new Set(bodies).size,
        `two sections of the shipped CHANGELOG carry the same text (${sections.map((s) => s.name).join(' and ')}) - the same work cannot be both released and unreleased`,
      ).toBe(bodies.length);
    }
  });

  test('every flag the section names is registered somewhere in the CLI', () => {
    const registered = registeredFlags();
    for (const s of sectionsUnderScrutiny()) {
      const bogus = flagsIn(s.body).filter((f) => !registered.has(f));
      expect(
        bogus,
        `the shipped CHANGELOG's ${s.name} section names flags that no command registers - the review-1 #11 defect, in the file \`doc-claims.test.ts\` does not cover`,
      ).toEqual([]);
    }
  });

  /**
   * THE ARM THAT ACTUALLY CATCHES THE HISTORICAL NEAR-MISS - and the first
   * version of it did NOT, which is why this one exists.
   *
   * My first design keyed on the `### Added` entry: "if the summary says no
   * flag changes, no Added entry may name a flag". It was sound, cheap, and
   * **measured useless**: replayed against the real state at `7183409d` (the
   * CHANGELOG that still claimed "no flag changes", with `--no-observe` already
   * in `src/`), it reported 3 PASSED. At that commit the flag existed in the
   * CODE and no Added entry had been written yet - so the arm was looking at
   * the one place the defect was not.
   *
   * The claim is about the SURFACE, so it has to be checked against the
   * surface. That needs a baseline, which is the cost I had tried to avoid.
   */
  /**
   * F-12 - THE SELF-INVALIDATION PROMISE, MADE REACHABLE.
   *
   * The assertion existed - and sat BELOW a `return` taken whenever the
   * `## Unreleased` section does not contain the words "no flag changes". At
   * HEAD the section does NOT contain them (the claim was removed in `2fad93ba`
   * when `--no-observe` was added), so the early return fired and **the promise
   * was unreachable**. A version bump would have turned nothing red, and the
   * baseline could have silently outlived its subject.
   *
   * Measured before that repair: emptying `BASELINE_FLAGS` from 61 to 0 left
   * the whole package suite GREEN at 107 files / 1,710 passed.
   *
   * R-CLI-6 - AND THEN THE ANCHOR ITSELF WAS WRONG. Hoisting it made it
   * reachable and revealed that it was unsatisfiable: it compared
   * `package.json.version` with `BASELINE_VERSION`, i.e. asserted *"the manifest
   * version equals the last PUBLISHED version"*, which is false for the whole of
   * a release preparation. `prepublishOnly` runs this suite, so the gate aborted
   * the publish it was guarding, and `build-mirror.sh:182` turned it into
   * MIRROR-READY FAIL. `release.sh` had already solved the sibling pin BY ORDER
   * and wrote down why - *"a pin that a correct procedure must break is not a
   * pin, it is a tripwire in the corridor"* - and no ordering exists here,
   * because no arrangement of a bump and a publish makes the tree's version
   * equal the published version BEFORE the publish.
   *
   * The anchor is now `LAST_PUBLISHED_VERSION`, a second committed constant that
   * moves only at a publish.  It is a committed constant for the same reason
   * `BASELINE_FLAGS` is: this file ships to the public mirror, whose export tree
   * is an orphan snapshot with no `.git`, so a `git tag` read - or a network
   * read - would be silently vacuous exactly where the fixture exists to work.
   *
   * WHAT THIS ARM STRUCTURALLY CANNOT SEE, stated so it is not mistaken for
   * more. A publish leaves NO trace in the tree: immediately after publishing
   * 0.7.0 the working tree is byte-identical to the tree that was merely
   * *prepared* for 0.7.0. So no in-repository check can distinguish "bumped, not
   * yet published" from "published, and nobody moved the constant". Arm 3 below
   * therefore catches that staleness ONE RELEASE CYCLE LATE - at the next bump,
   * when the CHANGELOG would claim two releases the baseline does not know
   * about - and that latency is a property of the world, not a softening.
   */
  test(' the flag baseline cannot outlive its subject - UNCONDITIONALLY', () => {
    // ARM 1 - the frozen baseline describes the artifact that is ACTUALLY
    // published. This is the property the fixture promises, and it is
    // independent of `package.json` entirely.
    expect(
      BASELINE_VERSION,
      `the flag baseline was frozen at ${BASELINE_VERSION} but LAST_PUBLISHED_VERSION says ${LAST_PUBLISHED_VERSION} is on the registry - one of the two was moved without the other, so this fixture describes an artifact nobody published`,
    ).toBe(LAST_PUBLISHED_VERSION);

    const headings = releasedHeadings();

    // ARM 3a - a CROSS-SOURCE check against the shipped CHANGELOG, and the
    // NON-VACUITY GUARD for arm 3b: over an empty heading list arm 3b would
    // be trivially true, which is precisely how this fixture went inert before.
    expect(
      headings,
      `LAST_PUBLISHED_VERSION is ${LAST_PUBLISHED_VERSION} but the CHANGELOG carries no released \`## ${LAST_PUBLISHED_VERSION}\` heading - either the constant names a version that was never released, or the heading reader is blind`,
    ).toContain(LAST_PUBLISHED_VERSION);

    // ARM 3b - at most ONE release may sit above the published one: the one
    // currently being prepared. Two means a publish happened and nobody moved
    // LAST_PUBLISHED_VERSION.
    const above = headings.filter((v) => cmpVersion(v, LAST_PUBLISHED_VERSION) > 0);
    expect(
      above.length,
      `the CHANGELOG carries ${above.length} released headings above LAST_PUBLISHED_VERSION=${LAST_PUBLISHED_VERSION} (${above.join(', ')}) - at most one release may be in preparation, so either a publish went unrecorded or an abandoned release left its heading behind`,
    ).toBeLessThanOrEqual(1);
  });

  /**
   * THE ARM THE OLD SHAPE HAD AND A NAIVE FIX WOULD HAVE THROWN AWAY.
   *
   * Driven, not argued: with the old `package.json.version === BASELINE_VERSION`
   * assertion in place, downgrading the manifest to an ALREADY-PUBLISHED version
   * turned the gate RED. Re-pointing the check at `LAST_PUBLISHED_VERSION` alone
   * - the shape `Q1-GATE-FIX-SPECIFICATION.md` recommended - turns that case
   * GREEN, which is a capability REMOVAL rather than a fix. The mutation table in
   * Both runs were recorded during testing.
   *
   * It is also a genuine CROSS-SOURCE check - the shipped manifest against the
   * fixture - so the pair above is not a file compared with itself.
   */
  test(' the working tree is never BEHIND the version on the registry', () => {
    const version = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version as string;
    expect(
      cmpVersion(version, LAST_PUBLISHED_VERSION),
      `package.json is ${version} but ${LAST_PUBLISHED_VERSION} is already published - a tree older than the registry cannot be the source of the next release`,
    ).toBeGreaterThanOrEqual(0);
  });

  /**
   * THE LEG ONLY A PLANT CAN CATCH, FOR THE TWO HELPERS THE ARMS ABOVE ADD.
   *
   * Both arms are comparisons against derived values, and at HEAD every one of
   * them is satisfied. A comparator that always returned 0, or a heading reader
   * that always returned the whole list, would leave every arm above green and
   * nothing else in this file could tell. This drives them directly.
   */
  test(' PLANT: the version comparison and the heading reader can FAIL', () => {
    // (a) ordering, in BOTH directions and across each component
    expect(cmpVersion('0.7.0', '0.6.0'), 'a higher minor must sort above').toBeGreaterThan(0);
    expect(cmpVersion('0.6.0', '0.7.0'), 'a lower minor must sort below').toBeLessThan(0);
    expect(cmpVersion('1.0.0', '0.99.99'), 'major dominates minor and patch').toBeGreaterThan(0);
    expect(cmpVersion('0.6.1', '0.6.0'), 'patch is compared too').toBeGreaterThan(0);
    expect(cmpVersion('0.6.0', '0.6.0'), 'equal versions must compare equal').toBe(0);

    // (b) a release outranks its own prerelease - the only prerelease rule claimed
    expect(cmpVersion('1.0.0', '1.0.0-rc.1'), 'a release must outrank its prerelease').toBeGreaterThan(0);
    expect(cmpVersion('1.0.0-rc.1', '1.0.0'), 'and the reverse').toBeLessThan(0);

    // (c) the heading reader must SEE releases and must NOT see the placeholder
    const sample = '# x\n\n## Unreleased\n\nbody\n\n## 0.7.0 - 2026-08-27\n\nb\n\n## 0.6.0 - 2026-07-09\n';
    expect(releasedHeadings(sample), 'the reader must find every released heading, in file order').toEqual(['0.7.0', '0.6.0']);
    expect(releasedHeadings('# x\n\n## Unreleased\n\nbody\n'), '`## Unreleased` is not a release').toEqual([]);

    // (d) and it must be non-empty on the SHIPPED changelog, or arm 3a is the
    // only thing standing between this gate and a silent zero.
    expect(releasedHeadings().length, 'the shipped CHANGELOG parses to zero releases - the reader is blind').toBeGreaterThanOrEqual(6);
  });

  /**
   * F-12 - THE REACHED-ASSERTION THAT MAKES THE FIXTURE'S GREENS MEAN
   * SOMETHING. Without it, an emptied baseline is invisible: the comparison that
   * reads it is claim-conditional, so when the claim is absent nothing reads the
   * fixture at all.
   *
   * THE FLOOR IS A LITERAL AND THAT IS DELIBERATE. Deriving the expected
   * count from the fixture itself would be the defect rebuilt with more lines -
   * an expectation computed from the thing it checks cannot falsify it. 63 is
   * the count at the `0.7.0` publish point; if it shrinks, someone edited a
   * frozen baseline and that must be a deliberate act.
   *
   * The containment arm is a genuine CROSS-SOURCE check: the frozen fixture
   * against a live derivation from `src/`. It is non-vacuous only because of the
   * floor above it - over an empty baseline it would be trivially true, which is
   * precisely how this fixture went inert.
   */
  test(' the flag baseline is READ, non-empty, and still describes this CLI', () => {
    expect(
      BASELINE_FLAGS.length,
      'the frozen baseline has shrunk - a frozen fixture may only change by deliberate regeneration',
    ).toBeGreaterThanOrEqual(63);

    const registered = registeredFlags();
    const vanished = [...BASELINE_FLAGS].filter((f) => !registered.has(f)).sort();
    expect(
      vanished,
      'flags the published baseline registered are no longer registered anywhere - that is a REMOVED public flag and needs a deliberate decision',
    ).toEqual([]);
  });

  /**
   * The claim-conditional comparison. The `return` stays - the claim is a
   * CONDITIONAL claim and checking it when it is not made would be meaningless -
   * but it no longer gates anything else, and the skip is now JUSTIFIED BY AN
   * ASSERTION rather than taken silently. That is the shape
   * `path-containment.test.ts:300` already uses for its platform skip.
   */
  test('a "no flag changes" claim is refuted by the registered surface itself', () => {
    for (const s of sectionsUnderScrutiny()) {
      // The skip is justified before it is taken: the body must be real, so a
      // parse that silently returned nothing cannot masquerade as "claim absent".
      expect(s.body.length, `the ${s.name} body is empty - a skip here would be a parse failure, not an absent claim`).toBeGreaterThan(200);
      if (!claimsNoFlagChanges(s.body)) continue; // claim genuinely absent - nothing to check

      const added = flagsAddedSinceBaseline(registeredFlags(), BASELINE_FLAGS);
      expect(
        added,
        `the ${s.name} summary claims "no flag changes" while the CLI registers flags the published baseline does not have`,
      ).toEqual([]);
    }
  });

  /**
   * F-12 - THE LEG ONLY A PLANT CAN CATCH.
   *
   * Every arm above is a difference against a real set, and at HEAD the claim is
   * absent so the comparison never runs on real input. Nothing else in this file
   * can distinguish "the comparison is correct" from "the comparison is never
   * reached". This drives it directly, with a planted divergence in EACH
   * direction, so an edit that made it always-empty turns this red.
   */
  test(' PLANT: the flag comparison can actually FAIL, in both directions', () => {
    const baseline = ['--alpha', '--beta'];

    // (a) a flag registered that the baseline lacks → MUST be reported
    expect(
      flagsAddedSinceBaseline(['--alpha', '--beta', '--gamma'], baseline),
      'a planted added flag was not reported - the comparison is inert',
    ).toEqual(['--gamma']);

    // (b) nothing beyond the baseline → MUST be empty
    expect(
      flagsAddedSinceBaseline(['--alpha', '--beta'], baseline),
      'the comparison reports a divergence where there is none',
    ).toEqual([]);

    // (c) and the claim detector must discriminate, or the arm above is
    // unreachable for a reason no assertion would show.
    expect(claimsNoFlagChanges('- summary: no flag changes in this release'), 'claim present not detected').toBe(true);
    expect(claimsNoFlagChanges('- summary: adds --no-observe to the agent'), 'claim absent read as present').toBe(false);
    // hard-wrapped prose is the shape that once made this detector wrong
    expect(claimsNoFlagChanges('- summary: no flag\n  changes at all'), 'a hard-wrapped claim must still be detected').toBe(true);
  });
});
