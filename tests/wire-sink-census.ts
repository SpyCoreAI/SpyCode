import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * THE WIRE→SINK CENSUS — the class counted by PROPERTY, at current state.
 *
 * Property: **a value that arrived over the wire reaches a rendering surface
 * without passing the sanitizer.**
 *
 * ⭐⭐ WHY THIS EXISTS AND WHY IT IS NOT KEYED ON NAMES OF COMMANDS.
 * F-2c-7 closed the display-sink class at 62 sites and recorded it closed. Its
 * census keyed on COMMANDS, so three sibling modules in one directory were
 * never swept, and the class recorded closed at 62 was closed at 62 *of the
 * sites it counted* — nine live holes survived into a published package
 * (SPY-248). Keying on DIRECTORIES would merely move the blind spot to the
 * next sibling somewhere else. So this keys on the VALUE'S ORIGIN and traces
 * it forward, which is the only key that does not have a "somewhere else".
 *
 * ⭐ AND THE SINK SET IS DISCOVERED, NOT LISTED. A census that enumerates
 * `print`/`success`/… cannot see `presentBlock`, `startSpinner` or
 * `renderOneShot` — local wrappers around a sink. That blind spot cost F-2c-7
 * six sites. `discoverSinkAliases` finds them to a fixpoint, including chains
 * (handleSlashCommand → renderOneShot → w → process.stderr.write).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * ⭐⭐ WHAT THIS CENSUS STRUCTURALLY CANNOT SEE — stated, and each one PROVEN
 * by a plant rather than asserted (see the §12 pins in
 * display-sink-reach.test.ts):
 *
 *  1. **An UNKNOWN wrapper call.** Taint stops at any call this file does not
 *     classify, so `print(`x ${someHelper(file.name)}`)` reads as clean. This
 *     is a real FALSE NEGATIVE, demonstrated by plant B5. It is the deliberate
 *     trade: propagating through every call would flag most of the package and
 *     a gate nobody can keep green is not a gate.
 *  2. **A wire origin not in the seed list.** `git`/`gh` subprocess output and
 *     repository file contents are untrusted but are not "over the wire"; they
 *     are covered by the execution pins (S10), not here.
 *  3. **SENSE.** This is a dataflow scan, not a judgement: it cannot tell that
 *     `relativeTime()` is safe — that is READ and encoded below, not inferred.
 *  4. **Ink prop threading.** A wire value passed through JSX props into a
 *     component defined elsewhere is not traced.
 *
 * A zero from this census means "zero under the above", never "zero".
 */

// ── 1. WIRE ORIGINS — the seeds (§I2: every remote-controlled producer) ─────
const WIRE_METHOD_ON: Readonly<Record<string, readonly string[]>> = {
  api: ['get', 'post', 'put', 'patch', 'delete'],
};
const WIRE_FUNCS: ReadonlySet<string> = new Set([
  'uploadFile',                                              // server response body
  'streamRequest',                                           // SSE payloads
  'fetchLatestVersion', 'checkForUpdate', 'getUpdateNotice', // npm registry
  'listTools', 'callTool', 'listPrompts', 'listResources',   // MCP peer
  'mcpRequest', 'connectMcpServer',
  'loadRemoteSkills', 'syncSkills',                          // server skill metadata
]);
const WIRE_CLIENT_METHODS: ReadonlySet<string> = new Set(['listTools', 'callTool', 'request', 'send']);
const WIRE_CLIENT_OBJ = /client|mcp|provider|transport/i;

// ── 2. PRIMITIVE RENDERING SURFACES ────────────────────────────────────────
// `fail()` is NOT a sink — it sanitizes internally (output.ts:157/159).
// `json()` / `writeFormatted()` are NOT sinks — the machine path is
// deliberately raw and SECURITY.md says so (pin B6).
const SINK_FUNCS: ReadonlySet<string> = new Set(['print', 'success', 'info', 'warn']);
const SPINNER_METHODS: ReadonlySet<string> = new Set([
  'succeed', 'fail', 'warn', 'info', 'start', 'stopAndPersist',
]);
const PROMPT_FUNCS: ReadonlySet<string> = new Set(['readSingleLineInput', 'readMultilineInput']);
const MACHINE_FUNCS: ReadonlySet<string> = new Set(['json', 'writeJsonLine', 'writeFormatted']);

// ── 3. TRANSFORMS ──────────────────────────────────────────────────────────
const PRESERVING_CALLS: ReadonlySet<string> = new Set([
  'String', 'basename', 'resolve', 'resolvePath', 'join', 'clip', 'padEnd', 'padStart',
  'trim', 'trimStart', 'trimEnd', 'slice', 'substring', 'substr', 'toString',
  'toLowerCase', 'toUpperCase', 'replace', 'replaceAll', 'concat', 'normalize',
  'shortMimeLabel', 'shortCmd', 'shortEntry', 'dirname', 'extname', 'at', 'repeat', 'split',
]);
/**
 * TERMINATORS — READ, not inferred. Every return of both is computed from a
 * parsed number and neither echoes its input, so taint genuinely dies here:
 *   relativeTime   (src/lib/files.ts) → `${n}s ago` … `${n}y ago` | ''
 *   formatFileSize (src/lib/files.ts) → `${n} B` … `${n} TB` | '?'
 * An earlier form of this census had `relativeTime` in PRESERVING_CALLS and
 * reported two false positives in files/show.ts as a result.
 */
const TERMINATING_CALLS: ReadonlySet<string> = new Set(['relativeTime', 'formatFileSize']);
const NUMERIC_PROPS: ReadonlySet<string> = new Set(['length', 'size', 'byteLength', 'statusCode']);
const SANITIZER = 'sanitizeForDisplay';
/** The composition boundary: literals are CLI-authored, interpolations are sanitized. */
const SANITIZING_TAG = 'display';

export interface SinkFinding {
  readonly file: string;
  readonly line: number;
  readonly sink: string;
  readonly root: string;
  readonly snippet: string;
}
export interface CensusResult {
  readonly findings: readonly SinkFinding[];
  readonly filesScanned: number;
  readonly aliases: ReadonlyMap<string, string>;
}

const SRC_ROOT = join(fileURLToPath(new URL('..', import.meta.url)), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

interface Parsed { readonly rel: string; readonly sf: ts.SourceFile }

function parseAll(extraFiles: Readonly<Record<string, string>>): Parsed[] {
  const real: Parsed[] = walk(SRC_ROOT).sort().map((f) => ({
    rel: `src/${relative(SRC_ROOT, f)}`.replace(/\\/g, '/'),
    sf: ts.createSourceFile(f, readFileSync(f, 'utf8'), ts.ScriptTarget.ES2022, true,
      f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
  }));
  for (const [rel, text] of Object.entries(extraFiles)) {
    real.push({ rel, sf: ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS) });
  }
  return real;
}

/** Local functions that forward a PARAMETER into a sink, to a fixpoint. */
function discoverSinkAliases(parsed: readonly Parsed[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (let round = 0; round < 6; round++) {
    let changed = false;
    for (const { rel, sf } of parsed) {
      const sinkOf = (n: ts.Node): string | null => {
        if (!ts.isCallExpression(n)) return null;
        const c = n.expression;
        if (ts.isIdentifier(c)) {
          if (SINK_FUNCS.has(c.text) || PROMPT_FUNCS.has(c.text) || c.text === 'ora') return c.text;
          if (aliases.has(c.text)) return c.text;
        }
        if (ts.isPropertyAccessExpression(c)) {
          const o = c.expression.getText(sf);
          const m = c.name.text;
          if (m === 'write' && /process\.(stdout|stderr)/.test(o)) return `${o}.write`;
          if (SPINNER_METHODS.has(m) && /spinner|ora/i.test(o)) return `spinner.${m}`;
          if (o === 'console') return `console.${m}`;
        }
        return null;
      };
      const check = (
        name: string, params: readonly ts.ParameterDeclaration[],
        body: ts.Node | undefined, node: ts.Node,
      ): void => {
        if (!body || params.length === 0 || aliases.has(name) || MACHINE_FUNCS.has(name)) return;
        const pn = new Set(params.filter((p) => ts.isIdentifier(p.name)).map((p) => p.name.getText(sf)));
        if (pn.size === 0) return;
        const readsParam = (x: ts.Node): boolean => {
          let f = false;
          const v = (m: ts.Node): void => {
            if (f) return;
            if (ts.isPropertyAccessExpression(m)) { v(m.expression); return; }
            if (ts.isIdentifier(m) && pn.has(m.text)) { f = true; return; }
            ts.forEachChild(m, v);
          };
          v(x);
          return f;
        };
        let hit: string | null = null;
        const visit = (n: ts.Node): void => {
          if (hit) return;
          const s = sinkOf(n);
          if (s && ts.isCallExpression(n) && n.arguments.some(readsParam)) { hit = s; return; }
          if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'text' &&
              readsParam(n.right)) { hit = 'spinner.text='; return; }
          ts.forEachChild(n, visit);
        };
        visit(body);
        if (hit !== null) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          aliases.set(name, `${rel}:${line + 1} → ${String(hit)}`);
          changed = true;
        }
      };
      const visit = (n: ts.Node): void => {
        if (ts.isFunctionDeclaration(n) && n.name) check(n.name.text, n.parameters, n.body, n);
        if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name) &&
            (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)))
          check(n.name.text, n.initializer.parameters, n.initializer.body, n);
        if (ts.isMethodDeclaration(n) && n.name) check(n.name.getText(sf), n.parameters, n.body, n);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    if (!changed) break;
  }
  for (const p of ['print', 'success', 'info', 'warn']) aliases.delete(p);
  return aliases;
}

/**
 * Count every site where a wire-origin value reaches a rendering surface
 * without crossing the sanitizer.
 *
 * `extraFiles` injects virtual sources — used by the pins to prove the census
 * can still SEE a known-real defect before any zero from it is believed.
 */
export function censusWireSinks(
  opts: { readonly extraFiles?: Readonly<Record<string, string>> } = {},
): CensusResult {
  const parsed = parseAll(opts.extraFiles ?? {});
  const aliases = discoverSinkAliases(parsed);
  const findings: SinkFinding[] = [];

  for (const { rel, sf } of parsed) {
    const tainted = new Set<string>();

    const isWireOrigin = (node: ts.Node): boolean => {
      let n = node;
      while (ts.isAwaitExpression(n) || ts.isParenthesizedExpression(n) ||
             ts.isNonNullExpression(n) || ts.isAsExpression(n)) n = n.expression;
      if (!ts.isCallExpression(n)) return false;
      const c = n.expression;
      if (ts.isPropertyAccessExpression(c)) {
        const obj = c.expression.getText(sf);
        const meth = c.name.text;
        if ((WIRE_METHOD_ON[obj] ?? []).includes(meth)) return true;
        if (['json', 'arrayBuffer', 'text'].includes(meth) && /res|response|body/i.test(obj)) return true;
        if (WIRE_CLIENT_METHODS.has(meth) && WIRE_CLIENT_OBJ.test(obj)) return true;
      }
      return ts.isIdentifier(c) && WIRE_FUNCS.has(c.text);
    };

    const exprTaint = (node: ts.Node): string | null => {
      let found: string | null = null;
      const visit = (n: ts.Node): void => {
        if (found !== null) return;
        // BARRIER 1 — the sanitizer itself.
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === SANITIZER) return;
        // BARRIER 2 — the `display` tag sanitizes every interpolation.
        if (ts.isTaggedTemplateExpression(n) && ts.isIdentifier(n.tag) && n.tag.text === SANITIZING_TAG) return;
        if (ts.isIdentifier(n) && tainted.has(n.text)) { found = n.text; return; }
        // `x.y` — visit the OBJECT only. A property NAME is an Identifier node
        // too; matching it against the taint set mis-flagged `h.event` in
        // chat.ts (a validated enum) because an SSE loop variable elsewhere in
        // the file was called `event`. A name is not a binding.
        if (ts.isPropertyAccessExpression(n)) {
          if (NUMERIC_PROPS.has(n.name.text)) return;
          visit(n.expression);
          return;
        }
        // A conditional's TEST is not rendered — only its branches are.
        if (ts.isConditionalExpression(n)) { visit(n.whenTrue); visit(n.whenFalse); return; }
        if (ts.isCallExpression(n)) {
          const c = n.expression;
          const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '';
          if (TERMINATING_CALLS.has(name)) return;
          if (PRESERVING_CALLS.has(name)) {
            if (ts.isPropertyAccessExpression(c)) visit(c.expression);
            n.arguments.forEach(visit);
          }
          return; // unknown call ⇒ stop. Declared blind spot #1.
        }
        ts.forEachChild(n, visit);
      };
      visit(node);
      return found;
    };

    const seedPass = (): boolean => {
      let changed = false;
      const add = (x: string): void => { if (!tainted.has(x)) { tainted.add(x); changed = true; } };
      const visit = (n: ts.Node): void => {
        if (ts.isVariableDeclaration(n) && n.initializer) {
          const names: string[] = [];
          if (ts.isIdentifier(n.name)) names.push(n.name.text);
          else for (const el of n.name.elements)
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) names.push(el.name.text);
          if (isWireOrigin(n.initializer) || exprTaint(n.initializer) !== null) names.forEach(add);
        }
        if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(n.left) && (isWireOrigin(n.right) || exprTaint(n.right) !== null))
          add(n.left.text);
        if (ts.isForOfStatement(n) && isWireOrigin(n.expression) &&
            ts.isVariableDeclarationList(n.initializer))
          for (const d of n.initializer.declarations) if (ts.isIdentifier(d.name)) add(d.name.text);
        ts.forEachChild(n, visit);
      };
      visit(sf);
      return changed;
    };
    // `let file: FileDetail;` then `file = await api.get(...)` needs >1 pass.
    for (let i = 0; i < 8 && seedPass(); i++) { /* fixpoint */ }

    const report = (node: ts.Node, kind: string, arg: ts.Node): void => {
      const root = exprTaint(arg);
      if (root === null) return;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      findings.push({
        file: rel, line: line + 1, sink: kind, root,
        snippet: arg.getText(sf).replace(/\s+/g, ' ').slice(0, 100),
      });
    };

    const findSinks = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.arguments.length > 0) {
        const c = n.expression;
        const first = n.arguments[0];
        if (ts.isIdentifier(c) && first !== undefined) {
          if (SINK_FUNCS.has(c.text)) report(n, `output.${c.text}`, first);
          else if (PROMPT_FUNCS.has(c.text)) report(n, `prompt.${c.text}`, first);
          else if (c.text === 'ora') report(n, 'spinner.ora()', first);
          else if (aliases.has(c.text)) n.arguments.forEach((a) => report(n, `alias.${c.text}`, a));
        }
        if (ts.isPropertyAccessExpression(c) && first !== undefined) {
          const m = c.name.text;
          const o = c.expression.getText(sf);
          if (m === 'write' && /process\.(stdout|stderr)/.test(o))
            report(n, `raw.${o.includes('stdout') ? 'stdout' : 'stderr'}.write`, first);
          if (o === 'console' && ['log', 'error', 'warn', 'info', 'debug'].includes(m))
            report(n, `console.${m}`, first);
          if (SPINNER_METHODS.has(m) && /spinner|ora/i.test(o)) report(n, `spinner.${m}`, first);
        }
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'text' &&
          /spinner/i.test(n.left.expression.getText(sf)))
        report(n, 'spinner.text=', n.right);
      if (ts.isJsxExpression(n) && n.expression) report(n, 'ink.jsx', n.expression);
      ts.forEachChild(n, findSinks);
    };
    findSinks(sf);
  }

  return { findings, filesScanned: parsed.length, aliases };
}

// ═══════════════════════════════════════════════════════════════════════════
// F-2c-10 §I1/§F2 — THE COST CENSUS FOR THE TWO SINK-SIDE BOUNDARIES.
//
// A sink-side sanitizer costs exactly one thing: it flattens CLI-AUTHORED
// styling that a call site composed into the value. So the cost of each
// boundary is the count of its sites that carry chalk (or a raw ESC), and that
// number is what must be pinned — not the boundary's existence.
//
// Measured at the boundary's introduction: prompt 21 sites / 1 styled;
// spinner 16 text-bearing sites of 37 / 0 styled.
// ═══════════════════════════════════════════════════════════════════════════

export interface StyledSite {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly styling: readonly string[];
}
export interface CostCensus {
  readonly sites: readonly StyledSite[];
  readonly styled: readonly StyledSite[];
  readonly filesScanned: number;
}

/** ora members whose first argument is rendered text. */
const SPINNER_TEXT_METHODS: ReadonlySet<string> = new Set([
  'start', 'succeed', 'fail', 'warn', 'info', 'stopAndPersist',
]);

/**
 * Does this expression compose CLI-AUTHORED styling? `chalk.…` in any depth, or
 * a literal carrying a raw escape byte. This is the whole cost, so it is read
 * off the AST rather than guessed.
 */
function stylingIn(node: ts.Node, sf: ts.SourceFile): string[] {
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAccessExpression(n)) {
      let root: ts.PropertyAccessExpression = n;
      while (ts.isPropertyAccessExpression(root.expression)) root = root.expression;
      if (ts.isIdentifier(root.expression) && /^chalk$/i.test(root.expression.text))
        hits.push(n.getText(sf).slice(0, 50));
    }
    // eslint-disable-next-line no-control-regex
    if (ts.isStringLiteralLike(n) && /\x1b|\\x1b|\\u001b|\\033/.test(n.getText(sf)))
      hits.push('RAW-ESC');
    ts.forEachChild(n, visit);
  };
  visit(node);
  return [...new Set(hits)];
}

/**
 * Count every PROMPT site and how many compose CLI-authored styling.
 *
 * ⭐ Two of the 21 pass a VARIABLE rather than a literal (`opts.askPrompt`, and
 * `confirm`'s `question`). A syntactic scan cannot see what those hold, so the
 * three `askPrompt` assignments and three `confirm` callers were traced by hand
 * and are all plain literals. That trace is the declared blind spot of this
 * function, stated rather than discovered later.
 */
export function censusPromptSites(
  opts: { readonly extraFiles?: Readonly<Record<string, string>> } = {},
): CostCensus {
  const parsed = parseAll(opts.extraFiles ?? {});
  const sites: StyledSite[] = [];
  for (const { rel, sf } of parsed) {
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && PROMPT_FUNCS.has(n.expression.text)) {
        const fn = n.expression.text;
        let arg: ts.Node | undefined = n.arguments[0];
        if (fn === 'readMultilineInput' && arg && ts.isObjectLiteralExpression(arg)) {
          arg = undefined;
          for (const p of (n.arguments[0] as ts.ObjectLiteralExpression).properties)
            if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'prompt') arg = p.initializer;
        }
        sites.push({
          file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
          kind: fn, styling: arg ? stylingIn(arg, sf) : [],
        });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { sites, styled: sites.filter((s) => s.styling.length > 0), filesScanned: parsed.length };
}

/**
 * Count every TEXT-BEARING spinner site and how many compose styling.
 *
 * ⭐ The receiver is RESOLVED, not name-matched: an identifier typed `Ora`, or
 * one initialised from `createSpinner`/`ora`/a helper returning `Ora`. An
 * earlier form of this keyed on /spinner|ora/i — a NAME — and would have been
 * blind to a spinner held in a differently-named variable.
 */
export function censusSpinnerSites(
  opts: { readonly extraFiles?: Readonly<Record<string, string>> } = {},
): CostCensus {
  const parsed = parseAll(opts.extraFiles ?? {});
  const factories = new Set(['ora', 'createSpinner']);
  for (const { sf } of parsed) {
    const v = (n: ts.Node): void => {
      if (ts.isFunctionDeclaration(n) && n.name && n.type && /\bOra\b/.test(n.type.getText(sf)))
        factories.add(n.name.text);
      ts.forEachChild(n, v);
    };
    v(sf);
  }

  const sites: StyledSite[] = [];
  for (const { rel, sf } of parsed) {
    // ⭐ The BOUNDARY ITSELF is not a call site. `spinner.ts` composes
    // `guard(ora(opts))`, and since both `guard` and `ora` return `Ora` both
    // match the factory rule — so an earlier form of this counted line 105
    // TWICE and reported 22 where the call-site population is 20. Excluding it
    // is not a convenience: a boundary cannot pay its own cost.
    if (rel === 'src/lib/spinner.ts') continue;
    const holders = new Set<string>();
    const fromFactory = (e: ts.Node | undefined): boolean => {
      let c = e;
      for (let i = 0; i < 4 && c && ts.isCallExpression(c); i++) {
        const x = c.expression;
        if (ts.isIdentifier(x) && factories.has(x.text)) return true;
        if (ts.isPropertyAccessExpression(x)) { c = x.expression; continue; }
        break;
      }
      return false;
    };
    const seed = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) &&
          ((n.type && /\bOra\b/.test(n.type.getText(sf))) || fromFactory(n.initializer)))
        holders.add(n.name.text);
      if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.type && /\bOra\b/.test(n.type.getText(sf)))
        holders.add(n.name.text);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left) && fromFactory(n.right)) holders.add(n.left.text);
      ts.forEachChild(n, seed);
    };
    seed(sf);
    const isSpinner = (e: ts.Node): boolean => {
      let b = e;
      while (ts.isNonNullExpression(b) || ts.isParenthesizedExpression(b)) b = b.expression;
      if (!ts.isIdentifier(b) && !ts.isPropertyAccessExpression(b)) return false;
      return holders.has(b.getText(sf).replace(/[?!].*$/, ''));
    };

    const push = (n: ts.Node, kind: string, e: ts.Node | undefined): void => {
      if (e === undefined) return; // no text ⇒ not a text sink
      sites.push({
        file: rel, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        kind, styling: stylingIn(e, sf),
      });
    };

    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && factories.has(n.expression.text)) {
        const a = n.arguments[0];
        if (a && ts.isObjectLiteralExpression(a)) {
          for (const p of a.properties) {
            if (ts.isPropertyAssignment(p) && p.name.getText(sf) === 'text') push(n, 'ctor', p.initializer);
            // ⭐ `{ text, stream }` — SHORTHAND. The first form of this census
            // read that as "no text" and so was blind to `startSpinner`, the
            // most-reached spinner in the package.
            else if (ts.isShorthandPropertyAssignment(p) && p.name.text === 'text') push(n, 'ctor', p.name);
          }
        } else if (a) push(n, 'ctor', a);
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(n.left) && n.left.name.text === 'text' &&
          isSpinner(n.left.expression)) push(n, 'text=', n.right);
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) &&
          SPINNER_TEXT_METHODS.has(n.expression.name.text) && isSpinner(n.expression.expression))
        push(n, `${n.expression.name.text}()`, n.arguments[0]);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { sites, styled: sites.filter((s) => s.styling.length > 0), filesScanned: parsed.length };
}

/**
 * A known-real defect shape, used to prove the census is not blind before any
 * zero from it is believed. Modelled on `files/upload.ts:236` as it stood at
 * `0b59e88f`: a server record rendered through a display sink with no
 * sanitizer anywhere on the path.
 */
export const KNOWN_DEFECT_PROBE = `
import { api } from '../../lib/api.js';
import { success } from '../../lib/output.js';
interface FileDetail { id: string; filename: string }
export async function probe(): Promise<void> {
  const file = await api.get<FileDetail>('/api/files/probe');
  success(\`Uploaded \${file.filename}\`);
}
`;
export const KNOWN_DEFECT_PROBE_PATH = 'src/commands/files/__census_probe.ts';
