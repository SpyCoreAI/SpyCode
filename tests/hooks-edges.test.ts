import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createAgentHooksBridge,
  fireHookEvent,
  loadHookSession,
  userHooksPath,
  type HookSession,
} from '../src/lib/hooks.js';
import { __resetConfigForTests, trustWorkspace } from '../src/lib/config.js';
import { freshConfigDir } from './helpers.js';

let workDir: string;
let cfgDir: string;

beforeEach(() => {
  cfgDir = freshConfigDir();
  __resetConfigForTests();
  workDir = mkdtempSync(join(tmpdir(), 'spycli-hooks-'));
});

afterEach(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const userHooks = (obj: unknown): void => writeFileSync(userHooksPath(), JSON.stringify(obj));
const sessionWith = (command: string, cwd = workDir): HookSession => ({
  cwd,
  sessionId: 'test',
  hooks: [{ event: 'pre-tool', command, timeoutMs: 5000, scope: 'user' }],
  notices: [],
});

describe('hooks.json parsing', () => {
  test('invalid JSON, missing array, unknown event, missing command', async () => {
    writeFileSync(userHooksPath(), '{not json');
    let s = await loadHookSession(workDir);
    expect(s.notices.some((n) => n.includes('not valid JSON'))).toBe(true);

    userHooks({ foo: 1 });
    s = await loadHookSession(workDir);
    expect(s.notices.some((n) => n.includes('no "hooks" array'))).toBe(true);

    userHooks({ hooks: [{ event: 'bogus-event', command: 'echo hi' }] });
    s = await loadHookSession(workDir);
    expect(s.notices.some((n) => n.includes('unknown event'))).toBe(true);

    userHooks({ hooks: [{ event: 'pre-tool', command: '   ' }] });
    s = await loadHookSession(workDir);
    expect(s.notices.some((n) => n.includes('missing command'))).toBe(true);

    userHooks({ hooks: [{ event: 'pre-tool', command: 'echo hi' }] });
    s = await loadHookSession(workDir);
    expect(s.hooks).toHaveLength(1);
    expect(s.hooks[0]!.scope).toBe('user');
  });

  // R3-14: a repo-supplied hooks.json over the 1 MB cap is skipped before
  // reading, never read whole into memory.
  test('an oversized hooks.json is ignored with a notice', async () => {
    const big = JSON.stringify({
      hooks: [{ event: 'pre-tool', command: `echo ${'x'.repeat(1_100_000)}` }],
    });
    expect(big.length).toBeGreaterThan(1_048_576);
    writeFileSync(userHooksPath(), big);
    const s = await loadHookSession(workDir);
    expect(s.hooks).toHaveLength(0);
    expect(s.notices.some((n) => n.includes('over 1 MB'))).toBe(true);
  });

  test('a throwing approval callback skips the project hook', async () => {
    trustWorkspace(workDir);
    mkdirSync(join(workDir, '.spycore'), { recursive: true });
    writeFileSync(
      join(workDir, '.spycore', 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'pre-tool', command: 'echo hi' }] }),
    );
    const s = await loadHookSession(workDir, {
      approveProjectHook: async () => {
        throw new Error('boom');
      },
    });
    expect(s.hooks).toHaveLength(0);
    expect(s.notices.some((n) => n.includes('not approved'))).toBe(true);
  });
});

describe('fireHookEvent outcomes', () => {
  test('a hook that cannot start reports spawnError', async () => {
    const r = await fireHookEvent(sessionWith('echo hi', '/nonexistent-dir-xyz'), 'pre-tool');
    expect(r.notices.some((n) => n.includes('could not start'))).toBe(true);
  });

  test('fail-open exit uses stdout when stderr is empty, and no suffix when both are empty', async () => {
    // `;` is not a separator under cmd.exe: `echo out; exit 3` prints the
    // literal `out; exit 3` and exits 0, so no `exited 3` notice ever fires.
    // The Windows spelling chains with `&`; `exit 3` is a builtin on both.
    const failing = process.platform === 'win32' ? 'echo out & exit 3' : 'echo out; exit 3';
    let r = await fireHookEvent(sessionWith(failing), 'pre-tool');
    expect(r.notices.some((n) => n.includes('exited 3') && n.includes(': out'))).toBe(true);
    r = await fireHookEvent(sessionWith('exit 3'), 'pre-tool');
    const notice = r.notices.find((n) => n.includes('exited 3'))!;
    expect(notice).toContain('- continuing.');
    expect(notice).not.toContain(': ');
  });

  test('payload digests cap long prompt and args', async () => {
    const outFile = join(workDir, 'payload.json');
    const s = sessionWith(`cat > ${outFile}`);
    await fireHookEvent(s, 'pre-tool', {
      prompt: 'p'.repeat(3000),
      tool: { name: 't', args: 'a'.repeat(3000) },
    });
    const payload = JSON.parse(readFileSync(outFile, 'utf8')) as {
      prompt: string;
      tool: { args: string };
    };
    expect(payload.prompt).toHaveLength(2000);
    expect(payload.tool.args).toHaveLength(2000);
  });

  test('a surviving descendant re-enters settle safely', async () => {
    const r = await fireHookEvent(sessionWith('sleep 0.6 & echo done'), 'pre-tool');
    expect(r.notices.some((n) => n.includes('done'))).toBe(true);
  });

  test('bridge preTool with no args sends an empty object', async () => {
    const outFile = join(workDir, 'bridge.json');
    const bridge = createAgentHooksBridge(sessionWith(`cat > ${outFile}`));
    await bridge.preTool('tool', undefined as never);
    const payload = JSON.parse(readFileSync(outFile, 'utf8')) as {
      tool: { args: string };
    };
    expect(payload.tool.args).toBe('{}');
  });
});

describe('fireHookEvent caps (4c)', () => {
  test('at most HOOK_MAX_PER_EVENT hooks run per event; the rest are skipped with a notice', async () => {
    const { HOOK_MAX_PER_EVENT } = await import('../src/lib/hooks.js');
    expect(HOOK_MAX_PER_EVENT).toBe(10);
    const hooks = Array.from({ length: 12 }, (_, i) => ({
      event: 'pre-tool' as const,
      command: `echo hook-${i}`,
      timeoutMs: 5000,
      scope: 'user' as const,
    }));
    const result = await fireHookEvent(
      { cwd: workDir, sessionId: 'test', hooks, notices: [] },
      'pre-tool',
    );
    expect(result.blocked).toBe(false);
    expect(result.notices.some((n) => n.includes('2 pre-tool hook(s) skipped'))).toBe(true);
    // Exactly 10 hooks ran: one notice per hook-0..9 stdout tail.
    expect(result.notices.filter((n) => n.startsWith('Hook (pre-tool):')).length).toBe(10);
  });

  test('the total budget stops later hooks once exhausted (Date.now mocked)', async () => {
    const { HOOK_TOTAL_BUDGET_MS } = await import('../src/lib/hooks.js');
    expect(HOOK_TOTAL_BUDGET_MS).toBe(300_000);
    // Date.now calls in fireHookEvent, in order: deadline, remaining
    // before hook 1, remaining before hook 2, ... - jump past the
    // deadline after the first hook.
    const nowValues = [0, 0, HOOK_TOTAL_BUDGET_MS + 1];
    let calls = 0;
    const origNow = Date.now;
    Date.now = () => nowValues[Math.min(calls++, nowValues.length - 1)] ?? 0;
    try {
      const hooks = [0, 1].map((i) => ({
        event: 'pre-tool' as const,
        command: `echo hook-${i}`,
        timeoutMs: 5000,
        scope: 'user' as const,
      }));
      const result = await fireHookEvent(
        { cwd: workDir, sessionId: 'test', hooks, notices: [] },
        'pre-tool',
      );
      expect(result.notices.some((n) => n.includes('Hook (pre-tool): hook-0'))).toBe(true);
      expect(result.notices.some((n) => n.includes('total hook budget'))).toBe(true);
      expect(result.notices.some((n) => n.includes('hook-1'))).toBe(false);
    } finally {
      Date.now = origNow;
    }
  });
});
