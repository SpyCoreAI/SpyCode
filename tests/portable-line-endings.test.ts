import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * F-2c-11 §3 — THE LINE-ENDING CLASS, CLOSED AS A CLASS.
 *
 * PROPERTY: a value read from REPOSITORY text and then compared against a
 * pattern containing a literal newline is CRLF-normalised at the read.
 *
 * ⭐ WHY IT MATTERS, MEASURED RATHER THAN ARGUED. Git checks this repository
 * out with CRLF on Windows. A pattern that spans a line break therefore matches
 * nothing there, and the failure names the assertion rather than the cause:
 * `expected 'import chalk from \'chalk\';\r\nimpor…' to match /export function
 * print\(msg: string\):…/`. In the `CLI Build` run at `25c8f21b` this produced
 * two of the eight Windows failures (B7 and B8 in `display-sink-reach`) — in a
 * suite whose subject has nothing to do with line endings.
 *
 * ⭐⭐ THE REPOSITORY ALREADY KNEW THE FIX AND HAD WRITTEN IT DOWN — the same
 * shape as the path idiom F-2c-10 closed. `scripts/gen-third-party-licenses.mjs`
 * has read `.replace(/\r\n/g, '\n')` at the read since it was written, and
 * `src/lib/sanitize-display.ts` and `src/lib/git-generate.ts` both normalise the
 * same way. Seven reads did not. A convention used in three places and enforced
 * in none is a habit, not a rule.
 *
 * ⭐ WHY THE TOLERANT FORM IS CLOSED TOO. `text.split('\n')` does not fail on
 * CRLF — it leaves a trailing `\r` on every line, which today's consumers
 * happen to trim. That is a latent defect, and F-2c-10 §6d is the reason it is
 * fixed anyway: **a latent defect becomes a real one the moment something
 * starts depending on its result.** Gating only the load-bearing form would
 * require the gate to keep a load-bearing/tolerant distinction that rots.
 * Normalising every newline-compared repository read gives the gate a fixed
 * point instead, which is the property TRIAGE-1 found the old rule #1 lacked.
 *
 * DECLARED BLIND SPOTS, stated rather than discovered later:
 *   1. A read whose result crosses a FUNCTION BOUNDARY before being compared.
 *   2. A pattern built by concatenation or interpolation rather than one literal.
 *   3. Content that reaches the comparison by some route other than a
 *      `readFileSync`/`readFile` bound to a variable — e.g. a spawn's stdout.
 *   4. Anything outside `packages/cli`.
 */

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = /node_modules|[/\\](dist|build|coverage)[/\\]|\.turbo/;

/** Contiguous match — an interposed `\r` breaks these outright. */
const LOAD_BEARING = new Set(['includes', 'toMatch', 'toContain', 'toBe', 'toEqual',
  'startsWith', 'endsWith', 'indexOf', 'match', 'search', 'lastIndexOf']);
/** The `\r` survives into a per-line value instead of breaking the match. */
const TOLERANT = new Set(['split', 'replace', 'replaceAll']);

/** Identifiers that name a path inside the checkout rather than a scratch dir. */
const REPO_ROOTED = /\b(REPO_ROOT|PKG_ROOT|pkgDir|srcRoot|DENYLIST|GUIDE|planPath|guidePath|SCRIPT)\b/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (SKIP.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|cjs|js)$/.test(p)) out.push(p);
  }
  return out;
}

function bearsNewline(node: ts.Node | undefined, sf: ts.SourceFile): boolean {
  if (!node) return false;
  const t = node.getText(sf);
  if (ts.isRegularExpressionLiteral(node)) return /\\n/.test(t);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return /\\n/.test(t) || /\n/.test(node.text);
  if (ts.isTemplateExpression(node)) return /\\n/.test(t) || /\n/.test(t);
  return false;
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly form: string;
  readonly bucket: 'LOAD-BEARING' | 'tolerant' | 'other';
}

interface Decl {
  readonly name: string;
  readonly pos: number;
  readonly normalised: boolean;
}

/**
 * ⭐⭐ SCOPE-RESOLVED, AND THE FIRST VERSION WAS NOT.
 *
 * The first form kept ONE SET OF NAMES PER FILE. `display-sink-reach.test.ts`
 * declares `const src = readFileSync(…)` in many different tests, so a single
 * un-normalised `src` anywhere in the file made EVERY `src` in it read as
 * un-normalised — and the class still reported five members after all seven had
 * been fixed. That is F-2c-10 §1a error 2 ("the receiver was keyed on a name")
 * reproduced exactly, in a new instrument, by the same author. Each use is now
 * resolved to the declaration that actually reaches it, and a probe below plants
 * the shadowing case specifically.
 */
interface Parsed {
  readonly rel: string;
  readonly sf: ts.SourceFile;
}

/**
 * ⭐ PARSED ONCE, REUSED. L1 calls the census seven times and each call used to
 * re-walk and re-parse all ~268 files. Measured on `linux/amd64` under emulation
 * that pushed L1 past vitest's 10 s default and it failed as a TIMEOUT — a test
 * failing for a reason unrelated to the property it guards, which is the exact
 * shape this suite exists to remove. The tree does not change during a run.
 */
let baseParse: Parsed[] | null = null;
function parseTree(): Parsed[] {
  if (!baseParse)
    baseParse = walk(PKG_ROOT)
      .sort()
      .map((f) => ({
        rel: relative(PKG_ROOT, f).replace(/\\/g, '/'),
        sf: ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.ES2022, true,
          f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
      }));
  return baseParse;
}

function censusLineEndings(extraFiles: Readonly<Record<string, string>> = {}): {
  hits: Hit[];
  filesScanned: number;
  repoReads: number;
} {
  const parsed: Parsed[] = [...parseTree()];
  for (const [rel, text] of Object.entries(extraFiles))
    parsed.push({ rel, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS) });

  const hits: Hit[] = [];
  let repoReads = 0;
  for (const { rel, sf } of parsed) {
    const decls: Decl[] = [];
    const seed = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
        const init = n.initializer.getText(sf);
        const isRead = /\breadFileSync\s*\(/.test(init) || /\bawait\s+readFile\s*\(/.test(init);
        // Only text git checks out can arrive as CRLF; a file the test itself
        // writes into a mkdtemp dir always has \n and is not a class member.
        const repoPath = /import\.meta\.url/.test(init) || REPO_ROOTED.test(init);
        if (isRead && repoPath) {
          repoReads++;
          decls.push({ name: n.name.text, pos: n.getStart(sf), normalised: /replace\(\s*\/\\r/.test(init) });
        }
      }
      ts.forEachChild(n, seed);
    };
    seed(sf);

    const reaching = (name: string, usePos: number): Decl | null => {
      let best: Decl | null = null;
      for (const d of decls)
        if (d.name === name && d.pos < usePos && (!best || d.pos > best.pos)) best = d;
      return best;
    };

    const consider = (n: ts.Node, ident: ts.Identifier, method: string): void => {
      const d = reaching(ident.text, ident.getStart(sf));
      if (!d || d.normalised) return;
      hits.push({
        file: rel,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        form: method,
        bucket: LOAD_BEARING.has(method) ? 'LOAD-BEARING' : TOLERANT.has(method) ? 'tolerant' : 'other',
      });
    };

    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        const recv = n.expression.expression;
        if (ts.isIdentifier(recv))
          for (const a of n.arguments)
            if (bearsNewline(a, sf)) { consider(n, recv, n.expression.name.text); break; }
      }
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
          ts.isCallExpression(n.expression.expression)) {
        const inner = n.expression.expression;
        if (ts.isIdentifier(inner.expression) && inner.expression.text === 'expect') {
          const subj = inner.arguments[0];
          if (subj && ts.isIdentifier(subj))
            for (const a of n.arguments)
              if (bearsNewline(a, sf)) { consider(n, subj, n.expression.name.text); break; }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { hits, filesScanned: parsed.length, repoReads };
}

const only = (name: string, src: string): Hit[] =>
  censusLineEndings({ [name]: src }).hits.filter((h) => h.file === name);

const REPO_READ = "readFileSync(new URL('../x', import.meta.url),'utf8')";

describe('§3 portable line endings — repository text is CRLF-normalised at the read', () => {
  /**
   * ⭐⭐ F-14 — AN EXPLICIT DEADLINE. THIS ARM IS RED AT HEAD ON ONE LEG.
   *
   * Measured from the `CLI Build` job logs across four shas: 1 922-3 813 ms on
   * the four supported legs, 5 057 ms on windows/Node 22 — and **10 639 ms on
   * windows/Node 20 at `9d4a79d9`, where it exceeded the 10 000 ms global cap
   * and failed.** It is a member of the same class as `portable-paths.test.ts`
   * W1, which blew the same cap one sha earlier on the same leg: the two swap
   * places depending on what else is running.
   *
   * ⭐ 60 000 ms is derived: the worst same-leg run-to-run swing measured
   * anywhere in this suite is 7.39x, and 7.39 x 5 057 = 37 371 ms. What it stops
   * catching is a slowdown of under ~12x in the census itself.
   *
   * ⭐ THIS IS A DEADLINE, NOT A CONTROL — not one assertion below changes.
   */
  test('L1 THE INSTRUMENT FIRST: the census re-finds known-real shapes and has no false positive', { timeout: 60_000 }, () => {
    // ⭐⭐ A census that cannot re-find a known-real defect is blind, and a
    // clean result from a blind census is the most dangerous output available.
    // This runs BEFORE L2 believes any zero.
    expect(only('__p_includes.ts', `const s = ${REPO_READ};\nexport const o = s.includes('a\\nb');\n`),
      'the B7 shape (contiguous includes) is invisible — the census is blind').toHaveLength(1);
    expect(only('__p_match.ts', `const s = ${REPO_READ};\nexpect(s).toMatch(/a\\nb/);\n`),
      'the B8 shape (expect().toMatch) is invisible — the census is blind').toHaveLength(1);

    // …and none of the legitimate forms may be flagged, or L2 is unsatisfiable.
    expect(only('__p_norm.ts', `const s = ${REPO_READ}.replace(/\\r\\n/g,'\\n');\nexport const o = s.includes('a\\nb');\n`),
      'the documented CORRECT form is reported as a defect').toHaveLength(0);
    expect(only('__p_tmp.ts', "const s = readFileSync(join(tmp,'x'),'utf8');\nexport const o = s.includes('a\\nb');\n"),
      'a scratch-dir read is flagged — that text can never be CRLF').toHaveLength(0);
    expect(only('__p_plain.ts', `const s = ${REPO_READ};\nexport const o = s.includes('plain');\n`),
      'a pattern with no newline is flagged — false positive').toHaveLength(0);

    // ⭐⭐ THE SHADOWING PROBE, AND THE FIRST VERSION OF IT WAS BLIND.
    // The first version used two DIFFERENT names (`s` and `s2`), so name-keying
    // could never confuse them and the probe passed under the very defect it
    // was written to catch — proven by mutation L-M4, which reddened L2 and left
    // this pin green. It must reuse ONE name: an earlier un-normalised `s` and a
    // later normalised `s` in an inner scope. Correct scope resolution flags the
    // first use only; the name-keyed form poisons both and reports 2.
    const shadowed = only('__p_shadow.ts',
      `const s = ${REPO_READ};\n` +
      "export const o1 = s.includes('a\\nb');\n" +
      `{ const s = ${REPO_READ}.replace(/\\r\\n/g,'\\n');\n` +
      "  globalThis.o2 = s.includes('a\\nb'); }\n");
    expect(
      shadowed.map((h) => h.line),
      'the census is name-keyed rather than scope-resolved: a later normalised ' +
        'declaration of the same name is being judged by an earlier raw one',
    ).toEqual([2]);
  });

  test('L2 the class is EMPTY across the whole package', () => {
    const { hits, filesScanned, repoReads } = censusLineEndings();
    // Reached-assertions: a census that walked nothing, or found no repository
    // reads at all, reports zero for the wrong reason.
    expect(filesScanned, 'walked almost no files — this gate measured nothing').toBeGreaterThan(250);
    expect(repoReads, 'found no repository-text reads at all — the discriminator is broken').toBeGreaterThan(20);

    expect(
      hits.map((h) => `${h.file}:${h.line} .${h.form}() [${h.bucket}]`),
      'repository text is being compared against a newline-bearing pattern without ' +
        'CRLF normalisation. On a Windows checkout that text arrives as \\r\\n and the ' +
        "comparison cannot match. Normalise at the read: .replace(/\\r\\n/g, '\\n') — " +
        'the form scripts/gen-third-party-licenses.mjs has always used.',
    ).toEqual([]);
  });

  test('L3 the convention is WRITTEN DOWN where a reader will meet it', () => {
    // ⭐ The path idiom survived sixteen times because its rule lived only in a
    // comment on one unrelated test. Pin that the explanation still sits at the
    // site that pays for it, so L2 cannot end up enforcing a rule nothing states.
    const doc = readFileSync(join(PKG_ROOT, 'tests', 'display-sink-reach.test.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(doc.length, 'read no source — vacuous').toBeGreaterThan(1000);
    expect(
      doc,
      'the comment naming the CRLF form is gone — L2 now enforces a rule nothing explains',
    ).toContain('CRLF-normalised at the READ');
  });
});
