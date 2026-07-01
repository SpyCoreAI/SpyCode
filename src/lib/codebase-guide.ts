/**
 * CODEBASE_GUIDE.md generator — Part 2 of SpyCode's living-memory system.
 *
 * Where SPYCODE.md (Part 1) is USER-AUTHORED memory that SpyCode injects into
 * context, CODEBASE_GUIDE.md is the opposite half: a SpyCode-GENERATED, living
 * architecture reference for the END-USER's repository. It is written to the
 * user's project root (wherever they run the `spycore` CLI) so a reader — human
 * or assistant — can get oriented fast.
 *
 * This file is TOOL-OWNED: `/init` creates it (refusing to clobber an existing
 * one) and `/guide refresh` regenerates it from a fresh scan, OVERWRITING the
 * generated body. A trailing "## Notes (manual)" section is the one part that is
 * PRESERVED across refreshes, so a hand-written note survives regeneration.
 *
 * The generator reuses `repo-scan.ts` (the same scanner that powers `/init`'s
 * SPYCODE.md) — it never re-walks the tree itself. `generateCodebaseGuide` is a
 * pure function of a `RepoScan`, so it is fully testable without the filesystem;
 * the write helpers (`initCodebaseGuide` / `refreshCodebaseGuide`) are the only
 * side-effecting surface.
 *
 * NOTE: this generates CODEBASE_GUIDE.md at the USER's project root. It always
 * targets the end-user's repo — nothing here ever writes into the CLI's own
 * source tree.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { scanRepo, type RepoScan } from './repo-scan.js';

/** The tool-generated architecture reference at the user's project root. */
export const GUIDE_FILE = 'CODEBASE_GUIDE.md';

/** Heading marking the trailing region preserved across `/guide refresh`. */
export const GUIDE_NOTES_HEADING = '## Notes (manual)';
/** Boilerplate comment that opens a fresh "Notes (manual)" section. */
const GUIDE_NOTES_HINT =
  '<!-- Add durable notes BELOW this line. The "Notes (manual)" section is ' +
  'PRESERVED across `/guide refresh`; everything above it is regenerated. -->';

/** Inferred purpose for common top-level directory names (keyed WITH the `/`). */
const DIR_PURPOSES: Record<string, string> = {
  'src/': 'Application / library source code',
  'lib/': 'Library / shared modules',
  'app/': 'Application entry (routes, pages, or app shell)',
  'apps/': 'Workspace applications (monorepo)',
  'packages/': 'Workspace packages (monorepo)',
  'components/': 'Reusable UI components',
  'pages/': 'Routed pages',
  'public/': 'Static assets served as-is',
  'assets/': 'Static assets (images, fonts, …)',
  'static/': 'Static assets served as-is',
  'styles/': 'Stylesheets / design tokens',
  'tests/': 'Test suite',
  'test/': 'Test suite',
  '__tests__/': 'Test suite',
  'spec/': 'Test / specification suite',
  'e2e/': 'End-to-end tests',
  'docs/': 'Documentation',
  'doc/': 'Documentation',
  'scripts/': 'Build / maintenance / automation scripts',
  'bin/': 'Executable entry points',
  'cmd/': 'Command-line entry points',
  'config/': 'Configuration',
  'configs/': 'Configuration',
  'examples/': 'Usage examples',
  'example/': 'Usage examples',
  'dist/': 'Build output (generated)',
  'build/': 'Build output (generated)',
  'out/': 'Build output (generated)',
  'server/': 'Backend / server code',
  'client/': 'Frontend / client code',
  'api/': 'API layer',
  'routes/': 'Request routing / handlers',
  'services/': 'Service-layer modules',
  'models/': 'Data models / schemas',
  'migrations/': 'Database migrations',
  'prisma/': 'Database schema & client',
  'db/': 'Database layer',
  'utils/': 'Utility helpers',
  'helpers/': 'Helper modules',
  'hooks/': 'Reusable hooks',
  'types/': 'Shared type definitions',
  'i18n/': 'Internationalization resources',
  'locales/': 'Localization resources',
  'vendor/': 'Third-party vendored code',
  '.github/': 'CI / repository automation',
};

/** Max top-level directories listed before the table is trimmed. */
const MAX_DIRS = 40;
/** Max dependency names listed per group before a `+N more` tail. */
const MAX_DEPS = 40;

/** Build the "Run, build & test" rows from package.json scripts. */
function guideScriptRows(pkg: RepoScan['pkg']): string[] {
  if (!pkg || pkg.scripts.length === 0) {
    return ['_No package.json scripts detected. Document how to install, run, build, and test here._'];
  }
  const preferred = ['dev', 'start', 'build', 'test', 'lint', 'typecheck', 'format'];
  const rows: string[] = [];
  for (const name of preferred) {
    if (pkg.scripts.includes(name)) rows.push(`- **${name}** — \`npm run ${name}\``);
  }
  const remaining = pkg.scripts.filter((s) => !preferred.includes(s));
  if (remaining.length > 0) {
    const shown = remaining.slice(0, 12);
    const tail = remaining.length > shown.length ? `, +${remaining.length - shown.length} more` : '';
    rows.push(`- Other scripts: ${shown.map((s) => `\`${s}\``).join(', ')}${tail}`);
  }
  return rows;
}

/** Build the "Key entry points" rows from package.json + detected source files. */
function guideEntryRows(scan: RepoScan): string[] {
  const rows: string[] = [];
  const pkg = scan.pkg;
  if (pkg?.main) rows.push(`- **main:** \`${pkg.main}\``);
  if (pkg?.bin && pkg.bin.length > 0) {
    rows.push(`- **bin:** ${pkg.bin.map((b) => `\`${b}\``).join(', ')}`);
  }
  if (pkg?.exports && pkg.exports.length > 0) {
    rows.push(`- **exports:** ${pkg.exports.map((e) => `\`${e}\``).join(', ')}`);
  }
  const entries = scan.entryFiles ?? [];
  if (entries.length > 0) {
    rows.push(`- **Source entry files:** ${entries.map((e) => `\`${e}\``).join(', ')}`);
  }
  if (rows.length === 0) {
    rows.push('_No entry points found in package.json or conventional source files — note the main entry point(s) here._');
  }
  return rows;
}

/** Format one dependency group as a capped, code-spanned list. */
function formatDeps(names: string[]): string {
  const shown = names.slice(0, MAX_DEPS);
  const tail = names.length > shown.length ? `, +${names.length - shown.length} more` : '';
  return `${shown.map((n) => `\`${n}\``).join(', ')}${tail}`;
}

/** Build the "Major dependencies" rows (names only — these are the user's deps). */
function guideDependencyRows(pkg: RepoScan['pkg']): string[] {
  const runtime = pkg?.dependencies ?? [];
  const dev = pkg?.devDependencies ?? [];
  if (runtime.length === 0 && dev.length === 0) {
    return ['_No dependencies detected (no package.json, or none declared)._'];
  }
  return [
    `**Runtime (${runtime.length}):** ${runtime.length > 0 ? formatDeps(runtime) : '_none_'}`,
    '',
    `**Dev (${dev.length}):** ${dev.length > 0 ? formatDeps(dev) : '_none_'}`,
  ];
}

/**
 * Best-effort, HONEST high-level data-flow notes inferred from the directory
 * layout. When nothing recognisable is present it says so rather than inventing
 * a flow — the section is explicitly labelled high-level.
 */
function guideDataFlowRows(scan: RepoScan): string[] {
  const dirs = new Set(scan.topDirs);
  const has = (d: string): boolean => dirs.has(d);
  const obs: string[] = [];

  if (has('apps/') || has('packages/')) {
    obs.push('- Monorepo layout: workspaces under `apps/` and/or `packages/` are composed together; check the workspace manifest for how they depend on each other.');
  }
  if (has('server/') && has('client/')) {
    obs.push('- Split client/server: `client/` is the frontend and `server/` the backend; they communicate across an API boundary.');
  } else {
    if (has('server/')) obs.push('- A `server/` directory holds the backend; trace requests from its entry point through its route/handler layer.');
    if (has('client/')) obs.push('- A `client/` directory holds the frontend.');
  }
  if (has('src/')) {
    obs.push('- Most source lives under `src/`; start from the entry point(s) above and follow imports outward.');
  }
  if (has('api/') || has('routes/')) {
    obs.push('- An API/route layer is present — it is the likely inbound edge where external requests enter the system.');
  }
  if (has('services/')) {
    obs.push('- A `services/` layer suggests business logic is factored out of the entry/route layer.');
  }
  if (has('prisma/') || has('migrations/') || has('db/') || has('models/')) {
    obs.push('- A data layer is present (schema/migrations/models); persistent state flows through it.');
  }

  if (obs.length === 0) {
    return ['_High-level only: the directory layout did not reveal an obvious data flow. Describe how a request or command moves through the system — entry point → core logic → outputs/storage._'];
  }
  obs.push('');
  obs.push('_This is a high-level inference from the directory layout; refine it with the real request/data path._');
  return obs;
}

/**
 * Render the full CODEBASE_GUIDE.md from a repo scan. Pure (no filesystem),
 * SpyCore-branded, and bounded — it summarises (top dirs, scripts, dep names,
 * entry points) rather than dumping every file.
 */
export function generateCodebaseGuide(scan: RepoScan): string {
  const pkg = scan.pkg;
  const projectName = pkg?.name ?? '_this project_';
  const overview =
    (pkg?.description && pkg.description.trim()) ||
    (scan.readmeSummary && scan.readmeSummary.trim()) ||
    '_No description found in package.json or README — summarise what this project is and who uses it here._';

  const langLine =
    scan.languages.length > 0
      ? scan.languages.map((l) => `${l.lang} (${l.count})`).join(', ')
      : '_not detected_';

  const dirRows =
    scan.topDirs.length > 0
      ? scan.topDirs
          .slice(0, MAX_DIRS)
          .map((d) => `| \`${d}\` | ${DIR_PURPOSES[d] ?? '_purpose unclear — describe it_'} |`)
      : ['| _no subdirectories detected_ | |'];
  const dirsTrimmed = scan.topDirs.length > MAX_DIRS;

  const lines: string[] = [
    `# ${projectName} — Codebase Guide`,
    '',
    '> **Generated by SpyCore — a living architecture reference.**',
    '> SpyCode maintains this file from a scan of the repository so a reader (human or',
    '> assistant) can get oriented fast. Regenerate it any time with `/guide refresh`.',
    '> Everything above the "Notes (manual)" section is overwritten on refresh — put',
    '> durable hand-written notes there.',
    '',
    '## Overview',
    '',
    overview,
    '',
    `**Primary languages:** ${langLine}`,
    `**Files scanned:** ${scan.fileCount}${scan.sampled ? ' (language detection sampled the first portion)' : ''}`,
    ...(scan.keyFiles.length > 0 ? [`**Key files:** ${scan.keyFiles.join(', ')}`] : []),
    '',
    '## Run, build & test',
    '',
    ...guideScriptRows(pkg),
    '',
    '## Architecture map',
    '',
    'Top-level layout and inferred purpose:',
    '',
    '| Directory | Purpose |',
    '|---|---|',
    ...dirRows,
    ...(dirsTrimmed ? ['', `_…and ${scan.topDirs.length - MAX_DIRS} more top-level directories (list trimmed)._`] : []),
    '',
    '## Key entry points',
    '',
    ...guideEntryRows(scan),
    '',
    '## Major dependencies',
    '',
    ...guideDependencyRows(pkg),
    '',
    '## Data flow & module relationships',
    '',
    ...guideDataFlowRows(scan),
    '',
    '## Conventions',
    '',
    '_SpyCode left this section for you: capture the coding style, naming, commit/PR',
    'flow, and testing expectations a contributor should follow. (Regenerated on',
    'refresh — for durable notes use "Notes (manual)" below.)_',
    '',
    '## Gotchas',
    '',
    '_Record non-obvious traps, sharp edges, and "looks wrong but is intentional" notes',
    'here so the next reader (or SpyCode) does not relearn them the hard way._',
    '',
    GUIDE_NOTES_HEADING,
    '',
    GUIDE_NOTES_HINT,
    '',
  ];
  return `${lines.join('\n')}\n`;
}

/** Slice out the trailing "## Notes (manual)" section (heading→EOF), or null. */
function extractNotesSection(content: string): string | null {
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim() === GUIDE_NOTES_HEADING);
  if (idx === -1) return null;
  return lines.slice(idx).join('\n').replace(/\s+$/, '');
}

/** True when a Notes section holds anything beyond its heading + boilerplate. */
function notesHaveUserContent(section: string): boolean {
  const body = section
    .split('\n')
    .slice(1) // drop the heading line
    .filter((l) => {
      const t = l.trim();
      if (t.length === 0) return false; // blank
      if (t.startsWith('<!--')) return false; // boilerplate comment
      return true;
    })
    .join('')
    .trim();
  return body.length > 0;
}

/** Replace the generated Notes section with a preserved one. */
function replaceNotesSection(generated: string, oldNotes: string): string {
  const lines = generated.split('\n');
  const idx = lines.findIndex((l) => l.trim() === GUIDE_NOTES_HEADING);
  const head =
    idx === -1 ? generated.replace(/\s+$/, '') : lines.slice(0, idx).join('\n').replace(/\s+$/, '');
  return `${head}\n\n${oldNotes}\n`;
}

export interface GuideInitResult {
  /** True when a new file was written; false when one already existed. */
  created: boolean;
  /** Absolute path of the (existing or written) CODEBASE_GUIDE.md. */
  path: string;
}

/**
 * Generate `<cwd>/CODEBASE_GUIDE.md` from a repo scan. Like `initMemoryFile`, it
 * NEVER overwrites: if the file already exists, returns `{ created: false }` so
 * the caller can point the user at `/guide refresh`.
 */
export async function initCodebaseGuide(cwd: string): Promise<GuideInitResult> {
  const path = join(resolve(cwd), GUIDE_FILE);
  if (existsSync(path)) return { created: false, path };
  const scan = await scanRepo(cwd);
  writeFileSync(path, generateCodebaseGuide(scan), 'utf8');
  return { created: true, path };
}

export interface GuideRefreshResult {
  /** Absolute path of the regenerated CODEBASE_GUIDE.md. */
  path: string;
  /** True when a file was already present (and thus overwritten). */
  existed: boolean;
  /** True when a hand-written "## Notes (manual)" section was carried across. */
  preservedNotes: boolean;
}

/**
 * Regenerate `<cwd>/CODEBASE_GUIDE.md` from a FRESH scan, OVERWRITING the body —
 * correct because this file is tool-owned. A trailing "## Notes (manual)"
 * section with hand-written content is preserved across the refresh.
 */
export async function refreshCodebaseGuide(cwd: string): Promise<GuideRefreshResult> {
  const path = join(resolve(cwd), GUIDE_FILE);
  const existed = existsSync(path);

  let oldNotes: string | null = null;
  if (existed) {
    try {
      const section = extractNotesSection(readFileSync(path, 'utf8'));
      if (section && notesHaveUserContent(section)) oldNotes = section;
    } catch {
      /* unreadable — regenerate from scratch */
    }
  }

  const scan = await scanRepo(cwd);
  let content = generateCodebaseGuide(scan);
  if (oldNotes) content = replaceNotesSection(content, oldNotes);
  writeFileSync(path, content, 'utf8');
  return { path, existed, preservedNotes: oldNotes !== null };
}

export interface GuideStatus {
  /** True when CODEBASE_GUIDE.md exists at the project root. */
  exists: boolean;
  /** Absolute path it would live at. */
  path: string;
  /** Line count of the file (0 when absent). */
  lines: number;
}

/** Presence + line count of `<cwd>/CODEBASE_GUIDE.md`, for the `/guide` status. */
export function guideStatus(cwd: string): GuideStatus {
  const path = join(resolve(cwd), GUIDE_FILE);
  if (!existsSync(path)) return { exists: false, path, lines: 0 };
  let lines = 0;
  try {
    const content = readFileSync(path, 'utf8');
    lines = content.length === 0 ? 0 : content.replace(/\n$/, '').split('\n').length;
  } catch {
    /* leave lines at 0 */
  }
  return { exists: true, path, lines };
}

export interface GuideContext {
  /** True when CODEBASE_GUIDE.md exists at the project root. */
  exists: boolean;
  /** Absolute path it lives at (or would). */
  path: string;
  /** The guide text (whole file), capped to `maxChars` when given. */
  text: string;
  /** True when the char cap trimmed the text. */
  truncated: boolean;
}

/**
 * Read CODEBASE_GUIDE.md for context injection. Returns the whole file (it is
 * already a bounded summary), optionally char-capped. Never throws — an absent
 * or unreadable file yields empty defaults so injection just skips it.
 */
export function readGuideForContext(
  cwd: string,
  opts: { maxChars?: number | undefined } = {},
): GuideContext {
  const path = join(resolve(cwd), GUIDE_FILE);
  if (!existsSync(path)) return { exists: false, path, text: '', truncated: false };
  let content = '';
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return { exists: true, path, text: '', truncated: false };
  }
  let text = content.replace(/\s+$/, '');
  let truncated = false;
  if (opts.maxChars !== undefined && text.length > opts.maxChars) {
    const marker = '\n\n<!-- … truncated to fit -->';
    const room = Math.max(0, opts.maxChars - marker.length);
    text = `${text.slice(0, room).replace(/\s+$/, '')}${marker}`;
    truncated = true;
  }
  return { exists: true, path, text, truncated };
}
