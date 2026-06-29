import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTurn, stripToolBlocksForDisplay } from '../src/lib/agent/protocol.js';
import {
  DEFAULT_LIMITS,
  dispatchTool,
  validateArgs,
  toolNames,
  describeToolsForPrompt,
  type ToolContext,
  type ToolLimits,
} from '../src/lib/agent/tools.js';

// ───────────────────────── protocol parser ─────────────────────────

describe('parseTurn (tool-call protocol)', () => {
  const block = (tool: string, args: unknown): string =>
    '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

  test('parses a single valid block', () => {
    const r = parseTurn(block('read_file', { path: 'a.ts' }));
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ tool: 'read_file', args: { path: 'a.ts' } });
    expect(r.errors).toHaveLength(0);
    expect(r.hasUnclosedBlock).toBe(false);
  });

  test('parses multiple blocks in document order', () => {
    const text = `${block('list_dir', { path: '.' })}\nthen\n${block('read_file', { path: 'b.ts' })}`;
    const r = parseTurn(text);
    expect(r.calls.map((c) => c.tool)).toEqual(['list_dir', 'read_file']);
    expect(r.prose).toContain('then');
  });

  test('captures prose around a block as the narration', () => {
    const r = parseTurn(`Let me look first.\n${block('repo_map', {})}\nthinking...`);
    expect(r.calls).toHaveLength(1);
    expect(r.prose).toContain('Let me look first.');
    expect(r.prose).toContain('thinking...');
  });

  test('defaults missing args to an empty object', () => {
    const r = parseTurn('```spycore:tool\n{"tool":"repo_map"}\n```');
    expect(r.calls[0]).toMatchObject({ tool: 'repo_map', args: {} });
  });

  test('reports malformed JSON as a structured error, not a call', () => {
    const r = parseTurn('```spycore:tool\n{not valid json}\n```');
    expect(r.calls).toHaveLength(0);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.message).toMatch(/not valid JSON/i);
  });

  test('reports a block missing the tool field', () => {
    const r = parseTurn('```spycore:tool\n{"args":{"x":1}}\n```');
    expect(r.calls).toHaveLength(0);
    expect(r.errors[0]?.message).toMatch(/tool/i);
  });

  test('flags an unclosed block as a streaming partial and never acts on it', () => {
    const r = parseTurn('here we go\n```spycore:tool\n{"tool":"read_file","args":{"path":"a.ts"}}');
    expect(r.calls).toHaveLength(0);
    expect(r.hasUnclosedBlock).toBe(true);
  });

  test('treats a message with no block as a final answer', () => {
    const r = parseTurn('This project is a CLI written in TypeScript.');
    expect(r.calls).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
    expect(r.hasUnclosedBlock).toBe(false);
    expect(r.prose).toContain('CLI written in TypeScript');
  });
});

describe('stripToolBlocksForDisplay (display-only)', () => {
  const block = (tool: string, args: unknown): string =>
    '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

  test('removes a complete block but keeps surrounding prose', () => {
    const out = stripToolBlocksForDisplay(`Let me read it.\n${block('read_file', { path: 'a.ts' })}\nthen continue`);
    expect(out).toContain('Let me read it.');
    expect(out).toContain('then continue');
    expect(out).not.toContain('spycore:tool');
    expect(out).not.toContain('read_file');
  });

  test('removes a still-open partial block (streaming) and its half-JSON', () => {
    const out = stripToolBlocksForDisplay('Working on it…\n```spycore:tool\n{"tool":"write_file","args":{"path":"x"');
    expect(out).toContain('Working on it');
    expect(out).not.toContain('spycore:tool');
    expect(out).not.toContain('write_file');
  });

  test('removes multiple blocks', () => {
    const out = stripToolBlocksForDisplay(`${block('list_dir', { path: '.' })}\n${block('read_file', { path: 'b.ts' })}`);
    expect(out).not.toContain('spycore:tool');
    expect(out).not.toContain('list_dir');
    expect(out).not.toContain('read_file');
  });

  test('leaves plain prose (and normal code fences) untouched', () => {
    const text = 'Here is the answer.\n\n```ts\nconst x = 1;\n```';
    expect(stripToolBlocksForDisplay(text)).toBe(text);
  });

  test('a message that is only a tool block renders as empty', () => {
    expect(stripToolBlocksForDisplay(block('repo_map', {})).trim()).toBe('');
  });
});

// ───────────────────────── registry / dispatch ─────────────────────────

describe('registry + validation', () => {
  test('exposes the read + write tools', () => {
    expect(toolNames().sort()).toEqual([
      'edit_file', 'glob', 'grep', 'list_dir', 'load_skill', 'read_file', 'repo_map', 'run_command', 'write_file',
    ]);
  });

  test('the prompt catalogue describes every tool', () => {
    const doc = describeToolsForPrompt();
    for (const n of toolNames()) expect(doc).toContain(n);
  });

  test('validateArgs flags missing required + wrong types + unknown keys', () => {
    const schema = {
      type: 'object' as const,
      properties: {
        path: { type: 'string' as const, description: '' },
        offset: { type: 'integer' as const, description: '' },
      },
      required: ['path'],
    };
    expect(validateArgs(schema, {})).toContain('missing required parameter "path"');
    expect(validateArgs(schema, { path: 5 })).toContain('"path" must be a string');
    expect(validateArgs(schema, { path: 'a', offset: 1.5 })).toContain('"offset" must be an integer');
    expect(validateArgs(schema, { path: 'a', bogus: 1 })).toContain('unknown parameter "bogus"');
    expect(validateArgs(schema, { path: 'a', offset: 3 })).toEqual([]);
  });
});

// ───────────────────────── tools over a temp fixture ─────────────────────────

describe('read-only filesystem tools', () => {
  let workDir: string;
  let outsideDir: string;
  const ctx = (limits: ToolLimits = DEFAULT_LIMITS): ToolContext => ({ cwd: workDir, limits });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-tools-'));
    outsideDir = mkdtempSync(join(tmpdir(), 'spycli-outside-'));

    writeFileSync(join(workDir, '.gitignore'), 'ignored.txt\ndist/\n');
    writeFileSync(
      join(workDir, 'package.json'),
      JSON.stringify({
        name: 'fixture-project',
        description: 'A small fixture for agent tool tests',
        scripts: { build: 'tsc', test: 'vitest' },
      }),
    );
    writeFileSync(join(workDir, 'README.md'), '# Fixture\n');
    mkdirSync(join(workDir, 'src'));
    writeFileSync(
      join(workDir, 'src', 'index.ts'),
      ['import x from "y";', 'const [a, setA] = useState(0);', 'const [b, setB] = useState(1);', 'export default a;'].join('\n'),
    );
    writeFileSync(join(workDir, 'src', 'util.ts'), 'export const id = (x: number) => x;\n');
    // gitignored file + dir
    writeFileSync(join(workDir, 'ignored.txt'), 'secret\n');
    mkdirSync(join(workDir, 'dist'));
    writeFileSync(join(workDir, 'dist', 'out.js'), 'console.log(1)\n');
    // always-ignored dir
    mkdirSync(join(workDir, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(workDir, 'node_modules', 'pkg', 'index.js'), 'useState\n');
    // binary file (NUL byte)
    writeFileSync(join(workDir, 'bin.dat'), Buffer.from([0x48, 0x00, 0x49, 0x00]));
    // big text file
    writeFileSync(join(workDir, 'big.txt'), Array.from({ length: 100 }, (_, i) => `line${i + 1}`).join('\n'));
    // outside fixture for symlink escape
    writeFileSync(join(outsideDir, 'secret.txt'), 'top secret\n');
    symlinkSync(outsideDir, join(workDir, 'escape'), 'dir');
  });

  afterEach(() => {
    for (const d of [workDir, outsideDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  // ── sandbox ──
  test('read_file rejects ../ traversal outside cwd', async () => {
    const r = await dispatchTool('read_file', { path: '../../etc/passwd' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/escapes the working directory/);
  });

  test('read_file rejects an absolute path outside cwd', async () => {
    const r = await dispatchTool('read_file', { path: '/etc/hosts' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/escapes the working directory/);
  });

  test('read_file bounds symlinks that point outside cwd', async () => {
    const r = await dispatchTool('read_file', { path: 'escape/secret.txt' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/symlink/);
  });

  // ── read_file ──
  test('read_file reads a text file and reports the line count', async () => {
    const r = await dispatchTool('read_file', { path: 'src/index.ts' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('4 lines');
    expect(r.content).toContain('useState');
  });

  test('read_file honors offset/limit and reports the slice of the total', async () => {
    const r = await dispatchTool('read_file', { path: 'big.txt', offset: 10, limit: 5 }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('lines 10-14 of 100');
    expect(r.content).toContain('line10');
    expect(r.content).toContain('line14');
    expect(r.content).not.toContain('line15');
  });

  test('read_file caps output at maxResultBytes; total line count stays in the summary', async () => {
    const tiny: ToolLimits = { ...DEFAULT_LIMITS, maxResultBytes: 100 };
    const r = await dispatchTool('read_file', { path: 'big.txt' }, ctx(tiny));
    expect(r.ok).toBe(true);
    expect(r.summary).toBe('100 lines'); // true length survives truncation
    expect(r.content).toMatch(/truncated to/); // dispatch's central byte-cap marker
  });

  test('read_file skips binary files', async () => {
    const r = await dispatchTool('read_file', { path: 'bin.dat' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/binary/);
  });

  test('read_file refuses a gitignored file', async () => {
    const r = await dispatchTool('read_file', { path: 'ignored.txt' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/gitignored|excluded/);
  });

  test('read_file refuses files inside node_modules', async () => {
    const r = await dispatchTool('read_file', { path: 'node_modules/pkg/index.js' }, ctx());
    expect(r.ok).toBe(false);
  });

  test('read_file reports a missing file', async () => {
    const r = await dispatchTool('read_file', { path: 'nope.ts' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/not found/);
  });

  // ── list_dir ──
  test('list_dir lists entries, marks directories, and respects ignores', async () => {
    const r = await dispatchTool('list_dir', {}, ctx());
    expect(r.ok).toBe(true);
    const lines = r.content.split('\n');
    expect(lines).toContain('src/');
    expect(lines).toContain('package.json');
    expect(lines).not.toContain('node_modules/');
    expect(lines).not.toContain('dist/'); // gitignored
    expect(lines).not.toContain('ignored.txt'); // gitignored
  });

  // ── glob ──
  test('glob finds matching files and excludes ignored trees', async () => {
    const r = await dispatchTool('glob', { pattern: '**/*.ts' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('src/index.ts');
    expect(r.content).toContain('src/util.ts');
    expect(r.content).not.toContain('node_modules');
  });

  // ── grep ──
  test('grep returns path:line:text matches with a summary', async () => {
    const r = await dispatchTool('grep', { pattern: 'useState' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/2 matches in 1 file/);
    expect(r.content).toMatch(/src\/index\.ts:2:/);
    expect(r.content).not.toContain('node_modules'); // ignored tree not searched
  });

  test('grep supports /pattern/flags (case-insensitive)', async () => {
    const r = await dispatchTool('grep', { pattern: '/USESTATE/i' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.summary).toMatch(/2 matches/);
  });

  test('grep caps matches and notes "+N more"', async () => {
    const capped: ToolLimits = { ...DEFAULT_LIMITS, maxMatches: 1 };
    const r = await dispatchTool('grep', { pattern: 'useState' }, ctx(capped));
    expect(r.content).toMatch(/\+1 more matches/);
  });

  test('grep rejects an invalid regular expression', async () => {
    const r = await dispatchTool('grep', { pattern: '(' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/invalid regular expression/);
  });

  // ── repo_map ──
  test('repo_map summarizes structure, languages, and package.json', async () => {
    const r = await dispatchTool('repo_map', {}, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('fixture-project');
    expect(r.content).toContain('TypeScript');
    expect(r.content).toMatch(/Key files:.*package\.json/);
    expect(r.content).toContain('scripts: build, test');
  });

  // ── dispatch errors ──
  test('dispatch returns a structured error for an unknown tool', async () => {
    const r = await dispatchTool('shellExec', { cmd: 'rm -rf /' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/unknown tool/);
  });

  test('dispatch returns a structured error for bad args', async () => {
    const r = await dispatchTool('read_file', {}, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/invalid arguments|missing required/);
  });
});
