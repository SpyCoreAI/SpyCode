import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHANGELOG_FILE,
  appendChangelogEntry,
  changelogStatus,
  formatChangelogEntry,
  generateInitialChangelog,
  initChangelogFile,
  nowStamp,
  parseChangelogEntries,
  readRecentChangelog,
} from '../src/lib/codebase-changelog.js';

/**
 * CODEBASE_CHANGELOG.md is the END-USER repo's tool-maintained, newest-first
 * change log (Part 3a — read side). Pure helpers are tested directly; the write
 * helper runs entirely inside a throwaway temp dir — NEVER this repo's root.
 */

const made: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spycode-cl-'));
  made.push(dir);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('generateInitialChangelog', () => {
  test('seeds a SpyCore-branded, newest-first header + one initial entry', () => {
    const out = generateInitialChangelog('2026-01-02');
    expect(out).toContain('# Codebase Changelog');
    expect(out).toContain('Maintained by SpyCore — newest entries first');
    expect(out).toContain('## 2026-01-02');
    expect(out).toContain('- Initialized project memory.');
    // SpyCore-branded only. The "no upstream vendor names" guarantee (with its
    // vendor literals) lives in the manifest-excluded negative gate
    // (tests/identity-denylist.test.ts) so this shipping file stays clean.
  });
});

describe('parseChangelogEntries', () => {
  test('separates the preamble from `## `-headed entries, newest first', () => {
    const content = [
      '# Codebase Changelog',
      '',
      '> Maintained by SpyCore — newest entries first.',
      '',
      '## 2026-03-03',
      '- newest change',
      '',
      '## 2026-02-02',
      '- middle change',
      '',
      '## 2026-01-01',
      '- Initialized project memory.',
      '',
    ].join('\n');
    const { preamble, entries } = parseChangelogEntries(content);
    expect(preamble).toContain('# Codebase Changelog');
    expect(entries).toHaveLength(3);
    expect(entries[0]!.heading).toBe('## 2026-03-03'); // newest first
    expect(entries[0]!.body).toContain('newest change');
    expect(entries[2]!.heading).toBe('## 2026-01-01');
  });

  test('does not treat an h3 (`### `) as a top-level entry', () => {
    const { entries } = parseChangelogEntries('# T\n\n## 2026-01-01\n### sub\n- x\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.body).toContain('### sub');
  });
});

describe('initChangelogFile — /init half', () => {
  test('creates CODEBASE_CHANGELOG.md when none exists', () => {
    const dir = tempProject();
    const res = initChangelogFile(dir, '2026-01-01');
    expect(res.created).toBe(true);
    expect(res.path).toBe(join(dir, CHANGELOG_FILE));
    const content = readFileSync(res.path, 'utf8');
    expect(content).toContain('Maintained by SpyCore');
    expect(content).toContain('Initialized project memory.');
  });

  test('refuses to overwrite an existing CODEBASE_CHANGELOG.md', () => {
    const dir = tempProject();
    writeFileSync(join(dir, CHANGELOG_FILE), 'HAND WRITTEN — DO NOT CLOBBER', 'utf8');
    const res = initChangelogFile(dir, '2026-01-01');
    expect(res.created).toBe(false);
    expect(readFileSync(res.path, 'utf8')).toBe('HAND WRITTEN — DO NOT CLOBBER');
  });
});

describe('readRecentChangelog — the newest-first tail', () => {
  function seed(dir: string): void {
    const content = [
      '# Codebase Changelog',
      '',
      '> Maintained by SpyCore — newest entries first.',
      '',
      '## 2026-03-03',
      '- third (newest)',
      '',
      '## 2026-02-02',
      '- second',
      '',
      '## 2026-01-01',
      '- first (oldest)',
      '',
    ].join('\n');
    writeFileSync(join(dir, CHANGELOG_FILE), content, 'utf8');
  }

  test('returns absent defaults when the file does not exist', () => {
    const dir = tempProject();
    const r = readRecentChangelog(dir);
    expect(r.exists).toBe(false);
    expect(r.text).toBe('');
    expect(r.entryCount).toBe(0);
  });

  test('shows the most-recent entries (top of the newest-first file)', () => {
    const dir = tempProject();
    seed(dir);
    const r = readRecentChangelog(dir, { maxEntries: 2 });
    expect(r.exists).toBe(true);
    expect(r.entryCount).toBe(3);
    expect(r.shownEntryCount).toBe(2);
    expect(r.text).toContain('third (newest)');
    expect(r.text).toContain('second');
    expect(r.text).not.toContain('first (oldest)'); // trimmed by entry cap
  });

  test('caps the rendered tail by chars with a marker', () => {
    const dir = tempProject();
    seed(dir);
    const r = readRecentChangelog(dir, { maxEntries: 10, maxChars: 80 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(80);
    expect(r.text).toContain('trimmed to fit');
  });
});

describe('changelogStatus', () => {
  test('reports absence then presence + line count', () => {
    const dir = tempProject();
    expect(changelogStatus(dir).exists).toBe(false);
    initChangelogFile(dir, '2026-01-01');
    const s = changelogStatus(dir);
    expect(s.exists).toBe(true);
    expect(s.lines).toBeGreaterThan(3);
    expect(s.path).toBe(join(dir, CHANGELOG_FILE));
  });
});

describe('formatChangelogEntry — Part 3b entry format', () => {
  test('builds a heading + grouped files + action summary + notes', () => {
    const entry = formatChangelogEntry({
      stamp: '2026-02-02 09:30 UTC',
      summary: 'Add the foo module',
      created: ['src/foo.ts'],
      modified: ['README.md', 'src/index.ts'],
      deleted: ['src/old.ts'],
      notes: ['Note: project structure changed — new dir `src/`.'],
    });
    expect(entry).toContain('## 2026-02-02 09:30 UTC — Add the foo module');
    expect(entry).toContain('**Created**');
    expect(entry).toContain('- `src/foo.ts`');
    expect(entry).toContain('**Modified**');
    expect(entry).toContain('- `README.md`');
    expect(entry).toContain('**Deleted**');
    expect(entry).toContain('- `src/old.ts`');
    expect(entry).toContain('1 created, 2 modified, 1 deleted.');
    expect(entry).toContain('Note: project structure changed');
  });

  test('collapses + caps a long multi-line summary into the heading', () => {
    const entry = formatChangelogEntry({
      stamp: '2026-02-02',
      summary: `multi\nline   summary ${'x'.repeat(200)}`,
      created: [],
      modified: ['a.ts'],
      deleted: [],
    });
    const heading = entry.split('\n')[0]!;
    expect(heading.startsWith('## 2026-02-02 — multi line summary')).toBe(true);
    expect(heading).not.toContain('\n');
    expect(heading.length).toBeLessThan(160);
    expect(heading.endsWith('…')).toBe(true);
  });

  test('an empty summary yields a stamp-only heading', () => {
    const entry = formatChangelogEntry({
      stamp: '2026-02-02',
      summary: '   ',
      created: ['a.ts'],
      modified: [],
      deleted: [],
    });
    expect(entry.split('\n')[0]).toBe('## 2026-02-02');
  });
});

describe('nowStamp', () => {
  test('formats a UTC date+time heading stamp', () => {
    expect(nowStamp(new Date('2026-02-02T09:30:45.000Z'))).toBe('2026-02-02 09:30 UTC');
  });
});

describe('appendChangelogEntry — newest-first prepend', () => {
  function tempProject(): string {
    const dir = mkdtempSync(join(tmpdir(), 'spycode-cl-append-'));
    made.push(dir);
    return dir;
  }

  test('prepends under the preamble, above existing entries, preserving them', () => {
    const dir = tempProject();
    writeFileSync(join(dir, CHANGELOG_FILE), generateInitialChangelog('2026-01-01'), 'utf8');
    const r = appendChangelogEntry(
      dir,
      formatChangelogEntry({ stamp: '2026-03-03', summary: 'New task', created: ['x.ts'], modified: [], deleted: [] }),
    );
    expect(r.appended).toBe(true);
    const content = readFileSync(join(dir, CHANGELOG_FILE), 'utf8');
    // Header preamble survives.
    expect(content).toContain('Maintained by SpyCore');
    // New entry is ABOVE the seed entry.
    expect(content.indexOf('New task')).toBeGreaterThan(content.indexOf('Maintained by SpyCore'));
    expect(content.indexOf('New task')).toBeLessThan(content.indexOf('Initialized project memory.'));
    // Exactly two entries now.
    expect(parseChangelogEntries(content).entries).toHaveLength(2);
  });

  test('is a no-op when the file is absent (never creates it)', () => {
    const dir = tempProject();
    const r = appendChangelogEntry(dir, '## 2026-01-01\n- x');
    expect(r.appended).toBe(false);
    expect(existsSync(join(dir, CHANGELOG_FILE))).toBe(false);
  });
});
