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
import { createRequire } from 'node:module';
import { join, relative, extname, basename, resolve, sep } from 'node:path';
import { loadSecretGuardSync } from './secrets.js';

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
  // This reader loads file CONTENTS for token estimation, so it consults
  // the same secret guard as the file tools: a credential file (e.g.
  // credentials.json) must never have its contents read here - not even
  // for a size estimate, and even though the map surfaces no content.
  // The guard is sync (this walk is sync) and carries the `.spycoreignore`
  // layer. A secret DIRECTORY is probed the same way builtin-tools does
  // (`isSecret(join(dir, '__probe__'))`) so a whole secret tree is pruned.
  const isSecret = loadSecretGuardSync(rootDir);
  // `.gitignore` respect, via globby's sync predicate (the same matcher
  // `gitignoreCheckFor` in tool-core.ts uses). Loaded through `createRequire`
  // because globby is ESM-only and this module is sync - the same precedent
  // as session-search.ts loading `node:sqlite`. If globby cannot load, the
  // predicate degrades to "ignore nothing" (the old behavior); the secret
  // guard above still applies, so the degradation is about visibility, never
  // about credential safety.
  let isGitIgnored: (abs: string) => boolean = () => false;
  try {
    const { isGitIgnoredSync } = createRequire(import.meta.url)('globby') as typeof import('globby');
    // followSymbolicLinks: false - globby's `**/.gitignore` scan follows
    // symlinks by default and its walker has no cycle protection, so a
    // symlink escaping the tree (e.g. a link to the parent/tmp dir) makes
    // the scan descend forever and OOM the worker. The walk below refuses
    // symlinked directories (lstat check), so the scan must not follow
    // them either; a .gitignore inside a symlinked dir is unreachable to
    // the walk anyway.
    const ignored = isGitIgnoredSync({ cwd: rootDir, followSymbolicLinks: false });
    isGitIgnored = (abs: string): boolean => ignored(abs);
  } catch {
    /* gitignore unavailable - fall back to no gitignore filtering */
  }
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
      // Case-insensitive: `Node_Modules` is skipped on macOS/Windows just
      // like `node_modules` - the old exact match let a differently-cased
      // tree into the map (and its contents into token estimation).
      if (SKIP_DIRS.has(name.toLowerCase())) continue;
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
        // Secret and gitignored directories are pruned whole: descending
        // into them would read the contents the guards exist to protect.
        if (isSecret(join(full, '__probe__')) || isGitIgnored(full)) continue;
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
        // Never read a secret or gitignored file's contents, even for a
        // token estimate.
        if (isSecret(full) || isGitIgnored(full)) continue;
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
