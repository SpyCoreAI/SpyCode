import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

/**
 * `spycore commit` / `spycore pr` / `spycore branch` — PHASE-1 1.5.
 *
 * The invariants under test:
 *  - NO git write (stage / commit / push / branch / PR) ever happens without
 *    an explicit confirmation or the documented headless flags; cancel and
 *    refusal leave the repository byte-identical.
 *  - Generation rides the EXISTING charged chat contract (POST /conversations
 *    + /api/chat/stream) with the staged diff and the pinned no-trailer
 *    instruction in the message — and the post-check net strips any
 *    attribution trailer a model emits anyway.
 *  - gh is the ONLY PR channel: missing/unauthenticated gh fails actionably,
 *    --draft/--base pass through, the body travels via file.
 */

// ── undici mock (the exact image-edit harness pattern) ─────────────────────

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

// ── gh seam mock ────────────────────────────────────────────────────────────

const ghState = vi.hoisted(() => ({
  available: true,
  authed: true,
  failWith: null as string | null,
  url: 'https://github.com/acme/repo/pull/7',
  created: [] as Array<{
    cwd: string;
    title: string;
    base?: string;
    draft?: boolean;
    bodyContent: string;
  }>,
}));

vi.mock('../src/lib/gh.js', async () => {
  const { readFileSync } = await import('node:fs');
  return {
    ghAvailable: () => ghState.available,
    ghAuthed: () => ghState.authed,
    ghPrCreate: (opts: {
      cwd: string;
      title: string;
      bodyFile: string;
      base?: string;
      draft?: boolean;
    }) => {
      if (ghState.failWith) throw new Error(ghState.failWith);
      ghState.created.push({
        cwd: opts.cwd,
        title: opts.title,
        base: opts.base,
        draft: opts.draft,
        bodyContent: readFileSync(opts.bodyFile, 'utf8'),
      });
      return ghState.url;
    },
  };
});

// ── prompt mock (scripted interactive answers) ──────────────────────────────

const promptState = vi.hoisted(() => ({
  answers: [] as string[],
  multiline: [] as string[],
}));

vi.mock('../src/lib/prompt.js', () => ({
  isPromptCancelled: (err: unknown) =>
    Boolean(err && typeof err === 'object' && (err as { cancelled?: unknown }).cancelled === true),
  readSingleLineInput: vi.fn(async () => {
    const next = promptState.answers.shift();
    if (next === undefined) {
      throw Object.assign(new Error('cancelled'), { cancelled: true });
    }
    return next;
  }),
  readMultilineInput: vi.fn(async () => promptState.multiline.shift() ?? ''),
  readStdinPipe: vi.fn(async () => ''),
}));

// ── harness ────────────────────────────────────────────────────────────────

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origCwd = process.cwd();
const origStdinTTY = process.stdin.isTTY;
const origStdoutTTY = process.stdout.isTTY;

let repoDir: string;

function setTTY(on: boolean): void {
  (process.stdin as unknown as { isTTY?: boolean }).isTTY = on;
  (process.stdout as unknown as { isTTY?: boolean }).isTTY = on;
}

function git(args: string[], cwd: string = repoDir): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

/** Fresh repo on branch main with one commit; process.cwd() moved into it. */
function makeRepo(): void {
  repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-gitcmd-')));
  git(['init'], repoDir);
  git(['config', 'user.email', 't@t.test'], repoDir);
  git(['config', 'user.name', 'T'], repoDir);
  git(['checkout', '-b', 'main'], repoDir);
  writeFileSync(join(repoDir, 'hello.txt'), 'hello\n');
  git(['add', '-A'], repoDir);
  git(['commit', '-m', 'chore: initial'], repoDir);
  process.chdir(repoDir);
}

/** A bare remote wired up as origin, with main pushed + tracking. */
function addRemote(): string {
  const remoteDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-gitremote-')));
  git(['init', '--bare'], remoteDir);
  git(['remote', 'add', 'origin', remoteDir]);
  git(['push', '-u', 'origin', 'main']);
  git(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main']);
  return remoteDir;
}

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  stdoutChunks = [];
  stderrChunks = [];
  ghState.available = true;
  ghState.authed = true;
  ghState.failWith = null;
  ghState.created = [];
  promptState.answers = [];
  promptState.multiline = [];
  setTTY(false);
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  makeRepo();
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  (process.stdin as unknown as { isTTY?: boolean }).isTTY = origStdinTTY;
  (process.stdout as unknown as { isTTY?: boolean }).isTTY = origStdoutTTY;
  process.chdir(origCwd);
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

/**
 * Responder for the generation channel: fresh conversation + one SSE text
 * turn per stream call (later calls walk the `texts` list — regenerate).
 */
function genResponder(
  texts: string[],
  streamCalls?: Array<Record<string, unknown>>,
) {
  let call = 0;
  return (url: string, init: { method: string; body?: unknown }): MockResp => {
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return jsonResp(200, {
        success: true,
        data: { id: 'cnv_git', title: 'New', model: 'HERMES' },
      });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      streamCalls?.push(body);
      const text = texts[Math.min(call, texts.length - 1)] ?? '';
      call += 1;
      return sseResp([{ type: 'text', content: text }, { type: 'done' }]);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

async function runCli(args: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerBranchCommand, registerCommitCommand, registerPrCommand } =
    await import('../src/commands/git-workflow.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerCommitCommand(program);
  registerPrCommand(program);
  registerBranchCommand(program);
  await program.parseAsync(['node', 'spycore', ...parentArgs, ...args]);
}

async function expectCliError(
  args: string[],
): Promise<{ message: string; hint?: string | undefined }> {
  const { isSpycoreCliError } = await import('../src/lib/errors.js');
  let caught: unknown = null;
  try {
    await runCli(args);
  } catch (err) {
    caught = err;
  }
  if (!caught || !isSpycoreCliError(caught)) {
    throw new Error(`expected SpycoreCliError, got: ${String(caught)}`);
  }
  return { message: caught.message, hint: caught.hint };
}

function headSha(): string {
  return git(['rev-parse', 'HEAD']).trim();
}

function lastMessage(): string {
  return git(['log', '-1', '--format=%B']).trimEnd();
}

function porcelain(): string {
  return git(['status', '--porcelain']);
}

const GENERATED_WITH_TRAILERS =
  'feat: add greeting\n\nAdds hello output.\n\nCo-Authored-By: Some Bot <bot@example.com>\n🤖 Generated with tooling';

// ─────────────────────────── spycore commit ────────────────────────────────

describe('spycore commit — confirmation gates', () => {
  test('headless without --yes refuses: no commit, staging untouched', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'hello world\n');
    git(['add', '-A']);
    responder = genResponder(['feat: add greeting']);
    const before = headSha();
    const err = await expectCliError(['commit']);
    expect(err.message).toMatch(/Refusing to commit/);
    expect(err.hint).toMatch(/--yes/);
    expect(headSha()).toBe(before);
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('hello.txt');
  });

  test('--yes commits via message FILE; the trailer net holds even if the model misbehaves', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'hello world\n');
    git(['add', '-A']);
    const streamCalls: Array<Record<string, unknown>> = [];
    responder = genResponder([GENERATED_WITH_TRAILERS], streamCalls);
    await runCli(['commit', '--yes']);

    const msg = lastMessage();
    expect(msg).toBe('feat: add greeting\n\nAdds hello output.');
    expect(msg).not.toMatch(/co-authored-by|generated with|🤖/i);

    // The generation was a NORMAL charged chat call: default model HERMES,
    // staged diff + the pinned no-trailer instruction in the message.
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0]?.model).toBe('HERMES');
    expect(streamCalls[0]?.conversationId).toBe('cnv_git');
    const wire = String(streamCalls[0]?.message ?? '');
    expect(wire).toContain('+hello world');
    expect(wire).toContain('Never add a trailer');
  });

  test('interactive cancel leaves the repository byte-identical', async () => {
    setTTY(true);
    writeFileSync(join(repoDir, 'hello.txt'), 'changed\n');
    git(['add', '-A']);
    responder = genResponder(['feat: change hello']);
    const shaBefore = headSha();
    const statusBefore = porcelain();
    promptState.answers = ['c'];
    await runCli(['commit']);
    expect(headSha()).toBe(shaBefore);
    expect(porcelain()).toBe(statusBefore);
    expect(stderrChunks.join('')).toMatch(/Cancelled/);
  });

  test('interactive edit replaces the message before the commit', async () => {
    setTTY(true);
    writeFileSync(join(repoDir, 'hello.txt'), 'changed\n');
    git(['add', '-A']);
    responder = genResponder(['feat: model draft']);
    promptState.answers = ['e', 'a'];
    promptState.multiline = ['fix: edited by hand'];
    await runCli(['commit']);
    expect(lastMessage()).toBe('fix: edited by hand');
  });

  test('regenerate stays on the SAME conversation and commits the second draft', async () => {
    setTTY(true);
    writeFileSync(join(repoDir, 'hello.txt'), 'changed\n');
    git(['add', '-A']);
    const streamCalls: Array<Record<string, unknown>> = [];
    responder = genResponder(['feat: first draft', 'feat: second draft'], streamCalls);
    promptState.answers = ['r', 'a'];
    await runCli(['commit']);
    expect(lastMessage()).toBe('feat: second draft');
    expect(streamCalls).toHaveLength(2);
    expect(streamCalls[1]?.conversationId).toBe('cnv_git');
  });
});

describe('spycore commit — staging semantics', () => {
  test('nothing staged, headless: actionable error naming --all — nothing staged silently', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'unstaged change\n');
    responder = genResponder(['feat: x']);
    const err = await expectCliError(['commit']);
    expect(err.message).toBe('Nothing staged.');
    expect(err.hint).toMatch(/--all/);
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('');
  });

  test('clean tree: nothing to commit', async () => {
    responder = genResponder(['feat: x']);
    const err = await expectCliError(['commit']);
    expect(err.message).toMatch(/Nothing to commit/);
  });

  test('--all --yes stages everything then commits (explicit headless flags)', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'v2\n');
    writeFileSync(join(repoDir, 'new.txt'), 'brand new\n');
    responder = genResponder(['feat: stage all']);
    await runCli(['commit', '--all', '--yes'], ['--json']);
    expect(lastMessage()).toBe('feat: stage all');
    expect(porcelain().trim()).toBe('');
    expect(stdoutChunks.join('')).toMatch(/"committed"\s*:\s*true/);
  });

  test('interactive decline of the stage-all offer commits nothing', async () => {
    setTTY(true);
    writeFileSync(join(repoDir, 'hello.txt'), 'unstaged\n');
    responder = genResponder(['feat: x']);
    const shaBefore = headSha();
    promptState.answers = ['n'];
    await runCli(['commit']);
    expect(headSha()).toBe(shaBefore);
    expect(git(['diff', '--cached', '--name-only']).trim()).toBe('');
  });
});

describe('spycore commit — push gate', () => {
  test('--push --yes pushes after the commit', async () => {
    addRemote();
    writeFileSync(join(repoDir, 'hello.txt'), 'push me\n');
    git(['add', '-A']);
    responder = genResponder(['feat: push me']);
    await runCli(['commit', '--push', '--yes']);
    const remoteSha = git(['ls-remote', 'origin', 'main']).split('\t')[0];
    expect(remoteSha).toBe(headSha());
  });

  test('interactive push decline: commit stands, remote untouched', async () => {
    addRemote();
    const remoteBefore = git(['ls-remote', 'origin', 'main']).split('\t')[0];
    writeFileSync(join(repoDir, 'hello.txt'), 'local only\n');
    git(['add', '-A']);
    setTTY(true);
    responder = genResponder(['feat: local only']);
    promptState.answers = ['a', 'n'];
    await runCli(['commit', '--push']);
    expect(lastMessage()).toBe('feat: local only');
    expect(git(['ls-remote', 'origin', 'main']).split('\t')[0]).toBe(remoteBefore);
    expect(stderrChunks.join('')).toMatch(/Skipped push/);
  });
});

describe('spycore commit — guard rails', () => {
  test('not a git repository', async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-plain-')));
    process.chdir(plain);
    responder = genResponder(['feat: x']);
    const err = await expectCliError(['commit']);
    expect(err.message).toBe('Not a git repository.');
    process.chdir(repoDir);
    rmSync(plain, { recursive: true, force: true });
  });

  test('detached HEAD refuses before any write', async () => {
    git(['checkout', '--detach']);
    responder = genResponder(['feat: x']);
    const err = await expectCliError(['commit']);
    expect(err.message).toBe('HEAD is detached.');
  });

  test('merge in progress refuses before any write', async () => {
    writeFileSync(join(repoDir, '.git', 'MERGE_HEAD'), `${headSha()}\n`);
    responder = genResponder(['feat: x']);
    const err = await expectCliError(['commit']);
    expect(err.message).toBe('A merge is in progress.');
  });

  test('not logged in — generation is the charged chat contract, so login is required', async () => {
    const { clearToken } = await import('../src/lib/auth.js');
    await clearToken();
    responder = genResponder(['feat: x']);
    const err = await expectCliError(['commit']);
    expect(err.message).toBe('Not logged in.');
  });
});

// ───────────────────────────── spycore pr ──────────────────────────────────

describe('spycore pr', () => {
  test('no remote: actionable error before anything else', async () => {
    responder = genResponder(['feat: pr']);
    const err = await expectCliError(['pr']);
    expect(err.message).toBe('No git remote configured.');
  });

  test('gh missing: actionable install hint', async () => {
    addRemote();
    ghState.available = false;
    responder = genResponder(['feat: pr']);
    const err = await expectCliError(['pr']);
    expect(err.message).toMatch(/GitHub CLI \(gh\) not found/);
    expect(err.hint).toMatch(/cli\.github\.com/);
  });

  test('gh unauthenticated: points at gh auth login', async () => {
    addRemote();
    ghState.authed = false;
    responder = genResponder(['feat: pr']);
    const err = await expectCliError(['pr']);
    expect(err.message).toMatch(/not authenticated/);
    expect(err.hint).toMatch(/gh auth login/);
  });

  test('on the base branch: refuses and suggests spycore branch', async () => {
    addRemote();
    responder = genResponder(['feat: pr']);
    const err = await expectCliError(['pr', '--base', 'main']);
    expect(err.message).toMatch(/base branch/);
    expect(err.hint).toMatch(/spycore branch/);
  });

  test('no commits vs base: nothing to open', async () => {
    addRemote();
    git(['checkout', '-b', 'feat/empty']);
    responder = genResponder(['feat: pr']);
    const err = await expectCliError(['pr', '--base', 'main']);
    expect(err.message).toMatch(/nothing to open a PR for/);
  });

  test('headless without --yes refuses to create', async () => {
    addRemote();
    git(['checkout', '-b', 'feat/thing']);
    writeFileSync(join(repoDir, 'thing.txt'), 'thing\n');
    git(['add', '-A']);
    git(['commit', '-m', 'feat: thing']);
    git(['push', '-u', 'origin', 'feat/thing']);
    responder = genResponder(['feat: add thing\n\nAdds the thing.']);
    const err = await expectCliError(['pr']);
    expect(err.message).toMatch(/Refusing to create a pull request/);
    expect(ghState.created).toHaveLength(0);
  });

  test('unpushed branch, headless without --yes: refuses with a push hint', async () => {
    addRemote();
    git(['checkout', '-b', 'feat/unpushed']);
    writeFileSync(join(repoDir, 'thing.txt'), 'thing\n');
    git(['add', '-A']);
    git(['commit', '-m', 'feat: thing']);
    responder = genResponder(['feat: add thing\n\nBody.']);
    const err = await expectCliError(['pr']);
    expect(err.message).toMatch(/not fully pushed/);
    expect(ghState.created).toHaveLength(0);
  });

  test('happy path: title/body split, --draft/--base pass through, body via file, URL printed', async () => {
    addRemote();
    git(['checkout', '-b', 'feat/thing']);
    writeFileSync(join(repoDir, 'thing.txt'), 'thing\n');
    git(['add', '-A']);
    git(['commit', '-m', 'feat: thing']);
    git(['push', '-u', 'origin', 'feat/thing']);
    const streamCalls: Array<Record<string, unknown>> = [];
    responder = genResponder(
      ['feat: add the thing\n\nThis PR adds the thing and covers it with tests.'],
      streamCalls,
    );
    await runCli(['pr', '--yes', '--draft', '--base', 'main']);

    expect(ghState.created).toHaveLength(1);
    const created = ghState.created[0];
    expect(created?.title).toBe('feat: add the thing');
    expect(created?.base).toBe('main');
    expect(created?.draft).toBe(true);
    expect(created?.bodyContent).toBe(
      'This PR adds the thing and covers it with tests.\n',
    );
    expect(stderrChunks.join('')).toContain(ghState.url);
    // Generation saw the branch-vs-base log and diff.
    const wire = String(streamCalls[0]?.message ?? '');
    expect(wire).toContain('feat: thing');
    expect(wire).toContain('+thing');
  });

  test('unpushed branch with --yes: pushed first, then created', async () => {
    addRemote();
    git(['checkout', '-b', 'feat/autopush']);
    writeFileSync(join(repoDir, 'thing.txt'), 'thing\n');
    git(['add', '-A']);
    git(['commit', '-m', 'feat: thing']);
    responder = genResponder(['feat: auto push\n\nBody.']);
    await runCli(['pr', '--yes', '--base', 'main']);
    expect(git(['ls-remote', 'origin', 'feat/autopush']).trim()).not.toBe('');
    expect(ghState.created).toHaveLength(1);
  });
});

// ───────────────────── lib/git — diff capture rules ────────────────────────

describe('lib/git diff capture', () => {
  test('binary changes surface as a summary line only — no raw bytes in the prompt feed', async () => {
    const { stagedDiff } = await import('../src/lib/git.js');
    writeFileSync(
      join(repoDir, 'blob.bin'),
      Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42, 0x00]),
    );
    git(['add', '-A']);
    const diff = stagedDiff(repoDir);
    expect(diff).toMatch(/Binary files .* differ/);
    expect(diff).not.toContain('\u0000');
  });
});

// ─────────────────────────── spycore branch ────────────────────────────────

describe('spycore branch', () => {
  test('--yes: suggestion sanitized to kebab-case, branch created + switched', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'auth work\n');
    responder = genResponder(['Feat/Add User Auth!!']);
    await runCli(['branch', '--yes']);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feat/add-user-auth');
  });

  test('headless without --yes refuses: no branch created', async () => {
    writeFileSync(join(repoDir, 'hello.txt'), 'auth work\n');
    responder = genResponder(['feat/add-user-auth']);
    const err = await expectCliError(['branch']);
    expect(err.message).toMatch(/Refusing to create a branch/);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
    expect(git(['branch', '--list', 'feat/add-user-auth']).trim()).toBe('');
  });

  test('--for hint drives the prompt when the tree is clean', async () => {
    const streamCalls: Array<Record<string, unknown>> = [];
    responder = genResponder(['feat/rate-limiting'], streamCalls);
    await runCli(['branch', '--yes', '--for', 'add rate limiting to the API']);
    expect(String(streamCalls[0]?.message ?? '')).toContain('add rate limiting to the API');
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feat/rate-limiting');
  });

  test('clean tree and no --for: actionable error', async () => {
    responder = genResponder(['feat/x']);
    const err = await expectCliError(['branch']);
    expect(err.message).toBe('No changes to name a branch from.');
    expect(err.hint).toMatch(/--for/);
  });

  test('existing branch name: clean error, still on the original branch', async () => {
    git(['branch', 'feat/taken']);
    writeFileSync(join(repoDir, 'hello.txt'), 'work\n');
    responder = genResponder(['feat/taken']);
    const err = await expectCliError(['branch', '--yes']);
    expect(err.message).toMatch(/already exists/);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main');
  });
});
