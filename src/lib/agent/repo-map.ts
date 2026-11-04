/**
 * Repository map - a lightweight codebase overview.
 *
 * Provides a file tree with size/token estimates to help the agent understand
 * project structure. Not a full AST map (that's a larger project), but gives
 * the agent a useful structural overview.
 *
 * Token estimation: ~4 chars per token (rough heuristic for code).
 */

import { readdirSync, statSync, readFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, relative, extname, basename, resolve, sep } from 'node:path';

export interface RepoMapEntry {
  path: string;
  type: 'file' | 'dir';
  size?: number;
  tokens?: number;
  children?: RepoMapEntry[];
}

// Directories to skip (common ignores).
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'coverage',
  '__pycache__',
  '.venv',
  'vendor',
]);

// File extensions to include (code files).
const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp',
  '.rb', '.php', '.swift', '.kt', '.scala', '.sh', '.sql',
  '.json', '.yaml', '.yml', '.toml', '.md',
]);

export function estimateTokens(content: string): number {
  // Rough heuristic: ~4 chars per token for code.
  return Math.ceil(content.length / 4);
}

export function buildRepoMap(
  rootDir: string,
  maxDepth = 3,
  maxTokens = 8000,
): RepoMapEntry {
  const root: RepoMapEntry = { path: '.', type: 'dir', children: [] };
  let totalTokens = 0;
  // Track visited real paths to prevent symlink loops.
  const visited = new Set<string>();
  const rootReal = (() => {
    try {
      return realpathSync(rootDir);
    } catch {
      return resolve(rootDir);
    }
  })();
  visited.add(rootReal);

  function walk(dir: string, entry: RepoMapEntry, depth: number): void {
    if (depth > maxDepth || totalTokens >= maxTokens) return;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (totalTokens >= maxTokens) break;
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      const rel = relative(rootDir, full);
      // Use lstatSync (not statSync) to detect symlinks without following.
      let lstat;
      try {
        lstat = lstatSync(full);
      } catch {
        continue;
      }
      // Refuse to follow symlink directories (prevents escape + loops).
      if (lstat.isSymbolicLink()) {
        continue;
      }
      if (lstat.isDirectory()) {
        // Resolve real path and check containment + visited.
        let real: string;
        try {
          real = realpathSync(full);
        } catch {
          continue;
        }
        // Must be inside root (containment).
        if (real !== rootReal && !real.startsWith(rootReal + sep)) {
          continue;
        }
        // Skip if already visited (loop prevention).
        if (visited.has(real)) {
          continue;
        }
        visited.add(real);
        const child: RepoMapEntry = { path: rel, type: 'dir', children: [] };
        entry.children!.push(child);
        walk(full, child, depth + 1);
      } else if (lstat.isFile()) {
        const ext = extname(name).toLowerCase();
        if (!CODE_EXTS.has(ext)) continue;
        // Skip very large files.
        if (lstat.size > 200_000) continue;
        let tokens = 0;
        try {
          const content = readFileSync(full, 'utf-8');
          tokens = estimateTokens(content);
        } catch {
          continue;
        }
        // Only include if we have budget.
        if (totalTokens + tokens > maxTokens) continue;
        totalTokens += tokens;
        entry.children!.push({
          path: rel,
          type: 'file',
          size: lstat.size,
          tokens,
        });
      }
    }
  }

  walk(rootDir, root, 0);
  return root;
}

export function formatRepoMap(map: RepoMapEntry, indent = ''): string {
  const lines: string[] = [];
  const children = map.children ?? [];
  for (const child of children) {
    const name = basename(child.path);
    if (child.type === 'dir') {
      lines.push(`${indent}${name}/`);
      lines.push(formatRepoMap(child, indent + '  '));
    } else {
      const tok = child.tokens ? ` (~${child.tokens} tok)` : '';
      lines.push(`${indent}${name}${tok}`);
    }
  }
  return lines.join('\n');
}
