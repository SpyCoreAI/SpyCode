/**
 * R3-1 (pass 3): REAL unmocked HTTP tests for the redirect fix.
 *
 * The suite's undici mocks hid the defect (they asserted the broken
 * `maxRedirections` option was *passed*). This file mocks NOTHING: a local
 * HTTP server on 127.0.0.1 serves the API + presigned-URL hops, and the
 * real undici `request()` runs against it - so a regression here fails the
 * way the live CLI failed (exit 1 / silent preview), not the way a mock
 * would let it pass.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { requestWithRedirects } from '../src/lib/http-redirect.js';

let server: Server;
let base = '';

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

function stdout(): string {
  return stdoutChunks.join('');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/api/files/f1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            id: 'f1',
            filename: 'hello.txt',
            mimeType: 'text/plain',
            size: 11,
            url: `${base}/redir`,
            createdAt: new Date().toISOString(),
          },
        }),
      );
      return;
    }
    if (url === '/api/files/f2') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: {
            id: 'f2',
            filename: 'note.md',
            mimeType: 'text/markdown',
            size: 20,
            url: `${base}/redir-text`,
            createdAt: new Date().toISOString(),
          },
        }),
      );
      return;
    }
    if (url === '/api/auth/cli/whoami') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          success: true,
          data: { email: 'test@example.com', planDisplay: 'Pro' },
        }),
      );
      return;
    }
    if (url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptime: 1,
          timestamp: new Date().toISOString(),
          version: '0.9.10-test',
          build: 'test',
        }),
      );
      return;
    }
    if (url === '/redir') {
      // Relative Location, like a presigned S3/R2 URL serves.
      res.writeHead(302, { location: '/file' });
      res.end();
      return;
    }
    if (url === '/redir-text') {
      res.writeHead(302, { location: `${base}/file-text` });
      res.end();
      return;
    }
    if (url === '/file') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello world');
      return;
    }
    if (url === '/file-text') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello preview text');
      return;
    }
    if (url === '/loop') {
      res.writeHead(302, { location: '/loop' });
      res.end();
      return;
    }
    if (url === '/nolocation') {
      res.writeHead(302);
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
      resolve();
    });
  });
  freshConfigDir();
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterAll(() => {
  server.close();
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
});

function captureOutput(): void {
  stdoutChunks = [];
  stderrChunks = [];
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
}

async function runFiles(argv: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerFilesCommand } = await import('../src/commands/files/index.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerFilesCommand(program);
  await program.parseAsync(['node', 'spycore', ...parentArgs, 'files', ...argv]);
}

describe('requestWithRedirects against a real HTTP server (no mocks)', () => {
  test('follows a 302 with a relative Location to 200', async () => {
    const res = await requestWithRedirects(`${base}/redir`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.statusCode).toBe(200);
    expect(await res.body.text()).toBe('hello world');
  });

  test('follows a 302 with an absolute Location to 200', async () => {
    const res = await requestWithRedirects(`${base}/redir-text`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.statusCode).toBe(200);
    expect(await res.body.text()).toBe('hello preview text');
  });

  test('a 302 without Location is returned as-is (caller decides)', async () => {
    const res = await requestWithRedirects(`${base}/nolocation`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.statusCode).toBe(302);
  });

  test('a redirect loop stops after the hop budget and returns the 302', async () => {
    const res = await requestWithRedirects(`${base}/loop`, {
      signal: AbortSignal.timeout(5_000),
      maxRedirections: 3,
    });
    expect(res.statusCode).toBe(302);
  });
});

describe('files download/show against a real HTTP server (no mocks)', () => {
  test('files download follows the presigned-URL 302 and writes the bytes', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'spycli-r3-live-'));
    try {
      captureOutput();
      const out = join(workDir, 'hello.txt');
      await runFiles(['download', 'f1', '--output', out, '--force'], ['--api-url', base]);
      expect(readFileSync(out, 'utf8')).toBe('hello world');
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('files show renders the preview through the presigned-URL 302', async () => {
    captureOutput();
    try {
      await runFiles(['show', 'f2'], ['--api-url', base]);
      expect(stdout()).toContain('--- preview ---');
      expect(stdout()).toContain('hello preview text');
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }
  });
});

describe('ping against a real HTTP server (no mocks)', () => {
  test('ping reaches /api/health with a no-/api base (R3-5)', async () => {
    const { Command } = await import('commander');
    const { registerPingCommand } = await import('../src/commands/ping.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    captureOutput();
    try {
      const program = new Command();
      program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
      registerPingCommand(program);
      await program.parseAsync(['node', 'spycore', '--api-url', base, 'ping']);
      expect(stdout()).toContain('API reachable');
    } finally {
      process.stdout.write = origStdoutWrite;
      process.stderr.write = origStderrWrite;
    }
  });
});
