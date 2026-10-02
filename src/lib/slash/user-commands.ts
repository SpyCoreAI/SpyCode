/**
 * User-defined slash commands — PHASE-1 1.6 feature A.
 *
 * A command is a single `.md` file; its FILENAME (minus `.md`) is the
 * invocation name. Optional frontmatter provides `description:` (parsed with
 * the skills parser — the existing hand-rolled frontmatter reader, no YAML
 * dep); a missing description falls back to the first body line. The body is
 * a prompt TEMPLATE sent as a normal chat message after:
 *
 *   1. `@path` includes — the REUSED SPYCODE.md machinery (depth-5,
 *      boundary containment, cycle guard), resolved FIRST so arguments can
 *      never trigger a file read;
 *   2. ONE single-pass substitution of `$ARGUMENTS` / `$1..$9` — inserted
 *      text is never re-scanned, so an argument containing `$1` stays
 *      literal.
 *
 * Scopes and precedence (the skills pattern):
 *   user     <configDir>/commands/<name>.md      — always loaded
 *   project  ./.spycore/commands/<name>.md       — ONLY in a TRUSTED
 *            workspace (CL1 gate); untrusted → not loaded + one notice.
 * Project wins a user collision (noticed). Built-ins ALWAYS win: the shared
 * registry dispatches built-ins first, and the loader additionally skips a
 * shadowing file with a warning so the surprise is visible.
 *
 * v1 has NO command interpolation of any kind inside templates (no !bash,
 * no backtick execution) — templates are inert text.
 *
 * The loader never throws: any unreadable/broken/oversized file degrades to
 * a skipped entry + a notice, and the session stays alive.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getConfigPath, isWorkspaceTrusted } from '../config.js';
import { parseSkillFile } from '../agent/skills.js';
import { resolveTemplateIncludes } from '../memory.js';
import { WIRE_MESSAGE_MAX_CHARS } from '../attachments.js';
import { SLASH_HELP, type SlashHelpEntry, type SlashOutcome } from './registry.js';
import { loadSecretGuardSync } from '../agent/secrets.js';
import { sanitizeForDisplay } from '../sanitize-display.js';

export interface LoadedUserCommand {
  /** Invocation name — the filename minus `.md`, validated. */
  name: string;
  description: string;
  /** Raw template body (frontmatter stripped; not yet expanded). */
  body: string;
  source: 'user' | 'project';
  /** Absolute path of the .md file (for error messages / listing). */
  path: string;
  /** Directory `@path` includes resolve FROM. */
  baseDir: string;
  /** Directory `@path` includes may not escape. */
  boundary: string;
}

export interface UserCommandLoadResult {
  commands: Map<string, LoadedUserCommand>;
  /** One-line, display-ready load diagnostics (skips, shadowing, trust). */
  notices: string[];
}

/** Command names: filename charset that is safe to type after `/`. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Built-in names (+ aliases) — these ALWAYS win a collision. */
export function builtinSlashNames(): Set<string> {
  const names = new Set<string>(['quit', 'model']);
  for (const entry of SLASH_HELP as readonly SlashHelpEntry[]) {
    const name = entry.command.replace(/^\//, '').split(/[\s<[]/)[0];
    if (name) names.add(name);
  }
  return names;
}

export function userCommandsDir(): string {
  return join(dirname(getConfigPath()), 'commands');
}

export function projectCommandsDir(cwd: string): string {
  return join(cwd, '.spycore', 'commands');
}

function scanCommandsRoot(
  root: string,
  source: 'user' | 'project',
  boundary: string,
  notices: string[],
): LoadedUserCommand[] {
  const out: LoadedUserCommand[] = [];
  let entries;
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return out;
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  const isSecret = loadSecretGuardSync(boundary);
  for (const entry of entries) {
    // No isFile() pre-filter: a directory named `x.md` (or any unreadable
    // entry) must surface a notice below, not vanish silently.
    if (!entry.name.endsWith('.md')) continue;
    const name = basename(entry.name, '.md');
    if (!NAME_RE.test(name)) {
      // `entry.name` FAILED the name check, so it is an arbitrary repository
      // filename being echoed back — sanitize before it reaches a notice sink.
      notices.push(
        `Skipped ${source} command "${sanitizeForDisplay(entry.name)}": name must match ${NAME_RE}.`,
      );
      continue;
    }
    const path = join(root, entry.name);
    // The template body is expanded into the user turn, so a `.md` symlinked at
    // a secret puts it in the model's context on invocation.
    if (isSecret(path)) {
      notices.push(`Skipped ${source} command /${name}: sensitive path.`);
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      notices.push(`Skipped ${source} command /${name}: file not readable.`);
      continue;
    }
    // The skills frontmatter parser is lenient and never throws; the
    // invocation name stays the FILENAME (predictable), frontmatter only
    // contributes the description.
    const parsed = parseSkillFile(raw, name);
    if (parsed.body.trim().length === 0) {
      notices.push(`Skipped ${source} command /${name}: empty template body.`);
      continue;
    }
    out.push({
      name,
      description: parsed.description,
      body: parsed.body,
      source,
      path,
      baseDir: dirname(path),
      boundary,
    });
  }
  return out;
}

/**
 * Discover user + project commands. Project commands load ONLY in a trusted
 * workspace; built-in names are skipped with a warning; project wins a
 * user-scope collision (noticed). Never throws.
 */
export function loadUserCommands(cwd: string): UserCommandLoadResult {
  const notices: string[] = [];
  const builtins = builtinSlashNames();
  const commands = new Map<string, LoadedUserCommand>();

  const userRoot = userCommandsDir();
  const found: LoadedUserCommand[] = scanCommandsRoot(
    userRoot,
    'user',
    dirname(userRoot),
    notices,
  );

  const projectRoot = projectCommandsDir(cwd);
  let projectPresent = false;
  try {
    projectPresent = existsSync(projectRoot) && statSync(projectRoot).isDirectory();
  } catch {
    projectPresent = false;
  }
  if (projectPresent) {
    if (isWorkspaceTrusted(cwd)) {
      found.push(...scanCommandsRoot(projectRoot, 'project', cwd, notices));
    } else {
      notices.push(
        'Project commands (.spycore/commands) not loaded — untrusted workspace. Trust it with `spycore mcp trust`.',
      );
    }
  }

  for (const cmd of found) {
    if (builtins.has(cmd.name.toLowerCase())) {
      notices.push(`Skipped ${cmd.source} command /${cmd.name}: a built-in command with that name wins.`);
      continue;
    }
    const existing = commands.get(cmd.name);
    if (existing && existing.source === 'user' && cmd.source === 'project') {
      notices.push(`Project command /${cmd.name} overrides the user-scope one.`);
    }
    commands.set(cmd.name, cmd);
  }
  return { commands, notices };
}

export interface ExpandedCommand {
  ok: true;
  message: string;
  notices: string[];
}

export interface ExpandFailure {
  ok: false;
  error: string;
}

/**
 * Expand a command template: `@path` includes FIRST (author-controlled only),
 * then ONE single-pass `$ARGUMENTS` / `$1..$9` substitution. A missing
 * positional becomes the empty string with a notice. The expanded message
 * must fit the wire cap — over-budget fails, never a silent trim.
 */
export function expandUserCommand(
  cmd: LoadedUserCommand,
  args: string[],
): ExpandedCommand | ExpandFailure {
  const { text, notices } = resolveTemplateIncludes(cmd.body, cmd.baseDir, cmd.boundary);
  const missing = new Set<string>();
  const message = text
    .replace(/\$(ARGUMENTS|[1-9])/g, (_m, token: string) => {
      if (token === 'ARGUMENTS') return args.join(' ');
      const idx = Number.parseInt(token, 10) - 1;
      const value = args[idx];
      if (value === undefined) {
        missing.add(`$${token}`);
        return '';
      }
      return value;
    })
    .trim();
  for (const m of [...missing].sort()) {
    notices.push(`No value for ${m} — substituted an empty string.`);
  }
  if (message.length === 0) {
    return { ok: false, error: `/${cmd.name} expanded to an empty message.` };
  }
  if (message.length > WIRE_MESSAGE_MAX_CHARS) {
    return {
      ok: false,
      error: `/${cmd.name} expanded to ${message.length} characters — the limit is ${WIRE_MESSAGE_MAX_CHARS}. Trim the template or its @includes.`,
    };
  }
  return { ok: true, message, notices };
}

/**
 * Build the registry's `resolveUserCommand` hook from a loaded command map.
 * Consulted only in the registry's default arm — built-ins always win.
 */
export function makeUserCommandResolver(
  commands: ReadonlyMap<string, LoadedUserCommand>,
): (name: string, args: string[]) => SlashOutcome | null {
  return (name, args) => {
    const cmd = commands.get(name);
    if (!cmd) return null;
    const expanded = expandUserCommand(cmd, args);
    if (!expanded.ok) {
      return { kind: 'user-command-error', name: cmd.name, message: expanded.error };
    }
    return {
      kind: 'user-command',
      name: cmd.name,
      source: cmd.source,
      message: expanded.message,
      notices: expanded.notices,
    };
  };
}

// ───────────────────────── slash suggestions ───────────────────────────────

export interface SlashSuggestion {
  /** Bare command name (no slash). */
  name: string;
  summary: string;
  source: 'builtin' | 'user' | 'project';
}

/** Max suggestions the TUI panel shows. */
export const SLASH_SUGGESTION_CAP = 8;

/**
 * Prefix-filtered suggestions (built-ins + loaded user commands, each with
 * its description) for the TUI panel while the user types `/name`. Empty
 * once a space is typed (the name is already chosen).
 */
export function slashSuggestions(
  input: string,
  userCommands?: ReadonlyMap<string, LoadedUserCommand>,
): SlashSuggestion[] {
  if (!input.startsWith('/') || /\s/.test(input)) return [];
  const prefix = input.slice(1).toLowerCase();
  const out: SlashSuggestion[] = [];
  for (const entry of SLASH_HELP as readonly SlashHelpEntry[]) {
    const name = entry.command.replace(/^\//, '').split(/[\s<[]/)[0] ?? '';
    if (name.toLowerCase().startsWith(prefix)) {
      out.push({ name, summary: entry.summary, source: 'builtin' });
    }
  }
  if (userCommands) {
    for (const cmd of [...userCommands.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      if (cmd.name.toLowerCase().startsWith(prefix)) {
        out.push({ name: cmd.name, summary: cmd.description, source: cmd.source });
      }
    }
  }
  return out.slice(0, SLASH_SUGGESTION_CAP);
}
