/**
 * R3 pass-3 regression tests (R3-2..R3-13, except R3-1/R3-5 which live in
 * tests/http-redirect-live.test.ts against a real HTTP server).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { sanitizeForDisplay } from '../src/lib/sanitize-display.js';
import { buildSubprocessEnv } from '../src/lib/spawn-env.js';
import { isImageMime, isTextMime, shortMimeLabel } from '../src/lib/files.js';
import { decodeUtf8Prefix, decodeUtf8Suffix, truncateSafe } from '../src/lib/text.js';
import { readFilePrefix, readFileSuffix } from '../src/lib/repo-scan.js';
import { truncateWithMarker } from '../src/lib/git-generate.js';
import { wrapHookFeedback } from '../src/lib/hooks.js';
import { formatChangelogEntry } from '../src/lib/codebase-changelog.js';
import { conversationToMarkdown } from '../src/lib/transcript.js';
import { redactedExport } from '../src/commands/conversations/export.js';
import { readSkillFileCapped } from '../src/lib/agent/skills.js';

const EMOJI = '😀'; // U+1F600: a surrogate pair (2 UTF-16 units, 4 UTF-8 bytes)

let stdoutChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  freshConfigDir();
  stdoutChunks = [];
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  vi.resetModules();
});

describe('R3-7: sanitizeForDisplay strips bidi controls', () => {
  test.each([
    ['U+202E override', `a\u202Eb`],
    ['U+202A/U+202C embed', `a\u202Ab\u202Cc`],
    ['U+2066/U+2069 isolate', `a\u2066b\u2069c`],
    ['U+200B zero-width space', `a\u200Bb`],
    ['U+202D override', `a\u202Db`],
  ])('%s is stripped', (_label, input) => {
    const out = sanitizeForDisplay(input);
    expect(out).not.toMatch(/[\u202a-\u202e\u2066-\u2069\u200b]/);
    expect(out.replace(/[^a-z]/g, '')).toBe(input.replace(/[^a-z]/g, ''));
  });

  test('ZWJ emoji sequences are kept (U+200D is legitimate)', () => {
    const family = '👨‍👩‍👧'; // ZWJ-joined emoji
    expect(sanitizeForDisplay(family)).toBe(family);
  });
});

describe('R3-8: buildSubprocessEnv strips credential-file pointers', () => {
  test('AWS_CONFIG_FILE and DOCKER_CONFIG do not pass through', () => {
    const prevAws = process.env.AWS_CONFIG_FILE;
    const prevDocker = process.env.DOCKER_CONFIG;
    const prevKube = process.env.KUBECONFIG;
    process.env.AWS_CONFIG_FILE = '/tmp/aws-config';
    process.env.DOCKER_CONFIG = '/tmp/docker-config';
    process.env.KUBECONFIG = '/tmp/kubeconfig';
    try {
      const env = buildSubprocessEnv();
      expect(env.AWS_CONFIG_FILE).toBeUndefined();
      expect(env.DOCKER_CONFIG).toBeUndefined();
      expect(env.KUBECONFIG).toBeUndefined();
    } finally {
      if (prevAws === undefined) delete process.env.AWS_CONFIG_FILE;
      else process.env.AWS_CONFIG_FILE = prevAws;
      if (prevDocker === undefined) delete process.env.DOCKER_CONFIG;
      else process.env.DOCKER_CONFIG = prevDocker;
      if (prevKube === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = prevKube;
    }
  });
});

describe('R3-2: getStoredMcpServers filters wrong-typed command/env/url/headers', () => {
  test('wrong-typed command/env/url/headers rows are skipped, missing ones kept', async () => {
    const { getStoredMcpServers, setStoredMcpServers } = await import(
      '../src/lib/config.js'
    );
    setStoredMcpServers([
      { name: 'good', command: 'npx', args: ['x'] },
      { name: 'missing-command' },
      { name: 'bad-command', command: 42 },
      { name: 'bad-env', command: 'npx', env: 'oops' },
      { name: 'bad-env-entry', command: 'npx', env: [{ name: 42 }] },
      { name: 'bad-url', type: 'http', url: 42 },
      { name: 'bad-headers', type: 'http', url: 'https://example.com', headers: { A: 42 } },
      { name: 'bad-args', command: 'npx', args: ['ok', 42] },
    ] as unknown as Parameters<typeof setStoredMcpServers>[0]);
    const names = getStoredMcpServers().map((s) => s.name);
    expect(names).toEqual(['good', 'missing-command']);
  });

  test('describeServerTarget does not throw on a wrong-typed command', async () => {
    const { describeServerTarget } = await import('../src/lib/agent/mcp-config.js');
    expect(() =>
      describeServerTarget({ name: 'x', command: 42 } as unknown as Parameters<
        typeof describeServerTarget
      >[0]),
    ).not.toThrow();
  });
});

describe('R3-3: config reset preserves the file-backed token', () => {
  test('reset --yes keeps __token__ and clears other values', async () => {
    const { getConfigStore, getStoredTokenFromFile, setStoredTokenInFile } = await import(
      '../src/lib/config.js'
    );
    // A non-default apiUrl proves the clear ran (get() falls back to the
    // schema default after a reset, so assert reversion, not undefined).
    getConfigStore().set('apiUrl', 'https://example.com/custom-api');
    setStoredTokenInFile('tok-keep-me');
    const { Command } = await import('commander');
    const { registerConfigCommand } = await import('../src/commands/config/index.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    const program = new Command();
    program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
    registerConfigCommand(program);
    await program.parseAsync(['node', 'spycore', 'config', 'reset', '--yes']);
    expect(getStoredTokenFromFile()).toBe('tok-keep-me');
    expect(getConfigStore().get('apiUrl')).toBe('https://api.spycore.ai/api');
  });
});

describe('R3-4: non-string server mimeType/filename do not crash', () => {
  test('shortMimeLabel coerces non-strings to the file fallback', () => {
    expect(shortMimeLabel(42 as unknown as string, 42 as unknown as string)).toBe('file');
    expect(shortMimeLabel('text/plain', 42 as unknown as string)).toBe('TEXT');
  });

  test('isTextMime/isImageMime return false for non-strings', () => {
    expect(isTextMime(42 as unknown as string)).toBe(false);
    expect(isImageMime(42 as unknown as string)).toBe(false);
  });
});

describe('R3-6: surrogate-safe truncation and UTF-8-boundary reads', () => {
  test('truncateSafe never leaves a lone surrogate', () => {
    const s = `ab${EMOJI}cd`;
    // Cut point lands between the surrogate halves (index 3).
    const cut = truncateSafe(s, 3);
    expect(cut).toBe('ab');
    expect(cut).not.toContain('�');
    expect(truncateSafe(s, 4)).toBe(`ab${EMOJI}`);
  });

  test('decodeUtf8Prefix drops a split multi-byte char at the cut', () => {
    const buf = Buffer.from(`ab${EMOJI}cd`, 'utf8');
    // 2 ASCII + first 2 bytes of the 4-byte emoji.
    expect(decodeUtf8Prefix(buf.subarray(0, 4))).toBe('ab');
    expect(decodeUtf8Prefix(buf)).toBe(`ab${EMOJI}cd`);
  });

  test('decodeUtf8Suffix drops orphaned leading continuation bytes', () => {
    const buf = Buffer.from(`ab${EMOJI}cd`, 'utf8');
    // Start mid-emoji (last 2 bytes of the emoji + 'cd').
    expect(decodeUtf8Suffix(buf.subarray(4))).toBe('cd');
    expect(decodeUtf8Suffix(buf)).toBe(`ab${EMOJI}cd`);
  });

  test('readFilePrefix/readFileSuffix are boundary-aware on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spycli-r3-utf8-'));
    try {
      const file = join(dir, 'f.txt');
      writeFileSync(file, `ab${EMOJI}cd`, 'utf8');
      expect(readFilePrefix(file, 4)).toBe('ab');
      expect(readFileSuffix(file, 4)).toBe('cd');
      expect(readFilePrefix(file, 100)).toBe(`ab${EMOJI}cd`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('truncateWithMarker (git-generate) keeps the emoji whole', () => {
    const text = `ab${EMOJI}cd`.repeat(20);
    const out = truncateWithMarker(text, 10);
    expect(out).not.toContain('�');
    expect(out).toContain('[... truncated');
  });

  test('wrapHookFeedback cuts before a surrogate straddling the cap', () => {
    // HOOK_FEEDBACK_MAX_CHARS is 4000: the emoji's high surrogate sits at
    // index 3999, so the cut must back off to 3999, not split the pair.
    const out = wrapHookFeedback('x'.repeat(3999) + EMOJI + 'y'.repeat(100));
    expect(out).not.toContain('�');
    expect(out).not.toContain(EMOJI);
  });

  test('formatChangelogEntry caps without splitting a surrogate', () => {
    const entry = formatChangelogEntry({
      stamp: '2026-11-09',
      summary: `ab${EMOJI}`.repeat(40),
      created: [],
      modified: [],
      deleted: [],
    });
    expect(entry).not.toContain('�');
  });
});

describe('R3-11: export title/model are redacted', () => {
  const secretTitle = 'discuss api_key=abc123def456 leak';

  test('redactedExport scrubs the title and model', () => {
    const out = redactedExport({
      id: 'c1',
      title: secretTitle,
      model: 'hermes',
      createdAt: '2026-11-09T00:00:00Z',
      updatedAt: '2026-11-09T00:00:00Z',
      messages: [{ role: 'user', content: 'hi', createdAt: '2026-11-09T00:00:00Z' }],
    });
    expect(out.title).not.toContain('abc123def456');
    expect(JSON.stringify(out)).not.toContain('abc123def456');
  });

  test('conversationToMarkdown scrubs the title', () => {
    const md = conversationToMarkdown({
      id: 'c1',
      title: secretTitle,
      model: 'hermes',
      messages: [{ role: 'user', content: 'hi', createdAt: '2026-11-09T00:00:00Z' }],
    });
    expect(md).not.toContain('abc123def456');
  });
});

describe('R3-9: capped skill reads and bounded import copy', () => {
  test('readSkillFileCapped refuses an over-cap SKILL.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spycli-r3-cap-'));
    try {
      const big = join(dir, 'SKILL.md');
      writeFileSync(big, Buffer.alloc(1_048_577, 0x41));
      expect(readSkillFileCapped(big)).toBeNull();
      const small = join(dir, 'small.md');
      writeFileSync(small, '# hi\n');
      expect(readSkillFileCapped(small)).toBe('# hi\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('planFromDir refuses to apply an oversize skill pack', async () => {
    const { planFromDir } = await import('../src/commands/import.js');
    const root = mkdtempSync(join(tmpdir(), 'spycli-r3-import-'));
    const cwd = mkdtempSync(join(tmpdir(), 'spycli-r3-import-cwd-'));
    try {
      const skillDir = join(root, 'big-skill');
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), '# Big\n');
      writeFileSync(join(skillDir, 'blob.bin'), Buffer.alloc(11 * 1_048_576, 0));
      const plan = planFromDir(root, cwd);
      expect(plan.items).toHaveLength(1);
      expect(plan.items[0]?.detail).toContain('over the import bound');
      expect(() => plan.items[0]?.apply()).toThrow(/exceeds the import bound/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('planClaudeCode skips an over-cap CLAUDE.md and .claude.json', async () => {
    const { planClaudeCode } = await import('../src/commands/import.js');
    const root = mkdtempSync(join(tmpdir(), 'spycli-r3-import2-'));
    try {
      const home = join(root, 'home');
      const cwd = join(root, 'cwd');
      const configDir = join(root, 'config');
      mkdirSync(join(home, '.claude'), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(home, '.claude', 'CLAUDE.md'), Buffer.alloc(1_048_577, 0x41));
      writeFileSync(
        join(home, '.claude.json'),
        Buffer.alloc(1_048_577, 0x41),
      );
      const plan = planClaudeCode(cwd, false, home, configDir);
      expect(plan.items).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
