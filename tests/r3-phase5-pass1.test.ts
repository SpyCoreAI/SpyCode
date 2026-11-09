/**
 * SpyCode v0.9.10 Phase 5 pass 1, reviewer R3 — regression tests for the
 * shared-lib + other-commands findings (H1-H2, M1-M3, L1-L22).
 *
 * Every test pins the FIXED behavior; each was verified to fail on the
 * pre-fix code where a cheap negative control exists (noted per test).
 * Modules that transitively import the config singleton are imported
 * dynamically inside the test, after freshConfigDir() + resetModules(),
 * so the singleton always points at the test config dir.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Command, Option } from 'commander';
import { freshConfigDir } from './helpers.js';

let workDir: string;
const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  freshConfigDir();
  workDir = mkTmp('spycli-r3-');
});

afterEach(async () => {
  vi.resetModules();
  try {
    const { __resetConfigForTests } = await import('../src/lib/config.js');
    __resetConfigForTests();
  } catch {
    /* config not imported in this test */
  }
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/** Swap process.stdin for a scripted stream (prompt.test.ts pattern). */
function feedStdin(chunks: Array<string | Buffer>): { restore: () => void } {
  const mockStdin = Readable.from(chunks);
  const origStdin = process.stdin;
  Object.defineProperty(process, 'stdin', { value: mockStdin, configurable: true });
  return {
    restore: () => {
      Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
    },
  };
}

describe('H1 repo-scan does not follow symlinks', () => {
  test('a parent-escaping symlink does not blow up fileCount', async () => {
    const { scanRepo } = await import('../src/lib/repo-scan.js');
    writeFileSync(join(workDir, 'a.txt'), 'a\n');
    writeFileSync(join(workDir, 'b.txt'), 'b\n');
    const sub = join(workDir, 'sub');
    mkdirSync(sub);
    symlinkSync(workDir, join(sub, 'parent'));
    // Old code: 82 entries for this 2-file tree (same file 41x via ELOOP).
    const scan = await scanRepo(workDir);
    expect(scan.fileCount).toBe(2);
    expect(scan.topDirs).toContain('sub/');
  });

  test('a symlinked directory is listed in topDirs, not topFiles', async () => {
    const { scanRepo } = await import('../src/lib/repo-scan.js');
    const real = join(workDir, 'realdir');
    mkdirSync(real);
    writeFileSync(join(real, 'x.txt'), 'x\n');
    symlinkSync(real, join(workDir, 'linkdir'));
    const scan = await scanRepo(workDir);
    expect(scan.topDirs).toContain('linkdir/');
    expect(scan.topFiles).not.toContain('linkdir');
  });

  test('readFileSuffix reads the tail only', async () => {
    const { readFileSuffix } = await import('../src/lib/repo-scan.js');
    const p = join(workDir, 'f.txt');
    writeFileSync(p, '0123456789abcdef');
    expect(readFileSuffix(p, 6)).toBe('abcdef');
    expect(readFileSuffix(p, 100)).toBe('0123456789abcdef');
    expect(readFileSuffix(join(workDir, 'missing'), 10)).toBeNull();
  });
});

describe('M2 prompt EOF settles as cancelled', () => {
  test('readSingleLineInput rejects cancelled on EOF (empty pipe)', async () => {
    const { readSingleLineInput, isPromptCancelled } = await import('../src/lib/prompt.js');
    const { restore } = feedStdin([]);
    try {
      const err = await readSingleLineInput('Name: ').then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).not.toBeNull();
      expect(isPromptCancelled(err)).toBe(true);
    } finally {
      restore();
    }
  });

  test('confirmYesNo returns false on EOF (its docstring promise)', async () => {
    const { confirmYesNo } = await import('../src/lib/prompt.js');
    const { restore } = feedStdin([]);
    try {
      await expect(confirmYesNo('Delete everything?')).resolves.toBe(false);
    } finally {
      restore();
    }
  });

  test('readStdinPipe rejects past the 1 MB cap instead of buffering unboundedly', async () => {
    const { readStdinPipe } = await import('../src/lib/prompt.js');
    const { restore } = feedStdin([Buffer.alloc(2 * 1024 * 1024, 0x78)]);
    try {
      await expect(readStdinPipe()).rejects.toThrow(/exceeds the 1\.0 MB limit/);
    } finally {
      restore();
    }
  });

  test('readStdinPipe still returns small piped input', async () => {
    const { readStdinPipe } = await import('../src/lib/prompt.js');
    const { restore } = feedStdin([Buffer.from('hello')]);
    try {
      await expect(readStdinPipe()).resolves.toBe('hello');
    } finally {
      restore();
    }
  });
});

describe('M3 Windows boot-time parsing', () => {
  test('parseWmicBootTime handles offset, no-offset, and garbage', async () => {
    const { parseWmicBootTime } = await import('../src/commands/runs.js');
    // 2024-01-01 12:00:00 local at UTC+60min == 11:00 UTC.
    expect(parseWmicBootTime('LastBootUpTime=20240101120000.000000+060\r\n')).toBe(
      Date.UTC(2024, 0, 1, 11, 0, 0),
    );
    expect(parseWmicBootTime('LastBootUpTime=20240101120000.000000-300\r\n')).toBe(
      Date.UTC(2024, 0, 1, 17, 0, 0),
    );
    expect(parseWmicBootTime('LastBootUpTime=20240101120000\r\n')).toBe(
      Date.UTC(2024, 0, 1, 12, 0, 0),
    );
    expect(parseWmicBootTime('')).toBeNull();
    expect(parseWmicBootTime('LastBootUpTime=\r\n')).toBeNull();
  });

  // 30 s budget: on Windows the probes are synchronous with a bounded
  // 15 s worst case (5 s wmic + 10 s PowerShell cold start), so the
  // 10 s default would trip on a slow runner. Runs on every platform.
  test('getSystemBootTimeMs returns a plausible value on this platform', { timeout: 30_000 }, async () => {
    const { getSystemBootTimeMs } = await import('../src/commands/runs.js');
    const ms = getSystemBootTimeMs();
    expect(typeof ms).toBe('number');
    expect(ms as number).toBeGreaterThan(0);
    expect(ms as number).toBeLessThanOrEqual(Date.now());
  });
});

describe('L4 runs attach tail reads from the end', () => {
  test('readLastLines returns the last N lines', async () => {
    const { readLastLines } = await import('../src/commands/runs.js');
    const p = join(workDir, 'run.log');
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    writeFileSync(p, `${lines.join('\n')}\n`);
    expect(readLastLines(p, 3)).toBe('line 198\nline 199\nline 200');
    expect(readLastLines(p, 500)).toBe(lines.join('\n'));
    expect(readLastLines(p, 0)).toBe('');
    expect(readLastLines(join(workDir, 'missing.log'), 10)).toBeNull();
    const empty = join(workDir, 'empty.log');
    writeFileSync(empty, '');
    expect(readLastLines(empty, 10)).toBe('');
  });

  test('readLastLines on a multi-MB log returns the tail without the whole file', async () => {
    const { readLastLines } = await import('../src/commands/runs.js');
    const p = join(workDir, 'big.log');
    const lines = Array.from({ length: 50000 }, (_, i) => `log line ${i} ${'x'.repeat(40)}`);
    writeFileSync(p, `${lines.join('\n')}\n`);
    expect(statSync(p).size).toBeGreaterThan(2 * 1024 * 1024);
    const tail = readLastLines(p, 2);
    expect(tail).toBe(`log line 49998 ${'x'.repeat(40)}\nlog line 49999 ${'x'.repeat(40)}`);
  });
});

describe('L1 capped JSON reads', () => {
  test('readCappedJson returns null past the 1 MB cap, parses small bodies', async () => {
    const { readCappedJson } = await import('../src/lib/sse.js');
    const small = {
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from(JSON.stringify({ version: '1.2.3' }));
      },
    };
    expect(await readCappedJson(small)).toEqual({ version: '1.2.3' });
    const big = {
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.alloc(2 * 1024 * 1024, 0x20);
      },
    };
    expect(await readCappedJson(big)).toBeNull();
  });
});

describe('L2 yamlScalar quotes document markers', () => {
  test('--- and ... are quoted; plain strings are not', async () => {
    const { formatOutput } = await import('../src/lib/output-formats/index.js');
    expect(formatOutput({ v: '---' }, 'yaml')).toBe('v: "---"');
    expect(formatOutput({ v: '...' }, 'yaml')).toBe('v: "..."');
    // Negative control for the regex: an arbitrary 3-char string stays bare.
    expect(formatOutput({ v: 'abc' }, 'yaml')).toBe('v: abc');
    expect(formatOutput({ v: 'yes' }, 'yaml')).toBe('v: "yes"');
  });
});

describe('L3 UTF-16 attachments are text, not binary', () => {
  test('looksBinary: UTF-16LE with and without BOM is text; NUL bytes are binary', async () => {
    const { looksBinary } = await import('../src/lib/attachments.js');
    const leBom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi\n', 'utf16le')]);
    expect(looksBinary(leBom)).toBe(false);
    const leNoBom = Buffer.from('hello world, this is text\n', 'utf16le');
    expect(looksBinary(leNoBom)).toBe(false);
    const beBom = Buffer.from([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69, 0x00, 0x0a]);
    expect(looksBinary(beBom)).toBe(false);
    expect(looksBinary(Buffer.from([0x68, 0x00, 0x69, 0x00, 0x89, 0x50, 0x4e, 0x47]))).toBe(true);
    expect(looksBinary(Buffer.from('plain ascii\n'))).toBe(false);
  });

  test('inspectAttachment decodes a UTF-16LE text file instead of rejecting it', async () => {
    const { inspectAttachment } = await import('../src/lib/attachments.js');
    const p = join(workDir, 'notes.txt');
    writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello utf16\n', 'utf16le')]));
    const att = inspectAttachment('notes.txt', workDir);
    expect(att.kind).toBe('text');
    expect(att.text).toContain('hello utf16');
  });
});

describe('L6/L7/L8 conversation shape drift + export redaction', () => {
  test('relativeTime renders future timestamps as "in …", never "-5s ago"', async () => {
    const { relativeTime } = await import('../src/lib/files.js');
    const future = new Date(Date.now() + 5000).toISOString();
    expect(relativeTime(future)).toMatch(/^in /);
    expect(relativeTime(future)).not.toContain('-');
  });

  test('conversationToMarkdown tolerates drifted messages and redacts content', async () => {
    const { conversationToMarkdown } = await import('../src/lib/transcript.js');
    const md = conversationToMarkdown({
      id: 'c1',
      title: 't',
      model: 'm',
      messages: [
        { role: 'user', content: 'my key is ghp_abcdefghij1234567890', createdAt: '' },
        null as unknown as { role: string; content: string; createdAt: string },
        { role: 42 as unknown as string, content: 99 as unknown as string, createdAt: '' },
        { role: 'assistant', content: 'ok', createdAt: '' },
      ],
    } as never);
    expect(md).not.toContain('ghp_abcdefghij1234567890');
    expect(md).toContain('***redacted***');
    expect(md).toContain('## You');
  });

  test('buildShareBody tolerates non-string content/role', async () => {
    const { buildShareBody } = await import('../src/commands/conversations/share.js');
    const body = buildShareBody({
      id: 'c1',
      title: 't',
      model: 'm',
      createdAt: '',
      updatedAt: '',
      messages: [
        { role: 7 as unknown as string, content: { x: 1 } as unknown as string, createdAt: '' },
      ],
    } as never);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]?.content).toBe('');
    expect(body.messages[0]?.role).toBe('');
  });

  test('redactedExport redacts message content in the JSON shape too', async () => {
    const { redactedExport } = await import('../src/commands/conversations/export.js');
    const out = redactedExport({
      id: 'c1',
      title: 't',
      model: 'm',
      createdAt: '',
      updatedAt: '',
      messages: [
        { role: 'user', content: 'token ghp_abcdefghij1234567890 here', createdAt: '' },
        null as unknown as { role: string; content: string; createdAt: string },
      ],
    } as never);
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]?.content).not.toContain('ghp_abcdefghij1234567890');
    expect(out.messages[0]?.content).toContain('***redacted***');
  });
});

describe('L9 cron schedule validation', () => {
  test('rejects prototype-chain names and silently-dropped segments', async () => {
    const { validateSchedule } = await import('../src/commands/cron/store.js');
    for (const bad of [
      '0 0 1 constructor *',
      '0 0 * * constructor',
      '0 0 1 __proto__ *',
      '0 0 1-2-3 * *',
      '*/15/3 * * * *',
      '61 * * * *',
      '0 0 1 foo *',
    ]) {
      expect(() => validateSchedule(bad), bad).toThrow(/Invalid schedule/);
    }
    expect(validateSchedule('0 0 1 jan *')).toBe('0 0 1 jan *');
    expect(validateSchedule('*/15 * * * *')).toBe('*/15 * * * *');
    expect(validateSchedule('0 9 * * MON')).toBe('0 9 * * MON');
  });
});

describe('L10 malformed rows survive a save', () => {
  test('cron: removing one entry preserves a malformed row verbatim', async () => {
    const { loadCronEntries, removeCronEntry } = await import('../src/commands/cron/store.js');
    const { getConfigPath } = await import('../src/lib/config.js');
    // The store resolves through getConfigPath(); the config dir is the
    // dirname of the config file path.
    const configDir = join(getConfigPath(), '..');
    const storePath = join(configDir, 'cron.json');
    const good = { id: 'good-1', prompt: 'hi', schedule: '* * * * *', model: null, createdAt: '2026-01-01T00:00:00.000Z' };
    const bad = { id: 123, prompt: 'broken row' };
    writeFileSync(storePath, JSON.stringify([good, bad], null, 2));
    expect(loadCronEntries()).toHaveLength(1);
    expect(removeCronEntry('good-1')).toBe(true);
    const saved = JSON.parse(readFileSync(storePath, 'utf8')) as unknown[];
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual(bad);
  });

  test('projects: saving preserves a malformed row verbatim', async () => {
    const { loadProjects, saveProjects } = await import('../src/commands/projects/store.js');
    const { getConfigPath } = await import('../src/lib/config.js');
    const configDir = join(getConfigPath(), '..');
    const storePath = join(configDir, 'projects.json');
    const good = { name: 'demo', path: '/tmp/demo', addedAt: '2026-01-01T00:00:00.000Z' };
    const bad = { name: 'broken' };
    writeFileSync(storePath, JSON.stringify([good, bad], null, 2));
    const loaded = loadProjects();
    expect(loaded).toHaveLength(1);
    saveProjects(loaded);
    const saved = JSON.parse(readFileSync(storePath, 'utf8')) as unknown[];
    expect(saved).toHaveLength(2);
    expect(saved).toContainEqual(bad);
  });
});

describe('L11 mcp trust requires an existing directory', () => {
  async function runMcp(argv: string[]): Promise<{ stdout: string; stderr: string; error: unknown }> {
    const { configureOutput } = await import('../src/lib/output.js');
    const { registerMcpCommand } = await import('../src/commands/mcp/index.js');
    const program = new Command();
    program.exitOverride();
    program.addOption(new Option('--api-url <url>')).addOption(new Option('--json')).addOption(new Option('--no-color'));
    configureOutput({ json: false, color: false });
    registerMcpCommand(program);
    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout.write as unknown) = (c: string | Uint8Array) => (out.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
    (process.stderr.write as unknown) = (c: string | Uint8Array) => (err.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
    let error: unknown;
    try {
      await program.parseAsync(['mcp', ...argv], { from: 'user' });
    } catch (e) {
      error = e;
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      configureOutput({ json: false, color: true });
    }
    return { stdout: out.join(''), stderr: err.join(''), error };
  }

  test('trust rejects a nonexistent path', async () => {
    const r = await runMcp(['trust', join(workDir, 'does-not-exist')]);
    expect(String((r.error as Error)?.message ?? r.error)).toMatch(/does not exist/);
  });

  test('trust rejects a file path', async () => {
    const f = join(workDir, 'a-file.txt');
    writeFileSync(f, 'x');
    const r = await runMcp(['trust', f]);
    expect(String((r.error as Error)?.message ?? r.error)).toMatch(/not a directory/);
  });

  test('trust accepts an existing directory', async () => {
    const r = await runMcp(['trust', workDir]);
    expect(r.error).toBeUndefined();
    expect(r.stdout).toContain('Trusted workspace');
  });
});

describe('L13 strict numeric flags', () => {
  test('parseStrictIntFlag errors on garbage/out-of-range, parseIntFlag errors on garbage', async () => {
    const { parseStrictIntFlag, parseIntFlag } = await import('../src/lib/numeric-flags.js');
    expect(() => parseStrictIntFlag('abc', 'max-turns', 1, 100, 25)).toThrow(/Invalid --max-turns/);
    expect(() => parseStrictIntFlag('0', 'max-turns', 1, 100, 25)).toThrow(/outside 1–100/);
    expect(() => parseStrictIntFlag('99999', 'max-turns', 1, 100, 25)).toThrow(/outside 1–100/);
    expect(parseStrictIntFlag(undefined, 'max-turns', 1, 100, 25)).toBe(25);
    expect(parseStrictIntFlag('50', 'max-turns', 1, 100, 25)).toBe(50);
    expect(() => parseIntFlag('abc', 'lines', { min: 0, max: 10000, defaultValue: 50 })).toThrow(/Invalid --lines/);
    expect(parseIntFlag('0', 'lines', { min: 0, max: 10000, defaultValue: 50 })).toBe(0);
  });
});

describe('L14 schema lists the three missing env vars', () => {
  test('spycore schema --json includes all three knobs', async () => {
    const { configureOutput } = await import('../src/lib/output.js');
    const { registerSchemaCommand } = await import('../src/commands/schema.js');
    configureOutput({ json: true, color: false });
    const program = new Command();
    program.exitOverride();
    program.addOption(new Option('--json')).addOption(new Option('--no-color'));
    registerSchemaCommand(program, '0.9.10-test');
    const out: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (c: string | Uint8Array) => (out.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
    try {
      await program.parseAsync(['node', 'spycore', '--json', 'schema']);
    } finally {
      process.stdout.write = origOut;
      configureOutput({ json: false, color: true });
    }
    const schema = JSON.parse(out.join('')) as { envVars: Array<{ name: string }> };
    const names = schema.envVars.map((v) => v.name);
    for (const name of ['SPYCORE_HEALTH_CHECK_TIMEOUT_MS', 'SPYCORE_REDUCED_MOTION', 'SPYCODE_LSP']) {
      expect(names).toContain(name);
    }
  });
});

describe('L17 repo-supplied markdown reads are capped at 1 MB', () => {
  test('loadMemory skips an over-cap SPYCODE.md with a notice', async () => {
    const { loadMemory } = await import('../src/lib/memory.js');
    const home = mkTmp('spycli-r3-home-');
    writeFileSync(join(workDir, 'package.json'), '{"name":"x"}');
    writeFileSync(join(workDir, 'SPYCODE.md'), `# Big\n\n${'x'.repeat(1_100_000)}\n`);
    const loaded = loadMemory({ cwd: workDir, home });
    expect(loaded.text).toBe('');
    expect(loaded.notices.join(' ')).toMatch(/over 1 MB/);
  });

  test('loadMemory skips an over-cap @-import with a notice', async () => {
    const { loadMemory } = await import('../src/lib/memory.js');
    const home = mkTmp('spycli-r3-home-');
    writeFileSync(join(workDir, 'package.json'), '{"name":"x"}');
    writeFileSync(join(workDir, 'SPYCODE.md'), '# Memory\n\n@big.md\n');
    writeFileSync(join(workDir, 'big.md'), 'y'.repeat(1_100_000));
    const loaded = loadMemory({ cwd: workDir, home });
    expect(loaded.notices.join(' ')).toMatch(/@import skipped \(over 1 MB\)/);
    expect(loaded.text).not.toContain('y'.repeat(100));
  });

  test('appendMemoryNote refuses an over-cap memory file', async () => {
    const { appendMemoryNote } = await import('../src/lib/memory.js');
    writeFileSync(join(workDir, 'package.json'), '{"name":"x"}');
    writeFileSync(join(workDir, 'SPYCODE.md'), 'z'.repeat(1_100_000));
    expect(() => appendMemoryNote(workDir, 'a new note')).toThrow(/over 1 MB/);
  });
});

describe('L18 changelog append is capped and atomic', () => {
  test('appending to a >1 MB changelog keeps the file bounded and newest-first', async () => {
    const { appendChangelogEntry, formatChangelogEntry } = await import('../src/lib/codebase-changelog.js');
    const bigBody = 'old line\n'.repeat(200000); // ~1.8 MB
    writeFileSync(
      join(workDir, 'CODEBASE_CHANGELOG.md'),
      `# Codebase Changelog\n\n## 2026-01-01\n${bigBody}`,
    );
    const before = statSync(join(workDir, 'CODEBASE_CHANGELOG.md')).size;
    expect(before).toBeGreaterThan(1_048_576);
    const entry = formatChangelogEntry({
      stamp: '2026-11-09',
      summary: 'new work',
      created: [],
      modified: [],
      deleted: [],
    });
    const res = appendChangelogEntry(workDir, entry);
    expect(res.appended).toBe(true);
    const after = readFileSync(join(workDir, 'CODEBASE_CHANGELOG.md'), 'utf8');
    expect(after.length).toBeLessThan(1_048_576 + 4096);
    expect(after).toContain('new work');
    // No temp file left behind.
    expect(readdirSync(workDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('L19/L20 wire-message caps', () => {
  test('buildBranchPrompt stays within the 32k wire cap with a huge --for hint', async () => {
    const { buildBranchPrompt } = await import('../src/lib/git-generate.js');
    const prompt = buildBranchPrompt({ hint: 'x'.repeat(100000), diff: 'diff here' });
    expect(prompt.length).toBeLessThanOrEqual(32000);
    expect(prompt).toContain('[... truncated: diff exceeds the prompt budget ...]');
  });

  test('buildCreateMessage/buildFeedbackMessage cap user text at 8k', async () => {
    const { buildCreateMessage, buildFeedbackMessage } = await import('../src/lib/skills-create.js');
    const big = 'd'.repeat(100000);
    expect(buildCreateMessage('my-skill', big).length).toBeLessThan(9000);
    expect(buildCreateMessage('my-skill', big)).toContain('[... truncated: input exceeds the generation budget ...]');
    expect(buildFeedbackMessage(big).length).toBeLessThan(9000);
    expect(buildFeedbackMessage('short feedback')).toContain('short feedback');
  });
});

describe('L21 curator --unpin validates the name', () => {
  async function runSkillsCurator(argv: string[]): Promise<{ stdout: string; stderr: string; error: unknown }> {
    const { configureOutput } = await import('../src/lib/output.js');
    const { registerCurator } = await import('../src/commands/skills/curator.js');
    const program = new Command();
    program.exitOverride();
    program.addOption(new Option('--json')).addOption(new Option('--no-color'));
    const group = program.command('skills');
    configureOutput({ json: false, color: false });
    registerCurator(group);
    const out: string[] = [];
    const err: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout.write as unknown) = (c: string | Uint8Array) => (out.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
    (process.stderr.write as unknown) = (c: string | Uint8Array) => (err.push(typeof c === 'string' ? c : Buffer.from(c).toString()), true);
    let error: unknown;
    try {
      await program.parseAsync(['node', 'spycore', 'skills', 'curator', ...argv]);
    } catch (e) {
      error = e;
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
      configureOutput({ json: false, color: true });
    }
    return { stdout: out.join(''), stderr: err.join(''), error };
  }

  test('--unpin of a nonexistent skill errors instead of reporting success', async () => {
    const r = await runSkillsCurator(['--unpin', 'nonexistent-skill']);
    expect(String((r.error as Error)?.message ?? r.error)).toMatch(/No user-global skill named/);
    expect(r.stdout).not.toContain('Unpinned');
  });

  test('--unpin of an existing but unpinned skill errors', async () => {
    const { getConfigPath } = await import('../src/lib/config.js');
    const skillsDir = join(getConfigPath(), '..', 'skills', 'my-skill');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'SKILL.md'), '---\nname: my-skill\n---\nbody\n');
    const r = await runSkillsCurator(['--unpin', 'my-skill']);
    expect(String((r.error as Error)?.message ?? r.error)).toMatch(/is not pinned/);
  });

  test('--pin then --unpin succeeds', async () => {
    const { getConfigPath } = await import('../src/lib/config.js');
    const skillsDir = join(getConfigPath(), '..', 'skills', 'my-skill');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'SKILL.md'), '---\nname: my-skill\n---\nbody\n');
    const pinned = await runSkillsCurator(['--pin', 'my-skill']);
    expect(pinned.error).toBeUndefined();
    const unpinned = await runSkillsCurator(['--unpin', 'my-skill']);
    expect(unpinned.error).toBeUndefined();
    expect(unpinned.stdout).toContain('Unpinned');
  });
});

describe('L22 stored providers are validated per entry', () => {
  test('getStoredProviders drops corrupt rows instead of crashing callers', async () => {
    const { getStoredProviders, setStoredProviders } = await import('../src/lib/config.js');
    setStoredProviders([
      { name: 'good', type: 'openai', baseURL: 'https://example.com/v1' },
      { name: 42, type: 'openai', baseURL: 'https://example.com/v1' },
      { name: 'bad-type', type: 'bogus', baseURL: 'https://example.com/v1' },
      { name: 'no-url', type: 'openai', baseURL: '' },
      null,
      'junk',
    ] as never);
    const stored = getStoredProviders();
    // Structurally corrupt rows (non-string name, empty baseURL, non-object)
    // are dropped. An unknown `type` is KEPT: it flows to
    // resolveProviderSelection / keySource, which throw the clean
    // `Unknown BYOK provider type` error (R2 L9) instead of the entry
    // silently vanishing from every list.
    expect(stored).toHaveLength(2);
    expect(stored.map((p) => p.name).sort()).toEqual(['bad-type', 'good']);
  });
});

describe('L18 normal append still works', () => {
  test('a normal append still works and leaves no tmp file', async () => {
    const { appendChangelogEntry, formatChangelogEntry } = await import('../src/lib/codebase-changelog.js');
    writeFileSync(join(workDir, 'CODEBASE_CHANGELOG.md'), '# Codebase Changelog\n\n## 2026-01-01\n- Initialized project memory.\n');
    const entry = formatChangelogEntry({
      stamp: '2026-11-09',
      summary: 'did a thing',
      created: ['a.ts'],
      modified: [],
      deleted: [],
    });
    expect(appendChangelogEntry(workDir, entry).appended).toBe(true);
    const content = readFileSync(join(workDir, 'CODEBASE_CHANGELOG.md'), 'utf8');
    expect(content).toContain('did a thing');
    expect(content).toContain('Initialized project memory.');
    expect(readdirSync(workDir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});
