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

function readJsonFile(path: string): unknown | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
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

function skillImportItem(srcDir: string, destDir: string, scope: 'user' | 'project'): ImportItem {
  const name = basename(srcDir);
  const srcFile = join(srcDir, 'SKILL.md');
  const destFile = join(destDir, 'SKILL.md');
  const targetLabel = `${scope === 'user' ? 'user' : 'project'} skill ${name}`;
  let status: ImportItem['status'] = 'new';
  let detail = `new → ${destDir}`;
  if (existsSync(destFile)) {
    try {
      const same = readFileSync(srcFile, 'utf8') === readFileSync(destFile, 'utf8');
      if (same) {
        status = 'identical';
        detail = 'already imported (identical) - skip';
      } else {
        status = 'conflict';
        detail = `target exists with different content - skip (use --force to overwrite)`;
      }
    } catch {
      status = 'conflict';
      detail = 'target exists and could not be compared - skip (use --force to overwrite)';
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
      mkdirSync(destDir, { recursive: true });
      cpSync(srcDir, destDir, { recursive: true, force: true });
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

function mcpImportItem(server: McpServerConfig, scope: 'user' | 'project', cwd: string): ImportItem {
  const existing = readScope(scope, cwd).find((s) => s.name === server.name);
  let status: ImportItem['status'] = 'new';
  let detail = `new ${scope}-scope MCP server "${server.name}" (${server.command})`;
  if (existing) {
    const same = JSON.stringify({ ...existing, scope: undefined }) === JSON.stringify({ ...server, scope: undefined });
    if (same) {
      status = 'identical';
      detail = `"${server.name}" already configured identically - skip`;
    } else {
      status = 'conflict';
      detail = `"${server.name}" already configured differently - skip (use --force to overwrite)`;
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
      items.push(skillImportItem(dir, dest, scope));
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
      items.push(mcpImportItem(mapped, scope, cwd));
    }
  }

  // Memory: ~/.claude/CLAUDE.md → durable MEMORY.md.
  const claudeMdPath = join(home, '.claude', 'CLAUDE.md');
  if (existsSync(claudeMdPath)) {
    try {
      const item = memoryImportItem(readFileSync(claudeMdPath, 'utf8'), claudeMdPath, configDir);
      if (item) items.push(item);
    } catch {
      /* unreadable - skip */
    }
  }

  return { source: 'claude-code', items };
}

/** Build the import plan for --from-dir: any directory of <name>/SKILL.md. Exported for tests. */
export function planFromDir(dir: string, cwd: string): ImportPlan {
  const root = dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir;
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new SpycoreCliError(`--from-dir "${dir}" is not a directory.`, EXIT_USER_ERROR);
  }
  const items = listSubdirs(root)
    .filter((d) => !basename(d).startsWith('.'))
    .filter((d) => existsSync(join(d, 'SKILL.md')))
    .map((d) => skillImportItem(d, join(userSkillsDir(), basename(d)), 'user'));
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
          plan = planFromDir(opts.fromDir, cwd);
        } else if (source === 'claude-code') {
          plan = planClaudeCode(cwd, opts.includeProject === true);
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
            `${counts.new} new, ${counts.identical} already-imported, ${counts.conflict} conflict${counts.conflict === 1 ? '' : 's'} (skipped without --force).`,
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
