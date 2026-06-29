import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LIMITS,
  dispatchTool,
  type ToolContext,
} from '../src/lib/agent/tools.js';
import {
  createApprovalController,
  headlessApproval,
  type ApprovalRequest,
  type RequestApproval,
} from '../src/lib/agent/approval.js';
import { computeFileDiff } from '../src/lib/agent/diff.js';
import { matchesBuiltinDenylist, loadSecretGuard } from '../src/lib/agent/secrets.js';

const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });
const REJECT: RequestApproval = () => Promise.resolve({ approved: false, reason: 'rejected by user' });

// ───────────────────────── secret denylist (pure) ─────────────────────────

describe('matchesBuiltinDenylist', () => {
  test('blocks env files, keys, and secret dirs', () => {
    for (const p of [
      '.env', '.env.local', '.env.production', 'config/.env',
      'id_rsa', 'id_rsa.pub', 'id_ed25519', 'server.pem', 'tls/private.key',
      'cert.p12', 'store.keystore', '.ssh/known_hosts', '.git/config',
      'sub/.aws/credentials', '.npmrc',
    ]) {
      expect(matchesBuiltinDenylist(p)).toBe(true);
    }
  });
  test('allows ordinary source files', () => {
    for (const p of ['src/index.ts', 'README.md', 'env.ts', 'keymap.json', 'package.json']) {
      expect(matchesBuiltinDenylist(p)).toBe(false);
    }
  });
});

// ───────────────────────── diff computation (pure) ─────────────────────────

describe('computeFileDiff', () => {
  test('counts a one-line change', async () => {
    const fd = await computeFileDiff('a\nb\nc', 'a\nB\nc');
    expect(fd.added).toBe(1);
    expect(fd.removed).toBe(1);
    expect(fd.lines.some((l) => l.kind === 'add' && l.text === 'B')).toBe(true);
    expect(fd.lines.some((l) => l.kind === 'del' && l.text === 'b')).toBe(true);
  });
  test('treats a new file as all additions', async () => {
    const fd = await computeFileDiff('', 'one\ntwo\nthree');
    expect(fd.added).toBe(3);
    expect(fd.removed).toBe(0);
  });
  test('caps long diffs and reports hidden lines', async () => {
    const big = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n');
    const fd = await computeFileDiff('', big, { maxLines: 10 });
    expect(fd.truncated).toBe(true);
    expect(fd.lines.length).toBe(10);
    expect(fd.hiddenLines).toBeGreaterThan(0);
  });
});

// ───────────────────────── approval state machine (pure) ─────────────────────────

function fakeReq(): ApprovalRequest {
  return { tool: 'write_file', path: 'x.txt', isNew: true, added: 1, removed: 0, diff: [{ kind: 'add', text: 'x' }], truncated: false, hiddenLines: 0 };
}

describe('createApprovalController', () => {
  test('accept resolves approved', async () => {
    const ctrl = createApprovalController();
    const p = ctrl.request(fakeReq());
    expect(ctrl.hasPending()).toBe(true);
    ctrl.resolvePending('accept');
    expect((await p).approved).toBe(true);
    expect(ctrl.hasPending()).toBe(false);
  });
  test('reject resolves not-approved with a reason', async () => {
    const ctrl = createApprovalController();
    const p = ctrl.request(fakeReq());
    ctrl.resolvePending('reject');
    const out = await p;
    expect(out.approved).toBe(false);
    expect(out.reason).toMatch(/rejected/);
  });
  test('accept_all auto-approves subsequent writes with no prompt', async () => {
    let prompts = 0;
    const ctrl = createApprovalController({ onRequest: () => { prompts += 1; } });
    const p1 = ctrl.request(fakeReq());
    expect(prompts).toBe(1);
    ctrl.resolvePending('accept_all');
    expect((await p1).approved).toBe(true);
    const p2 = ctrl.request(fakeReq());
    expect(ctrl.hasPending()).toBe(false); // auto-approved, no pending prompt
    expect(prompts).toBe(1); // onRequest NOT called again
    expect((await p2).approved).toBe(true);
  });
  test('autoApproveAll resolves immediately without a prompt', async () => {
    let prompts = 0;
    const ctrl = createApprovalController({ autoApproveAll: true, onRequest: () => { prompts += 1; } });
    expect((await ctrl.request(fakeReq())).approved).toBe(true);
    expect(prompts).toBe(0);
  });
});

describe('headlessApproval', () => {
  test('rejects with guidance unless --yes', async () => {
    const out = await headlessApproval(false)(fakeReq());
    expect(out.approved).toBe(false);
    expect(out.reason).toMatch(/non-interactive|--yes/);
  });
  test('--yes auto-approves', async () => {
    expect((await headlessApproval(true)(fakeReq())).approved).toBe(true);
  });
});

// ───────────────────────── write/edit tools + secrets over a temp dir ─────────────────────────

describe('mutating tools', () => {
  let workDir: string;
  const ctx = (req: RequestApproval): ToolContext => ({ cwd: workDir, limits: DEFAULT_LIMITS, requestApproval: req });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-write-'));
  });
  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ── write_file ──
  test('write_file creates a new file with exact bytes when approved', async () => {
    const r = await dispatchTool('write_file', { path: 'new.txt', content: 'Hello\nWorld\n' }, ctx(ACCEPT));
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('applied');
    expect(r.isNew).toBe(true);
    expect(readFileSync(join(workDir, 'new.txt'), 'utf8')).toBe('Hello\nWorld\n');
  });

  test('write_file overwrites an existing file', async () => {
    writeFileSync(join(workDir, 'f.txt'), 'old contents\n');
    const r = await dispatchTool('write_file', { path: 'f.txt', content: 'new contents\n' }, ctx(ACCEPT));
    expect(r.ok).toBe(true);
    expect(r.isNew).toBe(false);
    expect(readFileSync(join(workDir, 'f.txt'), 'utf8')).toBe('new contents\n');
  });

  test('write_file creates parent directories within cwd', async () => {
    const r = await dispatchTool('write_file', { path: 'a/b/c.txt', content: 'deep\n' }, ctx(ACCEPT));
    expect(r.ok).toBe(true);
    expect(readFileSync(join(workDir, 'a/b/c.txt'), 'utf8')).toBe('deep\n');
  });

  test('write_file leaves no temp files behind (atomic)', async () => {
    await dispatchTool('write_file', { path: 'atomic.txt', content: 'x\n' }, ctx(ACCEPT));
    expect(readdirSync(workDir).some((n) => n.includes('.spycore-'))).toBe(false);
  });

  test('write_file rejected by approval does not touch disk', async () => {
    const r = await dispatchTool('write_file', { path: 'skip.txt', content: 'nope' }, ctx(REJECT));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('rejected');
    expect(existsSync(join(workDir, 'skip.txt'))).toBe(false);
  });

  test('write_file rejects path traversal (before any prompt)', async () => {
    let prompted = false;
    const spy: RequestApproval = () => { prompted = true; return Promise.resolve({ approved: true }); };
    const r = await dispatchTool('write_file', { path: '../escape.txt', content: 'x' }, ctx(spy));
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/escapes the working directory/);
    expect(prompted).toBe(false);
  });

  // ── edit_file ──
  test('edit_file replaces an exact-once match when approved', async () => {
    writeFileSync(join(workDir, 'e.txt'), 'foo\nbar\nbaz\n');
    const r = await dispatchTool('edit_file', { path: 'e.txt', old_str: 'bar', new_str: 'BAR' }, ctx(ACCEPT));
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('applied');
    expect(readFileSync(join(workDir, 'e.txt'), 'utf8')).toBe('foo\nBAR\nbaz\n');
  });

  test('edit_file treats new_str literally (no $-pattern interpretation)', async () => {
    writeFileSync(join(workDir, 'd.txt'), 'a B c\n');
    const r = await dispatchTool('edit_file', { path: 'd.txt', old_str: 'B', new_str: '$& and $1' }, ctx(ACCEPT));
    expect(r.ok).toBe(true);
    expect(readFileSync(join(workDir, 'd.txt'), 'utf8')).toBe('a $& and $1 c\n');
  });

  test('edit_file errors (no write) when old_str is absent', async () => {
    writeFileSync(join(workDir, 'e.txt'), 'hello\n');
    const before = readFileSync(join(workDir, 'e.txt'), 'utf8');
    const r = await dispatchTool('edit_file', { path: 'e.txt', old_str: 'ZZZ', new_str: 'x' }, ctx(ACCEPT));
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/not found|exactly once/);
    expect(readFileSync(join(workDir, 'e.txt'), 'utf8')).toBe(before);
  });

  test('edit_file errors (no write) when old_str matches multiple times', async () => {
    writeFileSync(join(workDir, 'e.txt'), 'x\nx\n');
    const r = await dispatchTool('edit_file', { path: 'e.txt', old_str: 'x', new_str: 'y' }, ctx(ACCEPT));
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/occurs 2 times|exactly once/);
    expect(readFileSync(join(workDir, 'e.txt'), 'utf8')).toBe('x\nx\n');
  });

  test('edit_file refuses a missing file', async () => {
    const r = await dispatchTool('edit_file', { path: 'nope.txt', old_str: 'a', new_str: 'b' }, ctx(ACCEPT));
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/not found/);
  });

  // ── secret protection (read AND write) ──
  test('secret-protected paths are blocked for read and write; content never surfaces', async () => {
    writeFileSync(join(workDir, '.env'), 'API_KEY=SUPERSECRETTOKEN\n');
    writeFileSync(join(workDir, 'server.pem'), 'KEYBYTES\n');
    writeFileSync(join(workDir, '.spycoreignore'), 'private/\n');
    writeFileSync(join(workDir, 'ok.txt'), 'visible\n');
    // a private/ tree blocked via .spycoreignore
    rmSync(join(workDir, 'private'), { recursive: true, force: true });
    writeFileSync(join(workDir, 'README.md'), 'readme\n');
    // mkdir + file in private/
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(workDir, 'private'));
    writeFileSync(join(workDir, 'private', 'p.txt'), 'PRIVATEDATA\n');

    // read blocked
    const rEnv = await dispatchTool('read_file', { path: '.env' }, ctx(ACCEPT));
    expect(rEnv.ok).toBe(false);
    expect(rEnv.content).toMatch(/blocked: sensitive path/);
    expect(rEnv.content).not.toContain('SUPERSECRETTOKEN');

    const rPriv = await dispatchTool('read_file', { path: 'private/p.txt' }, ctx(ACCEPT));
    expect(rPriv.ok).toBe(false);
    expect(rPriv.content).toMatch(/blocked: sensitive path/);

    // write blocked even with an accepting approver
    const wEnv = await dispatchTool('write_file', { path: '.env', content: 'API_KEY=changed\n' }, ctx(ACCEPT));
    expect(wEnv.ok).toBe(false);
    expect(wEnv.content).toMatch(/blocked: sensitive path/);
    expect(readFileSync(join(workDir, '.env'), 'utf8')).toBe('API_KEY=SUPERSECRETTOKEN\n'); // unchanged

    const wPem = await dispatchTool('write_file', { path: 'server.pem', content: 'x' }, ctx(ACCEPT));
    expect(wPem.ok).toBe(false);
    expect(wPem.content).toMatch(/blocked/);

    // list_dir hides secret entries
    const ls = await dispatchTool('list_dir', {}, ctx(ACCEPT));
    const entries = ls.content.split('\n');
    expect(entries).toContain('ok.txt');
    expect(entries).not.toContain('.env');
    expect(entries).not.toContain('server.pem');
    expect(entries).not.toContain('private/');

    // glob excludes secret files
    const g = await dispatchTool('glob', { pattern: '**/*' }, ctx(ACCEPT));
    expect(g.content).not.toContain('.env');
    expect(g.content).not.toContain('private/p.txt');

    // grep never surfaces secret contents
    const grep = await dispatchTool('grep', { pattern: 'SUPERSECRETTOKEN' }, ctx(ACCEPT));
    expect(grep.content).not.toContain('SUPERSECRETTOKEN');
    expect(grep.summary).toMatch(/0 matches/);
  });

  test('loadSecretGuard predicate flags built-in + .spycoreignore paths', async () => {
    writeFileSync(join(workDir, '.spycoreignore'), '*.secret\n');
    const guard = await loadSecretGuard(workDir);
    expect(guard(join(workDir, '.env'))).toBe(true);
    expect(guard(join(workDir, 'data.secret'))).toBe(true);
    expect(guard(join(workDir, 'src.ts'))).toBe(false);
  });
});
