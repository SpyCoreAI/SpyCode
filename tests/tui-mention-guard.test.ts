/**
 * M3 - the @-mention / paste file check judges the RESOLVED path, not the
 * spelling. The old checks let a `notes.md -> .env` symlink read the secret
 * file into the prompt context; these tests pin the resolved-path behavior
 * of resolveMentionTarget directly (the TUI component itself is not
 * unit-testable, so the check lives in its own module).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMentionTarget } from '../src/ui/tui/mention-guard.js';

let ws: string;
let outside: string;

beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'spycode-mention-')));
  ws = join(base, 'ws');
  outside = join(base, 'outside');
  mkdirSync(ws);
  mkdirSync(outside);
  writeFileSync(join(ws, '.env'), 'API_KEY=<redacted>\n');
  writeFileSync(join(ws, 'notes.txt'), 'plain notes\n');
  writeFileSync(join(outside, 'secret.txt'), 'outside secret\n');
});

afterEach(() => {
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const check = (abs: string) => resolveMentionTarget(ws, abs, { maxBytes: 1024 });

describe('resolveMentionTarget', () => {
  test('a plain file inside the workspace passes, and is read by its lexical path', () => {
    const t = check(join(ws, 'notes.txt'));
    expect(t).not.toBeNull();
    expect(t!.realAbs).toBe(join(ws, 'notes.txt'));
    expect(t!.size).toBe(12);
  });

  test('a symlink to .env is refused', () => {
    symlinkSync(join(ws, '.env'), join(ws, 'innocent.md'));
    expect(check(join(ws, 'innocent.md'))).toBeNull();
  });

  test('a symlink to a file outside the workspace is refused', () => {
    symlinkSync(join(outside, 'secret.txt'), join(ws, 'leak.txt'));
    expect(check(join(ws, 'leak.txt'))).toBeNull();
  });

  test('a symlink to a file inside the workspace passes, resolved to its target', () => {
    symlinkSync(join(ws, 'notes.txt'), join(ws, 'alias.txt'));
    const t = check(join(ws, 'alias.txt'));
    expect(t).not.toBeNull();
    expect(t!.realAbs).toBe(join(ws, 'notes.txt'));
  });

  test('a dangling symlink is refused, never throws', () => {
    symlinkSync(join(ws, 'missing.txt'), join(ws, 'dangling.txt'));
    expect(check(join(ws, 'dangling.txt'))).toBeNull();
  });

  test('a .spycoreignore-listed file is refused by the guard layer', () => {
    writeFileSync(join(ws, '.spycoreignore'), 'notes.txt\n');
    expect(check(join(ws, 'notes.txt'))).toBeNull();
  });

  test('an oversize file is refused', () => {
    expect(resolveMentionTarget(ws, join(ws, 'notes.txt'), { maxBytes: 5 })).toBeNull();
  });
});
