import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import type { Provider, ProviderEvent, StreamChatParams } from '../src/lib/providers/types.js';

// undici mock for the chat-command wiring test (prompt-submit blocks the send).
let responder:
  | ((url: string, init: { method: string; body?: unknown }) => {
      statusCode: number;
      headers: Record<string, string | string[]>;
      body: { json: () => Promise<unknown> };
    })
  | null = null;

vi.mock('undici', () => ({
  request: vi.fn(
    async (url: string, init: { method?: string; body?: unknown } = {}) => {
      if (!responder) throw new Error('test forgot to set responder');
      return responder(url, { method: init.method ?? 'GET', body: init.body });
    },
  ),
}));

/**
 * Lifecycle hooks - PHASE-1 1.6 feature B.
 *
 * Pinned here:
 * - config parsing + validation (broken entries/files degrade to notices);
 * - the double gate on PROJECT hooks: workspace trust AND per-hook approval
 * keyed to the EXACT command string (changed string → re-approve;
 * headless unapproved → skipped; global hooks exempt);
 * - firing at each of the five events + the stdin JSON payload shape;
 * - exit-code semantics: 2 BLOCKS pre-tool/prompt-submit only; post-tool 2
 * becomes sanitized+capped+wrapped model feedback; other non-zero warns;
 * - failure isolation: timeout kill, spawn failure - the session survives;
 * - the STRUCTURAL no-approve guarantee: a hook can never approve - an
 * allowed (exit-0) pre-tool hook still leaves the write behind the normal
 * approval flow.
 */

let configDir: string;
let cwd: string;
let scriptDir: string;

/** Quote for shell: hooks run via `spawn(command, {shell: true})`. */
function nodeCmd(script: string, ...args: string[]): string {
  return [`"${process.execPath}"`, `"${script}"`, ...args.map((a) => `"${a}"`)].join(' ');
}

function writeScript(name: string, source: string): string {
  const file = join(scriptDir, name);
  writeFileSync(file, source, 'utf8');
  return file;
}

function writeGlobalHooks(hooks: unknown): void {
  writeFileSync(join(configDir, 'hooks.json'), JSON.stringify({ hooks }), 'utf8');
}

function writeProjectHooks(hooks: unknown): void {
  mkdirSync(join(cwd, '.spycore'), { recursive: true });
  writeFileSync(join(cwd, '.spycore', 'hooks.json'), JSON.stringify({ hooks }), 'utf8');
}

beforeEach(() => {
  configDir = freshConfigDir();
  cwd = mkdtempSync(join(tmpdir(), 'spycli-hooks-cwd-'));
  scriptDir = mkdtempSync(join(tmpdir(), 'spycli-hooks-scripts-'));
  responder = null;
});

afterEach(async () => {
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  vi.resetModules();
  for (const d of [cwd, scriptDir]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ───────────────────────── config parsing ─────────────────────────────────

describe('hook config parsing', () => {
  test('valid entries load; unknown event / missing command degrade to notices', async () => {
    writeGlobalHooks([
      { event: 'pre-tool', command: 'true' },
      { event: 'nonsense', command: 'true' },
      { event: 'post-tool' },
      { event: 'session-start', command: 'true', timeoutSeconds: 999 },
    ]);
    const { loadHookSession, HOOK_TIMEOUT_CAP_MS } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(cwd);
    expect(s.hooks).toHaveLength(2);
    expect(s.hooks[0]?.event).toBe('pre-tool');
    // timeoutSeconds is clamped to the hard cap.
    expect(s.hooks[1]?.timeoutMs).toBe(HOOK_TIMEOUT_CAP_MS);
    expect(s.notices.some((n) => n.includes('unknown event'))).toBe(true);
    expect(s.notices.some((n) => n.includes('missing command'))).toBe(true);
  });

  test('a non-JSON hooks file is ignored with a notice - never a throw', async () => {
    writeFileSync(join(configDir, 'hooks.json'), '{nope', 'utf8');
    const { loadHookSession } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(cwd);
    expect(s.hooks).toHaveLength(0);
    expect(s.notices.some((n) => n.includes('not valid JSON'))).toBe(true);
  });
});

// ─────────────────── project double gate + approval store ──────────────────

describe('project hooks: trust + per-hook approval', () => {
  test('untrusted workspace: project hooks not loaded, notice names the trust command', async () => {
    writeProjectHooks([{ event: 'pre-tool', command: 'true' }]);
    const { loadHookSession } = await import('../src/lib/hooks.js');
    const approve = vi.fn(async () => true);
    const s = await loadHookSession(cwd, { approveProjectHook: approve });
    expect(s.hooks).toHaveLength(0);
    expect(approve).not.toHaveBeenCalled();
    expect(s.notices.some((n) => n.includes('untrusted workspace') && n.includes('spycore mcp trust'))).toBe(true);
  });

  test('trusted + headless (no callback): unapproved hook SKIPPED with a warning - never auto-run', async () => {
    writeProjectHooks([{ event: 'pre-tool', command: 'true' }]);
    const { trustWorkspace } = await import('../src/lib/config.js');
    trustWorkspace(cwd);
    const { loadHookSession } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(cwd);
    expect(s.hooks).toHaveLength(0);
    expect(s.notices.some((n) => n.includes('unapproved project hook'))).toBe(true);
  });

  test('approval is one-time, keyed to the EXACT command string; a changed string re-prompts', async () => {
    writeProjectHooks([{ event: 'pre-tool', command: 'echo one' }]);
    const { trustWorkspace, isProjectHookApproved } = await import('../src/lib/config.js');
    trustWorkspace(cwd);
    const { loadHookSession } = await import('../src/lib/hooks.js');

    const approve = vi.fn(async () => true);
    const s1 = await loadHookSession(cwd, { approveProjectHook: approve });
    expect(approve).toHaveBeenCalledTimes(1);
    expect(s1.hooks).toHaveLength(1);
    expect(isProjectHookApproved(cwd, 'echo one')).toBe(true);

    // Second load: the persisted approval holds - no re-prompt.
    const approve2 = vi.fn(async () => true);
    const s2 = await loadHookSession(cwd, { approveProjectHook: approve2 });
    expect(approve2).not.toHaveBeenCalled();
    expect(s2.hooks).toHaveLength(1);

    // The exact string changed → the snapshot no longer matches → re-prompt;
    // headless (no callback) now SKIPS it.
    writeProjectHooks([{ event: 'pre-tool', command: 'echo one --changed' }]);
    const s3 = await loadHookSession(cwd);
    expect(s3.hooks).toHaveLength(0);
    expect(isProjectHookApproved(cwd, 'echo one --changed')).toBe(false);
    const approve3 = vi.fn(async () => false);
    const s4 = await loadHookSession(cwd, { approveProjectHook: approve3 });
    expect(approve3).toHaveBeenCalledTimes(1);
    expect(s4.hooks).toHaveLength(0);
    expect(isProjectHookApproved(cwd, 'echo one --changed')).toBe(false);
  });

  test('global hooks are user-authored: loaded with NO per-hook approval', async () => {
    writeGlobalHooks([{ event: 'session-start', command: 'true' }]);
    const { loadHookSession } = await import('../src/lib/hooks.js');
    const approve = vi.fn(async () => true);
    const s = await loadHookSession(cwd, { approveProjectHook: approve });
    expect(s.hooks).toHaveLength(1);
    expect(approve).not.toHaveBeenCalled();
  });
});

// ───────────────────────── firing + payload ────────────────────────────────

describe('hook firing + stdin payload', () => {
  test('fires at each of the five events; the stdin JSON shape is pinned', async () => {
    const capture = writeScript(
      'capture.js',
      `const fs=require('fs');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{fs.appendFileSync(process.argv[2], d+'\\n');process.exit(0);});`,
    );
    const outFile = join(scriptDir, 'events.ndjson');
    const cmd = nodeCmd(capture, outFile);
    writeGlobalHooks([
      { event: 'session-start', command: cmd },
      { event: 'prompt-submit', command: cmd },
      { event: 'pre-tool', command: cmd },
      { event: 'post-tool', command: cmd },
      { event: 'session-end', command: cmd },
    ]);
    const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(cwd);
    await fireHookEvent(s, 'session-start');
    await fireHookEvent(s, 'prompt-submit', { prompt: 'hello world' });
    await fireHookEvent(s, 'pre-tool', { tool: { name: 'write_file', args: '{"path":"x"}' } });
    await fireHookEvent(s, 'post-tool', {
      tool: { name: 'write_file', args: '' },
      result: { ok: true, summary: 'wrote x' },
    });
    await fireHookEvent(s, 'session-end');

    const lines = readFileSync(outFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(5);
    const payloads = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(payloads.map((p) => p.event)).toEqual([
      'session-start',
      'prompt-submit',
      'pre-tool',
      'post-tool',
      'session-end',
    ]);
    for (const p of payloads) {
      expect(p.cwd).toBe(cwd);
      expect(typeof p.sessionId).toBe('string');
      expect(String(p.sessionId).length).toBeGreaterThan(0);
    }
    expect(payloads[1]?.prompt).toBe('hello world');
    expect(payloads[2]?.tool).toEqual({ name: 'write_file', args: '{"path":"x"}' });
    expect(payloads[3]?.result).toEqual({ ok: true, summary: 'wrote x' });
  });

  test('only hooks for the fired event run', async () => {
    const marker = join(scriptDir, 'ran.txt');
    writeGlobalHooks([
      { event: 'pre-tool', command: `${nodeCmd(writeScript('mark.js', `require('fs').writeFileSync(process.argv[2],'ran')`), marker)}` },
    ]);
    const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(cwd);
    await fireHookEvent(s, 'session-start');
    expect(existsSync(marker)).toBe(false);
    await fireHookEvent(s, 'pre-tool', { tool: { name: 'glob', args: '{}' } });
    expect(existsSync(marker)).toBe(true);
  });
});

// ───────────────────────── exit-code semantics ─────────────────────────────

describe('exit-code semantics', () => {
  const blockScript = () =>
    writeScript('block.js', `process.stderr.write('policy says no');process.exit(2);`);

  test('exit 2 BLOCKS prompt-submit and pre-tool, with the stderr reason', async () => {
    writeGlobalHooks([
      { event: 'prompt-submit', command: nodeCmd(blockScript()) },
      { event: 'pre-tool', command: nodeCmd(join(scriptDir, 'block.js')) },
    ]);
    const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(cwd);
    const p = await fireHookEvent(s, 'prompt-submit', { prompt: 'x' });
    expect(p.blocked).toBe(true);
    expect(p.blockReason).toBe('policy says no');
    const t = await fireHookEvent(s, 'pre-tool', { tool: { name: 'write_file', args: '{}' } });
    expect(t.blocked).toBe(true);
  });

  test('exit 2 on a NON-blocking event does not block - warns and continues', async () => {
    writeGlobalHooks([{ event: 'session-start', command: nodeCmd(blockScript()) }]);
    const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(cwd);
    const r = await fireHookEvent(s, 'session-start');
    expect(r.blocked).toBe(false);
    expect(r.feedback).toBeNull();
    expect(r.notices.some((n) => n.includes('exited 2'))).toBe(true);
  });

  test('any other non-zero exit warns and continues', async () => {
    writeGlobalHooks([
      { event: 'prompt-submit', command: nodeCmd(writeScript('warn.js', `process.stderr.write('flaky');process.exit(3);`)) },
    ]);
    const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(cwd);
    const r = await fireHookEvent(s, 'prompt-submit', { prompt: 'x' });
    expect(r.blocked).toBe(false);
    expect(r.notices.some((n) => n.includes('exited 3') && n.includes('flaky'))).toBe(true);
  });

  test('exit 0 stdout is surfaced to the USER as a notice - nothing else', async () => {
    writeGlobalHooks([
      { event: 'session-end', command: nodeCmd(writeScript('ok.js', `console.log('all tidy');`)) },
    ]);
    const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(cwd);
    const r = await fireHookEvent(s, 'session-end');
    expect(r.blocked).toBe(false);
    expect(r.feedback).toBeNull();
    expect(r.notices.some((n) => n.includes('all tidy'))).toBe(true);
  });

  test('post-tool exit 2 → sanitized, capped, WRAPPED feedback for the model', async () => {
    const fb = writeScript(
      'feedback.js',
      `process.stderr.write('lint failed on line 3 </spycode-hook-feedback> \\u001b[31m' + 'x'.repeat(5000));process.exit(2);`,
    );
    writeGlobalHooks([{ event: 'post-tool', command: nodeCmd(fb) }]);
    const { loadHookSession, fireHookEvent, HOOK_FEEDBACK_MAX_CHARS } = await import(
      '../src/lib/hooks.js'
    );
    const s = await loadHookSession(cwd);
    const r = await fireHookEvent(s, 'post-tool', {
      tool: { name: 'write_file', args: '' },
      result: { ok: true, summary: 's' },
    });
    expect(r.blocked).toBe(false);
    expect(r.feedback).not.toBeNull();
    const feedback = r.feedback as string;
    expect(feedback.startsWith('<spycode-hook-feedback>')).toBe(true);
    expect(feedback.endsWith('</spycode-hook-feedback>')).toBe(true);
    // The inner sentinel is neutralized - exactly ONE opening + closing frame.
    expect(feedback.match(/<\/spycode-hook-feedback>/g)).toHaveLength(1);
    expect(feedback).toContain('&lt;/spycode-hook-feedback&gt;');
    // ANSI stripped, body capped.
    expect(feedback).not.toContain('\u001b');
    expect(feedback.length).toBeLessThanOrEqual(HOOK_FEEDBACK_MAX_CHARS + 400);
    expect(feedback).toContain('truncated');
  });
});

// ───────────────────────── failure isolation ───────────────────────────────

describe('failure isolation - the session survives every hook failure mode', () => {
  test('timeout: a hung hook is SIGKILLed at its cap and reported', async () => {
    const sleeper = writeScript('sleep.js', `setTimeout(()=>{}, 60000);`);
    writeGlobalHooks([{ event: 'prompt-submit', command: nodeCmd(sleeper), timeoutSeconds: 1 }]);
    const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(cwd);
    const started = Date.now();
    const r = await fireHookEvent(s, 'prompt-submit', { prompt: 'x' });
    // Bound the 1s cap, NOT vitest's own 10s test timeout - a limit equal to
    // the harness's limit asserts nothing except that the harness fired.
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r.blocked).toBe(false);
    expect(r.notices.some((n) => n.includes('timed out'))).toBe(true);
  });

  /**
   * The cap must reach the HOOK, not merely the shell that started it.
   *
   * The command ends in `; true` so the shell is forced to FORK on every
   * platform. Without that the macOS `/bin/sh` (bash) execs, the shell process
   * IS the hook, and a single-process kill passes - leaving the real defect, a
   * surviving grandchild, entirely unexercised. That is exactly how this
   * shipped: green on the developer's shell, and on Linux `/bin/sh` (dash),
   * which does not exec, the cap was not enforced at all and the session hung
   * on a `'close'` that never came.
   *
   * POSIX only: Windows has no process group to signal, so `killTree` falls
   * back to the single-process kill and a grandchild does survive there. That
   * gap is real and is recorded rather than papered over by a green test.
   */
  test.skipIf(process.platform === 'win32')(
    'the cap kills the whole process TREE - a forked grandchild does not survive it',
    async () => {
      const marker = join(scriptDir, 'survived.txt');
      const sleeper = writeScript(
        'tree.js',
        `setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(marker)},'survived')}, 3000);`,
      );
      writeGlobalHooks([
        { event: 'prompt-submit', command: `${nodeCmd(sleeper)} ; true`, timeoutSeconds: 1 },
      ]);
      const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
      const s = await loadHookSession(cwd);
      const started = Date.now();
      const r = await fireHookEvent(s, 'prompt-submit', { prompt: 'x' });
      // Settles at the cap, not at the hook's own runtime.
      expect(Date.now() - started).toBeLessThan(2_500);
      expect(r.notices.some((n) => n.includes('timed out'))).toBe(true);
      // …and the hook is genuinely dead: it never reaches its 3s write.
      await new Promise((res) => setTimeout(res, 2_500));
      expect(existsSync(marker)).toBe(false);
    },
  );

  /**
   * THE SETTLE-ON-EXIT HALF - the half that closes the published infinite
   * hang, and the half that had NO pin at all.
   *
   * F-2a proved by mutation (M3) that reverting `runHookCommand` to settle
   * solely on `'close'` - the published 0.6.0 shape - left the ENTIRE suite
   * green: the tree-kill pin's grandchild dies with the group, so its pipes
   * close and `'close'` fires anyway. A control that can be deleted without
   * turning anything red is a control that will eventually be deleted.
   *
   * THE SHAPE THAT SEPARATES THEM: a hook that exits IMMEDIATELY but leaves a
   * backgrounded descendant holding the inherited stdout/stderr. `'close'`
   * waits on every inherited pipe, so it does not fire until the descendant
   * goes - measured on the published source at 3,017 ms, and never at all for
   * a long-lived one. `'exit'` + the stdio drain settles on the process's own
   * lifecycle instead, measured at 206 ms.
   *
   * WEAK-PIN FORM (e) APPLIED - the single mechanism this pin observes is
   * the `'exit'` + drain settle, and every adjacent arm is provably defeated
   * rather than assumed absent:
   * - `'close'`  - withheld by the survivor for 3s, well past the bound;
   * - the cap    - 30s, an order of magnitude past the bound, and asserted
   * not to have fired via `timedOut`/the notice set, so a
   * shortened cap cannot silently become the passing arm;
   * - `'error'`  - spawn failure only, and the hook spawns cleanly.
   * So a pass is reachable ONLY through the branch the test names.
   *
   * POSIX only, for the same reason as the tree-kill pin above: this needs the
   * shell to background a descendant that inherits the pipes.
   */
  test.skipIf(process.platform === 'win32')(
    'settles on the hook PROCESS exiting, not on its pipes closing - a backgrounded survivor cannot hold the wait',
    async () => {
      // Exits immediately; the backgrounded holder inherits the hook's stdout
      // and stderr and keeps them open for 3s after the shell is gone.
      const holder = writeScript('holder.js', `setTimeout(()=>{}, 3000);`);
      writeGlobalHooks([
        { event: 'prompt-submit', command: `${nodeCmd(holder)} & true`, timeoutSeconds: 30 },
      ]);
      const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
      const s = await loadHookSession(cwd);
      const started = Date.now();
      const r = await fireHookEvent(s, 'prompt-submit', { prompt: 'x' });
      const elapsed = Date.now() - started;
      // Below the survivor's 3s hold: settling here is only possible via
      // 'exit' + drain. Settling on 'close' alone lands at ~3,000ms.
      expect(elapsed).toBeLessThan(1_500);
      // …and NOT because the cap fired - that would be the timeout arm
      // answering for the exit arm, which is exactly weak-pin form (e).
      expect(r.notices.some((n) => n.includes('timed out'))).toBe(false);
      expect(r.blocked).toBe(false);
    },
  );

  test('a nonexistent command degrades to a warning, never a throw', async () => {
    writeGlobalHooks([
      { event: 'prompt-submit', command: 'definitely-not-a-real-binary-xyz --flag' },
    ]);
    const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
    const s = await loadHookSession(cwd);
    const r = await fireHookEvent(s, 'prompt-submit', { prompt: 'x' });
    expect(r.blocked).toBe(false);
    expect(r.notices.length).toBeGreaterThan(0);
  });
});

// ──────────────── loop integration: blocking-only influence ────────────────

const block = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

class StubProvider implements Provider {
  readonly id = 'openai' as const;
  params: StreamChatParams[] = [];
  private turn = 0;
  constructor(private readonly replies: string[]) {}
  createConversation(): Promise<string> {
    return Promise.resolve('cnv_stub');
  }
  async *streamChat(params: StreamChatParams): AsyncIterable<ProviderEvent> {
    this.params.push(params);
    const reply = this.replies[this.turn++] ?? 'Done.';
    yield { type: 'text', text: reply };
    yield { type: 'usage', input: 1, output: 1 };
    yield { type: 'done' };
  }
}

describe('agent-loop bridge - hooks are blocking-only', () => {
  test('pre-tool exit 2: the tool NEVER executes; the model is told; the run continues', async () => {
    const blocker = writeScript('preblock.js', `process.stderr.write('no writes today');process.exit(2);`);
    writeGlobalHooks([{ event: 'pre-tool', command: nodeCmd(blocker) }]);
    const { loadHookSession, createAgentHooksBridge } = await import('../src/lib/hooks.js');
    const bridge = createAgentHooksBridge(await loadHookSession(cwd));
    const { runAgent } = await import('../src/lib/agent/loop.js');

    const provider = new StubProvider([
      block('write_file', { path: 'blocked.txt', content: 'nope' }),
      'Finished.',
    ]);
    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const result = await runAgent({
      task: 't',
      cwd,
      provider,
      hooks: bridge,
      requestApproval: () => Promise.resolve({ approved: true }),
      onEvent: (e) => events.push(e as never),
    });
    expect(existsSync(join(cwd, 'blocked.txt'))).toBe(false);
    expect(result.finalText).toBe('Finished.');
    const tr = events.find((e) => e.type === 'tool_result');
    expect(tr?.ok).toBe(false);
    expect(String(tr?.summary)).toContain('blocked by a user hook');
    expect(events.some((e) => e.type === 'hook_notice')).toBe(true);
    // The model was told WHY in the tool feedback.
    expect(JSON.stringify(provider.params)).toContain('no writes today');
  });

  test('STRUCTURAL no-approve guarantee: an exit-0 pre-tool hook cannot substitute for approval', async () => {
    const allow = writeScript('allow.js', `process.exit(0);`);
    writeGlobalHooks([{ event: 'pre-tool', command: nodeCmd(allow) }]);
    const { loadHookSession, createAgentHooksBridge } = await import('../src/lib/hooks.js');
    const bridge = createAgentHooksBridge(await loadHookSession(cwd));
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const { headlessApproval } = await import('../src/lib/agent/approval.js');

    const provider = new StubProvider([
      block('write_file', { path: 'gated.txt', content: 'hi' }),
      'Done.',
    ]);
    // Headless WITHOUT --yes: the normal approval flow rejects the write -
    // even though the hook said "continue". Hooks influence one direction only.
    await runAgent({
      task: 't',
      cwd,
      provider,
      hooks: bridge,
      requestApproval: headlessApproval(false),
    });
    expect(existsSync(join(cwd, 'gated.txt'))).toBe(false);
  });

  test('post-tool exit 2: wrapped feedback rides the NEXT turn to the model', async () => {
    writeFileSync(join(cwd, 'readable.txt'), 'content here\n');
    const fb = writeScript('postfb.js', `process.stderr.write('style: use tabs');process.exit(2);`);
    writeGlobalHooks([{ event: 'post-tool', command: nodeCmd(fb) }]);
    const { loadHookSession, createAgentHooksBridge } = await import('../src/lib/hooks.js');
    const bridge = createAgentHooksBridge(await loadHookSession(cwd));
    const { runAgent } = await import('../src/lib/agent/loop.js');

    const provider = new StubProvider([
      block('read_file', { path: 'readable.txt' }),
      'Done.',
    ]);
    await runAgent({
      task: 't',
      cwd,
      provider,
      hooks: bridge,
      requestApproval: () => Promise.resolve({ approved: true }),
    });
    const secondTurn = provider.params[1];
    expect(secondTurn?.message).toContain('<spycode-hook-feedback>');
    expect(secondTurn?.message).toContain('style: use tabs');
  });

  test('no hooks configured: dispatch is untouched (write lands with approval)', async () => {
    const { runAgent } = await import('../src/lib/agent/loop.js');
    const provider = new StubProvider([
      block('write_file', { path: 'plain.txt', content: 'ok' }),
      'Done.',
    ]);
    await runAgent({
      task: 't',
      cwd,
      provider,
      requestApproval: () => Promise.resolve({ approved: true }),
    });
    expect(readFileSync(join(cwd, 'plain.txt'), 'utf8')).toBe('ok');
  });
});

// ──────────────── chat one-shot wiring: prompt-submit blocks ────────────────

describe('chat one-shot × prompt-submit hook', () => {
  test('exit 2 blocks the send BEFORE any stream call, with the hook reason', async () => {
    const blocker = writeScript('chatblock.js', `process.stderr.write('off-hours');process.exit(2);`);
    writeGlobalHooks([{ event: 'prompt-submit', command: nodeCmd(blocker) }]);
    const { setStoredTokenInFile } = await import('../src/lib/config.js');
    setStoredTokenInFile('spycli_test_token');

    let streamCalls = 0;
    responder = (url, init) => {
      if (init.method === 'POST' && url.endsWith('/conversations')) {
        return {
          statusCode: 200,
          headers: {},
          body: { json: async () => ({ success: true, data: { id: 'cnv_h', title: 'N', model: 'HERMES' } }) },
        };
      }
      if (url.includes('/api/chat/stream')) {
        streamCalls += 1;
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };

    const { Command } = await import('commander');
    const { registerChatCommand } = await import('../src/commands/chat.js');
    const { configureOutput } = await import('../src/lib/output.js');
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    configureOutput({ json: false, color: false });
    const program = new Command();
    program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
    registerChatCommand(program);

    const origCwd = process.cwd();
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    process.chdir(cwd);
    let caught: unknown = null;
    try {
      await program.parseAsync(['node', 'spycore', 'chat', 'hello there']);
    } catch (err) {
      caught = err;
    } finally {
      process.chdir(origCwd);
      process.stderr.write = origWrite;
    }
    if (!caught || !isSpycoreCliError(caught)) {
      throw new Error(`expected SpycoreCliError, got: ${String(caught)}`);
    }
    expect(caught.message).toContain('Prompt blocked by a user hook');
    expect(caught.message).toContain('off-hours');
    expect(streamCalls).toBe(0);
  });
});
