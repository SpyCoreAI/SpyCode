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
    let r = await fireHookEvent(sessionWith('echo out; exit 3'), 'pre-tool');
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
