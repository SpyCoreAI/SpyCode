import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';
import { __resetConfigForTests } from '../src/lib/config.js';
import type { CheckpointSession, ResumeState } from '../src/lib/agent/checkpoint.js';
import {
  buildResumeBanner,
  buildResumeContinueMessage,
  currentGitHead,
  isResumable,
  type ResumeTarget,
} from '../src/lib/agent/resume.js';

function makeState(over: Partial<ResumeState> = {}): ResumeState {
  return {
    version: 1,
    status: 'interrupted',
    conversationId: 'conv-123',
    nativeTools: false,
    providerKind: 'spycore',
    model: 'styx',
    planMode: false,
    approvedPlan: null,
    turnsCompleted: 4,
    maxTurns: 50,
    budget: { tokensUsed: 1000, turnsUsed: 4, elapsedMs: 60_000, caps: { maxTokens: 100_000 } },
    loadedSkills: [],
    gitHead: null,
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

function makeSession(over: Partial<CheckpointSession> = {}): CheckpointSession {
  return {
    id: '1700000000000-abcdef',
    cwd: '/tmp/ws',
    startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    task: 'Fix the login bug',
    changes: [],
    resume: makeState(),
    ...over,
  };
}

describe('currentGitHead', () => {
  test('null outside a repo', () => {
    expect(currentGitHead(tmpdir())).toBeNull();
  });

  test('returns the 40-hex HEAD inside a repo', async () => {
    const { runGit } = await import('../src/lib/git.js');
    const dir = mkdtempSync(join(tmpdir(), 'spy-resume-'));
    const gitEnv = {
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@example.com',
    };
    Object.assign(process.env, gitEnv);
    try {
      expect(runGit(dir, ['init']).ok).toBe(true);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(dir, 'a.txt'), 'a');
      expect(runGit(dir, ['add', '-A']).ok).toBe(true);
      expect(runGit(dir, ['commit', '-m', 'one']).ok).toBe(true);
      const head = currentGitHead(dir);
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      for (const k of Object.keys(gitEnv)) delete process.env[k];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('isResumable', () => {
  test('an interrupted spycore session bound to a conversation is resumable', () => {
    expect(isResumable(makeSession())).toBe(true);
  });

  test('a crash-time running boundary is also resumable', () => {
    expect(isResumable(makeSession({ resume: makeState({ status: 'running' }) }))).toBe(true);
  });

  test('not resumable: completed, byok, no conversation, no resume record', () => {
    expect(isResumable(makeSession({ resume: makeState({ status: 'completed' }) }))).toBe(false);
    expect(isResumable(makeSession({ resume: makeState({ providerKind: 'byok' }) }))).toBe(false);
    expect(isResumable(makeSession({ resume: makeState({ conversationId: null }) }))).toBe(false);
    expect(isResumable(makeSession({ resume: undefined }))).toBe(false);
  });

  test('not resumable: malformed resume record', () => {
    expect(
      isResumable(makeSession({ resume: { version: 2 } as unknown as ResumeState })),
    ).toBe(false);
  });
});

describe('buildResumeBanner', () => {
  function bannerInput(): Parameters<typeof buildResumeBanner>[0] {
    const session = makeSession();
    return {
      target: { session, state: session.resume! } as ResumeTarget,
      drift: null,
      modelLabel: 'Styx',
      modelFromFlag: false,
      webTools: true,
      observeWorkspace: false,
      budget: session.resume!.budget,
    };
  }

  test('states what is being restored', () => {
    const lines = buildResumeBanner(bannerInput());
    expect(lines[0]).toContain('Resuming agent session 1700000000000-abcdef');
    expect(lines[1]).toBe('Task: Fix the login bug');
    expect(lines[2]).toContain('Progress: 4 completed turns');
    expect(lines[2]).toContain('0 files changed');
  });

  test('shows cumulative budget caps and the pinned tool protocol', () => {
    const lines = buildResumeBanner(bannerInput());
    expect(lines.some((l) => l.includes('Budget (cumulative - consumption carried over)'))).toBe(true);
    expect(lines.some((l) => l.includes('1000/100000 tokens'))).toBe(true);
    expect(lines.some((l) => l.includes('fenced tool protocol (pinned by session)'))).toBe(true);
  });

  test('approved plans and drift are surfaced', () => {
    const input = bannerInput();
    input.target.state = makeState({ approvedPlan: 'do the thing' });
    input.drift = { headMoved: true, fromHead: 'aaa', toHead: 'bbb', modifiedFiles: ['a.txt', 'b.txt'] };
    const lines = buildResumeBanner(input);
    expect(lines.some((l) => l.includes('approved plan restored'))).toBe(true);
    expect(lines.some((l) => l.includes('Workspace drift detected'))).toBe(true);
    expect(lines.some((l) => l.includes('git HEAD moved since the interrupt'))).toBe(true);
    expect(lines.some((l) => l.includes('2 journaled files modified outside the run'))).toBe(true);
  });

  test('singular grammar: 1 turn, 1 file', () => {
    const input = bannerInput();
    input.target.state = makeState({ turnsCompleted: 1 });
    input.target.session = makeSession({ changes: [{ path: 'a.txt' } as never] });
    const lines = buildResumeBanner(input);
    expect(lines.some((l) => l.includes('1 completed turn ·'))).toBe(true);
    expect(lines.some((l) => l.includes('1 file changed'))).toBe(true);
  });
});

describe('buildResumeContinueMessage', () => {
  test('the base message never replays work', () => {
    const msg = buildResumeContinueMessage({
      state: makeState(),
      driftAccepted: false,
      protocolHint: '',
    });
    expect(msg).toContain('interrupted after 4 completed tool-calling turns');
    expect(msg).toContain('Do NOT redo completed work');
    expect(msg).not.toContain('approved plan');
  });

  test('approved plan, drift acceptance, and protocol hint are appended', () => {
    const msg = buildResumeContinueMessage({
      state: makeState({ approvedPlan: 'p' }),
      driftAccepted: true,
      protocolHint: 'HINT',
    });
    expect(msg).toContain('The previously approved plan still applies.');
    expect(msg).toContain('workspace was modified outside this session');
    expect(msg.endsWith('HINT')).toBe(true);
  });
});

describe('resolveResumeTarget', () => {
  beforeEach(() => {
    freshConfigDir();
    __resetConfigForTests();
  });
  afterEach(() => {
    __resetConfigForTests();
  });

  test('bare --resume with no sessions is a clean user error', async () => {
    const { resolveResumeTarget } = await import('../src/lib/agent/resume.js');
    const cwd = mkdtempSync(join(tmpdir(), 'spy-resume-target-'));
    try {
      expect(() => resolveResumeTarget(cwd, true)).toThrow('No resumable agent session');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('unknown session id is a clean user error', async () => {
    const { resolveResumeTarget } = await import('../src/lib/agent/resume.js');
    const cwd = mkdtempSync(join(tmpdir(), 'spy-resume-target-'));
    try {
      expect(() => resolveResumeTarget(cwd, 'nope')).toThrow('No session "nope"');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
