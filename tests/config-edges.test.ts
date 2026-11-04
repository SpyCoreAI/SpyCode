import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  __resetConfigForTests,
  approveProjectCommandRule,
  approveProjectHook,
  coerceValue,
  ensureConfigFileMode,
  getConfigPath,
  getConfigStore,
  isProjectCommandRuleApproved,
  trustWorkspace,
  untrustWorkspace,
} from '../src/lib/config.js';
import { freshConfigDir } from './helpers.js';

let workDir: string;
let savedTestCwd: string | undefined;
let savedConfigDir: string | undefined;

beforeEach(() => {
  freshConfigDir();
  __resetConfigForTests();
  workDir = mkdtempSync(join(tmpdir(), 'spycli-config-'));
  savedTestCwd = process.env.SPYCORE_TEST_CWD;
  savedConfigDir = process.env.SPYCORE_CONFIG_DIR;
});

afterEach(() => {
  if (savedTestCwd === undefined) delete process.env.SPYCORE_TEST_CWD;
  else process.env.SPYCORE_TEST_CWD = savedTestCwd;
  if (savedConfigDir === undefined) delete process.env.SPYCORE_CONFIG_DIR;
  else process.env.SPYCORE_CONFIG_DIR = savedConfigDir;
  __resetConfigForTests();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('config store selection and file mode', () => {
  test('SPYCORE_CONFIG_DIR is used when no test cwd is set', () => {
    delete process.env.SPYCORE_TEST_CWD;
    const userDir = mkdtempSync(join(tmpdir(), 'spycli-usercfg-'));
    process.env.SPYCORE_CONFIG_DIR = userDir;
    __resetConfigForTests();
    getConfigStore();
    expect(getConfigPath().startsWith(userDir)).toBe(true);
    rmSync(userDir, { recursive: true, force: true });
  });

  test('ensureConfigFileMode tolerates a missing config file', () => {
    getConfigStore();
    rmSync(getConfigPath(), { force: true });
    expect(() => ensureConfigFileMode()).not.toThrow();
  });
});

describe('trust and approval stores', () => {
  test('duplicate trust/approvals are no-ops, untrust of unknown returns false', () => {
    trustWorkspace(workDir);
    trustWorkspace(workDir);
    expect(getConfigStore().get('trustedWorkspaces')).toHaveLength(1);
    expect(untrustWorkspace(join(workDir, 'other'))).toBe(false);
    expect(untrustWorkspace(workDir)).toBe(true);

    approveProjectHook(workDir, 'echo hi');
    approveProjectHook(workDir, 'echo hi');
    expect(getConfigStore().get('approvedProjectHooks')).toHaveLength(1);

    approveProjectCommandRule(workDir, 'allow', 'true');
    approveProjectCommandRule(workDir, 'allow', 'true');
    expect(getConfigStore().get('approvedProjectCommandRules')).toHaveLength(1);
  });

  test('a stored deny rule is recognized with its own kind', () => {
    getConfigStore().set('approvedProjectCommandRules', [
      { workspace: workDir, kind: 'deny', entry: 'rm -rf /' },
    ]);
    expect(isProjectCommandRuleApproved(workDir, 'deny', 'rm -rf /')).toBe(true);
    expect(isProjectCommandRuleApproved(workDir, 'allow', 'rm -rf /')).toBe(false);
  });
});

describe('coerceValue cases', () => {
  test('outputFormat, contextPaths, shell, modelMaxTokens, guardianThreshold', () => {
    expect(coerceValue('outputFormat', 'json')).toBe('json');
    expect(() => coerceValue('outputFormat', 'yaml')).toThrow();
    expect(coerceValue('contextPaths', 'a, b')).toEqual(['a', 'b']);
    expect(coerceValue('shell', '  /bin/sh  ')).toBe('/bin/sh');
    expect(() => coerceValue('shell', '   ')).toThrow();
    expect(coerceValue('modelMaxTokens', '{"hermes": 4000}')).toEqual({ hermes: 4000 });
    expect(() => coerceValue('modelMaxTokens', 'nope')).toThrow();
    expect(coerceValue('guardianThreshold', '5')).toBe(5);
    expect(() => coerceValue('guardianThreshold', '-1')).toThrow();
  });

  test('toolsetsDisabled, keybindings, and the default passthrough', () => {
    expect(coerceValue('toolsetsDisabled', '{"cli":["web"]}')).toEqual({ cli: ['web'] });
    expect(coerceValue('toolsetsDisabled', '{"tui":[]}')).toEqual({ tui: [] });
    expect(coerceValue('toolsetsDisabled', '{"acp":[]}')).toEqual({ acp: [] });
    expect(() => coerceValue('toolsetsDisabled', 'nope')).toThrow();
    expect(() => coerceValue('toolsetsDisabled', '[]')).toThrow();
    expect(() => coerceValue('toolsetsDisabled', '{"bogus":[]}')).toThrow(/unknown surface/);
    expect(() => coerceValue('toolsetsDisabled', '{"cli":"web"}')).toThrow();
    expect(() => coerceValue('toolsetsDisabled', '{"cli":["web", 123]}')).toThrow();
    expect(coerceValue('keybindings', '[]')).toEqual([]);
    expect(() => coerceValue('keybindings', 'nope')).toThrow();
    expect(() =>
      coerceValue('keybindings', '[{"context":"bogus","action":"send","key":"ctrl+enter"}]'),
    ).toThrow();
    expect(coerceValue('defaultModel', 'hermes')).toBe('hermes');
  });

  test('contextPaths empty, JSON array, and malformed JSON', () => {
    expect(coerceValue('contextPaths', '   ')).toEqual([]);
    expect(coerceValue('contextPaths', '["a", "b"]')).toEqual(['a', 'b']);
    expect(() => coerceValue('contextPaths', '["a",')).toThrow();
  });

  test('modelMaxTokens rejects a non-positive value', () => {
    expect(() => coerceValue('modelMaxTokens', '{"hermes": -1}')).toThrow();
    expect(() => coerceValue('modelMaxTokens', '{"hermes": 1.5}')).toThrow();
  });
});
