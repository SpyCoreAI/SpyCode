import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRepoMap, estimateTokens, formatRepoMap } from '../src/lib/agent/repo-map.js';

describe('estimateTokens', () => {
  test('is the 4-chars-per-token heuristic, rounded up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(100))).toBe(25);
  });
});

describe('buildRepoMap', () => {
  let root: string;
  const cleanup = (): void => {
    if (root) rmSync(root, { recursive: true, force: true });
  };
  afterEach(cleanup);

  function makeTree(): string {
    root = mkdtempSync(join(tmpdir(), 'spy-repomap-'));
    writeFileSync(join(root, 'index.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'README.md'), '# hi\n');
    writeFileSync(join(root, 'image.png'), 'not-code');
    mkdirSync(join(root, 'src', 'deep', 'deeper'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'const a = 1;\n');
    writeFileSync(join(root, 'src', 'deep', 'mid.ts'), 'const m = 1;\n');
    writeFileSync(join(root, 'src', 'deep', 'deeper', 'leaf.ts'), 'const l = 1;\n');
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'evil\n');
    mkdirSync(join(root, '.git'), { recursive: true });
    writeFileSync(join(root, '.git', 'config.ts'), 'secret\n');
    return root;
  }

  test('lists code files, skips non-code and ignored dirs', () => {
    const map = buildRepoMap(makeTree());
    const flat: string[] = [];
    const walk = (e: { path: string; children?: { path: string }[] }): void => {
      flat.push(e.path);
      for (const c of e.children ?? []) walk(c as never);
    };
    walk(map as never);
    expect(flat).toContain('index.ts');
    expect(flat).toContain('README.md');
    expect(flat).toContain(join('src', 'app.ts'));
    expect(flat).not.toContain('image.png');
    expect(flat).not.toContain(join('node_modules', 'pkg', 'index.js'));
    expect(flat).not.toContain(join('.git', 'config.ts'));
  });

  test('respects maxDepth', () => {
    const map = buildRepoMap(makeTree(), 2);
    const flat: string[] = [];
    const walk = (e: { path: string; children?: { path: string }[] }): void => {
      flat.push(e.path);
      for (const c of e.children ?? []) walk(c as never);
    };
    walk(map as never);
    expect(flat).toContain(join('src', 'deep', 'mid.ts'));
    expect(flat).not.toContain(join('src', 'deep', 'deeper', 'leaf.ts'));
  });

  test('refuses to follow symlinked directories', () => {
    const r = makeTree();
    symlinkSync(r, join(r, 'src', 'self-link'));
    const map = buildRepoMap(r);
    const flat: string[] = [];
    const walk = (e: { path: string; children?: { path: string }[] }): void => {
      flat.push(e.path);
      for (const c of e.children ?? []) walk(c as never);
    };
    walk(map as never);
    expect(flat).not.toContain(join('src', 'self-link'));
    // and a link pointing outside the root cannot escape either
    symlinkSync(tmpdir(), join(r, 'outside-link'));
    const map2 = buildRepoMap(r);
    const flat2: string[] = [];
    const walk2 = (e: { path: string; children?: { path: string }[] }): void => {
      flat2.push(e.path);
      for (const c of e.children ?? []) walk2(c as never);
    };
    walk2(map2 as never);
    expect(flat2).not.toContain('outside-link');
  });

  test('honours the token budget', () => {
    const r = makeTree();
    const map = buildRepoMap(r, 5, 1); // room for a single tiny file
    let tokens = 0;
    const walk = (e: { tokens?: number; children?: unknown[] }): void => {
      if (e.tokens) tokens += e.tokens;
      for (const c of (e.children ?? []) as { tokens?: number }[]) walk(c);
    };
    walk(map);
    expect(tokens).toBeLessThanOrEqual(1);
  });

  test('missing root yields an empty dir entry, never throws', () => {
    const map = buildRepoMap(join(tmpdir(), 'spy-repomap-nope-' + Date.now()));
    expect(map).toEqual({ path: '.', type: 'dir', children: [] });
  });

  test('file entries carry size and token counts', () => {
    const map = buildRepoMap(makeTree());
    const index = map.children!.find((c) => c.path === 'index.ts')!;
    expect(index.type).toBe('file');
    expect(index.size).toBeGreaterThan(0);
    expect(index.tokens).toBe(estimateTokens('export const x = 1;\n'));
  });
});

describe('formatRepoMap', () => {
  test('renders a readable indented tree', () => {
    const out = formatRepoMap({
      path: '.',
      type: 'dir',
      children: [
        { path: 'index.ts', type: 'file', size: 10, tokens: 3 },
        {
          path: 'src',
          type: 'dir',
          children: [{ path: join('src', 'app.ts'), type: 'file', size: 10, tokens: 3 }],
        },
      ],
    });
    expect(out).toContain('index.ts');
    expect(out).toContain('src/');
    expect(out).toContain('app.ts');
    expect(out).toContain('(~3 tok)');
  });

  test('accepts a custom indent', () => {
    const out = formatRepoMap({ path: '.', type: 'dir', children: [] }, '  ');
    expect(typeof out).toBe('string');
  });
});
