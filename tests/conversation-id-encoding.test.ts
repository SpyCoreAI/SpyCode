import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';

/**
 * H9 - conversation ids went into URLs unencoded, so a crafted id could
 * traverse to other API endpoints (`spycore conversations delete
 * '../../api/memory'` became `DELETE /api/memory`) or inject a query
 * string. Ids are now `encodeURIComponent`-ed at every call site, the way
 * `files/*` already does.
 */
interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
}

const seenUrls: string[] = [];
let responder: ((url: string, init: { method: string }) => MockResp) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string } = {}) => {
    seenUrls.push(url);
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET' });
  }),
}));

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  seenUrls.length = 0;
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
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  vi.resetModules();
});

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

async function runCli(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerConversationsCommand } = await import('../src/commands/conversations/index.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: false, color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerConversationsCommand(program);
  await program.parseAsync(['node', 'spycore', 'conversations', ...argv]);
}

const CONVO = {
  id: 'cnv_test',
  title: 'Test',
  model: 'HERMES',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('conversation ids are URL-encoded at every call site', () => {
  test('show: ../../api/memory cannot escape to /api/memory', async () => {
    responder = () => jsonResp(200, { success: true, data: CONVO });
    await runCli(['show', '../../api/memory']);
    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).toContain('/conversations/..%2F..%2Fapi%2Fmemory');
    expect(seenUrls[0]).not.toContain('/conversations/../../');
  });

  test('delete: ../../api/memory cannot escape to /api/memory', async () => {
    responder = () => jsonResp(200, { success: true, data: {} });
    await runCli(['delete', '--yes', '../../api/memory']);
    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).toContain('/conversations/..%2F..%2Fapi%2Fmemory');
    expect(seenUrls[0]).not.toContain('/conversations/../../');
  });

  test('export: ../../api/memory cannot escape to /api/memory', async () => {
    responder = () => jsonResp(200, { success: true, data: CONVO });
    await runCli(['export', '../../api/memory']);
    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).toContain('/conversations/..%2F..%2Fapi%2Fmemory');
  });

  test('share: traversal id stays in one path segment for GET and POST', async () => {
    responder = (url, init) => {
      if (init.method === 'POST') return jsonResp(200, { success: true, data: { url: 'https://share.example/x' } });
      return jsonResp(200, { success: true, data: CONVO });
    };
    await runCli(['share', '../../api/memory']);
    expect(seenUrls).toHaveLength(2);
    for (const u of seenUrls) {
      expect(u).toContain('/conversations/..%2F..%2Fapi%2Fmemory');
      expect(u).not.toContain('/conversations/../../');
    }
    expect(seenUrls[1]).toContain('/share');
  });

  test('show: an id with ? cannot inject a query string', async () => {
    responder = () => jsonResp(200, { success: true, data: CONVO });
    await runCli(['show', 'x?admin=true']);
    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).toContain('/conversations/x%3Fadmin%3Dtrue');
    expect(seenUrls[0]).not.toContain('?admin=true');
  });

  test('ordinary ids are unaffected by the encoding', async () => {
    responder = () => jsonResp(200, { success: true, data: CONVO });
    await runCli(['show', 'cnv_aaaa1111bbbb2222']);
    expect(seenUrls).toHaveLength(1);
    expect(seenUrls[0]).toContain('/conversations/cnv_aaaa1111bbbb2222');
  });
});
