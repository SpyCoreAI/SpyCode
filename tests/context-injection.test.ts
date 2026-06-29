import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildContextInjection,
  formatContextInjection,
} from '../src/lib/memory.js';
import { GUIDE_FILE } from '../src/lib/codebase-guide.js';
import { CHANGELOG_FILE } from '../src/lib/codebase-changelog.js';

/**
 * Part 3a folds CODEBASE_GUIDE.md + the CODEBASE_CHANGELOG.md tail into the same
 * once-per-conversation injection as SPYCODE.md, under a COMBINED budget with
 * priority SPYCODE > GUIDE > CHANGELOG. All filesystem work happens in a
 * throwaway temp project + temp home — NEVER this repo's root.
 */

let root: string;
let home: string;
const made: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spycode-ctx-'));
  made.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }));
  mkdirSync(join(root, '.git'), { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'spycode-ctx-home-'));
  made.push(home);
});

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  writeFileSync(join(root, name), content, 'utf8');
}

const CHANGELOG = [
  '# Codebase Changelog',
  '',
  '> Maintained by SpyCore — newest entries first.',
  '',
  '## 2026-03-03',
  '- newest change',
  '',
  '## 2026-01-01',
  '- Initialized project memory.',
  '',
].join('\n');

describe('buildContextInjection — composition', () => {
  test('includes SPYCODE + GUIDE + CHANGELOG-tail when all exist', () => {
    write('SPYCODE.md', 'PROJECT RULE');
    write(GUIDE_FILE, '# Guide\n\nARCH BODY');
    write(CHANGELOG_FILE, CHANGELOG);

    const inj = buildContextInjection({ cwd: root, home });
    expect(inj.block).toContain('<spycode-context>');
    expect(inj.block).toContain('PROJECT RULE');
    expect(inj.block).toContain(`# Architecture: ${GUIDE_FILE}`);
    expect(inj.block).toContain('ARCH BODY');
    expect(inj.block).toContain(`# Recent changes: ${CHANGELOG_FILE} (latest)`);
    expect(inj.block).toContain('newest change');

    const kinds = inj.parts.map((p) => p.kind);
    expect(kinds).toContain('memory');
    expect(kinds).toContain('guide');
    expect(kinds).toContain('changelog');
    // Block frames it as supplementary, non-overriding context.
    expect(inj.block).toContain('supplements your instructions');
    expect(inj.block).toContain('does NOT');
  });

  test('returns an empty block when none of the files exist', () => {
    const inj = buildContextInjection({ cwd: root, home });
    expect(inj.block).toBe('');
    expect(inj.parts).toHaveLength(0);
  });

  test('the CHANGELOG section carries the newest entries first, entry-capped', () => {
    write(CHANGELOG_FILE, CHANGELOG);
    const inj = buildContextInjection({ cwd: root, home, changelogMaxEntries: 1 });
    expect(inj.block).toContain('newest change');
    expect(inj.block).not.toContain('Initialized project memory.');
  });
});

describe('buildContextInjection — toggles', () => {
  test('injectGuide=false drops the guide from the block, marks it off', () => {
    write('SPYCODE.md', 'RULE');
    write(GUIDE_FILE, '# Guide\n\nARCH BODY');
    const inj = buildContextInjection({ cwd: root, home, injectGuide: false });
    expect(inj.block).not.toContain('ARCH BODY');
    expect(inj.block).toContain('RULE');
    const guide = inj.parts.find((p) => p.kind === 'guide');
    expect(guide?.status).toBe('off');
  });

  test('injectChangelog=false drops the changelog from the block, marks it off', () => {
    write('SPYCODE.md', 'RULE');
    write(CHANGELOG_FILE, CHANGELOG);
    const inj = buildContextInjection({ cwd: root, home, injectChangelog: false });
    expect(inj.block).not.toContain('newest change');
    const cl = inj.parts.find((p) => p.kind === 'changelog');
    expect(cl?.status).toBe('off');
  });
});

describe('buildContextInjection — combined budget + priority', () => {
  test('over budget: keep SPYCODE, truncate GUIDE, drop CHANGELOG (priority order)', () => {
    write('SPYCODE.md', 'M'.repeat(100));
    write(GUIDE_FILE, `# Guide\n\n${'G'.repeat(8000)}`);
    write(CHANGELOG_FILE, `# Codebase Changelog\n\n## 2026-01-01\n- ${'C'.repeat(8000)}`);

    const inj = buildContextInjection({
      cwd: root,
      home,
      // Big per-part caps so the COMBINED cap is the only binding constraint.
      guideBudgetChars: 50_000,
      changelogBudgetChars: 50_000,
      contextBudgetChars: 4_000,
    });

    expect(inj.block).toContain('MMMM'); // SPYCODE kept (priority 1)
    expect(inj.block).toContain('GGGG'); // GUIDE present…
    expect(inj.block).toContain('truncated to fit the combined context budget'); // …but truncated
    expect(inj.block).not.toContain('CCCC'); // CHANGELOG dropped (priority 3)

    const statusOf = (k: string) => inj.parts.find((p) => p.kind === k)?.status;
    expect(statusOf('memory')).toBe('full');
    expect(statusOf('guide')).toBe('truncated');
    expect(statusOf('changelog')).toBe('dropped');

    expect(inj.notices.some((n) => n.startsWith('Truncated') && n.includes(GUIDE_FILE))).toBe(true);
    expect(inj.notices.some((n) => n.startsWith('Dropped') && n.includes(CHANGELOG_FILE))).toBe(true);
    expect(inj.totalChars).toBeLessThanOrEqual(4_000);
  });
});

describe('formatContextInjection — /memory transparency', () => {
  test('lists every active part + total, reflecting GUIDE + CHANGELOG', () => {
    write('SPYCODE.md', 'RULE');
    write(GUIDE_FILE, '# Guide\n\nARCH');
    write(CHANGELOG_FILE, CHANGELOG);
    const out = formatContextInjection(buildContextInjection({ cwd: root, home }));
    expect(out).toContain('Project context injected');
    expect(out).toContain('SPYCODE.md');
    expect(out).toContain(GUIDE_FILE);
    expect(out).toContain(CHANGELOG_FILE);
  });

  test('explains the empty state', () => {
    const out = formatContextInjection(buildContextInjection({ cwd: root, home }));
    expect(out).toContain('No project context is loaded');
    expect(out).toContain('/init');
  });

  test('shows a disabled part as such', () => {
    write('SPYCODE.md', 'RULE');
    write(GUIDE_FILE, '# Guide\n\nARCH');
    const out = formatContextInjection(
      buildContextInjection({ cwd: root, home, injectGuide: false }),
    );
    expect(out).toContain('disabled');
  });
});
