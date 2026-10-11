/**
 * A-3 - `spycore import` tests: plan building (dry-run preview), conflict
 * semantics (never overwrite without --force), and the per-item apply paths.
 * The real config dir is isolated via SPYCORE_TEST_CWD.
 */
process.env.SPYCORE_TEST_CWD = process.env.SPYCORE_TEST_CWD ?? `/tmp/spycode-import-test-${process.pid}`;

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
  mapClaudeMcpServer,
  planClaudeCode,
  planFromDir,
} from '../src/commands/import.js';
import { getStoredMcpServers } from '../src/lib/config.js';
import { readDurableFile } from '../src/lib/agent/durable-memory.js';

const ROOT = `/tmp/spycode-import-${process.pid}`;
const HOME = join(ROOT, 'home');
const CWD = join(ROOT, 'cwd');
const CONFIG_DIR = join(ROOT, 'config');

function writeSkill(root: string, name: string, body = '# Skill\n'): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  mkdirSync(CWD, { recursive: true });
  process.env.SPYCORE_TEST_CWD = CONFIG_DIR;
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe('planClaudeCode', () => {
  test('finds user skills, MCP servers and CLAUDE.md', () => {
    writeSkill(join(HOME, '.claude', 'skills'), 'my-skill');
    writeFileSync(
      join(HOME, '.claude.json'),
      JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['-y', 'mcp-gh'] } } }),
      'utf8',
    );
    writeFileSync(join(HOME, '.claude', 'CLAUDE.md'), '# Agent notes\n', 'utf8');

    const plan = planClaudeCode(CWD, false, HOME, CONFIG_DIR);
    const kinds = plan.items.map((i) => `${i.kind}:${i.name}:${i.status}`);
    expect(kinds).toContain('skill:my-skill:new');
    expect(kinds).toContain('mcp-server:gh:new');
    expect(kinds).toContain('memory:agent memory:new');
    // No project items without --include-project.
    expect(plan.items.every((i) => !i.source.startsWith(CWD))).toBe(true);
  });

  test('--include-project adds ./.claude sources', () => {
    writeSkill(join(CWD, '.claude', 'skills'), 'proj-skill');
    writeFileSync(
      join(CWD, '.claude.json'),
      JSON.stringify({ mcpServers: { local: { command: '/bin/tool' } } }),
      'utf8',
    );
    const plan = planClaudeCode(CWD, true, HOME, CONFIG_DIR);
    expect(plan.items.some((i) => i.kind === 'skill' && i.name === 'proj-skill' && i.target.includes('project'))).toBe(true);
    expect(plan.items.some((i) => i.kind === 'mcp-server' && i.name === 'local' && i.target.includes('project'))).toBe(true);
  });

  test('identical existing skill is not a conflict', () => {
    writeSkill(join(HOME, '.claude', 'skills'), 'same', '# Same\n');
    const dest = join(CONFIG_DIR, 'skills', 'same');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'SKILL.md'), '# Same\n', 'utf8');
    const plan = planClaudeCode(CWD, false, HOME, CONFIG_DIR);
    expect(plan.items.find((i) => i.name === 'same')?.status).toBe('identical');
  });

  test('different existing skill is a conflict (never overwritten silently)', () => {
    writeSkill(join(HOME, '.claude', 'skills'), 'diff', '# New\n');
    const dest = join(CONFIG_DIR, 'skills', 'diff');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'SKILL.md'), '# Old\n', 'utf8');
    const plan = planClaudeCode(CWD, false, HOME, CONFIG_DIR);
    const item = plan.items.find((i) => i.name === 'diff');
    expect(item?.status).toBe('conflict');
    expect(item?.detail).toContain('--force');
  });

  test('apply() copies a skill dir', () => {
    writeSkill(join(HOME, '.claude', 'skills'), 'copy-me', '# Copy\n');
    const plan = planClaudeCode(CWD, false, HOME, CONFIG_DIR);
    const item = plan.items.find((i) => i.kind === 'skill' && i.name === 'copy-me');
    expect(item).toBeDefined();
    item!.apply();
    expect(readFileSync(join(CONFIG_DIR, 'skills', 'copy-me', 'SKILL.md'), 'utf8')).toBe('# Copy\n');
  });

  test('apply() merges an MCP server into the user store', () => {
    writeFileSync(
      join(HOME, '.claude.json'),
      JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['x'], env: { GH_TOKEN: 'abc' } } } }),
      'utf8',
    );
    const plan = planClaudeCode(CWD, false, HOME, CONFIG_DIR);
    const item = plan.items.find((i) => i.kind === 'mcp-server' && i.name === 'gh');
    expect(item).toBeDefined();
    item!.apply();
    const stored = getStoredMcpServers();
    expect(stored.some((s) => s.name === 'gh' && s.command === 'npx')).toBe(true);
  });

  test('apply() appends CLAUDE.md to durable memory with a marker (idempotent)', () => {
    mkdirSync(join(HOME, '.claude'), { recursive: true });
    writeFileSync(join(HOME, '.claude', 'CLAUDE.md'), 'Prefer tabs.\n', 'utf8');
    const plan = planClaudeCode(CWD, false, HOME, CONFIG_DIR);
    const item = plan.items.find((i) => i.kind === 'memory');
    expect(item).toBeDefined();
    item!.apply();
    const content = readDurableFile('memory', CONFIG_DIR);
    expect(content).toContain('Prefer tabs.');
    expect(content).toContain('imported from Claude Code');
    // A second plan sees the marker and reports already-imported.
    const plan2 = planClaudeCode(CWD, false, HOME, CONFIG_DIR);
    expect(plan2.items.find((i) => i.kind === 'memory')?.status).toBe('identical');
  });

  test('missing sources produce an empty plan (no crash)', () => {
    const plan = planClaudeCode(CWD, true, HOME, CONFIG_DIR);
    expect(plan.items).toEqual([]);
  });
});

describe('mapClaudeMcpServer', () => {
  test('maps a stdio entry, including env literals', () => {
    const s = mapClaudeMcpServer('gh', {
      command: 'npx',
      args: ['-y', 'mcp-gh'],
      env: { GH_TOKEN: 'abc', NOT_AN_ENV: 42 },
    });
    expect(s).toMatchObject({ name: 'gh', type: 'stdio', command: 'npx', args: ['-y', 'mcp-gh'] });
    expect(s?.env).toEqual([{ name: 'GH_TOKEN', value: 'abc' }]);
  });

  test('rejects non-stdio types, missing commands and bad names', () => {
    expect(mapClaudeMcpServer('x', { command: 'npx', type: 'http' })).toBeNull();
    expect(mapClaudeMcpServer('x', { args: [] })).toBeNull();
    expect(mapClaudeMcpServer('../evil', { command: 'npx' })).toBeNull();
  });
});

describe('planFromDir', () => {
  test('imports any <name>/SKILL.md tree', () => {
    const src = join(ROOT, 'skills-src');
    writeSkill(src, 'alpha');
    writeSkill(src, 'beta');
    mkdirSync(join(src, 'not-a-skill'), { recursive: true }); // no SKILL.md
    const plan = planFromDir(src, CWD);
    expect(plan.items.map((i) => i.name).sort()).toEqual(['alpha', 'beta']);
    expect(plan.items.every((i) => i.status === 'new')).toBe(true);
  });

  test('rejects a non-directory', () => {
    expect(() => planFromDir(join(ROOT, 'nope'), CWD)).toThrow();
  });

  test('existsSync sanity - apply lands in the user skills dir', () => {
    const src = join(ROOT, 'skills-apply');
    writeSkill(src, 'gamma', '# Gamma\n');
    const plan = planFromDir(src, CWD);
    plan.items[0]!.apply();
    expect(existsSync(join(CONFIG_DIR, 'skills', 'gamma', 'SKILL.md'))).toBe(true);
  });
});
