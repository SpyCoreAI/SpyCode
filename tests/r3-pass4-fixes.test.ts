/**
 * R3-14 / R3-15 / R3-16 / R3-17 (pass 4): REAL unmocked tests.
 *
 * Like tests/http-redirect-live.test.ts, this file mocks NOTHING: a local
 * HTTP server (plus a local TLS server for the downgrade test, whose
 * self-signed cert is generated at runtime with openssl) serves the API
 * and the redirect hops, and the real undici `request()` runs against it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createServer as createTlsServer, type Server as TlsServer } from 'node:https';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { freshConfigDir, fakeCommitIo } from './helpers.js';
import { requestWithRedirects } from '../src/lib/http-redirect.js';
import { truncateSafe } from '../src/lib/text.js';

let server: Server;
let base = '';
let tlsServer: TlsServer | null = null;
let tlsBase = '';
let tlsAvailable = false;
let tlsTmpDir = '';

/** Paths the fake API saw, in order (R3-15 pins the upload path). */
const hitPaths: string[] = [];
/** Bytes the server managed to write of the 100 MB 302 body (R3-14). */
let big302BytesWritten = 0;
/** Hits on the plaintext target of the refused downgrade (R3-16). */
let tlsTargetHits = 0;

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

function stdout(): string {
  return stdoutChunks.join('');
}

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      // A high surrogate at the very end has no partner: charCodeAt
      // past the end is NaN, and NaN fails every comparison, so test
      // the bounds explicitly instead of comparing the raw value.
      if (i + 1 >= s.length) return true;
      const next = s.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    hitPaths.push(`${req.method} ${url}`);
    if (url === '/big302') {
      // R3-14: a 302 carrying a 100 MB body, written backpressure-aware
      // (the server stalls when the client stops reading, so any RSS
      // growth is the client's drain, not server-side buffering).
      res.writeHead(302, { location: '/final' });
      res.on('error', () => {
        /* client went away - expected once the drain stops early */
      });
      const chunk = Buffer.alloc(1024 * 1024, 0x78);
      let closed = false;
      res.on('close', () => {
        closed = true;
      });
      void (async () => {
        try {
          for (let i = 0; i < 100 && !closed; i += 1) {
            if (!res.write(chunk)) {
              await Promise.race([once(res, 'drain'), once(res, 'close')]);
            }
            big302BytesWritten += chunk.length;
          }
        } catch {
          /* client went away mid-body */
        }
        try {
          res.end();
        } catch {
          /* already gone */
        }
      })();
      return;
    }
    if (url === '/final') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('final');
      return;
    }
    if (url === '/tls-target') {
      tlsTargetHits += 1;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('http target');
      return;
    }
    if (url === '/redir') {
      res.writeHead(302, { location: '/file' });
      res.end();
      return;
    }
    if (url === '/file') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello world');
      return;
    }
    if (url === '/api/user/me') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { id: 'u_1', plan: 'PRO' } }));
      return;
    }
    if (url === '/api/files/upload' && req.method === 'POST') {
      // Drain the multipart body, then answer like the real API.
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            success: true,
            data: { id: 'up1', url: 'https://x/up1', size: 5, filename: 't.txt' },
          }),
        );
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'not found' }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
      resolve();
    });
  });

  // R3-16 TLS fixture: a throwaway self-signed cert for 127.0.0.1,
  // generated at runtime (nothing is committed to the repo). If openssl
  // is unavailable the downgrade test skips itself instead of failing
  // the suite on an unrelated environment gap.
  try {
    tlsTmpDir = mkdtempSync(join(tmpdir(), 'spycli-r3-tls-'));
    const keyPath = join(tlsTmpDir, 'key.pem');
    const certPath = join(tlsTmpDir, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048',
        '-keyout', keyPath, '-out', certPath,
        '-days', '2', '-nodes',
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    tlsServer = createTlsServer(
      { key: readFileSync(keyPath), cert: readFileSync(certPath) },
      (req, res) => {
        const url = req.url ?? '/';
        if (url === '/down') {
          res.writeHead(302, { location: `${base}/tls-target` });
          res.end();
          return;
        }
        if (url === '/up') {
          res.writeHead(302, { location: `${tlsBase}/tlsfinal` });
          res.end();
          return;
        }
        if (url === '/tlsfinal') {
          res.writeHead(200, { 'content-type': 'text/plain' });
          res.end('tls final');
          return;
        }
        res.writeHead(404);
        res.end();
      },
    );
    await new Promise<void>((resolve) => {
      tlsServer!.listen(0, '127.0.0.1', () => {
        const addr = tlsServer!.address();
        tlsBase = `https://127.0.0.1:${typeof addr === 'object' && addr !== null ? addr.port : 0}`;
        resolve();
      });
    });
    tlsAvailable = true;
  } catch {
    tlsAvailable = false;
  }

  freshConfigDir();
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterAll(() => {
  server.close();
  tlsServer?.close();
  if (tlsTmpDir) rmSync(tlsTmpDir, { recursive: true, force: true });
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

async function runFiles(argv: string[], parentArgs: string[] = []): Promise<unknown> {
  const { Command } = await import('commander');
  const { registerFilesCommand } = await import('../src/commands/files/index.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerFilesCommand(program);
  let caught: unknown = null;
  try {
    await program.parseAsync(['node', 'spycore', ...parentArgs, 'files', ...argv]);
  } catch (e) {
    caught = e;
  }
  return caught;
}

describe('R3-14: redirect bodies are drained bounded, never slurped', () => {
  test(
    'a 302 with a 100 MB body does not spike RSS and still follows to 200',
    async () => {
      const baseRss = process.memoryUsage().rss;
      let peakRss = baseRss;
      const sampler = setInterval(() => {
        const rss = process.memoryUsage().rss;
        if (rss > peakRss) peakRss = rss;
      }, 25);
      try {
        const res = await requestWithRedirects(`${base}/big302`, {
          signal: AbortSignal.timeout(30_000),
        });
        expect(res.statusCode).toBe(200);
        expect(await res.body.text()).toBe('final');
      } finally {
        clearInterval(sampler);
      }
      const peakDeltaMB = (peakRss - baseRss) / (1024 * 1024);
      // eslint-disable-next-line no-console
      console.log(
        `R3-14 probe: baseRss=${Math.round(baseRss / 1048576)}MB peakDelta=${peakDeltaMB.toFixed(1)}MB serverWrote=${Math.round(big302BytesWritten / 1048576)}MB`,
      );
      // The old unbounded drain spiked peak RSS by 317 MB on this probe;
      // the bounded drain must stay far below that (one socket-sized
      // chunk plus the 64 KiB cap). 64 MB leaves ample headroom for
      // allocator noise while still catching the old behaviour.
      expect(peakDeltaMB).toBeLessThan(64);
      // The server stopped early too: it never got to write the full body.
      expect(big302BytesWritten).toBeLessThan(16 * 1024 * 1024);
    },
    30_000,
  );

  test('a same-scheme http redirect still follows (control)', async () => {
    const res = await requestWithRedirects(`${base}/redir`, {
      signal: AbortSignal.timeout(5_000),
    });
    expect(res.statusCode).toBe(200);
    expect(await res.body.text()).toBe('hello world');
  });
});

describe('R3-15: files upload normalizes a no-/api base', () => {
  test(
    'upload against a no-/api base POSTs to /api/files/upload and exits 0',
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'spycli-r3-upload-'));
      try {
        const file = join(workDir, 't.txt');
        writeFileSync(file, 'hello');
        hitPaths.length = 0;
        captureOutput();
        let caught: unknown;
        try {
          caught = await runFiles(['upload', file], ['--api-url', base]);
        } finally {
          process.stdout.write = origStdoutWrite;
          process.stderr.write = origStderrWrite;
        }
        expect(caught).toBeNull();
        expect(stdout()).toContain('Uploaded t.txt');
        expect(hitPaths).toContain('POST /api/files/upload');
        expect(hitPaths).not.toContain('POST /files/upload');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    10_000,
  );

  test(
    'upload against a with-/api base still works (control)',
    async () => {
      const workDir = mkdtempSync(join(tmpdir(), 'spycli-r3-upload-'));
      try {
        const file = join(workDir, 't.txt');
        writeFileSync(file, 'hello');
        hitPaths.length = 0;
        captureOutput();
        let caught: unknown;
        try {
          caught = await runFiles(['upload', file], ['--api-url', `${base}/api`]);
        } finally {
          process.stdout.write = origStdoutWrite;
          process.stderr.write = origStderrWrite;
        }
        expect(caught).toBeNull();
        expect(stdout()).toContain('Uploaded t.txt');
        expect(hitPaths).toContain('POST /api/files/upload');
        expect(hitPaths).not.toContain('POST /files/upload');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    },
    10_000,
  );
});

describe('R3-16: https-to-http redirect downgrades are refused', () => {
  test(
    'https -> http 302 is refused with a downgrade error; the http target is never fetched',
    async ({ skip }) => {
      if (!tlsAvailable) {
        // eslint-disable-next-line no-console
        console.warn('R3-16 test skipped: openssl unavailable, no TLS fixture');
        skip();
      }
      const prev = getGlobalDispatcher();
      setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
      try {
        const before = tlsTargetHits;
        await expect(
          requestWithRedirects(`${tlsBase}/down`, {
            signal: AbortSignal.timeout(10_000),
          }),
        ).rejects.toThrow(/downgrades HTTPS to plain HTTP/);
        expect(tlsTargetHits).toBe(before);
      } finally {
        setGlobalDispatcher(prev);
      }
    },
    10_000,
  );

  test(
    'https -> https and http -> http redirects still follow (controls)',
    async ({ skip }) => {
      if (!tlsAvailable) {
        // eslint-disable-next-line no-console
        console.warn('R3-16 control skipped: openssl unavailable, no TLS fixture');
        skip();
      }
      const prev = getGlobalDispatcher();
      setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
      try {
        const up = await requestWithRedirects(`${tlsBase}/up`, {
          signal: AbortSignal.timeout(10_000),
        });
        expect(up.statusCode).toBe(200);
        expect(await up.body.text()).toBe('tls final');
      } finally {
        setGlobalDispatcher(prev);
      }
      const plain = await requestWithRedirects(`${base}/redir`, {
        signal: AbortSignal.timeout(5_000),
      });
      expect(plain.statusCode).toBe(200);
      expect(await plain.body.text()).toBe('hello world');
    },
    10_000,
  );
});

describe('R3-17: commit-flow status echo truncates without splitting a surrogate pair', () => {
  test('truncateSafe backs off the cut so the emoji pair stays whole', () => {
    // The reviewer's exact reproduction string: the emoji's high
    // surrogate lands at index 1499, the cut at 1500 splits the pair.
    const s = 'x'.repeat(1499) + '😀' + 'y';
    expect(s.slice(0, 1500).charCodeAt(1499)).toBe(0xd83d);
    const cut = truncateSafe(s, 1500);
    expect(cut).toBe('x'.repeat(1499));
    expect(hasLoneSurrogate(cut)).toBe(false);
    // The scanner itself must catch a lone high surrogate at end of
    // string (charCodeAt past the end is NaN, which fails comparisons).
    expect(hasLoneSurrogate(`${'x'.repeat(1499)}${String.fromCharCode(0xd83d)}`)).toBe(true);
  });

  test('the /commit stage-all echo carries no lone surrogate when an emoji filename straddles the cap', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'spycli-r3-commit-'));
    try {
      const git = (args: string[]): void => {
        const r = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
        if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      };
      git(['init']);
      git(['config', 'user.email', 't@t.test']);
      git(['config', 'user.name', 'T']);
      // Raw UTF-8 filenames in status output (the default
      // core.quotePath would octal-escape the emoji instead).
      git(['config', 'core.quotePath', 'false']);
      git(['checkout', '-b', 'main']);
      // Porcelain lines are ` M <name>\n`: 11-char names give 15-char
      // lines, 12-char names give 16-char lines. 8x15 + 86x16 = 1496,
      // so the emoji file's line starts at 1496 and its high surrogate
      // lands exactly at index 1499 - the 1500-char cut splits the pair
      // under a raw `.slice`, but not under `truncateSafe`.
      const names: string[] = [];
      for (let i = 0; i < 8; i += 1) names.push(`pad-${String(i).padStart(3, '0')}.txt`);
      for (let i = 0; i < 86; i += 1) names.push(`pad-${String(i).padStart(4, '0')}.txt`);
      names.push('😀.txt');
      for (const name of names) writeFileSync(join(repoDir, name), 'v1\n');
      git(['add', '-A']);
      git(['commit', '-m', 'chore: initial']);
      for (const name of names) writeFileSync(join(repoDir, name), 'v2\n');
      const { shortStatus } = await import('../src/lib/git.js');
      const status = shortStatus(repoDir);
      expect(status.charCodeAt(1499)).toBe(0xd83d);
      expect(status.charCodeAt(1500)).toBe(0xde00);

      const { runCommitFlow } = await import('../src/lib/slash/commit-flow.js');
      const h = fakeCommitIo(['n']);
      const result = await runCommitFlow({ cwd: repoDir, model: 'hermes', io: h.io });
      expect(result.committed).toBe(false);
      const echo = h.notices.find((n) => n.text.startsWith('Nothing staged.'));
      expect(echo).toBeDefined();
      expect(hasLoneSurrogate(echo!.text)).toBe(false);
      expect(echo!.text).not.toContain('😀');
    } finally {
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 30_000);
});
