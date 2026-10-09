import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dispatchTool,
  DEFAULT_LIMITS,
  type ToolContext,
} from '../src/lib/agent/tools.js';
import { __clearLspManagersForTests, shutdownLspManagers } from '../src/lib/agent/lsp/manager.js';
import { trustWorkspace } from '../src/lib/config.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/lsp-fixture-server.mjs', import.meta.url));

let cwd: string;
let ctx: ToolContext;

function writeLspConfig(config: unknown): void {
  mkdirSync(join(cwd, '.spycore'), { recursive: true });
  writeFileSync(join(cwd, '.spycore', 'lsp.json'), JSON.stringify(config));
  trustWorkspace(cwd);
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'spycli-lsp-tool-'));
  delete process.env.SPYCODE_LSP;
  ctx = { cwd, limits: DEFAULT_LIMITS };
});

afterEach(async () => {
  delete process.env.SPYCODE_LSP;
  await shutdownLspManagers();
  __clearLspManagersForTests();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('diagnostics tool', () => {
  test('reports how to opt in when LSP is not enabled', async () => {
    writeFileSync(join(cwd, 'a.ts'), 'const x = 1;\n');
    const res = await dispatchTool('diagnostics', { path: 'a.ts' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/not enabled/);
    expect(res.content).toMatch(/\.spycore\/lsp\.json/);
  });

  test('returns live diagnostics for a file when enabled', async () => {
    writeLspConfig({
      enabled: true,
      servers: { typescript: { command: process.execPath, args: [FIXTURE] } },
    });
    writeFileSync(join(cwd, 'package.json'), '{}');
    writeFileSync(join(cwd, 'a.ts'), 'const x = foo;\n');
    const res = await dispatchTool('diagnostics', { path: 'a.ts' }, ctx);
    expect(res.ok).toBe(true);
    expect(res.summary).toMatch(/1 diagnostic/);
    expect(res.content).toMatch(/a\.ts:1:5/);
    expect(res.content).toMatch(/TS2304/);
  });

  test('workspace mode aggregates across files', async () => {
    writeLspConfig({
      enabled: true,
      servers: { typescript: { command: process.execPath, args: [FIXTURE] } },
    });
    writeFileSync(join(cwd, 'package.json'), '{}');
    writeFileSync(join(cwd, 'a.ts'), 'const x = foo;\n');
    const res = await dispatchTool('diagnostics', { timeout: 10 }, ctx);
    expect(res.ok).toBe(true);
    expect(res.content).toMatch(/TS2304/);
  });

  test('rejects paths outside the sandbox', async () => {
    process.env.SPYCODE_LSP = '1';
    const res = await dispatchTool('diagnostics', { path: '../escape.ts' }, ctx);
    expect(res.ok).toBe(false);
  });

  test('reports cleanly for an extension with no language server', async () => {
    process.env.SPYCODE_LSP = '1';
    writeFileSync(join(cwd, 'notes.md'), '# hi\n');
    const res = await dispatchTool('diagnostics', { path: 'notes.md' }, ctx);
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/no language server/);
  });
});
