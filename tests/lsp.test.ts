/**
 * LSP subsystem tests: types, wire framing, opt-in config, manager pure
 * functions, a bounded client handshake against an inline fake server, and
 * the LSP-based diagnostics provider (no `npx tsc` anywhere).
 *
 * The fake server speaks just enough LSP (initialize → initialized,
 * textDocument/didOpen → publishDiagnostics, shutdown → exit) to exercise
 * the client's handshake, push handling and teardown without any real
 * language server installed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';
import { mapLspSeverity, formatLspDiagnostics, LspError } from '../src/lib/agent/lsp/types.js';
import { LspFramer, encodeLspMessage, LSP_MAX_MESSAGE_BYTES } from '../src/lib/agent/lsp/protocol.js';
import { loadLspConfig, LSP_ENV_VAR } from '../src/lib/agent/lsp/config.js';
import {
  detectLanguages,
  languageForExtension,
  commandExists,
  getLspManager,
  __clearLspManagersForTests,
} from '../src/lib/agent/lsp/manager.js';
import { LspClient } from '../src/lib/agent/lsp/client.js';
import { getTypeScriptDiagnostics, formatDiagnostics } from '../src/lib/agent/diagnostics.js';

// ───────────────────────── types ─────────────────────────

describe('lsp/types', () => {
  test('mapLspSeverity maps 1-4 and defaults unknown/omitted to info', () => {
    expect(mapLspSeverity(1)).toBe('error');
    expect(mapLspSeverity(2)).toBe('warning');
    expect(mapLspSeverity(3)).toBe('info');
    expect(mapLspSeverity(4)).toBe('hint');
    expect(mapLspSeverity(undefined)).toBe('info');
    expect(mapLspSeverity(0)).toBe('info');
    expect(mapLspSeverity(99)).toBe('info');
  });

  test('formatLspDiagnostics renders file:line:col [severity] message', () => {
    expect(formatLspDiagnostics([])).toBe('No diagnostics.');
    const one = formatLspDiagnostics([
      { file: '/a.ts', line: 1, column: 2, endLine: 1, endColumn: 5, severity: 'error', message: 'boom' },
    ]);
    expect(one).toBe('/a.ts:1:2 [error] boom');
    const full = formatLspDiagnostics([
      {
        file: '/a.ts', line: 3, column: 4, endLine: 3, endColumn: 9,
        severity: 'warning', message: 'careful', code: 1234, source: 'ts',
      },
    ]);
    expect(full).toBe('/a.ts:3:4 [warning] 1234 careful (ts)');
  });

  test('formatLspDiagnostics caps at 50 with an overflow line', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      file: '/a.ts', line: i + 1, column: 1, endLine: i + 1, endColumn: 2,
      severity: 'error' as const, message: `e${i}`,
    }));
    const out = formatLspDiagnostics(many).split('\n');
    expect(out).toHaveLength(51);
    expect(out[50]).toBe('... and 1 more');
  });

  test('LspError is an Error', () => {
    expect(new LspError('x')).toBeInstanceOf(Error);
  });
});

// ───────────────────────── protocol ─────────────────────────

describe('lsp/protocol', () => {
  const framed = (body: string): Buffer => encodeLspMessage(JSON.parse(body));

  test('encodeLspMessage round-trips through the framer', () => {
    const framer = new LspFramer();
    const bodies = framer.feed(encodeLspMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0] as string)).toEqual({ jsonrpc: '2.0', id: 1, method: 'ping' });
  });

  test('Content-Length counts UTF-8 bytes, not characters', () => {
    const body = JSON.stringify({ text: 'héllo 🌍' });
    const msg = encodeLspMessage(JSON.parse(body));
    const header = msg.subarray(0, msg.indexOf('\r\n\r\n')).toString('ascii');
    expect(header).toBe(`Content-Length: ${Buffer.from(body, 'utf8').length}`);
    // Sanity: the multibyte body is longer in bytes than in chars.
    expect(Buffer.from(body, 'utf8').length).toBeGreaterThan(body.length);
    const framer = new LspFramer();
    expect(framer.feed(msg)).toEqual([body]);
  });

  test('a message split across chunks (even mid-multibyte-char) reassembles', () => {
    const msg = encodeLspMessage({ text: 'héllo 🌍 world' });
    const framer = new LspFramer();
    // Split at every possible byte offset would be slow; split mid-header,
    // mid-body, and inside the multibyte sequence.
    const cuts = [10, msg.indexOf('\r\n\r\n') + 2, msg.length - 3];
    let pending = msg;
    const out: string[] = [];
    for (const cut of cuts) {
      out.push(...framer.feed(pending.subarray(0, cut)));
      pending = pending.subarray(cut);
    }
    out.push(...framer.feed(pending));
    expect(out).toHaveLength(1);
    expect((out[0] as string)).toContain('🌍');
    expect(framer.bufferedBytes).toBe(0);
  });

  test('two messages in one chunk both decode, in order', () => {
    const framer = new LspFramer();
    const both = Buffer.concat([encodeLspMessage({ id: 1 }), encodeLspMessage({ id: 2 })]);
    const bodies = framer.feed(both);
    expect(bodies.map((b) => JSON.parse(b).id)).toEqual([1, 2]);
  });

  test('tolerates lone-LF header terminators', () => {
    const body = Buffer.from('{"id":7}', 'utf8');
    const msg = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\n\n`, 'ascii'), body]);
    expect(new LspFramer().feed(msg)).toEqual(['{"id":7}']);
  });

  test('missing or invalid Content-Length fails closed', () => {
    expect(() => new LspFramer().feed(Buffer.from('Content-Length: abc\r\n\r\n{}', 'ascii'))).toThrow(LspError);
    expect(() => new LspFramer().feed(Buffer.from('X-Other: 5\r\n\r\n{}', 'ascii'))).toThrow(LspError);
  });

  test('oversized message fails closed without allocating', () => {
    const msg = Buffer.from(`Content-Length: ${LSP_MAX_MESSAGE_BYTES + 1}\r\n\r\n`, 'ascii');
    expect(() => new LspFramer().feed(msg)).toThrow(LspError);
  });

  test('header block without a terminator is capped', () => {
    const framer = new LspFramer();
    expect(() => framer.feed(Buffer.alloc(9000, 'x'))).toThrow(LspError);
  });

  test('partial message stays buffered until complete', () => {
    const framer = new LspFramer();
    const msg = encodeLspMessage({ id: 9 });
    expect(framer.feed(msg.subarray(0, 12))).toEqual([]);
    expect(framer.bufferedBytes).toBe(12);
    expect(framer.feed(msg.subarray(12))).toHaveLength(1);
  });

  test('framed helper is unused-safe: encodeLspMessage of primitives', () => {
    expect(new LspFramer().feed(framed('"just a string"'))).toEqual(['"just a string"']);
  });
});

// ───────────────────────── config ─────────────────────────

describe('lsp/config', () => {
  let workDir: string;
  let envBefore: string | undefined;
  let configDir: string;

  const writeConfig = (content: string): void => {
    const d = join(workDir, '.spycore');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'lsp.json'), content, 'utf8');
  };

  async function lspEnabled(cwd: string): Promise<boolean> {
    const { isLspEnabled } = await import('../src/lib/agent/lsp/config.js');
    return isLspEnabled(cwd);
  }

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lsp-cfg-'));
    configDir = freshConfigDir();
    envBefore = process.env[LSP_ENV_VAR];
    delete process.env[LSP_ENV_VAR];
  });

  afterEach(() => {
    vi.resetModules();
    if (envBefore === undefined) delete process.env[LSP_ENV_VAR];
    else process.env[LSP_ENV_VAR] = envBefore;
    rmSync(workDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test('loadLspConfig: missing file → {}; malformed JSON → {} (never throws)', () => {
    expect(loadLspConfig(workDir)).toEqual({});
    writeConfig('{not json');
    expect(loadLspConfig(workDir)).toEqual({});
    writeConfig('[1,2]');
    expect(loadLspConfig(workDir)).toEqual({});
  });

  test('loadLspConfig: reads enabled + validated server overrides', () => {
    writeConfig(
      JSON.stringify({
        enabled: true,
        servers: {
          python: { command: 'pyright-langserver', args: ['--stdio'] },
          go: { command: '' }, // empty command — dropped
          cobol: { command: 'cobol-ls' }, // unknown language — ignored
        },
      }),
    );
    expect(loadLspConfig(workDir)).toEqual({
      enabled: true,
      servers: { python: { command: 'pyright-langserver', args: ['--stdio'] } },
    });
  });

  test('loadLspConfig: non-boolean enabled is ignored', () => {
    writeConfig(JSON.stringify({ enabled: 'yes' }));
    expect(loadLspConfig(workDir)).toEqual({});
  });

  test('isLspEnabled: env var wins over everything', async () => {
    writeConfig(JSON.stringify({ enabled: false }));
    process.env[LSP_ENV_VAR] = '1';
    expect(await lspEnabled(workDir)).toBe(true);
    process.env[LSP_ENV_VAR] = '0';
    expect(await lspEnabled(workDir)).toBe(false);
    for (const v of ['true', 'yes', 'True', ' YES ']) {
      process.env[LSP_ENV_VAR] = v;
      expect(await lspEnabled(workDir)).toBe(true);
    }
    for (const v of ['false', 'no', '0']) {
      process.env[LSP_ENV_VAR] = v;
      expect(await lspEnabled(workDir)).toBe(false);
    }
  });

  test('isLspEnabled: unrecognised env value falls through to the file', async () => {
    writeConfig(JSON.stringify({ enabled: true }));
    process.env[LSP_ENV_VAR] = 'maybe';
    const { trustWorkspace } = await import('../src/lib/config.js');
    trustWorkspace(workDir);
    expect(await lspEnabled(workDir)).toBe(true);
  });

  test('isLspEnabled: default off; file opt-in needs workspace trust', async () => {
    expect(await lspEnabled(workDir)).toBe(false);
    writeConfig(JSON.stringify({ enabled: true }));
    // Untrusted: a cloned repo's lsp.json must not spawn processes.
    expect(await lspEnabled(workDir)).toBe(false);
    const { trustWorkspace } = await import('../src/lib/config.js');
    trustWorkspace(workDir);
    expect(await lspEnabled(workDir)).toBe(true);
  });

  test('isLspEnabled: env opt-in bypasses the trust gate (explicit user action)', async () => {
    process.env[LSP_ENV_VAR] = '1';
    expect(await lspEnabled(workDir)).toBe(true);
  });
});

// ───────────────────────── manager (pure parts) ─────────────────────────

describe('lsp/manager pure functions', () => {
  let workDir: string;
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lsp-mgr-'));
    __clearLspManagersForTests();
  });
  afterEach(() => {
    __clearLspManagersForTests();
    rmSync(workDir, { recursive: true, force: true });
  });

  test('detectLanguages: root markers, then extension fallback, in spec order', () => {
    expect(detectLanguages(workDir)).toEqual([]);
    writeFileSync(join(workDir, 'main.py'), 'x');
    expect(detectLanguages(workDir)).toEqual(['python']);
    writeFileSync(join(workDir, 'tsconfig.json'), '{}');
    // Spec priority order: typescript before python.
    expect(detectLanguages(workDir)).toEqual(['typescript', 'python']);
    writeFileSync(join(workDir, 'go.mod'), 'module x');
    writeFileSync(join(workDir, 'Cargo.toml'), '[package]');
    expect(detectLanguages(workDir)).toEqual(['typescript', 'python', 'go', 'rust']);
  });

  test('languageForExtension is case-insensitive; null when unknown', () => {
    expect(languageForExtension('.ts')).toBe('typescript');
    expect(languageForExtension('.TS')).toBe('typescript');
    expect(languageForExtension('.tsx')).toBe('typescript');
    expect(languageForExtension('.py')).toBe('python');
    expect(languageForExtension('.go')).toBe('go');
    expect(languageForExtension('.rs')).toBe('rust');
    expect(languageForExtension('.md')).toBeNull();
    expect(languageForExtension('')).toBeNull();
  });

  test('commandExists finds PATH binaries and misses nonsense', () => {
    expect(commandExists('node')).toBe(true);
    expect(commandExists('spycore-definitely-not-a-real-command-xyz')).toBe(false);
    expect(commandExists(process.execPath)).toBe(true);
  });

  test('getLspManager caches per resolved workspace root', () => {
    const a = getLspManager(workDir);
    const b = getLspManager(workDir);
    expect(a).toBe(b);
    expect(a.cwd).toBe(workDir);
    const other = mkdtempSync(join(tmpdir(), 'lsp-mgr2-'));
    try {
      expect(getLspManager(other)).not.toBe(a);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    __clearLspManagersForTests();
    expect(getLspManager(workDir)).not.toBe(a);
  });
});

// ───────────────────────── client ─────────────────────────

const FAKE_SERVER = `
const chunks = [];
process.stdin.on('data', (c) => {
  let buf = Buffer.concat([...chunks, c]);
  chunks.length = 0;
  for (;;) {
    const i = buf.indexOf('\\r\\n\\r\\n');
    if (i === -1) { chunks.push(buf); return; }
    const m = buf.subarray(0, i).toString('ascii').match(/content-length:\\s*(\\d+)/i);
    if (!m) process.exit(3);
    const len = parseInt(m[1], 10);
    if (buf.length < i + 4 + len) { chunks.push(buf); return; }
    const msg = JSON.parse(buf.subarray(i + 4, i + 4 + len).toString('utf8'));
    buf = buf.subarray(i + 4 + len);
    handle(msg);
  }
});
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + body.length + '\\r\\n\\r\\n', 'ascii'), body]));
}
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { textDocumentSync: 1 } } });
  } else if (msg.method === 'textDocument/didOpen') {
    const uri = msg.params.textDocument.uri;
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
      uri,
      diagnostics: [{
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 5 } },
        severity: 1, code: 123, source: 'fake', message: 'fake error',
      }],
    }});
  } else if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  } else if (msg.method === 'exit') {
    process.exit(0);
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  }
}
`;

describe('lsp/client', () => {
  test('start rejects with LspError when the command does not exist', async () => {
    await expect(
      LspClient.start({
        command: 'spycore-definitely-not-a-real-command-xyz',
        args: [],
        rootUri: 'file:///tmp',
        initTimeoutMs: 3000,
      }),
    ).rejects.toThrow(LspError);
  }, 15000);

  test('handshake + push diagnostics + graceful shutdown against a fake server', async () => {
    const client = await LspClient.start({
      command: process.execPath,
      args: ['-e', FAKE_SERVER],
      rootUri: 'file:///tmp',
      initTimeoutMs: 10000,
    });
    try {
      expect(client.hasExited).toBe(false);
      expect(client.serverCapabilities).toEqual({ textDocumentSync: 1 });
      const uri = 'file:///tmp/a.ts';
      client.openDocument(uri, 'typescript', 'const x = 1;');
      const diags = await client.waitForDiagnostics(uri, 5000);
      expect(diags).toHaveLength(1);
      // 0-based LSP range → 1-based agent range.
      expect(diags[0]).toMatchObject({
        file: '/tmp/a.ts',
        line: 1,
        column: 2,
        endLine: 1,
        endColumn: 6,
        severity: 'error',
        message: 'fake error',
        code: 123,
        source: 'fake',
      });
      expect(client.getDiagnostics(uri)).toHaveLength(1);
    } finally {
      await client.shutdown();
    }
    expect(client.hasExited).toBe(true);
  }, 30000);
});

// ───────────────────────── diagnostics provider ─────────────────────────

describe('diagnostics (LSP-based)', () => {
  let workDir: string;
  let envBefore: string | undefined;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'lsp-diag-'));
    freshConfigDir();
    envBefore = process.env[LSP_ENV_VAR];
    delete process.env[LSP_ENV_VAR];
    __clearLspManagersForTests();
  });

  afterEach(() => {
    vi.resetModules();
    if (envBefore === undefined) delete process.env[LSP_ENV_VAR];
    else process.env[LSP_ENV_VAR] = envBefore;
    rmSync(workDir, { recursive: true, force: true });
    __clearLspManagersForTests();
  });

  test('not enabled → ok:false with an opt-in reason (spawns nothing)', async () => {
    writeFileSync(join(workDir, 'tsconfig.json'), '{}');
    const result = await getTypeScriptDiagnostics(workDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not enabled');
  });

  test('enabled but no TypeScript server installed → ok:false names the cause', async () => {
    if (commandExists('typescript-language-server')) return; // needs the negative path
    process.env[LSP_ENV_VAR] = '1';
    writeFileSync(join(workDir, 'tsconfig.json'), '{}');
    writeFileSync(join(workDir, 'a.ts'), 'const x: number = 1;\n');
    const result = await getTypeScriptDiagnostics(workDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('unavailable');
  }, 60000);

  test('formatDiagnostics: failure, empty, entries, overflow', () => {
    expect(formatDiagnostics({ ok: false, reason: 'nope' })).toBe('Diagnostic check failed: nope');
    expect(formatDiagnostics({ ok: true, diagnostics: [] })).toBe('No TypeScript errors.');
    const one = formatDiagnostics({
      ok: true,
      diagnostics: [{ file: 'a.ts', line: 1, column: 2, severity: 'error', message: 'm', code: 2322 }],
    });
    expect(one).toBe('a.ts:1:2 [TS2322] m');
    const many = Array.from({ length: 55 }, (_, i) => ({
      file: 'a.ts', line: i + 1, column: 1, severity: 'error' as const, message: 'm', code: 1,
    }));
    const out = formatDiagnostics({ ok: true, diagnostics: many }).split('\n');
    expect(out).toHaveLength(51);
    expect(out[50]).toBe('... and 5 more');
  });
});

// ───────────────────────── barrel ─────────────────────────

describe('lsp/index barrel', () => {
  test('re-exports the public surface', async () => {
    const mod = await import('../src/lib/agent/lsp/index.js');
    for (const name of [
      'LspClient',
      'LspManager',
      'LANGUAGE_SPECS',
      'detectLanguages',
      'languageForExtension',
      'commandExists',
      'getLspManager',
      'shutdownLspManagers',
      'loadLspConfig',
      'isLspEnabled',
      'LspFramer',
      'encodeLspMessage',
      'LspError',
      'mapLspSeverity',
      'formatLspDiagnostics',
    ]) {
      expect((mod as Record<string, unknown>)[name], name).toBeDefined();
    }
  });
});
