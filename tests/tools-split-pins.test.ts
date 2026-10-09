/**
 * PINS FOR SPLITTING `tools.ts` - N24 (order and catalogue), N25 (dispatch
 * contract), N33 (lazy imports), N34 (public surface) and N35 (runtime import
 * cycles).
 *
 * The split moves code byte for byte, so what can break is what lives BETWEEN
 * the pieces: the order of the registry, the identity of the one `ToolError`
 * class dispatch recognises, the timeout watchdog's contract, which modules
 * load lazily, which names the `tools.ts` / `loop.ts` facades still export, and
 * the import graph. Vitest hides two of these by design - a missing named
 * export and an early read inside an import cycle both come back `undefined`
 * instead of throwing - so they are pinned here explicitly.
 *
 * Each test was mutation-verified against the unchanged source: the mutation
 * named in its comment turns it red, and reverting turns it green again.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  DEFAULT_DISPATCH_TIMEOUT_MS,
  DEFAULT_LIMITS,
  ToolError,
  buildToolDeclarations,
  describeToolsForPrompt,
  dispatchTool,
  toolNames,
  validateArgs,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from '../src/lib/agent/tools.js';
import type {
  CommandRun,
  JsonSchemaProperty,
  JsonSchemaType,
  ToolLimits,
  ToolParameters,
} from '../src/lib/agent/tools.js';
import type { AgentEvent, AgentModelSlug, AgentResult, AgentRunState, RunAgentOptions } from '../src/lib/agent/loop.js';
import type { DelegateChildResult, Delegator } from '../src/lib/agent/delegate.js';
import { resultTruncMarker } from '../src/lib/wire-limits.js';
import { deferred, extraTool, removeDir, tempDir } from './loop-pin-harness.js';

/**
 * N34, TYPE HALF. Every exported type of both facades, imported by name. A
 * dropped type export is invisible at run time (types are erased), so this
 * half is enforced by `tsc -p tsconfig.test.json`, which type-checks this file.
 */
export type ToolsTypeSurface = [CommandRun, JsonSchemaProperty, JsonSchemaType, ToolContext, ToolDefinition, ToolLimits, ToolParameters, ToolResult];
export type LoopTypeSurface = [AgentEvent, AgentModelSlug, AgentResult, AgentRunState, RunAgentOptions];

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(PKG_ROOT, 'src');

function golden(name: string): unknown {
  const text = readFileSync(fileURLToPath(new URL(`./fixtures/refactor-golden/${name}.json`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  return JSON.parse(text) as unknown;
}

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ cwd: PKG_ROOT, limits: DEFAULT_LIMITS, ...over });

// ─────────────────────────── N24 ───────────────────────────

describe('N24 registry order and catalogue bytes', () => {
  const expected = golden('tool-catalogue') as {
    names: string[];
    prompt: Record<'default' | 'readOnly' | 'webOff' | 'delegateOff', string>;
    declarations: Record<'default' | 'readOnly', unknown[]>;
  };

  // Mutation: swap two ALL_TOOLS entries.
  test('N24 toolNames() is in registry order, exactly', () => {
    expect(toolNames()).toEqual([
      'read_file',
      'list_dir',
      'glob',
      'grep',
      'repo_map',
      'diagnostics',
      'load_skill',
      'web_search',
      'fetch_url',
      'write_file',
      'edit_file',
      'run_command',
      'delegate',
    ]);
    expect(expected.names).toEqual(toolNames());
  });

  // Mutation: re-indent the catalogue.
  test('N24 the prompt catalogue is byte-identical in every variant', () => {
    expect(describeToolsForPrompt(), 'default').toBe(expected.prompt.default);
    expect(describeToolsForPrompt({ readOnlyOnly: true }), 'read-only').toBe(expected.prompt.readOnly);
    expect(describeToolsForPrompt({ webEnabled: false }), 'web off').toBe(expected.prompt.webOff);
    expect(describeToolsForPrompt({ delegateEnabled: false }), 'delegate off').toBe(expected.prompt.delegateOff);
    expect(expected.prompt.default.length, 'the fixture is empty').toBeGreaterThan(2000);
  });

  // Mutation: always emit `required`.
  test('N24 the native declarations are byte-identical, in registry order, with no empty required list', () => {
    expect(buildToolDeclarations(), 'default').toEqual(expected.declarations.default);
    expect(buildToolDeclarations({ readOnlyOnly: true }), 'read-only').toEqual(expected.declarations.readOnly);
    const listDir = buildToolDeclarations().find((d) => d.name === 'list_dir')!;
    expect(Object.keys(listDir.parameters), 'a tool with no required parameter declares no required list').toEqual(['type', 'properties']);
  });

  // Mutation: change the description cap.
  test('N24 extra tools: descriptions are capped at 1000 characters, schemas pass through, unusable names are dropped', () => {
    const noop: ToolDefinition['execute'] = () => Promise.resolve({ ok: true, summary: '', content: '' });
    const extras = new Map<string, ToolDefinition>(
      [
        extraTool('mcp__x__long', noop, { description: 'd'.repeat(1500) }),
        extraTool('mcp__x__exact', noop, { description: 'e'.repeat(1000) }),
        { ...extraTool('mcp__x__schema', noop), jsonSchema: { type: 'object', properties: { q: { type: 'array' } }, required: ['q'] } },
        extraTool('bad name!', noop),
        extraTool('mcp__x__mutates', noop, { mutating: true }),
      ].map((t) => [t.name, t]),
    );
    const decls = buildToolDeclarations({ extraTools: extras });
    const extra = decls.slice(toolNames().length);
    expect(extra.map((d) => d.name)).toEqual(['mcp__x__long', 'mcp__x__exact', 'mcp__x__schema', 'mcp__x__mutates']);
    expect(extra[0]!.description).toBe(`${'d'.repeat(999)}…`);
    expect(extra[1]!.description).toBe('e'.repeat(1000));
    expect(extra[2]!.parameters).toEqual({ type: 'object', properties: { q: { type: 'array' } }, required: ['q'] });
    expect(extra[0]!.parameters).toEqual({ type: 'object', properties: {} });
    expect(buildToolDeclarations({ extraTools: extras, readOnlyOnly: true }).slice(toolNames().length - 3).map((d) => d.name)).toEqual([
      'mcp__x__long',
      'mcp__x__exact',
      'mcp__x__schema',
    ]);
  });
});

// ─────────────────────────── N25 ───────────────────────────

describe('N25 dispatch contract', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const d of dirs.splice(0)) removeDir(d);
  });

  const SEVENTY = 'a pinned tool error whose message runs to exactly seventy characters..';

  // Mutations: a second ToolError class (dispatch checks one, tools throw another); change the cut to 61.
  test('N25 one ToolError: a built-in failure and a thrown ToolError are both cut to 60 characters plus an ellipsis', async () => {
    expect(SEVENTY).toHaveLength(70);
    const cwd = tempDir('spycli-n25-');
    dirs.push(cwd);
    const dirName = 'a-directory-whose-name-runs-past-the-cut';
    mkdirSync(join(cwd, dirName));
    const builtin = await dispatchTool('read_file', { path: dirName }, ctx({ cwd }));
    const message = `"${dirName}" is a directory - use list_dir`;
    expect(builtin).toEqual({ ok: false, summary: `${message.slice(0, 60)}…`, content: `Error: ${message}` });

    const thrower = extraTool('mcp__x__throws', () => Promise.reject(new ToolError(SEVENTY)));
    const thrown = await dispatchTool('mcp__x__throws', {}, ctx({ extraTools: new Map([[thrower.name, thrower]]) }));
    expect(thrown).toEqual({ ok: false, summary: `${SEVENTY.slice(0, 60)}…`, content: `Error: ${SEVENTY}` });
  });

  // Mutation: change the 'error' fallback.
  test("N25 any other thrown error is summarised as 'error'", async () => {
    const thrower = extraTool('mcp__x__plain', () => Promise.reject(new Error(SEVENTY)));
    const res = await dispatchTool('mcp__x__plain', {}, ctx({ extraTools: new Map([[thrower.name, thrower]]) }));
    expect(res).toEqual({ ok: false, summary: 'error', content: `Error: ${SEVENTY}` });
  });

  // Mutations: drop the extra tools from the list; ignore the web switch in the list.
  test('N25 an unknown tool names every available tool, honouring the web switch and listing extra tools last', async () => {
    const extra = extraTool('mcp__x__extra', () => Promise.resolve({ ok: true, summary: '', content: '' }));
    const all = await dispatchTool('nope', {}, ctx({ extraTools: new Map([[extra.name, extra]]) }));
    expect(all).toEqual({
      ok: false,
      summary: 'unknown tool',
      content: `Error: unknown tool "nope". Available tools: ${[...toolNames(), 'mcp__x__extra'].join(', ')}.`,
    });
    const noWeb = await dispatchTool('web_search', { query: 'abc' }, ctx({ webToolsEnabled: false }));
    expect(noWeb.content).toBe(
      `Error: unknown tool "web_search". Available tools: ${toolNames().filter((n) => n !== 'web_search' && n !== 'fetch_url').join(', ')}.`,
    );
  });

  // Mutation: `slice(0, maxChars - 1)` in capContent.
  test('N25 an oversized result keeps exactly maxResultChars of body, then the marker', async () => {
    const body = 'z'.repeat(1000);
    const big = extraTool('mcp__x__big', () => Promise.resolve({ ok: true, summary: 'big', content: body }));
    const res = await dispatchTool('mcp__x__big', {}, ctx({ limits: { ...DEFAULT_LIMITS, maxResultChars: 100 }, extraTools: new Map([[big.name, big]]) }));
    expect(res.content).toBe(`${'z'.repeat(100)}${resultTruncMarker(100)}`);
  });

  // Mutations: change the number-branch message; drop the boolean branch.
  test('N25 validateArgs: the number and boolean branches', () => {
    const params: ToolParameters = {
      type: 'object',
      properties: {
        n: { type: 'number', description: 'n' },
        b: { type: 'boolean', description: 'b' },
        i: { type: 'integer', description: 'i' },
      },
      required: ['n'],
    };
    expect(validateArgs(params, { n: '1', b: 'yes', i: 1.5 })).toEqual(['"n" must be a number', '"b" must be a boolean', '"i" must be an integer']);
    expect(validateArgs(params, { n: 1.5, b: false, i: 2 })).toEqual([]);
    expect(validateArgs(params, { b: true, extra: 1 })).toEqual(['missing required parameter "n"', 'unknown parameter "extra"']);
  });

  /** A tool that never settles until released, and a dispatch whose settlement can be observed. */
  function hanging(over: Partial<ToolContext>): { settled: () => ToolResult | null; release: () => void; done: Promise<ToolResult> } {
    const gate = deferred<ToolResult>();
    const tool = extraTool('mcp__x__hang', () => gate.promise);
    let result: ToolResult | null = null;
    const done = dispatchTool('mcp__x__hang', {}, ctx({ ...over, extraTools: new Map([[tool.name, tool]]) })).then((r) => (result = r));
    return { settled: () => result, release: () => gate.resolve({ ok: true, summary: 'released', content: 'released' }), done };
  }

  const fake = (): void => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  };

  // Mutation: remove the slide.
  test('N25 the deadline slides while an approval is open, then expires', async () => {
    fake();
    let inFlight = true;
    const h = hanging({ dispatchTimeoutMs: 5_000, isApprovalInFlight: () => inFlight });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.settled(), 'an open approval held the deadline off').toBeNull();
    inFlight = false;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.settled()).toEqual({ ok: false, summary: 'tool dispatch timed out after 5s', content: 'Error: tool dispatch timed out after 5s' });
    h.release();
  });

  // Mutation: `budget > 0` → `budget >= 0`.
  test.each([0, -5])('N25 a dispatch timeout of %s disables the watchdog', async (dispatchTimeoutMs) => {
    fake();
    const h = hanging({ dispatchTimeoutMs });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.settled(), 'nothing timed out').toBeNull();
    h.release();
    await h.done;
    expect(h.settled()).toEqual({ ok: true, summary: 'released', content: 'released' });
  });

  // Mutation: stop applying the default.
  test('N25 with no timeout configured the 10-minute default applies', async () => {
    fake();
    expect(DEFAULT_DISPATCH_TIMEOUT_MS).toBe(600_000);
    const h = hanging({});
    await vi.advanceTimersByTimeAsync(DEFAULT_DISPATCH_TIMEOUT_MS - 1_000);
    expect(h.settled(), 'not before ten minutes').toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    h.release();
    await h.done;
    expect(h.settled()).toEqual({ ok: false, summary: 'tool dispatch timed out after 600s', content: 'Error: tool dispatch timed out after 600s' });
  });

  // Mutation: drop the delegate exemption.
  test('N25 delegate is exempt from the dispatch timeout', async () => {
    fake();
    const child = deferred<DelegateChildResult>();
    const delegator: Delegator = { depth: 0, maxDepth: 2, spawnChild: () => child.promise };
    let result: ToolResult | null = null;
    const done = dispatchTool('delegate', { task: 'take your time' }, ctx({ dispatchTimeoutMs: 1_000, delegator })).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(result, 'a running child is never orphaned by the watchdog').toBeNull();
    child.resolve({
      ok: true,
      finalText: 'child answer',
      turns: 1,
      toolCalls: 0,
      tokensUsed: 0,
      turnsUsed: 1,
      budgetStop: null,
      reachedMaxTurns: false,
      cancelled: false,
      stopNote: null,
    });
    await done;
    expect(result).toMatchObject({ ok: true, summary: 'sub-agent: 1 turn, 0 tokens' });
  });
});

// ─────────────────────────── shared AST helpers ───────────────────────────

interface Source {
  readonly file: string;
  readonly text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.d\.ts$/.test(p)) out.push(p);
  }
  return out;
}

function parse(src: Source): ts.SourceFile {
  return ts.createSourceFile(src.file, src.text, ts.ScriptTarget.ES2022, true, src.file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** True when a declaration brings in no runtime binding (erased by the compiler). */
function typeOnly(st: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(st)) {
    if (st.isTypeOnly) return true;
    const named = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements : null;
    return named !== null && named.length > 0 && named.every((e) => e.isTypeOnly);
  }
  const clause = st.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const b = clause.namedBindings;
  if (!b || ts.isNamespaceImport(b)) return false;
  return b.elements.length > 0 && b.elements.every((e) => e.isTypeOnly);
}

/** Every static, value-carrying import or re-export: [module specifier]. */
function staticValueSpecifiers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const st of sf.statements) {
    if ((ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      if (!typeOnly(st)) out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

/** Every `import('…')` with a literal specifier. */
function dynamicSpecifiers(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0];
      if (a && ts.isStringLiteral(a)) out.push(a.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function readSources(files: string[]): Source[] {
  return files.map((file) => ({ file, text: readFileSync(file, 'utf8').replace(/\r\n/g, '\n') }));
}

// ─────────────────────────── N33 ───────────────────────────

/** Modules that must stay off the CLI start-up path: loaded with `import()` only. */
const isLazyModule = (spec: string): boolean => spec === 'globby' || spec === 'diff' || spec.startsWith('./lsp/') || spec === '../api.js';

/** The static importers that exist today, each reviewed: neither is reachable from command registration. */
const STATIC_LAZY_ALLOWLIST = [
  'lib/agent/diagnostics.ts -> ./lsp/index.js',
  'lib/agent/router.ts -> ../api.js',
];

function lazyCensus(sources: Source[]): { statics: string[]; dynamics: string[] } {
  const statics: string[] = [];
  const dynamics: string[] = [];
  for (const s of sources) {
    const sf = parse(s);
    const rel = relative(SRC, s.file).replace(/\\/g, '/');
    for (const spec of staticValueSpecifiers(sf)) if (isLazyModule(spec)) statics.push(`${rel} -> ${spec}`);
    for (const spec of dynamicSpecifiers(sf)) if (isLazyModule(spec)) dynamics.push(`${rel} -> ${spec}`);
  }
  return { statics: statics.sort(), dynamics };
}

const agentTopLevel = (): string[] =>
  readdirSync(join(SRC, 'lib', 'agent'))
    .filter((f) => /\.ts$/.test(f))
    .map((f) => join(SRC, 'lib', 'agent', f));

describe('N33 lazy imports stay lazy', () => {
  test('N33 THE INSTRUMENT FIRST: a planted static import is seen, a type-only one and a dynamic one are not', () => {
    const planted = (text: string): Source => ({ file: join(SRC, 'lib', 'agent', '__planted.ts'), text });
    expect(lazyCensus([planted("import { globby } from 'globby';\n")]).statics).toEqual(['lib/agent/__planted.ts -> globby']);
    expect(lazyCensus([planted("export { api } from '../api.js';\n")]).statics).toEqual(['lib/agent/__planted.ts -> ../api.js']);
    expect(lazyCensus([planted("import type { LspManager } from './lsp/manager.js';\n")]).statics).toEqual([]);
    const dyn = lazyCensus([planted("export async function f() { return (await import('diff')).structuredPatch; }\n")]);
    expect([dyn.statics, dyn.dynamics]).toEqual([[], ['lib/agent/__planted.ts -> diff']]);
  });

  // Mutation: turn one dynamic import into a static one (globby / ../api.js in tools.ts, ./lsp/manager.js in loop.ts, diff in diff.ts).
  test('N33 no module in src/lib/agent imports globby, diff, ./lsp/* or ../api.js statically, outside the reviewed allowlist', () => {
    const { statics, dynamics } = lazyCensus(readSources(agentTopLevel()));
    expect(statics).toEqual(STATIC_LAZY_ALLOWLIST);
    // Reached-assertion: the lazy loads still exist, so a zero above is not a blind census.
    for (const mod of ['globby', 'diff', './lsp/manager.js', '../api.js']) {
      expect(dynamics.some((d) => d.endsWith(`-> ${mod}`)), `no dynamic import of ${mod} was found - the census is blind`).toBe(true);
    }
  });
});

// ─────────────────────────── N34 ───────────────────────────

describe('N34 public surface of the facades', () => {
  // Mutation: drop a value export (tools.ts or loop.ts). The type half is pinned by the
  // `ToolsTypeSurface` / `LoopTypeSurface` aliases above, under `tsc -p tsconfig.test.json`.
  test('N34 the runtime exports of tools.js and loop.js are exactly the hand-written lists', async () => {
    const tools = await import('../src/lib/agent/tools.js');
    const loop = await import('../src/lib/agent/loop.js');
    expect(Object.keys(tools).sort()).toEqual(
      [
        'COMMAND_CARRIERS',
        'DATA_CONTAINER_SEGMENTS',
        'DEFAULT_COMMAND_TIMEOUT_MS',
        'DEFAULT_DISPATCH_TIMEOUT_MS',
        'DEFAULT_LIMITS',
        'DEVICE_WRITE_VERBS',
        'INSTALL_CONTAINER_SEGMENTS',
        'INTERPRETERS',
        'INTERPRETER_CODE_FLAGS',
        'MAX_RESULT_CHARS',
        'MAX_SCREEN_DEPTH',
        'REGISTRY',
        'SAFE_DEVICES',
        'SAFE_DEVICE_ROLES',
        'SHELLS',
        'SYSTEM_TREE_SEGMENTS',
        'ToolError',
        'WEB_CONTENT_MAX_CHARS',
        'buildToolDeclarations',
        'describeCallArg',
        'describeToolsForPrompt',
        'dispatchTool',
        'matchesCatastrophic',
        'runShellCommand',
        'stripExpansions',
        'tailLines',
        'toolNames',
        'validateArgs',
        'wrapUntrustedWebContent',
      ].sort(),
    );
    expect(Object.keys(loop).sort()).toEqual(
      [
        'CONTINUE_HINT',
        'DEFAULT_MAX_TOOL_CALLS_PER_TURN',
        'DEFAULT_MAX_TURNS',
        'MAX_RETAINED_EVENTS',
        'MAX_TOOL_CALLS_PER_TURN_CAP',
        'MAX_TURNS_CAP',
        'MIN_TURNS',
        'assembleFencedContinuation',
        'runAgent',
      ].sort(),
    );
    for (const [name, value] of [...Object.entries(tools), ...Object.entries(loop)]) {
      expect(value, `${name} is exported but undefined - a re-export that resolves to nothing`).not.toBeUndefined();
    }
  });
});

// ─────────────────────────── N35 ───────────────────────────

/** Resolve a relative specifier to a source file, the way the build does (`.js` names the `.ts` file). */
function resolveSpecifier(from: string, spec: string, exists: (p: string) => boolean): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  for (const c of [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (exists(c)) return c;
  }
  throw new Error(`unresolved import ${spec} in ${from}`);
}

/** Strongly connected components of the static value-import graph (dynamic `import()` is lazy and not an edge). */
function importCycles(sources: Source[], exists: (p: string) => boolean): string[][] {
  const graph = new Map<string, string[]>();
  for (const s of sources) {
    const edges = staticValueSpecifiers(parse(s))
      .map((spec) => resolveSpecifier(s.file, spec, exists))
      .filter((t): t is string => t !== null);
    graph.set(s.file, edges);
  }
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const sccs: string[][] = [];
  const strong = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || (graph.get(v) ?? []).includes(v)) {
        sccs.push(component.map((f) => relative(SRC, f).replace(/\\/g, '/')).sort());
      }
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) strong(v);
  return sccs.sort((a, b) => a[0]!.localeCompare(b[0]!));
}

/**
 * NONE. The 0.9.1 tree had one runtime cycle (approval -> command-rules ->
 * tools -> approval). The `tools.ts` split removed it by retargeting
 * `command-rules.ts` at the extracted screener (`command-screen.ts`), and this
 * list stays EMPTY: any cycle in `src/` is a regression.
 */
const KNOWN_CYCLES: string[][] = [];

describe('N35 runtime import cycles', () => {
  test('N35 THE INSTRUMENT FIRST: a planted cycle is found, a type-only back edge and a dynamic one are not', () => {
    const a = join(SRC, '__a.ts');
    const b = join(SRC, '__b.ts');
    const exists = (p: string): boolean => p === a || p === b;
    expect(importCycles([{ file: a, text: "import { b } from './__b.js';\n" }, { file: b, text: "import { a } from './__a.js';\n" }], exists)).toEqual([['__a.ts', '__b.ts']]);
    expect(importCycles([{ file: a, text: "export { b } from './__b.js';\n" }, { file: b, text: "import { a } from './__a.js';\n" }], exists)).toEqual([['__a.ts', '__b.ts']]);
    expect(importCycles([{ file: a, text: "import { b } from './__b.js';\n" }, { file: b, text: "import type { A } from './__a.js';\n" }], exists)).toEqual([]);
    expect(importCycles([{ file: a, text: "import { b } from './__b.js';\n" }, { file: b, text: "export const f = () => import('./__a.js');\n" }], exists)).toEqual([]);
  });

  // Mutations: re-add command-rules.ts -> tools.ts; add any other cycle.
  test('N35 the static value-import graph of src/ has no cycles', () => {
    const files = walk(SRC);
    expect(files.length, 'walked almost nothing - this gate measured nothing').toBeGreaterThan(200);
    const exists = (p: string): boolean => existsSync(p) && statSync(p).isFile();
    expect(importCycles(readSources(files), exists)).toEqual(KNOWN_CYCLES);
  });
});
