/**
 * Lightweight, structured repository scanner.
 *
 * This mirrors the technique the agent's `repo_map` tool uses (gitignore-aware
 * globbing via `globby`, the same node_modules/.git/build/dist exclusions, and
 * extension-based language detection) but returns STRUCTURED data rather than a
 * pre-formatted string, so the `/init` SPYCODE.md generator can lay the facts
 * out in its own template.
 *
 * It is deliberately standalone (it does NOT import `agent/tools.ts`) so the
 * lightweight chat/memory path never drags the agent runtime — secrets guard,
 * diff engine, skills loader — into the bundle just to list directories. The
 * scanning approach is kept byte-compatible with `repo_map` so the two stay in
 * agreement about what a project looks like.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/** Directories never worth scanning — mirrors agent/tools.ts ALWAYS_IGNORE_NAMES. */
const IGNORE_NAMES = new Set(['node_modules', '.git', 'build', 'dist']);
/** Glob ignores mirroring IGNORE_NAMES (for the globby walk). */
const IGNORE_GLOBS = [
  '**/node_modules',
  '**/node_modules/**',
  '**/.git',
  '**/.git/**',
  '**/build',
  '**/build/**',
  '**/dist',
  '**/dist/**',
];

/** Extension → human language name. Mirrors agent/tools.ts EXT_LANG. */
const EXT_LANG: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.mts': 'TypeScript', '.cts': 'TypeScript',
  '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.rb': 'Ruby', '.java': 'Java',
  '.kt': 'Kotlin', '.swift': 'Swift', '.c': 'C', '.h': 'C', '.cpp': 'C++', '.cc': 'C++',
  '.cs': 'C#', '.php': 'PHP', '.scala': 'Scala', '.sh': 'Shell', '.bash': 'Shell',
  '.json': 'JSON', '.md': 'Markdown', '.mdx': 'Markdown', '.css': 'CSS', '.scss': 'CSS',
  '.html': 'HTML', '.vue': 'Vue', '.svelte': 'Svelte', '.yml': 'YAML', '.yaml': 'YAML',
  '.sql': 'SQL', '.prisma': 'Prisma', '.toml': 'TOML', '.proto': 'Protobuf',
};

/** Common project-root marker files surfaced in the architecture map. */
const KEY_FILES = [
  'package.json', 'pnpm-workspace.yaml', 'README.md', 'README',
  'tsconfig.json', 'pyproject.toml', 'requirements.txt', 'go.mod',
  'Cargo.toml', 'Gemfile', 'pom.xml', 'build.gradle', 'Makefile',
  'Dockerfile', 'docker-compose.yml', '.gitignore',
];

/** Upper bound on the file walk so a giant tree can't stall `/init`. */
const SCAN_SAMPLE_CAP = 8000;

/** README filenames probed (in order) for a fallback project overview. */
const README_NAMES = ['README.md', 'README.markdown', 'README'];
/** Cap on the extracted README overview snippet. */
const README_SUMMARY_CAP = 500;

/**
 * Conventional source entry points, checked by existence relative to the root.
 * Bounded + deterministic — file-based only (never directories) so a directory
 * sharing one of these names can't masquerade as an entry point.
 */
const ENTRY_CANDIDATES = [
  'src/index.ts', 'src/index.tsx', 'src/index.js', 'src/index.mjs',
  'src/main.ts', 'src/main.tsx', 'src/main.js',
  'index.ts', 'index.tsx', 'index.js', 'index.mjs',
  'main.ts', 'main.js',
  'src/main.py', 'src/__main__.py', 'main.py', '__main__.py', 'app.py',
  'main.go', 'cmd/main.go',
  'src/main.rs', 'src/lib.rs',
  'app/page.tsx', 'app/layout.tsx', 'pages/index.tsx', 'pages/_app.tsx',
];

export interface PackageInfo {
  name?: string | undefined;
  description?: string | undefined;
  /** Script names from package.json, in declaration order. */
  scripts: string[];
  /** package.json `main` entry, when it is a string. */
  main?: string | undefined;
  /** `bin` command names — object keys, or the package name for a string bin. */
  bin?: string[] | undefined;
  /** `exports` subpath keys, or `['.']` for a single string export. */
  exports?: string[] | undefined;
  /** Runtime dependency names, in declaration order. */
  dependencies?: string[] | undefined;
  /** Dev dependency names, in declaration order. */
  devDependencies?: string[] | undefined;
}

export interface RepoScan {
  cwd: string;
  /** Top-level directory names, each with a trailing '/', sorted. */
  topDirs: string[];
  /** Top-level file names, sorted. */
  topFiles: string[];
  /** Detected languages by file count, most-used first (max 6). */
  languages: Array<{ lang: string; count: number }>;
  /** Total non-ignored files discovered. */
  fileCount: number;
  /** True when the walk was capped at SCAN_SAMPLE_CAP for language detection. */
  sampled: boolean;
  /** Which KEY_FILES are present at the root. */
  keyFiles: string[];
  /** Parsed package.json facts, when one exists at the root. */
  pkg?: PackageInfo | undefined;
  /** First meaningful paragraph of the root README, when present. */
  readmeSummary?: string | undefined;
  /** Conventional source entry files detected at the root (relative paths). */
  entryFiles?: string[] | undefined;
}

function topLanguages(extCount: Map<string, number>): Array<{ lang: string; count: number }> {
  const byLang = new Map<string, number>();
  for (const [ext, count] of extCount) {
    const lang = EXT_LANG[ext];
    if (!lang) continue;
    byLang.set(lang, (byLang.get(lang) ?? 0) + count);
  }
  return [...byLang.entries()]
    .map(([lang, count]) => ({ lang, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);
}

/** Keys of a plain (non-array) object, or [] for anything else. */
function objectKeys(value: unknown): string[] {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>)
    : [];
}

function readPackageInfo(cwd: string): PackageInfo | undefined {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return undefined;
  try {
    const pj = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
      name?: unknown;
      description?: unknown;
      scripts?: Record<string, unknown>;
      main?: unknown;
      bin?: unknown;
      exports?: unknown;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const scripts = pj.scripts && typeof pj.scripts === 'object' ? Object.keys(pj.scripts) : [];
    const name = typeof pj.name === 'string' ? pj.name : undefined;

    // bin: a string maps the package name to one command; an object lists its keys.
    let bin: string[] | undefined;
    if (typeof pj.bin === 'string') bin = [name ?? '(default)'];
    else if (objectKeys(pj.bin).length > 0) bin = objectKeys(pj.bin);

    // exports: a string is the single '.' entry; an object lists its subpath keys.
    let exportsKeys: string[] | undefined;
    if (typeof pj.exports === 'string') exportsKeys = ['.'];
    else if (objectKeys(pj.exports).length > 0) exportsKeys = objectKeys(pj.exports);

    return {
      name,
      description: typeof pj.description === 'string' ? pj.description : undefined,
      scripts,
      main: typeof pj.main === 'string' ? pj.main : undefined,
      bin,
      exports: exportsKeys,
      dependencies: objectKeys(pj.dependencies),
      devDependencies: objectKeys(pj.devDependencies),
    };
  } catch {
    return undefined;
  }
}

/**
 * Best-effort first meaningful paragraph of the root README, for a fallback
 * project overview. Skips the H1 title, badge lines, and raw-HTML wrappers, then
 * collects the first prose paragraph and caps it. Never throws.
 */
function readReadmeSummary(cwd: string): string | undefined {
  for (const fileName of README_NAMES) {
    const p = join(cwd, fileName);
    if (!existsSync(p)) continue;
    let raw: string;
    try {
      raw = readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
    const para: string[] = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (para.length === 0) {
        if (t.length === 0) continue; // leading blank lines
        if (t.startsWith('#')) continue; // headings (title / section)
        if (t.startsWith('![') || t.startsWith('[![')) continue; // badge images
        if (t.startsWith('<') && t.endsWith('>')) continue; // raw-HTML wrapper lines
        para.push(t);
      } else {
        if (t.length === 0 || t.startsWith('#')) break; // end of the paragraph
        para.push(t);
      }
    }
    const text = para.join(' ').replace(/\s+/g, ' ').trim();
    if (text.length === 0) return undefined;
    return text.length > README_SUMMARY_CAP
      ? `${text.slice(0, README_SUMMARY_CAP).trimEnd()}…`
      : text;
  }
  return undefined;
}

/** Conventional source entry files that actually exist as files at the root. */
function detectEntryFiles(cwd: string): string[] {
  return ENTRY_CANDIDATES.filter((c) => {
    const abs = join(cwd, c);
    try {
      return existsSync(abs) && statSync(abs).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * Scan `cwd` and return a compact, structured overview. Gitignore-aware and
 * bounded. Never throws — a fully unreadable directory degrades to an empty
 * scan with whatever facts could be gathered.
 */
export async function scanRepo(cwd: string): Promise<RepoScan> {
  const { isGitIgnoredSync, globby } = await import('globby');
  let ignored: (p: string) => boolean;
  try {
    ignored = isGitIgnoredSync({ cwd });
  } catch {
    ignored = () => false;
  }

  const topDirs: string[] = [];
  const topFiles: string[] = [];
  try {
    for (const d of readdirSync(cwd, { withFileTypes: true })) {
      if (IGNORE_NAMES.has(d.name)) continue;
      if (ignored(join(cwd, d.name))) continue;
      if (d.isDirectory()) topDirs.push(`${d.name}/`);
      else topFiles.push(d.name);
    }
  } catch {
    /* unreadable cwd — leave the lists empty */
  }
  topDirs.sort((a, b) => a.localeCompare(b));
  topFiles.sort((a, b) => a.localeCompare(b));

  let all: string[] = [];
  try {
    all = await globby(['**/*'], {
      cwd,
      gitignore: true,
      dot: false,
      onlyFiles: true,
      ignore: IGNORE_GLOBS,
      suppressErrors: true,
    });
  } catch {
    all = [];
  }
  const sample = all.slice(0, SCAN_SAMPLE_CAP);
  const extCount = new Map<string, number>();
  for (const f of sample) {
    const ext = extname(f).toLowerCase();
    if (ext) extCount.set(ext, (extCount.get(ext) ?? 0) + 1);
  }

  return {
    cwd,
    topDirs,
    topFiles,
    languages: topLanguages(extCount),
    fileCount: all.length,
    sampled: all.length > sample.length,
    keyFiles: KEY_FILES.filter((k) => existsSync(join(cwd, k))),
    pkg: readPackageInfo(cwd),
    readmeSummary: readReadmeSummary(cwd),
    entryFiles: detectEntryFiles(cwd),
  };
}
