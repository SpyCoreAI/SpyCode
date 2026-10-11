/**
 * H-15 - invisible-unicode detection in commands (homoglyph defense).
 * Zero-width and bidi-control characters are flagged on the approval card -
 * a flag, not a hard block - because the screen's hard blocks are reserved
 * for the obviously catastrophic.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  findInvisibleUnicode,
  invisibleUnicodeNotice,
} from '../src/lib/agent/command-screen/invisible.js';
import type { ApprovalRequest, RequestApproval } from '../src/lib/agent/approval.js';
import { DEFAULT_LIMITS, dispatchTool, type ToolContext } from '../src/lib/agent/tools.js';

describe('H-15 findInvisibleUnicode', () => {
  test('clean commands pass', () => {
    expect(findInvisibleUnicode('ls -la')).toBeNull();
    expect(findInvisibleUnicode('echo "hello world" | grep hello')).toBeNull();
    expect(findInvisibleUnicode('npm test -- --watch')).toBeNull();
  });

  test('zero-width space is found with its position', () => {
    const hit = findInvisibleUnicode('ls\u200b -la');
    expect(hit).not.toBeNull();
    expect(hit!.name).toBe('zero-width space');
    expect(hit!.index).toBe(2);
  });

  test('bidi overrides are found', () => {
    const hit = findInvisibleUnicode('echo \u202ereversed');
    expect(hit).not.toBeNull();
    expect(hit!.name).toBe('right-to-left override');
  });

  test('bidi isolates are found', () => {
    const hit = findInvisibleUnicode('echo \u2066x\u2069');
    expect(hit).not.toBeNull();
    expect(hit!.name).toContain('isolate');
  });

  test('byte-order mark and soft hyphen are found', () => {
    expect(findInvisibleUnicode('\ufeffecho hi')!.name).toBe('byte-order mark');
    expect(findInvisibleUnicode('echo\u00ad hi')!.name).toBe('soft hyphen');
  });

  test('variation selectors are found', () => {
    expect(findInvisibleUnicode('echo \ufe00hi')!.name).toBe('variation selector');
  });

  test('the notice names the character and offset', () => {
    const hit = findInvisibleUnicode('ab\u200bcd')!;
    const notice = invisibleUnicodeNotice(hit);
    expect(notice).toContain('zero-width space');
    expect(notice).toContain('U+200B');
    expect(notice).toContain('position 2');
  });
});

describe('H-15 approval flag', () => {
  test('an invisible character in the command reaches the approval request as a notice', async () => {
    const seen: ApprovalRequest[] = [];
    const spy: RequestApproval = (req) => {
      seen.push(req);
      return Promise.resolve({ approved: true });
    };
    const cwd = mkdtempSync(join(tmpdir(), 'spycode-h15-'));
    const ctx: ToolContext = { cwd, limits: DEFAULT_LIMITS, requestApproval: spy };
    const r = await dispatchTool('run_command', { command: 'echo\u200b hi' }, ctx);
    // The shell cannot even find `echo<ZWSP>` (exit 127) - which is exactly
    // why the flag matters. What we assert here is the approval capture.
    expect(r.ok).toBe(false);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.kind).toBe('command');
    if (req.kind === 'command') {
      expect(req.notices).toHaveLength(1);
      expect(req.notices![0]).toContain('zero-width space');
    }
  });

  test('a clean command carries no notices', async () => {
    const seen: ApprovalRequest[] = [];
    const spy: RequestApproval = (req) => {
      seen.push(req);
      return Promise.resolve({ approved: true });
    };
    const cwd = mkdtempSync(join(tmpdir(), 'spycode-h15-'));
    const ctx: ToolContext = { cwd, limits: DEFAULT_LIMITS, requestApproval: spy };
    await dispatchTool('run_command', { command: 'echo hi' }, ctx);
    const req = seen[0]!;
    expect(req.kind).toBe('command');
    if (req.kind === 'command') expect(req.notices ?? []).toEqual([]);
  });
});
