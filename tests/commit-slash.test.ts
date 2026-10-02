import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

/**
 * TUI `/commit` — PHASE-1 1.6, wrapping the 1.5 machinery.
 *
 * runCommitFlow is the render-agnostic core the Ink session wires to its
 * interact primitive. Pinned here with fake IO + a REAL git repo + the
 * mocked generation channel:
 *  - happy path: accept → committed via the message FILE, trailer net holds
 *    (byte-identical to `spycore commit` semantics — same functions);
 *  - cancel leaves the repository byte-identical;
 *  - the stage-all offer declines to a no-op;
 *  - guard rails (not a repo) never throw out of the flow;
 *  - the registry recognises /commit and the one-shot renderer points at
 *    `spycore commit`.
 */

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: {
    json: () => Promise<unknown>;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer>;
  };
}

let responder:
  | ((url: string, init: { method: string; body?: unknown }) => MockResp)
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(
    async (url: string, init: { method?: string; body?: unknown } = {}) => {
      if (!responder) throw new Error('test forgot to set responder');
      return responder(url, { method: init.method ?? 'GET', body: init.body });
    },
  ),
}));

let repoDir: string;

function git(args: string[], cwd: string = repoDir): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-commitslash-')));
  git(['init'], repoDir);
  git(['config', 'user.email', 't@t.test'], repoDir);
  git(['config', 'user.name', 'T'], repoDir);
  git(['checkout', '-b', 'main'], repoDir);
  writeFileSync(join(repoDir, 'hello.txt'), 'hello\n');
  git(['add', '-A'], repoDir);
  git(['commit', '-m', 'chore: initial'], repoDir);
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  vi.resetModules();
  try {
    rmSync(repoDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: {
      json: async () => ({}),
      [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator](),
    },
  };
}

function genResponder(texts: string[]) {
  let call = 0;
  return (url: string, init: { method: string }): MockResp => {
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return jsonResp(200, {
        success: true,
        data: { id: 'cnv_git', title: 'New', model: 'HERMES' },
      });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      const text = texts[Math.min(call, texts.length - 1)] ?? '';
      call += 1;
      return sseResp([{ type: 'text', content: text }, { type: 'done' }]);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

interface FakeIo {
  notices: Array<{ kind: string; text: string }>;
  presented: string[];
  io: {
    notify(kind: 'info' | 'success' | 'warning' | 'error', text: string): void;
    present(text: string): void;
    ask(q: string): Promise<string>;
    readText(q: string): Promise<string>;
  };
}

function fakeIo(answers: string[], texts: string[] = []): FakeIo {
  const notices: Array<{ kind: string; text: string }> = [];
  const presented: string[] = [];
  return {
    notices,
    presented,
    io: {
      notify: (kind, text) => void notices.push({ kind, text }),
      present: (text) => void presented.push(text),
      ask: async () => answers.shift() ?? 'c',
      readText: async () => texts.shift() ?? '',
    },
  };
}

describe('runCommitFlow', () => {
  test('happy path: accept → committed via message FILE; the trailer net holds', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'hello world\n');
    git(['add', '-A']);
    responder = genResponder([
      'feat: add greeting\n\nAdds hello output.\n\nCo-Authored-By: Bot <b@x>\n🤖 Generated with tooling',
    ]);
    const { runCommitFlow } = await import('../src/lib/slash/commit-flow.js');
    const h = fakeIo(['a']);
    const result = await runCommitFlow({
      cwd: repoDir,
      model: 'hermes',
      apiUrlOverride: undefined,
      io: h.io,
    });
    expect(result.committed).toBe(true);
    expect(result.subject).toBe('feat: add greeting');
    const msg = git(['log', '-1', '--format=%B']).trimEnd();
    expect(msg).toBe('feat: add greeting\n\nAdds hello output.');
    expect(msg).not.toMatch(/co-authored-by|generated with|🤖/i);
    expect(h.presented).toHaveLength(1);
    expect(h.notices.some((n) => n.kind === 'success' && n.text.includes('Committed'))).toBe(true);
  });

  test('cancel leaves the repository byte-identical', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'changed\n');
    git(['add', '-A']);
    responder = genResponder(['feat: change hello']);
    const shaBefore = git(['rev-parse', 'HEAD']).trim();
    const statusBefore = git(['status', '--porcelain']);
    const { runCommitFlow } = await import('../src/lib/slash/commit-flow.js');
    const h = fakeIo(['c']);
    const result = await runCommitFlow({ cwd: repoDir, model: 'hermes', io: h.io });
    expect(result.committed).toBe(false);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(shaBefore);
    expect(git(['status', '--porcelain'])).toBe(statusBefore);
    expect(h.notices.some((n) => n.kind === 'warning' && n.text.includes('Cancelled'))).toBe(true);
  });

  test('edit path: the accepted EDIT is what lands (same reviewLoop as 1.5)', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'edited\n');
    git(['add', '-A']);
    responder = genResponder(['feat: model draft']);
    const { runCommitFlow } = await import('../src/lib/slash/commit-flow.js');
    const h = fakeIo(['e', 'a'], ['fix: hand-written subject']);
    const result = await runCommitFlow({ cwd: repoDir, model: 'hermes', io: h.io });
    expect(result.committed).toBe(true);
    expect(git(['log', '-1', '--format=%s']).trim()).toBe('fix: hand-written subject');
  });

  test('nothing staged: the stage-all offer declines to a no-op', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'unstaged\n');
    responder = genResponder(['feat: x']);
    const shaBefore = git(['rev-parse', 'HEAD']).trim();
    const { runCommitFlow } = await import('../src/lib/slash/commit-flow.js');
    const h = fakeIo(['n']);
    const result = await runCommitFlow({ cwd: repoDir, model: 'hermes', io: h.io });
    expect(result.committed).toBe(false);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(shaBefore);
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  test('nothing staged: an explicit yes stages all, then the flow proceeds', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'stage me\n');
    responder = genResponder(['feat: staged via offer']);
    const { runCommitFlow } = await import('../src/lib/slash/commit-flow.js');
    const h = fakeIo(['y', 'a']);
    const result = await runCommitFlow({ cwd: repoDir, model: 'hermes', io: h.io });
    expect(result.committed).toBe(true);
    expect(git(['status', '--porcelain']).trim()).toBe('');
  });

  test('not a git repository: an error notice, never a throw (the Ink session survives)', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-plain-')));
    responder = genResponder(['feat: x']);
    const { runCommitFlow } = await import('../src/lib/slash/commit-flow.js');
    const h = fakeIo([]);
    const result = await runCommitFlow({ cwd: plain, model: 'hermes', io: h.io });
    expect(result.committed).toBe(false);
    expect(h.notices.some((n) => n.kind === 'error' && n.text.includes('Not a git repository'))).toBe(true);
    rmSync(plain, { recursive: true, force: true });
  });

  test('generation failure surfaces as an error notice; nothing committed', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'x\n');
    git(['add', '-A']);
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return jsonResp(200, { success: true, data: { id: 'c', title: 'N', model: 'HERMES' } });
      }
      return jsonResp(500, { success: false, error: 'upstream unavailable' });
    };
    const shaBefore = git(['rev-parse', 'HEAD']).trim();
    const { runCommitFlow } = await import('../src/lib/slash/commit-flow.js');
    const h = fakeIo(['a']);
    const result = await runCommitFlow({ cwd: repoDir, model: 'hermes', io: h.io });
    expect(result.committed).toBe(false);
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(shaBefore);
    expect(h.notices.some((n) => n.kind === 'error')).toBe(true);
  });
});

describe('/commit registry surface', () => {
  test('the registry recognises /commit; SLASH_HELP lists it', async () => {
    const { runSlashCommand, SLASH_HELP } = await import('../src/lib/slash/registry.js');
    const outcome = await runSlashCommand('commit', [], {
      cwd: repoDir,
      model: 'hermes',
      effort: 'auto',
      conversationId: 'c',
      apiUrl: undefined,
      injectGuide: false,
      injectChangelog: false,
    });
    expect(outcome).toEqual({ kind: 'commit-flow' });
    expect(SLASH_HELP.some((e) => e.command === '/commit')).toBe(true);
  });

  test('the one-shot renderer points /commit at the flat command (consumed, no write)', async () => {
    const stderrChunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((c: unknown) => {
      stderrChunks.push(String(c));
      return true;
    }) as typeof process.stderr.write;
    try {
      const { handleSlashCommand } = await import('../src/commands/chat.js');
      const r = await handleSlashCommand('/commit', {
        json: false,
        color: false,
        currentConvo: 'c',
        apiUrl: undefined,
      });
      expect(r.consumed).toBe(true);
      expect(stderrChunks.join('')).toContain('spycore commit');
    } finally {
      process.stderr.write = orig;
    }
  });
});
