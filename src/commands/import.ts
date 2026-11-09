/**
 * A-3 - `spycore import`: zero-friction migration from competing tools.
 *
 * Imports skills, MCP servers, and agent memory from Claude Code (and any
 * directory of SKILL.md skills via --from-dir) into SpyCode's own stores:
 *   skills  ~/.claude/skills/<name>/  →  <configDir>/skills/<name>/
 *   mcp     ~/.claude.json mcpServers →  user-scope MCP servers
 *   memory  ~/.claude/CLAUDE.md       →  durable MEMORY.md (H-7)
 * Project-scoped sources (./.claude/*) map to ./.spycore/* with
 * --include-project.
 *
 * Two safety properties, both load-bearing:
 * 1. PREVIEW FIRST - without --apply nothing is written; the command prints
 *    exactly what it would do (the hermes `import-agent --dry-run` shape).
 * 2. NEVER OVERWRITE WITHOUT EXPLICIT CONFIRMATION - an item whose target
 *    already exists with different content is SKIPPED and reported; only
 *    --force overwrites. Identical content is reported as already-imported.
 */
import { Command, Option } from 'commander';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { EXIT_USER_ERROR, SpycoreCliError } from '../lib/errors.js';
import { formatOption, getOutputOptions, info, json, print, resolveFormat, success, warn } from '../lib/output.js';
import { sanitizeForDisplay } from '../lib/sanitize-display.js';
import { projectSkillsDir, userSkillsDir } from '../lib/agent/skills.js';
import { isValidServerName, readScope, writeScope, type McpServerConfig } from '../lib/agent/mcp-config.js';
import {
  appendDurableMemoryRaw,
  DURABLE_MEMORY_FILE,
  readDurableFile,
} from '../lib/agent/durable-memory.js';

type ImportKind = 'skill' | 'mcp-server' | 'memory';

interface ImportItem {
  kind: ImportKind;
  /** Display name (skill name / server name / 'agent memory'). */
  name: string;
  /** Where it comes from (human-readable). */
  source: string;
  /** Where it would go (human-readable). */
  target: string;
  /** 'new' | 'identical' | 'conflict' */
  status: 'new' | 'identical' | 'conflict';
  /** One-line status detail for the preview. */
  detail: string;
  /** Perform the import. Throws on failure. */
  apply: () => string;
}

interface ImportPlan {
  source: string;
  items: ImportItem[];
}

/** 1 MB per-file read cap, matching the skill-discovery cap (R3-14). */
const IMPORT_READ_CAP_BYTES = 1_048_576;

function readJsonFile(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null;
    // R3-9: stat-size guard (1 MB, the discovery cap) before reading - a
    // crafted ~/.claude.json used to be read whole into memory.
    if (statSync(path).size > IMPORT_READ_CAP_BYTES) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/**
 * Read a text file only when its size is at or under the import cap;
 * null when missing, unreadable, or over the cap. The callers treat null
 * as "could not be compared/read" (R3-9), never as empty content.
 */
function readCappedTextFile(path: string): string | null {
  try {
    if (statSync(path).size > IMPORT_READ_CAP_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Bound on one skill-directory copy: a crafted --from-dir pack can be multi-GB. */
const IMPORT_COPY_MAX_BYTES = 10 * 1_048_576;
const IMPORT_COPY_MAX_FILES = 1_000;

/**
 * Measure a skill directory WITHOUT following symlinks (a symlink's target
 * size is not copied - cpSync copies the link itself). Totals stop
 * accumulating past the bounds: the caller only needs to know "over".
 */
function measureSkillDir(srcDir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const stack = [srcDir];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > IMPORT_COPY_MAX_FILES * 2 + 100) return { files, bytes };
      const p = join(dir, e.name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // the link itself is copied, not its target
      if (st.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (st.isFile()) {
        files += 1;
        bytes += st.size;
      }
    }
  }
  return { files, bytes };
}

/** Absolute paths of every immediate subdirectory of `root` ([] when missing). */
function listSubdirs(root: string): string[] {
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(root, d.name));
  } catch {
    return [];
  }
}

/** Scan a skill directory for entries the copy will carry over verbatim: symlinks and executable files (scripts). Bounded (500 entries) so a pathological tree cannot stall the plan. */
function scanRiskySkillEntries(srcDir: string): {
  executables: string[];
  symlinks: string[];
  executableCount: number;
  symlinkCount: number;
} {
  const out = {
    executables: [] as string[],
    symlinks: [] as string[],
    executableCount: 0,
    symlinkCount: 0,
  };
  const stack = [srcDir];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > 500) return out;
      const p = join(dir, e.name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        out.symlinkCount += 1;
        if (out.symlinks.length < 5) out.symlinks.push(e.name);
        continue;
      }
      if (st.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (st.isFile() && (st.mode & 0o111) !== 0) {
        out.executableCount += 1;
        if (out.executables.length < 5) out.executables.push(e.name);
      }
    }
  }
  return out;
}

function skillImportItem(srcDir: string, destDir: string, scope: 'user' | 'project', force = false): ImportItem {
  const name = basename(srcDir);
  const srcFile = join(srcDir, 'SKILL.md');
  const destFile = join(destDir, 'SKILL.md');
  const targetLabel = `${scope === 'user' ? 'user' : 'project'} skill ${name}`;
  // Whole-directory copies used to carry scripts and symlinks over with no
  // warning at all - surface them in the preview detail and again at apply.
  const risky = scanRiskySkillEntries(srcDir);
  const riskyNote =
    risky.executableCount > 0 || risky.symlinkCount > 0
      ? ` - WARNING: copies ${risky.executableCount} executable file(s) and ${risky.symlinkCount} symlink(s) as-is - review them before applying`
      : '';
  let status: ImportItem['status'] = 'new';
  let detail = `new → ${destDir}${riskyNote}`;
  // R3-9: the copy is bounded (see apply) - surface an oversize pack in
  // the preview so --apply does not surprise the user with a refusal.
  const pack = measureSkillDir(srcDir);
  const packOverBound =
    pack.files > IMPORT_COPY_MAX_FILES || pack.bytes > IMPORT_COPY_MAX_BYTES;
  const packNote = packOverBound
    ? ` - WARNING: skill pack is ${pack.files} file(s) / ${pack.bytes} bytes, over the import bound (${IMPORT_COPY_MAX_FILES} files / ${IMPORT_COPY_MAX_BYTES} bytes) - apply will refuse it`
    : '';
  detail += packNote;
  if (existsSync(destFile)) {
    // R3-9: capped compare - the whole SKILL.md used to be read twice
    // (source + dest) with no size guard. An over-cap file cannot be
    // compared, so it lands in the conflict branch like an unreadable one.
    const srcText = readCappedTextFile(srcFile);
    const destText = readCappedTextFile(destFile);
    if (srcText === null || destText === null) {
      status = 'conflict';
      detail = force
        ? `target exists and could not be compared - will overwrite with --force${riskyNote}${packNote}`
        : `target exists and could not be compared - skip (use --force to overwrite)${riskyNote}${packNote}`;
    } else if (srcText === destText) {
      status = 'identical';
      detail = `already imported (identical) - skip${riskyNote}${packNote}`;
    } else {
      status = 'conflict';
      detail = force
        ? `target exists with different content - will overwrite with --force${riskyNote}${packNote}`
        : `target exists with different content - skip (use --force to overwrite)${riskyNote}${packNote}`;
    }
  }
  return {
    kind: 'skill',
    name,
    source: srcDir,
    target: targetLabel,
    status,
    detail,
    apply: () => {
      // R3-9: bound the copy BEFORE cpSync - a crafted skill pack from
      // --from-dir (an arbitrary directory) can be multi-GB, and the old
      // code copied it whole. Fail closed, naming the bound.
      if (packOverBound) {
        throw new SpycoreCliError(
          `Refusing to import skill "${name}": ${pack.files} file(s) / ${pack.bytes} bytes exceeds the import bound (${IMPORT_COPY_MAX_FILES} files / ${IMPORT_COPY_MAX_BYTES} bytes).`,
          EXIT_USER_ERROR,
          'Trim the skill directory and retry.',
        );
      }
      mkdirSync(destDir, { recursive: true });
      cpSync(srcDir, destDir, { recursive: true, force: true });
      if (risky.executableCount > 0 || risky.symlinkCount > 0) {
        const shown = [...risky.executables, ...risky.symlinks].join(', ');
        const extra =
          risky.executableCount + risky.symlinkCount > risky.executables.length + risky.symlinks.length
            ? ', …'
            : '';
        warn(
          `imported skill "${sanitizeForDisplay(name)}" copied ${risky.executableCount} executable file(s) and ${risky.symlinkCount} symlink(s) as-is (${sanitizeForDisplay(shown)}${extra}) - review them.`,
        );
      }
      return `skill "${name}" → ${scope} scope`;
    },
  };
}

interface ClaudeMcpEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  type?: unknown;
}

/** Map one Claude Code mcpServers entry to a SpyCode server config (or null when unusable). Exported for tests. */
export function mapClaudeMcpServer(name: string, entry: ClaudeMcpEntry): McpServerConfig | null {
  if (!isValidServerName(name)) return null;
  if (entry.type !== undefined && entry.type !== 'stdio') return null; // remote shapes differ - skip loudly
  if (typeof entry.command !== 'string' || entry.command.length === 0) return null;
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : [];
  const env: McpServerConfig['env'] =
    entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env)
      ? Object.entries(entry.env as Record<string, unknown>)
          .filter(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string')
          .map(([k, v]) => ({ name: k, value: v as string }))
      : undefined;
  return {
    name,
    type: 'stdio',
    command: entry.command,
    ...(args.length > 0 ? { args } : {}),
    ...(env && env.length > 0 ? { env } : {}),
  };
}

/** JSON with object keys sorted recursively, so two configs that differ only in key order compare equal. JSON.stringify is order-sensitive and used to report identical servers as conflicts. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function mcpImportItem(server: McpServerConfig, scope: 'user' | 'project', cwd: string, force = false): ImportItem {
  const existing = readScope(scope, cwd).find((s) => s.name === server.name);
  let status: ImportItem['status'] = 'new';
  let detail = `new ${scope}-scope MCP server "${server.name}" (${server.command})`;
  if (existing) {
    const same = stableStringify({ ...existing, scope: undefined }) === stableStringify({ ...server, scope: undefined });
    if (same) {
      status = 'identical';
      detail = `"${server.name}" already configured identically - skip`;
    } else {
      status = 'conflict';
      detail = force
        ? `"${server.name}" already configured differently - will overwrite with --force`
        : `"${server.name}" already configured differently - skip (use --force to overwrite)`;
    }
  }
  return {
    kind: 'mcp-server',
    name: server.name,
    source: `Claude Code mcpServers`,
    target: `${scope}-scope MCP server "${server.name}"`,
    status,
    detail,
    apply: () => {
      const list = readScope(scope, cwd).filter((s) => s.name !== server.name);
      list.push(server);
      list.sort((a, b) => a.name.localeCompare(b.name));
      writeScope(scope, cwd, list);
      return `MCP server "${server.name}" → ${scope} scope`;
    },
  };
}

const MEMORY_IMPORT_MARKER = '<!-- imported from Claude Code CLAUDE.md -->';

function memoryImportItem(claudeMd: string, sourcePath: string, configDir?: string): ImportItem | null {
  const body = claudeMd.trim();
  if (body.length === 0) return null;
  const current = readDurableFile('memory', configDir);
  if (current.includes(MEMORY_IMPORT_MARKER)) {
    return {
      kind: 'memory',
      name: 'agent memory',
      source: sourcePath,
      target: `durable ${DURABLE_MEMORY_FILE}`,
      status: 'identical',
      detail: 'CLAUDE.md already imported (marker present) - skip',
      apply: () => 'agent memory already imported - skipped',
    };
  }
  const section = `${MEMORY_IMPORT_MARKER}\n## From Claude Code (${sourcePath})\n\n${body}`;
  // Appending is never destructive, so an existing MEMORY.md is not a
  // conflict - the marker above keeps re-imports idempotent. Conflicts
  // (and --force) are for items that would OVERWRITE user data.
  return {
    kind: 'memory',
    name: 'agent memory',
    source: sourcePath,
    target: `durable ${DURABLE_MEMORY_FILE}`,
    status: 'new',
    detail:
      current.trim().length > 0
        ? `appends below the existing content of ${DURABLE_MEMORY_FILE}`
        : `new → appended to ${DURABLE_MEMORY_FILE}`,
    apply: () => {
      appendDurableMemoryRaw('memory', section, configDir);
      return `agent memory → durable ${DURABLE_MEMORY_FILE}`;
    },
  };
}

/** Build the import plan for the `claude-code` adapter. `home`/`configDir` are injectable for tests. */
export function planClaudeCode(
  cwd: string,
  includeProject: boolean,
  home: string = homedir(),
  configDir?: string,
  force = false,
): ImportPlan {
  const items: ImportItem[] = [];

  // Skills: ~/.claude/skills (user) [+ ./.claude/skills (project)].
  const skillRoots: Array<{ root: string; scope: 'user' | 'project' }> = [
    { root: join(home, '.claude', 'skills'), scope: 'user' },
  ];
  if (includeProject) skillRoots.push({ root: join(cwd, '.claude', 'skills'), scope: 'project' });
  for (const { root, scope } of skillRoots) {
    for (const dir of listSubdirs(root)) {
      const skillName = basename(dir);
      if (skillName.startsWith('.')) continue; // never import dotfile dirs
      if (!existsSync(join(dir, 'SKILL.md'))) continue;
      const dest = join(scope === 'user' ? userSkillsDir() : projectSkillsDir(cwd), skillName);
      items.push(skillImportItem(dir, dest, scope, force));
    }
  }

  // MCP servers: ~/.claude.json [+ ./.claude.json].
  const mcpFiles: Array<{ file: string; scope: 'user' | 'project' }> = [
    { file: join(home, '.claude.json'), scope: 'user' },
  ];
  if (includeProject) mcpFiles.push({ file: join(cwd, '.claude.json'), scope: 'project' });
  for (const { file, scope } of mcpFiles) {
    const parsed = readJsonFile(file) as { mcpServers?: Record<string, ClaudeMcpEntry> } | null;
    const servers = parsed?.mcpServers;
    if (!servers || typeof servers !== 'object') continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== 'object') continue;
      const mapped = mapClaudeMcpServer(name, entry);
      if (!mapped) {
        warn(`skipping MCP server "${sanitizeForDisplay(name)}" from ${file} - unsupported shape (only stdio command entries import)`);
        continue;
      }
      items.push(mcpImportItem(mapped, scope, cwd, force));
    }
  }

  // Memory: ~/.claude/CLAUDE.md → durable MEMORY.md.
  const claudeMdPath = join(home, '.claude', 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    // R3-9: capped read (1 MB) - the file used to be read whole.
    const claudeMd = readCappedTextFile(claudeMdPath);
    if (claudeMd !== null) {
      try {
        const item = memoryImportItem(claudeMd, claudeMdPath, configDir);
        if (item) items.push(item);
      } catch {
        /* unreadable - skip */
      }
    }
  }

  return { source: 'claude-code', items };
}

/**
 * Resolve a --from-dir path: only a bare `~` or a `~/...` prefix expands to
 * the home directory. Any other `~` prefix (e.g. `~other/x`) is a literal
 * path - the old code treated every `~` prefix as $HOME + rest, so `~other/x`
 * silently became $HOME/other/x.
 */
export function resolveFromDirRoot(dir: string, home: string = homedir()): string {
  if (dir === '~') return home;
  if (dir.startsWith('~/')) return join(home, dir.slice(2));
  return dir;
}

/** Build the import plan for --from-dir: any directory of <name>/SKILL.md. Exported for tests. */
export function planFromDir(dir: string, cwd: string, force = false): ImportPlan {
  const root = resolveFromDirRoot(dir);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new SpycoreCliError(`--from-dir "${dir}" is not a directory.`, EXIT_USER_ERROR);
  }
  const items = listSubdirs(root)
    .filter((d) => !basename(d).startsWith('.'))
    .filter((d) => existsSync(join(d, 'SKILL.md')))
    .map((d) => skillImportItem(d, join(userSkillsDir(), basename(d)), 'user', force));
  return { source: `--from-dir ${dir}`, items };
}

export function registerImportCommand(program: Command): void {
  program
    .command('import')
    .description('Import skills, MCP servers and agent memory from competing tools (default: Claude Code)')
    .argument('[source]', 'Source adapter: "claude-code" (default)', 'claude-code')
    .addOption(formatOption())
    .addOption(new Option('--from-dir <path>', 'Generic adapter: import <name>/SKILL.md skill dirs from any directory'))
    .addOption(new Option('--apply', 'Actually write the imported data (default is a dry-run preview)'))
    .addOption(new Option('--force', 'Overwrite existing user data on conflicts (default: skip conflicts)'))
    .addOption(new Option('--include-project', 'Also import project-scoped items (./.claude/* → ./.spycore/*)'))
    .action(
      (
        source: string,
        opts: { format?: string; fromDir?: string; apply?: boolean; force?: boolean; includeProject?: boolean },
      ) => {
        const cwd = process.cwd();
        let plan: ImportPlan;
        if (opts.fromDir) {
          plan = planFromDir(opts.fromDir, cwd, opts.force === true);
        } else if (source === 'claude-code') {
          plan = planClaudeCode(cwd, opts.includeProject === true, undefined, undefined, opts.force === true);
        } else {
          throw new SpycoreCliError(
            `Unknown import source "${source}".`,
            EXIT_USER_ERROR,
            'Supported: "claude-code", or use --from-dir <path> for any SKILL.md directory.',
          );
        }

        const counts = {
          new: plan.items.filter((i) => i.status === 'new').length,
          identical: plan.items.filter((i) => i.status === 'identical').length,
          conflict: plan.items.filter((i) => i.status === 'conflict').length,
        };

        if (resolveFormat(opts.format) === 'json' || getOutputOptions().json) {
          if (!opts.apply) {
            json({
              source: plan.source,
              dryRun: true,
              items: plan.items.map((i) => ({
                kind: i.kind,
                name: i.name,
                source: i.source,
                target: i.target,
                status: i.status,
                detail: i.detail,
              })),
              counts,
            });
            return;
          }
        }

        if (plan.items.length === 0) {
          info(
            opts.fromDir
              ? `Nothing to import from ${opts.fromDir} (no <name>/SKILL.md directories found).`
              : 'Nothing found to import (no Claude Code skills, MCP servers, or CLAUDE.md).',
          );
          if (resolveFormat(opts.format) === 'json' || getOutputOptions().json) json({ source: plan.source, imported: 0, skipped: 0, counts });
          return;
        }

        // Preview (dry-run) first - nothing is written without --apply.
        if (!opts.apply) {
          print(`Import preview from ${plan.source} (dry-run - nothing was written; re-run with --apply):`);
          print('');
          for (const item of plan.items) {
            const mark = item.status === 'new' ? '+' : item.status === 'identical' ? '=' : '!';
            print(
              `  [${mark}] ${sanitizeForDisplay(item.kind)} ${sanitizeForDisplay(item.name)}: ${sanitizeForDisplay(item.detail)}`,
            );
          }
          print('');
          print(
            `${counts.new} new, ${counts.identical} already-imported, ${counts.conflict} conflict${counts.conflict === 1 ? '' : 's'}${opts.force ? ' (overwritten with --force).' : ' (skipped without --force).'}`,
          );
          return;
        }

        // Apply: new items always; conflicts only with --force.
        let imported = 0;
        let skipped = 0;
        const applied: string[] = [];
        for (const item of plan.items) {
          if (item.status === 'identical') {
            skipped += 1;
            continue;
          }
          if (item.status === 'conflict' && !opts.force) {
            skipped += 1;
            warn(`skipped ${item.kind} "${sanitizeForDisplay(item.name)}": ${sanitizeForDisplay(item.detail)}`);
            continue;
          }
          try {
            applied.push(item.apply());
            imported += 1;
          } catch (err) {
            skipped += 1;
            warn(
              `failed to import ${item.kind} "${sanitizeForDisplay(item.name)}": ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (resolveFormat(opts.format) === 'json' || getOutputOptions().json) {
          json({ source: plan.source, imported, skipped, counts, applied });
          return;
        }
        success(`Imported ${imported} item${imported === 1 ? '' : 's'}${skipped > 0 ? `, skipped ${skipped}` : ''}.`);
        for (const a of applied) print(`  + ${sanitizeForDisplay(a)}`);
      },
    );
}
