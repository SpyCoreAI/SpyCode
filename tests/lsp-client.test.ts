import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LspClient } from '../src/lib/agent/lsp/client.js';
import { LspError } from '../src/lib/agent/lsp/types.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/lsp-fixture-server.mjs', import.meta.url));

function startFixture(env: NodeJS.ProcessEnv = {}): Promise<LspClient> {
  return LspClient.start({
    command: process.execPath,
    args: [FIXTURE],
    rootUri: pathToFileURL(cwd).href,
    env: { ...process.env, ...env },
    initTimeoutMs: 5000,
    requestTimeoutMs: 5000,
  });
}

/** Poll until `pid` is no longer a live process (or time out). */
async function waitGone(pid: number, ms = 4000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true; // ESRCH - gone
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'spycli-lsp-cli-'));
});

afterEach(() => {
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('LspClient (real stdio handshake, Content-Length framing)', () => {
  test('initializes and records server capabilities', async () => {
    const client = await startFixture();
    try {
      expect(client.serverCapabilities).toMatchObject({ textDocumentSync: 1 });
      expect(typeof client.pid).toBe('number');
      expect(client.hasExited).toBe(false);
    } finally {
      await client.shutdown();
    }
  });

  test('didOpen → publishDiagnostics → normalized 1-based diagnostics', async () => {
    const client = await startFixture();
    try {
      const uri = `${pathToFileURL(cwd).href}/a.ts`;
      client.openDocument(uri, 'typescript', 'const x = foo;\n');
      const diags = await client.waitForDiagnostics(uri, 5000);
      expect(diags).toHaveLength(1);
      const d = diags[0]!;
      // Fixture sends 0-based (0,4)-(0,9); the client normalises to 1-based.
      expect(d.line).toBe(1);
      expect(d.column).toBe(5);
      expect(d.endLine).toBe(1);
      expect(d.endColumn).toBe(10);
      expect(d.severity).toBe('error');
      expect(d.code).toBe('TS2304');
      expect(d.source).toBe('ts');
      expect(d.message).toMatch(/Cannot find name/);
      // getDiagnostics returns the cached push.
      expect(client.getDiagnostics(uri)).toEqual(diags);
    } finally {
      await client.shutdown();
    }
  });

  test('answers server→client requests (fixture gates diagnostics on the reply)', async () => {
    // The fixture only publishes diagnostics AFTER it receives our response to
    // its window/workDoneProgress/create request. Diagnostics arriving at all
    // therefore proves the client answered the server request.
    const client = await startFixture();
    try {
      const uri = `${pathToFileURL(cwd).href}/b.ts`;
      client.openDocument(uri, 'typescript', 'const y = 1;\n');
      const diags = await client.waitForDiagnostics(uri, 5000);
      expect(diags.length).toBeGreaterThan(0);
    } finally {
      await client.shutdown();
    }
  });

  test('waitForDiagnostics resolves [] on timeout when the server stays silent', async () => {
    const client = await startFixture({ LSP_FIXTURE_NO_DIAG: '1' });
    try {
      const uri = `${pathToFileURL(cwd).href}/c.ts`;
      client.openDocument(uri, 'typescript', 'const z = 1;\n');
      const diags = await client.waitForDiagnostics(uri, 300);
      expect(diags).toEqual([]);
    } finally {
      await client.shutdown();
    }
  });

  test('didChange re-opens an already-open document with a bumped version', async () => {
    const client = await startFixture();
    try {
      const uri = `${pathToFileURL(cwd).href}/d.ts`;
      client.openDocument(uri, 'typescript', 'v1');
      client.openDocument(uri, 'typescript', 'v2'); // → didChange, no crash
      const diags = await client.waitForDiagnostics(uri, 5000);
      expect(diags.length).toBeGreaterThan(0);
      client.closeDocument(uri);
      client.closeDocument(uri); // idempotent — no crash
    } finally {
      await client.shutdown();
    }
  });

  test('shutdown() runs the LSP shutdown→exit sequence and the child is gone', async () => {
    const client = await startFixture();
    const pid = client.pid!;
    await client.shutdown();
    expect(client.hasExited).toBe(true);
    expect(await waitGone(pid)).toBe(true);
  });

  test('a server that exits immediately fails start with LspError', async () => {
    await expect(startFixture({ LSP_FIXTURE_CRASH: '1' })).rejects.toThrow(LspError);
  });

  test('requests after the server died reject with LspError', async () => {
    const client = await startFixture();
    const pid = client.pid!;
    process.kill(pid, 'SIGKILL');
    await expect(client.request('anything', {}, 3000)).rejects.toThrow(LspError);
  });
});
