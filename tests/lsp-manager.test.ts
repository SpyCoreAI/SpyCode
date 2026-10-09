import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  __clearLspManagersForTests,
  commandExists,
  detectLanguages,
  getLspManager,
  languageForExtension,
  LspManager,
  shutdownLspManagers,
} from '../src/lib/agent/lsp/manager.js';
import { isLspEnabled, loadLspConfig } from '../src/lib/agent/lsp/config.js';
import { LspError } from '../src/lib/agent/lsp/types.js';
import { trustWorkspace } from '../src/lib/config.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/lsp-fixture-server.mjs', import.meta.url));

let cwd: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'spycli-lsp-mgr-'));
  savedEnv = { ...process.env };
  delete process.env.SPYCODE_LSP;
});

afterEach(async () => {
  process.env = savedEnv;
  await shutdownLspManagers();
  __clearLspManagersForTests();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function writeLspConfig(config: unknown): void {
  mkdirSync(join(cwd, '.spycore'), { recursive: true });
  writeFileSync(join(cwd, '.spycore', 'lsp.json'), JSON.stringify(config));
  // Fixture tests use custom server overrides; trust the workspace so the
  // security gate allows them (the gate itself is tested separately).
  trustWorkspace(cwd);
}

describe('detectLanguages', () => {
  test('detects TypeScript from package.json / tsconfig.json', () => {
    writeFileSync(join(cwd, 'package.json'), '{}');
    expect(detectLanguages(cwd)).toEqual(['typescript']);
  });

  test('detects each language from its root marker', () => {
    const cases: Array<[string, string[]]> = [
      ['pyproject.toml', ['python']],
      ['go.mod', ['go']],
      ['Cargo.toml', ['rust']],
    ];
    for (const [marker, expected] of cases) {
      const dir = mkdtempSync(join(tmpdir(), 'spycli-lsp-det-'));
      try {
        writeFileSync(join(dir, marker), '');
        expect(detectLanguages(dir)).toEqual(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('falls back to a top-level extension probe', () => {
    writeFileSync(join(cwd, 'main.go'), 'package main\n');
    expect(detectLanguages(cwd)).toEqual(['go']);
  });

  test('returns [] for an empty directory', () => {
    expect(detectLanguages(cwd)).toEqual([]);
  });

  test('reports multiple languages in spec priority order', () => {
    writeFileSync(join(cwd, 'Cargo.toml'), '');
    writeFileSync(join(cwd, 'package.json'), '{}');
    expect(detectLanguages(cwd)).toEqual(['typescript', 'rust']);
  });
});

describe('languageForExtension', () => {
  test('maps extensions to languages', () => {
    expect(languageForExtension('.ts')).toBe('typescript');
    expect(languageForExtension('.tsx')).toBe('typescript');
    expect(languageForExtension('.py')).toBe('python');
    expect(languageForExtension('.go')).toBe('go');
    expect(languageForExtension('.rs')).toBe('rust');
    expect(languageForExtension('.md')).toBeNull();
    expect(languageForExtension('')).toBeNull();
  });
});

describe('commandExists', () => {
  test('finds node on PATH and rejects nonsense names', () => {
    expect(commandExists('node')).toBe(true);
    expect(commandExists('definitely-not-a-real-binary-xyz')).toBe(false);
  });

  test('finds a fake executable prepended to PATH', () => {
    const bin = mkdtempSync(join(tmpdir(), 'spycli-lsp-bin-'));
    try {
      const exe = join(bin, 'fake-ls-binary');
      writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
      process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;
      expect(commandExists('fake-ls-binary')).toBe(true);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});

describe('LSP opt-in config', () => {
  test('loadLspConfig: absent file → {}', () => {
    expect(loadLspConfig(cwd)).toEqual({});
  });

  test('loadLspConfig: malformed JSON → {} (never throws)', () => {
    mkdirSync(join(cwd, '.spycore'), { recursive: true });
    writeFileSync(join(cwd, '.spycore', 'lsp.json'), '{not json');
    expect(loadLspConfig(cwd)).toEqual({});
  });

  test('loadLspConfig: parses enabled + server overrides, drops junk', () => {
    writeLspConfig({
      enabled: true,
      servers: {
        python: { command: 'pyright-langserver', args: ['--stdio'] },
        cobol: { command: 'cobc' },
        go: { command: '' },
      },
    });
    expect(loadLspConfig(cwd)).toEqual({
      enabled: true,
      servers: { python: { command: 'pyright-langserver', args: ['--stdio'] } },
    });
  });

  test('isLspEnabled: default off, file opts in (trusted), env overrides both ways', () => {
    expect(isLspEnabled(cwd)).toBe(false);
    writeLspConfig({ enabled: true });
    // writeLspConfig trusts the workspace (fixture helper); file-based
    // opt-in requires trust (security: cloned repos must not spawn arbitrary
    // servers until trusted).
    expect(isLspEnabled(cwd)).toBe(true);
    process.env.SPYCODE_LSP = '0';
    expect(isLspEnabled(cwd)).toBe(false);
    process.env.SPYCODE_LSP = '1';
    expect(isLspEnabled(cwd)).toBe(true);
  });

  test('isLspEnabled: file opt-in without trust is denied', () => {
    mkdirSync(join(cwd, '.spycore'), { recursive: true });
    writeFileSync(join(cwd, '.spycore', 'lsp.json'), JSON.stringify({ enabled: true }));
    // No trustWorkspace call - must be denied.
    expect(isLspEnabled(cwd)).toBe(false);
  });

  test('isLspEnabled: env alone opts in without any file', () => {
    process.env.SPYCODE_LSP = 'true';
    expect(isLspEnabled(cwd)).toBe(true);
  });
});

describe('LspManager (fixture-backed)', () => {
  function enableWithFixture(): void {
    writeLspConfig({
      enabled: true,
      servers: { typescript: { command: process.execPath, args: [FIXTURE] } },
    });
    writeFileSync(join(cwd, 'package.json'), '{}');
  }

  test('ensureServer starts on demand; statuses() matches the sidebar shape', async () => {
    enableWithFixture();
    const manager = new LspManager(cwd);
    try {
      const client = await manager.ensureServer('typescript');
      expect(client.hasExited).toBe(false);
      // Second call reuses the warm server.
      expect(await manager.ensureServer('typescript')).toBe(client);
      expect(manager.statuses()).toEqual([
        { name: 'typescript-language-server', status: 'running', languages: ['TypeScript/JavaScript'] },
      ]);
    } finally {
      await manager.shutdown();
    }
  });

  test('fileDiagnostics returns the fixture diagnostic for a .ts file', async () => {
    enableWithFixture();
    const manager = new LspManager(cwd);
    try {
      const file = join(cwd, 'a.ts');
      writeFileSync(file, 'const x = foo;\n');
      const diags = await manager.fileDiagnostics(file, { timeoutMs: 8000 });
      expect(diags).toHaveLength(1);
      expect(diags[0]).toMatchObject({
        file,
        line: 1,
        column: 5,
        severity: 'error',
        code: 'TS2304',
      });
    } finally {
      await manager.shutdown();
    }
  });

  test('fileDiagnostics rejects for an extension with no server', async () => {
    enableWithFixture();
    const manager = new LspManager(cwd);
    try {
      await expect(manager.fileDiagnostics(join(cwd, 'notes.md'))).rejects.toThrow(LspError);
    } finally {
      await manager.shutdown();
    }
  });

  test('missing server binary → LspError and status error (no hang)', async () => {
    // Bogus override keeps this hermetic even where a real gopls is installed.
    writeLspConfig({
      enabled: true,
      servers: { go: { command: 'definitely-not-a-real-gopls', args: [] } },
    });
    writeFileSync(join(cwd, 'package.json'), '{}');
    const manager = new LspManager(cwd);
    try {
      await expect(manager.ensureServer('go')).rejects.toThrow(LspError);
      expect(manager.statuses()).toEqual([
        { name: 'gopls', status: 'error', languages: ['Go'] },
      ]);
      expect(manager.serverError('go')).toMatch(/not found/);
    } finally {
      await manager.shutdown();
    }
  });

  test('a crashing server records status error', async () => {
    // `false` exits 1 immediately: the handshake fails and the manager records
    // status error instead of hanging or throwing an unclassified error.
    const m2dir = mkdtempSync(join(tmpdir(), 'spycli-lsp-crash-'));
    try {
      mkdirSync(join(m2dir, '.spycore'), { recursive: true });
      writeFileSync(
        join(m2dir, '.spycore', 'lsp.json'),
        JSON.stringify({ enabled: true, servers: { go: { command: 'false', args: [] } } }),
      );
      writeFileSync(join(m2dir, 'go.mod'), 'module x\n');
      const m2 = new LspManager(m2dir);
      await expect(m2.ensureServer('go')).rejects.toThrow(LspError);
      expect(m2.statuses()).toEqual([{ name: 'gopls', status: 'error', languages: ['Go'] }]);
      await m2.shutdown();
    } finally {
      rmSync(m2dir, { recursive: true, force: true });
    }
  });

  test('workspaceDiagnostics aggregates across files and skips dead servers', async () => {
    writeLspConfig({
      enabled: true,
      servers: {
        typescript: { command: process.execPath, args: [FIXTURE] },
        // Force the skip deterministically, regardless of what is on PATH.
        go: { command: 'definitely-not-a-real-gopls', args: [] },
      },
    });
    writeFileSync(join(cwd, 'package.json'), '{}');
    writeFileSync(join(cwd, 'go.mod'), 'module x\n'); // go detected, binary bogus → skipped
    writeFileSync(join(cwd, 'a.ts'), 'const a = foo;\n');
    mkdirSync(join(cwd, 'sub'), { recursive: true });
    writeFileSync(join(cwd, 'sub', 'b.ts'), 'const b = foo;\n');
    const manager = new LspManager(cwd);
    try {
      const { diagnostics, skipped } = await manager.workspaceDiagnostics({
        timeoutMs: 15000,
        maxFiles: 10,
      });
      expect(diagnostics.length).toBeGreaterThanOrEqual(1);
      expect(diagnostics[0]!.file).toContain(cwd);
      expect(skipped.map((s) => s.language)).toEqual(['go']);
    } finally {
      await manager.shutdown();
    }
  });

  test('getLspManager caches per cwd; shutdownLspManagers clears', async () => {
    enableWithFixture();
    const a = getLspManager(cwd);
    expect(getLspManager(cwd)).toBe(a);
    expect(getLspManager(join(cwd, 'sub'))).not.toBe(a);
    await a.ensureServer('typescript');
    await shutdownLspManagers();
    expect(getLspManager(cwd)).not.toBe(a);
  });
});
