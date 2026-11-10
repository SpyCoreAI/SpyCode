/**
 * H-10 - delegation roles: depth > 0 is a leaf; leaf runs never get the
 * `delegate` tool (no recursive spawning) and cannot write durable memory.
 * MAX_DELEGATE_DEPTH stays as dispatch-time defense in depth.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { MAX_DELEGATE_DEPTH, roleForDepth } from '../src/lib/agent/delegate.js';
import {
  DEFAULT_LIMITS,
  dispatchTool,
  describeToolsForPrompt,
  buildToolDeclarations,
  type ToolContext,
} from '../src/lib/agent/tools.js';

let dir = '';
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = '';
  }
});

function leafCtx(): ToolContext {
  dir = mkdtempSync(join(tmpdir(), 'spycode-leaf-'));
  return {
    cwd: dir,
    limits: DEFAULT_LIMITS,
    role: 'leaf',
    requestApproval: () => Promise.resolve({ approved: true }),
  };
}

describe('roleForDepth', () => {
  test('depth 0 is the orchestrator; anything deeper is a leaf', () => {
    expect(roleForDepth(0)).toBe('orchestrator');
    expect(roleForDepth(1)).toBe('leaf');
    expect(roleForDepth(2)).toBe('leaf');
    expect(MAX_DELEGATE_DEPTH).toBe(2);
  });
});

describe('leaf tool gating', () => {
  test('the leaf catalogue omits delegate (delegateEnabled=false)', () => {
    const orch = describeToolsForPrompt({ delegateEnabled: true });
    const leaf = describeToolsForPrompt({ delegateEnabled: false });
    expect(orch).toContain('delegate');
    expect(leaf).not.toContain('delegate(');
  });

  test('native declarations omit delegate for leaves', () => {
    const decls = buildToolDeclarations({ delegateEnabled: false });
    expect(decls.some((d) => d.name === 'delegate')).toBe(false);
    expect(buildToolDeclarations({ delegateEnabled: true }).some((d) => d.name === 'delegate')).toBe(true);
  });

  test('dispatch refuses a guessed delegate call for a leaf', async () => {
    const res = await dispatchTool('delegate', { task: 'x' }, leafCtx());
    expect(res.ok).toBe(false);
    expect(res.content).toContain('unknown tool');
  });

  test('a leaf cannot write durable memory (reads still work)', async () => {
    const ctx = leafCtx();
    const write = await dispatchTool('memory', { action: 'add', text: 'leaf note' }, ctx);
    expect(write.ok).toBe(false);
    expect(write.content).toContain('sub-agents cannot write');
    const view = await dispatchTool('memory', { action: 'view' }, ctx);
    expect(view.ok).toBe(true);
  });
});
