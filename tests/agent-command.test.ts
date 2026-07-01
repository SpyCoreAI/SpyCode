import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_LIMITS,
  dispatchTool,
  matchesCatastrophic,
  type ToolContext,
  type ToolLimits,
} from '../src/lib/agent/tools.js';
import type { RequestApproval } from '../src/lib/agent/approval.js';

const ACCEPT: RequestApproval = () => Promise.resolve({ approved: true });
const REJECT: RequestApproval = () => Promise.resolve({ approved: false, reason: 'rejected by user' });

// ───────────────────────── catastrophic denylist (pure) ─────────────────────────

describe('matchesCatastrophic', () => {
  test('blocks obviously destructive commands', () => {
    for (const c of [
      'rm -rf /',
      'rm -fr /',
      'rm -rf /*',
      'rm -rf ~',
      'rm -rf $HOME',
      'rm -rf /usr',
      'rm --recursive --force /',
      'rm -rf / --no-preserve-root',
      ':(){ :|:& };:',
      'mkfs.ext4 /dev/sda',
      'dd if=/dev/zero of=/dev/sda bs=1M',
      'echo boom > /dev/sda',
    ]) {
      expect(matchesCatastrophic(c), c).not.toBeNull();
    }
  });

  test('allows ordinary commands (approval still gates them)', () => {
    for (const c of [
      'ls -la',
      'git status',
      'npm test',
      'pnpm build',
      'rm -rf node_modules',
      'rm -rf build/',
      'rm -rf ./tmp',
      'rm file.txt',
      'echo hello > out.txt',
      'cat /dev/null',
      'git rm -rf src/old',
    ]) {
      expect(matchesCatastrophic(c), c).toBeNull();
    }
  });
});

// ───────────────────────── run_command (real spawn) ─────────────────────────

describe('run_command', () => {
  let workDir: string;
  const ctx = (req: RequestApproval = ACCEPT, over: Partial<ToolContext> = {}): ToolContext => ({
    cwd: workDir,
    limits: DEFAULT_LIMITS,
    requestApproval: req,
    ...over,
  });

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-cmd-'));
  });
  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test('captures stdout and a zero exit code', async () => {
    const r = await dispatchTool('run_command', { command: 'echo hi' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('command');
    expect(r.exitCode).toBe(0);
    expect(r.content).toContain('hi');
    expect(r.summary).toMatch(/exit 0/);
  });

  test('captures a non-zero exit code', async () => {
    const r = await dispatchTool('run_command', { command: 'exit 3' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(3);
    expect(r.summary).toMatch(/exit 3/);
  });

  test('captures stderr', async () => {
    const r = await dispatchTool('run_command', { command: 'echo oops 1>&2' }, ctx());
    expect(r.ok).toBe(true);
    expect(r.content).toContain('oops');
  });

  test('runs in the sandbox cwd', async () => {
    const r = await dispatchTool('run_command', { command: 'echo made > made_here.txt' }, ctx());
    expect(r.ok).toBe(true);
    expect(existsSync(join(workDir, 'made_here.txt'))).toBe(true);
  });

  test('times out and kills the process group', async () => {
    const start = Date.now();
    const r = await dispatchTool(
      'run_command',
      { command: 'sleep 5 && touch marker.txt' },
      ctx(ACCEPT, { commandTimeoutMs: 700 }),
    );
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
    expect(Date.now() - start).toBeLessThan(4000); // didn't wait the full 5s
    // The process group was killed before `touch` could run.
    expect(existsSync(join(workDir, 'marker.txt'))).toBe(false);
  }, 10000);

  test('caps oversized output (model content) but keeps a tail', async () => {
    const tiny: ToolLimits = { ...DEFAULT_LIMITS, maxResultBytes: 200 };
    const r = await dispatchTool(
      'run_command',
      { command: "awk 'BEGIN{for(i=1;i<=500;i++)print \"line\"i}'" },
      ctx(ACCEPT, { limits: tiny }),
    );
    expect(r.ok).toBe(true);
    expect(r.content).toMatch(/truncated to/); // dispatch byte-cap
    expect(r.outputTail ?? '').toContain('line500'); // tail keeps the last lines
  });

  test('reject (approval) does not run the command', async () => {
    const r = await dispatchTool('run_command', { command: 'echo nope > nope.txt' }, ctx(REJECT));
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('rejected');
    expect(existsSync(join(workDir, 'nope.txt'))).toBe(false);
  });

  test('catastrophic commands are blocked BEFORE approval (no prompt, no run)', async () => {
    let prompted = false;
    const spy: RequestApproval = () => {
      prompted = true;
      return Promise.resolve({ approved: true }); // even an approve-all approver
    };
    const r = await dispatchTool('run_command', { command: 'rm -rf /' }, ctx(spy));
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/blocked: refusing to run a catastrophic command/);
    expect(prompted).toBe(false);
  });

  test('empty command is rejected', async () => {
    const r = await dispatchTool('run_command', { command: '   ' }, ctx());
    expect(r.ok).toBe(false);
    expect(r.content).toMatch(/must not be empty/);
  });
});
