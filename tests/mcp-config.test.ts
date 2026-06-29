import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import {
  parseEnvAssignment,
  buildMinimalEnv,
  isValidServerName,
  sanitizeServerName,
  loadProjectMcpServers,
  writeProjectMcpServers,
  projectMcpPath,
  loadMcpServers,
  enabledMcpServers,
  readScope,
  writeScope,
  type McpServerConfig,
} from '../src/lib/agent/mcp-config.js';

let cwd: string;

beforeEach(() => {
  freshConfigDir();
  cwd = mkdtempSync(join(tmpdir(), 'spycli-mcp-cfg-'));
});

afterEach(async () => {
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('parseEnvAssignment', () => {
  test('bare KEY is a passthrough (no value)', () => {
    expect(parseEnvAssignment('API_TOKEN')).toEqual({ name: 'API_TOKEN' });
  });
  test('KEY=VALUE is a literal; value may contain =', () => {
    expect(parseEnvAssignment('FOO=bar')).toEqual({ name: 'FOO', value: 'bar' });
    expect(parseEnvAssignment('URL=https://x/y?a=b')).toEqual({ name: 'URL', value: 'https://x/y?a=b' });
  });
  test('empty value is allowed', () => {
    expect(parseEnvAssignment('EMPTY=')).toEqual({ name: 'EMPTY', value: '' });
  });
  test('invalid names throw', () => {
    expect(() => parseEnvAssignment('=oops')).toThrow();
    expect(() => parseEnvAssignment('1BAD=x')).toThrow();
    expect(() => parseEnvAssignment('has space=x')).toThrow();
  });
});

describe('buildMinimalEnv', () => {
  test('forwards PATH/HOME but NOT arbitrary parent vars', () => {
    const parent = { PATH: '/bin', HOME: '/home/x', SECRET_TOKEN: 'shh', RANDOM: '1' } as NodeJS.ProcessEnv;
    const env = buildMinimalEnv(undefined, parent);
    expect(env.PATH).toBe('/bin');
    expect(env.HOME).toBe('/home/x');
    expect(env.SECRET_TOKEN).toBeUndefined();
    expect(env.RANDOM).toBeUndefined();
  });
  test('passes a configured NAME through from the parent (secret-safe)', () => {
    const parent = { PATH: '/bin', MY_KEY: 'live-value', OTHER: 'no' } as NodeJS.ProcessEnv;
    const env = buildMinimalEnv([{ name: 'MY_KEY' }], parent);
    expect(env.MY_KEY).toBe('live-value');
    expect(env.OTHER).toBeUndefined();
  });
  test('uses a literal value verbatim', () => {
    const env = buildMinimalEnv([{ name: 'LIT', value: 'hello' }], { PATH: '/bin' } as NodeJS.ProcessEnv);
    expect(env.LIT).toBe('hello');
  });
  test('a configured passthrough that is unset in the parent is omitted', () => {
    const env = buildMinimalEnv([{ name: 'MISSING' }], { PATH: '/bin' } as NodeJS.ProcessEnv);
    expect('MISSING' in env).toBe(false);
  });
});

describe('server name validation', () => {
  test('accepts safe names, rejects unsafe', () => {
    expect(isValidServerName('files')).toBe(true);
    expect(isValidServerName('my-server_2')).toBe(true);
    expect(isValidServerName('-bad')).toBe(false);
    expect(isValidServerName('has space')).toBe(false);
    expect(isValidServerName('')).toBe(false);
  });
  test('sanitize maps unsafe chars to underscore', () => {
    expect(sanitizeServerName('a.b/c')).toBe('a_b_c');
  });
});

describe('project file I/O + merge precedence', () => {
  test('round-trips the project file at ./.spycore/mcp.json', () => {
    const servers: McpServerConfig[] = [{ name: 'p', command: 'node', args: ['s.js'] }];
    writeProjectMcpServers(cwd, servers);
    expect(existsSync(projectMcpPath(cwd))).toBe(true);
    expect(loadProjectMcpServers(cwd)).toEqual(servers);
  });

  test('tolerates a bare-array project file and drops junk entries', () => {
    mkdirSync(join(cwd, '.spycore'), { recursive: true });
    writeFileSync(
      projectMcpPath(cwd),
      JSON.stringify([{ name: 'ok', command: 'node' }, { name: 'nocommand' }, 42]),
    );
    expect(loadProjectMcpServers(cwd)).toEqual([{ name: 'ok', command: 'node' }]);
  });

  test('a malformed project file degrades to empty (never throws)', () => {
    mkdirSync(join(cwd, '.spycore'), { recursive: true });
    writeFileSync(projectMcpPath(cwd), '{ not json');
    expect(loadProjectMcpServers(cwd)).toEqual([]);
  });

  test('project entries override user ones by name', () => {
    writeScope('user', cwd, [
      { name: 'shared', command: 'user-cmd' },
      { name: 'only-user', command: 'u' },
    ]);
    writeScope('project', cwd, [{ name: 'shared', command: 'project-cmd' }]);
    const merged = loadMcpServers(cwd);
    const shared = merged.find((s) => s.name === 'shared');
    expect(shared?.command).toBe('project-cmd');
    expect(shared?.scope).toBe('project');
    expect(merged.find((s) => s.name === 'only-user')?.scope).toBe('user');
    // sorted by name
    expect(merged.map((s) => s.name)).toEqual(['only-user', 'shared']);
  });

  test('enabledMcpServers filters out disabled entries', () => {
    writeScope('user', cwd, [
      { name: 'on', command: 'a' },
      { name: 'off', command: 'b', enabled: false },
    ]);
    expect(enabledMcpServers(cwd).map((s) => s.name)).toEqual(['on']);
    // default (unset) enabled is true
    expect(loadMcpServers(cwd).find((s) => s.name === 'on')?.enabled).toBe(true);
  });

  test('readScope/writeScope address the right backend', () => {
    writeScope('user', cwd, [{ name: 'u', command: 'x' }]);
    writeScope('project', cwd, [{ name: 'p', command: 'y' }]);
    expect(readScope('user', cwd).map((s) => s.name)).toEqual(['u']);
    expect(readScope('project', cwd).map((s) => s.name)).toEqual(['p']);
  });
});
