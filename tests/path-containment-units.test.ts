import { describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canonicalize,
  containmentBound,
  isInsideReal,
  realRoot,
} from '../src/lib/path-containment.js';

/** A workspace bed: ws/ plus a secret-bearing dir outside it. */
function withBed() {
  const root = mkdtempSync(join(tmpdir(), 'spy-contain-'));
  const ws = join(root, 'ws');
  const outside = join(root, 'outside');
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'secret');
  return {
    root,
    ws,
    outside,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('canonicalize', () => {
  test('resolves an existing file to its real path', () => {
    const b = withBed();
    try {
      writeFileSync(join(b.ws, 'a.txt'), 'a');
      expect(canonicalize(join(b.ws, 'a.txt'))).toBe(join(b.ws, 'a.txt'));
    } finally {
      b.done();
    }
  });

  test('follows a symlink to where it actually points', () => {
    const b = withBed();
    try {
      symlinkSync(join(b.outside, 'secret.txt'), join(b.ws, 'link.txt'));
      expect(canonicalize(join(b.ws, 'link.txt'))).toBe(join(b.outside, 'secret.txt'));
    } finally {
      b.done();
    }
  });

  test('a DANGLING symlink is dereferenced by hand - the answer is where a write would LAND', () => {
    const b = withBed();
    try {
      // Target does not exist; existsSync-based walks treated the link's name
      // as an in-workspace tail and returned "inside".
      symlinkSync(join(b.outside, 'new-file.txt'), join(b.ws, 'dangling.txt'));
      expect(canonicalize(join(b.ws, 'dangling.txt'))).toBe(join(b.outside, 'new-file.txt'));
    } finally {
      b.done();
    }
  });

  test('a dangling link pointing inside still resolves inside', () => {
    const b = withBed();
    try {
      symlinkSync(join(b.ws, 'inner-new.txt'), join(b.ws, 'dangling-inner.txt'));
      expect(canonicalize(join(b.ws, 'dangling-inner.txt'))).toBe(join(b.ws, 'inner-new.txt'));
    } finally {
      b.done();
    }
  });

  test('a symlink cycle returns null (no information), never "inside"', () => {
    const b = withBed();
    try {
      symlinkSync(join(b.ws, 'b'), join(b.ws, 'a'));
      symlinkSync(join(b.ws, 'a'), join(b.ws, 'b'));
      expect(canonicalize(join(b.ws, 'a'))).toBeNull();
    } finally {
      b.done();
    }
  });

  test('a not-yet-existing path resolves through a symlinked parent', () => {
    const b = withBed();
    try {
      const realSub = join(b.ws, 'real-sub');
      mkdirSync(realSub);
      symlinkSync(realSub, join(b.ws, 'sub'));
      expect(canonicalize(join(b.ws, 'sub', 'new.txt'))).toBe(join(realSub, 'new.txt'));
    } finally {
      b.done();
    }
  });

  test('missing ancestors resolve through the nearest existing one with the tail re-appended', () => {
    // /tmp exists, so the ghost tail is re-joined onto the real /tmp.
    const ghost = join(tmpdir(), 'spy-contain-ghost-' + Date.now(), 'deep', 'x.txt');
    expect(canonicalize(ghost)).toBe(ghost);
  });

  test('a not-yet-existing tail is re-appended to the resolved ancestor', () => {
    const b = withBed();
    try {
      expect(canonicalize(join(b.ws, 'nope', 'nothing', 'here.txt'))).toBe(
        join(b.ws, 'nope', 'nothing', 'here.txt'),
      );
    } finally {
      b.done();
    }
  });
});

describe('realRoot', () => {
  test('resolves an existing dir', () => {
    const b = withBed();
    try {
      expect(realRoot(b.ws)).toBe(b.ws);
    } finally {
      b.done();
    }
  });

  test('returns the input unchanged when unresolvable', () => {
    const missing = join(tmpdir(), 'spy-contain-missing-' + Date.now());
    expect(realRoot(missing)).toBe(missing);
  });
});

describe('containmentBound', () => {
  test('binds the boundary once: inside → true, escape → false', () => {
    const b = withBed();
    try {
      const inside = containmentBound(b.ws);
      expect(inside(join(b.ws, 'a.txt'))).toBe(true);
      expect(inside(b.ws)).toBe(true);
      expect(inside(join(b.outside, 'secret.txt'))).toBe(false);
    } finally {
      b.done();
    }
  });

  test('a symlink inside the boundary pointing out is NOT inside', () => {
    const b = withBed();
    try {
      symlinkSync(join(b.outside, 'secret.txt'), join(b.ws, 'link.txt'));
      expect(containmentBound(b.ws)(join(b.ws, 'link.txt'))).toBe(false);
    } finally {
      b.done();
    }
  });

  test('a DANGLING symlink pointing out is NOT inside (F-N2d class)', () => {
    const b = withBed();
    try {
      symlinkSync(join(b.outside, 'new-file.txt'), join(b.ws, 'dangling.txt'));
      expect(containmentBound(b.ws)(join(b.ws, 'dangling.txt'))).toBe(false);
    } finally {
      b.done();
    }
  });

  test('unresolvable → true: no extra information, the lexical check governs', () => {
    const b = withBed();
    try {
      const real = realRoot(b.ws);
      expect(isInsideReal(real, join(b.ws, 'ghost', 'x.txt'))).toBe(true);
    } finally {
      b.done();
    }
  });
});
