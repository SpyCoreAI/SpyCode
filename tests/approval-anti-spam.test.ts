/**
 * H-4 - approval anti-spam: when an approval is rejected, the feedback the
 * model gets tells it not to emit new variants of the same action (each
 * variant opens another approval card for the user).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  APPROVAL_ANTI_SPAM_TEXT,
  type RequestApproval,
} from '../src/lib/agent/approval.js';
import { DEFAULT_LIMITS, dispatchTool, type ToolContext } from '../src/lib/agent/tools.js';

const REJECT: RequestApproval = () => Promise.resolve({ approved: false, reason: 'rejected by user' });
const ctx = (cwd: string): ToolContext => ({ cwd, limits: DEFAULT_LIMITS, requestApproval: REJECT });

describe('H-4 approval anti-spam', () => {
  test('the constant names the mechanism', () => {
    expect(APPROVAL_ANTI_SPAM_TEXT).toContain('another approval card');
  });

  test('a rejected write carries the anti-spam line', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'spycode-h4-'));
    const r = await dispatchTool('write_file', { path: 'skip.txt', content: 'nope' }, ctx(cwd));
    expect(r.ok).toBe(false);
    expect(r.content).toContain(APPROVAL_ANTI_SPAM_TEXT);
  });

  test('a rejected command carries the anti-spam line', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'spycode-h4-'));
    const r = await dispatchTool('run_command', { command: 'echo hi' }, ctx(cwd));
    expect(r.ok).toBe(false);
    expect(r.content).toContain(APPROVAL_ANTI_SPAM_TEXT);
  });
});
