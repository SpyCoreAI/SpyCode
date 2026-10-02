import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * F-2c-10 §2 — THE WINDOWS PATH IDIOM, CLOSED AS A CLASS RATHER THAN AT 16
 * CALL SITES.
 *
 * PROPERTY: a `file:` URL is turned into a filesystem path with
 * `fileURLToPath()`, never by reading `.pathname`.
 *
 * ⭐ WHY IT MATTERS, MEASURED RATHER THAN ARGUED. On Windows
 * `new URL('..', import.meta.url).pathname` yields `/D:/…`; `join()` then
 * produces the doubled-drive path `D:\D:\a\SpyCore\…`, which `readdirSync`
 * and `readFileSync` cannot open. In the `CLI Build` run at `bd8c3c8a` that
 * single idiom produced **76 doubled-drive paths in one job log** and 20 of the
 * 25 Windows failures, across `display-sink-reach` and
 * `codebase-guide-changelog` — suites whose subject has nothing to do with
 * paths. A test that fails for a reason unrelated to the property it guards is
 * not a control; it is noise that teaches people to ignore red, which is what
 * cost this project 126 consecutive runs.
 *
 * ⭐⭐ THE REPOSITORY ALREADY KNEW THE FIX AND HAD WRITTEN IT DOWN.
 * `tests/child-process-lifecycle.test.ts:189` carries the comment *"fileURLToPath,
 * not URL.pathname: on Windows the latter yields `/C:/…`"* and uses the correct
 * form. Sixteen occurrences across three files still used the broken one. A
 * convention that is written in a comment and enforced nowhere is a suggestion.
 *
 * ⭐ WHY AN AST SCAN AND NOT A GREP. Four `.pathname` lines in this package are
 * the COMMENT that documents the correct form. A grep counts those and reports
 * a class that is 4 larger than it is; a grep also counted a 17th occurrence
 * that lives inside a TEMPLATE LITERAL in `scripts/debug-bench/scenarios/s1.mjs`
 * — generated fixture text, not code this package runs. Structure decides.
 *
 * DECLARED BLIND SPOTS, stated rather than discovered later:
 *   1. A `URL` passed ACROSS A FUNCTION BOUNDARY and `.pathname`-read there.
 *      (The two-hop form WITHIN one file is caught — proven by the plant below.)
 *   2. `.pathname` on a URL built from a string that merely looks like a file
 *      URL, with no `import.meta.url` in the expression.
 *   3. Anything outside `packages/cli`.
 */

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKIP = /node_modules|[/\\](dist|build|coverage)[/\\]|\.turbo/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (SKIP.test(p)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|mjs|cjs|js)$/.test(p)) out.push(p);
  }
  return out;
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly form: 'direct' | 'two-hop';
}

/**
 * Count the class. `extraFiles` injects virtual sources so the instrument can
 * be PROVEN able to see a known-real instance before any zero it reports is
 * believed (digest 27 / register #108).
 */
function censusPathname(extraFiles: Readonly<Record<string, string>> = {}): {
  hits: Hit[];
  filesScanned: number;
} {
  const parsed = walk(PKG_ROOT)
    .sort()
    .map((f) => ({
      rel: relative(PKG_ROOT, f).replace(/\\/g, '/'),
      sf: ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.ES2022, true,
        f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
    }));
  for (const [rel, text] of Object.entries(extraFiles))
    parsed.push({ rel, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS) });

  const hits: Hit[] = [];
  for (const { rel, sf } of parsed) {
    const isFileUrlCtor = (n: ts.Node): boolean =>
      ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'URL' &&
      (n.arguments ?? []).some((a) => /import\.meta\.url/.test(a.getText(sf)));

    // Identifiers bound to a file: URL — the TWO-HOP form.
    const urlVars = new Set<string>();
    const seed = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
          isFileUrlCtor(n.initializer)) urlVars.add(n.name.text);
      ts.forEachChild(n, seed);
    };
    seed(sf);

    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n) && n.name.text === 'pathname') {
        const obj = n.expression;
        const form: Hit['form'] | null = isFileUrlCtor(obj)
          ? 'direct'
          : ts.isIdentifier(obj) && urlVars.has(obj.text)
            ? 'two-hop'
            : null;
        if (form) hits.push({ file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1, form });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { hits, filesScanned: parsed.length };
}

describe('§2 portable paths — a file: URL never becomes a path via .pathname', () => {
  /**
   * ⭐⭐ F-14 — AN EXPLICIT DEADLINE, BECAUSE THE GLOBAL ONE HAS ALREADY BLOWN HERE.
   *
   * This arm runs the whole AST census FOUR times (once per planted probe), so
   * it is the most expensive test in the file by construction. Measured from the
   * `CLI Build` job logs across four shas: 1 841-4 279 ms on the four supported
   * legs, 6 049 ms on windows/Node 22, and at `5972f29d` it **exceeded the
   * 10 000 ms global cap on windows/Node 20 and turned the leg red**.
   *
   * ⭐ It is green today only because F-13's skip removed three spawn-and-fail
   * arms from that run and reduced contention — green by luck, not by repair.
   *
   * ⭐ 60 000 ms is derived, not habitual: the worst same-leg run-to-run swing
   * measured anywhere in this suite is 7.39x, and 7.39 x 6 049 = 44 702 ms. The
   * deadline covers the worst swing ever measured applied to the worst duration
   * ever measured, and still fails a genuine hang. What it stops catching is a
   * slowdown of under ~10x in the census itself.
   *
   * ⭐ THIS IS A DEADLINE, NOT A CONTROL — not one assertion below changes.
   */
  test('W1 THE INSTRUMENT FIRST: the census re-finds a known-real instance, both forms, and has no false positive', { timeout: 60_000 }, () => {
    // ⭐⭐ A census that cannot re-find a known-real defect is blind, and a clean
    // result from a blind census is the most dangerous output available. This
    // runs BEFORE W2 believes any zero.
    const direct = censusPathname({
      '__probe_direct.ts': "import { join } from 'node:path';\nexport const R = join(new URL('..', import.meta.url).pathname, 'src');\n",
    }).hits.filter((h) => h.file === '__probe_direct.ts');
    expect(direct, 'the census cannot see the exact live shape it was built for — it is blind').toHaveLength(1);
    expect(direct[0]?.form).toBe('direct');

    const twoHop = censusPathname({
      '__probe_twohop.ts': "const u = new URL('../src', import.meta.url);\nexport const p = u.pathname;\n",
    }).hits.filter((h) => h.file === '__probe_twohop.ts');
    expect(twoHop, 'the two-hop form is invisible — declared blind spot 1 is wider than stated').toHaveLength(1);

    // …and the CORRECT form must not be flagged, or W2 is unsatisfiable.
    const correct = censusPathname({
      '__probe_correct.ts': "import { fileURLToPath } from 'node:url';\nexport const R = fileURLToPath(new URL('../src/', import.meta.url));\n",
    }).hits.filter((h) => h.file === '__probe_correct.ts');
    expect(correct, 'the documented CORRECT form is reported as a defect').toHaveLength(0);

    // …nor is `.pathname` on a URL that is not a file: URL (that is legitimate).
    const http = censusPathname({
      '__probe_http.ts': "export const p = new URL('https://example.com/a/b').pathname;\n",
    }).hits.filter((h) => h.file === '__probe_http.ts');
    expect(http, 'a non-file URL .pathname read is flagged — false positive').toHaveLength(0);
  });

  test('W2 the class is EMPTY across the whole package', () => {
    const { hits, filesScanned } = censusPathname();
    // Reached-assertion: a census that walked nothing reports zero for the
    // wrong reason.
    expect(filesScanned, 'walked almost no files — this gate measured nothing').toBeGreaterThan(250);
    expect(
      hits.map((h) => `${h.file}:${h.line} [${h.form}]`),
      'a file: URL is being turned into a path via .pathname again — on Windows this yields /D:/… and produces D:\\D:\\…\nUse fileURLToPath(new URL(…, import.meta.url)) instead.',
    ).toEqual([]);
  });

  test('W3 the convention is WRITTEN DOWN where a reader will meet it', () => {
    // ⭐ The idiom survived 16 times precisely because the rule lived only in a
    // comment on one unrelated test. Pin that the comment still exists, so the
    // gate above and the prose that explains it cannot drift apart.
    const doc = readFileSync(join(PKG_ROOT, 'tests', 'child-process-lifecycle.test.ts'), 'utf8');
    expect(doc.length, 'read no source — vacuous').toBeGreaterThan(1000);
    expect(
      doc,
      'the comment naming the correct form is gone — W2 now enforces a rule nothing explains',
    ).toContain('fileURLToPath, not URL.pathname');
  });
});
