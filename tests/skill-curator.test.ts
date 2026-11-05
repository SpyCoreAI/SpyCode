/**
 * H-13 - skill curator: usage telemetry, stale detection (with a pinned
 * clock), pinning, and archiving (never deleting).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  SKILL_ARCHIVE_DIRNAME,
  archiveSkill,
  findStaleSkills,
  isSkillPinned,
  pinSkill,
  readCuratorState,
  recordSkillLoad,
  unpinSkill,
} from '../src/lib/agent/skill-curator.js';

let dir = '';

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = '';
  }
});

function freshDir(): string {
  dir = join(tmpdir(), `spycode-curator-${process.pid}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSkill(d: string, name: string): void {
  const s = join(d, name);
  mkdirSync(s, { recursive: true });
  writeFileSync(join(s, 'SKILL.md'), `# ${name}\n`, 'utf8');
}

const NOW = Date.UTC(2026, 9, 11);

describe('recordSkillLoad / pinSkill', () => {
  test('loads are recorded and pins stick', () => {
    const d = freshDir();
    recordSkillLoad('alpha', d);
    expect(isSkillPinned('alpha', d)).toBe(false);
    pinSkill('alpha', d);
    expect(isSkillPinned('alpha', d)).toBe(true);
    unpinSkill('alpha', d);
    expect(isSkillPinned('alpha', d)).toBe(false);
    expect(readCuratorState(d).pinned).toEqual([]);
  });
});

describe('findStaleSkills', () => {
  test('idle and never-used skills are stale; pinned and fresh are not', () => {
    const d = freshDir();
    writeSkill(d, 'old-idle');
    writeSkill(d, 'fresh');
    writeSkill(d, 'pinned');
    writeSkill(d, 'ancient');
    const usageFile = join(d, '.usage.json');
    const patchUsage = (name: string, iso: string) => {
      const file = JSON.parse(readFileSync(usageFile, 'utf8')) as {
        version: 1;
        skills: Record<string, { views: number; lastActivityAt: string | null }>;
      };
      file.skills[name] = { views: 1, lastActivityAt: iso };
      writeFileSync(usageFile, JSON.stringify(file), 'utf8');
    };
    // old-idle: loaded 100 days ago (threshold 90).
    recordSkillLoad('old-idle', d);
    patchUsage('old-idle', new Date(NOW - 100 * 86400_000).toISOString());
    // fresh: loaded now.
    recordSkillLoad('fresh', d);
    patchUsage('fresh', new Date(NOW).toISOString());
    // ancient: never loaded, directory mtime 200 days old.
    const past = new Date(NOW - 200 * 86400_000);
    utimesSync(join(d, 'ancient'), past, past);
    pinSkill('pinned', d);

    const stale = findStaleSkills({ userDir: d, now: NOW }).map((s) => s.name).sort();
    expect(stale).toContain('old-idle');
    expect(stale).toContain('ancient');
    expect(stale).not.toContain('fresh');
    expect(stale).not.toContain('pinned');
    // Stale entries carry a reason.
    const reasons = findStaleSkills({ userDir: d, now: NOW });
    expect(reasons.every((s) => s.reason.length > 0)).toBe(true);
  });
});

describe('archiveSkill', () => {
  test('archives (never deletes) and refuses pinned/dotfile/escape names', () => {
    const d = freshDir();
    writeSkill(d, 'dusty');
    const { archivedTo } = archiveSkill('dusty', d);
    expect(existsSync(join(d, 'dusty'))).toBe(false);
    expect(existsSync(join(archivedTo, 'SKILL.md'))).toBe(true); // the dir moved whole
    expect(readdirSync(join(d, SKILL_ARCHIVE_DIRNAME))).toHaveLength(1);

    writeSkill(d, 'keep');
    pinSkill('keep', d);
    expect(() => archiveSkill('keep', d)).toThrow(/pinned/);
    expect(() => archiveSkill('.archive', d)).toThrow();
    expect(() => archiveSkill('../escape', d)).toThrow();
    expect(() => archiveSkill('missing', d)).toThrow();
  });
});
