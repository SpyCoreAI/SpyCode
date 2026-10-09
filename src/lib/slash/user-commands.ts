/**
 * User-defined slash commands - PHASE-1 1.6 feature A.
 *
 * A command is a single `.md` file; its FILENAME (minus `.md`) is the
 * invocation name. Optional frontmatter provides `description:` (parsed with
 * the skills parser - the existing hand-rolled frontmatter reader, no YAML
 * dep); a missing description falls back to the first body line. The body is
 * a prompt TEMPLATE sent as a normal chat message after:
 *
 *   1. `@path` includes - the REUSED SPYCODE.md machinery (depth-5,
 *      boundary containment, cycle guard), resolved FIRST so arguments can
 *      never trigger a file read;
 *   2. ONE single-pass substitution of `$ARGUMENTS` / `$1..$9` / `$NAME` -
 *      inserted text is never re-scanned, so an argument containing `$1` or
 *      `$FILE` stays literal.
 *
 * Argument forms (0.9.0 F6):
 *   $ARGUMENTS        - all positional args joined with spaces
 *   $1..$9           - positional args (missing → empty string + a notice)
 *   $NAME            - NAMED placeholders: `$` + a letter-led identifier
 *                      (`$FILE`, `$MESSAGE`, …). A value is supplied with a
 *                      `--arg NAME=value` flag (see below); a missing value
 *                      substitutes empty + a notice, exactly like $1..$9.
 *                      Matching is case-sensitive; `$ARGUMENTS` keeps its
 *                      special meaning.
 *
 * `--arg NAME=value` flags (F6):
 *   Accepted on the invocation line on BOTH surfaces - the resolver strips
 *   them before positional matching, so `spycore chat "/review
 *   --arg FILE=src/x.ts"` and the TUI input line `/review --arg FILE=src/x.ts`
 *   both work. Also accepted as `--arg=NAME=value`. Values with spaces need
 *   quotes: `--arg MESSAGE="ship it friday"`. Last `--arg` for a NAME wins.
 *   In the TUI, a missing $NAME can instead be collected through a simple
 *   input dialog - see makeUserCommandResolverAsync (the surface passes its
 *   prompt; the registry consults it via SlashContext.resolveUserCommandAsync).
 *
 * SECURITY: $NAME values are UNTRUSTED user input. Substitution is pure
 * string splicing into the chat prompt - the replacer is a FUNCTION, so `$`
 * sequences inside a value are never re-interpreted, and templates stay
 * inert text (no !bash, no backtick execution, no shell of any kind). NEVER
 * concatenate these values into shell commands; pass them as separate argv
 * entries or environment variables instead.
 *
 * Scopes and precedence (the skills pattern):
 *   user     <configDir>/commands/<name>.md      - always loaded
 *   project  ./.spycore/commands/<name>.md       - ONLY in a TRUSTED
 *            workspace (CL1 gate); untrusted → not loaded + one notice.
 * Project wins a user collision (noticed). Built-ins ALWAYS win: the shared
 * registry dispatches built-ins first, and the loader additionally skips a
 * shadowing file with a warning so the surprise is visible.
 *
 * v1 has NO command interpolation of any kind inside templates (no !bash,
 * no backtick execution) - templates are inert text.
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
  /** Invocation name - the filename minus `.md`, validated. */
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

/** Built-in names (+ aliases) - these ALWAYS win a collision. */
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
      // filename being echoed back - sanitize before it reaches a notice sink.
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
        'Project commands (.spycore/commands) not loaded - untrusted workspace. Trust it with `spycore mcp trust`.',
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
 * Named-argument values keyed by placeholder name (no `$` prefix).
 * Untrusted user input - see the SECURITY note in the module docstring.
 */
export type NamedArgValues = Record<string, string>;

/** `$NAME` placeholder names: `$` + a letter, then letters/digits/`_`. */
const NAMED_PLACEHOLDER_RE = /\$([A-Za-z][A-Za-z0-9_]*)/g;

/** One substitution token: `ARGUMENTS`, a positional digit, or a $NAME. */
const SUBSTITUTE_TOKEN_RE = /\$([A-Za-z][A-Za-z0-9_]*|[1-9])/g;

/**
 * F6: list the `$NAME` placeholders in a template (includes-resolved text),
 * unique, in first-appearance order. `$ARGUMENTS` and `$1..$9` are NOT named
 * placeholders and are skipped.
 */
export function extractNamedPlaceholders(template: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  NAMED_PLACEHOLDER_RE.lastIndex = 0;
  for (const m of template.matchAll(NAMED_PLACEHOLDER_RE)) {
    const name = m[1] ?? '';
    if (name === 'ARGUMENTS' || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export interface SplitArgsResult {
  /** Args with every `--arg` flag removed. */
  positional: string[];
  /** `NAME → value` from the flags (last flag for a NAME wins). */
  named: NamedArgValues;
  /** Display-ready diagnostics for malformed flags. */
  notices: string[];
}

/** `NAME` in `--arg NAME=value`: letter-led, letters/digits/`_`. */
const NAMED_ARG_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

function stripArgQuotes(value: string): string {
  if (value.length >= 2) {
    const q = value[0];
    if ((q === '"' || q === "'") && value[value.length - 1] === q) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * F6: split `--arg NAME=value` flags out of an invocation's arg tokens.
 *
 * Accepted forms: `--arg NAME=value`, `--arg=NAME=value`. A value containing
 * spaces must be quoted - `--arg MESSAGE="ship it friday"` - and a quoted
 * value may span the whitespace-split tokens the shell/parseSlashInput
 * produced; the closing quote ends the value. A malformed flag is dropped
 * with a notice (never silently kept as a positional, never a throw).
 */
export function splitNamedArgFlags(args: string[]): SplitArgsResult {
  const positional: string[] = [];
  const named: NamedArgValues = {};
  const notices: string[] = [];
  let i = 0;
  while (i < args.length) {
    const tok = args[i] ?? '';
    if (tok !== '--arg' && !tok.startsWith('--arg=')) {
      positional.push(tok);
      i += 1;
      continue;
    }
    let flag: string | undefined;
    if (tok === '--arg') {
      i += 1;
      flag = args[i];
      i += 1;
    } else {
      flag = tok.slice('--arg='.length);
      i += 1;
    }
    const fail = (why: string): void => {
      notices.push(`Ignoring malformed --arg flag (${why}) - expected --arg NAME=value.`);
    };
    if (flag === undefined || flag === '') {
      fail('nothing after --arg');
      continue;
    }
    // Quote-aware: a quoted value may continue into following tokens.
    const eq = flag.indexOf('=');
    if (eq !== -1) {
      const after = flag.slice(eq + 1);
      if (after.length > 0 && (after[0] === '"' || after[0] === "'")) {
        const q = after[0];
        let value = after;
        while (i < args.length && !(value.length > 1 && value.endsWith(q))) {
          value += ` ${args[i] ?? ''}`;
          i += 1;
        }
        flag = `${flag.slice(0, eq + 1)}${stripArgQuotes(value)}`;
      }
    }
    const name = eq === -1 ? flag : flag.slice(0, eq);
    const value = eq === -1 ? '' : flag.slice(eq + 1);
    if (eq === -1 || !NAMED_ARG_NAME_RE.test(name)) {
      fail(`"${flag}"`);
      continue;
    }
    named[name] = value;
  }
  return { positional, named, notices };
}

/**
 * Shared single-pass substitution over includes-resolved template text.
 * The replacer is a FUNCTION, so `$`-sequences inside substituted VALUES are
 * never re-interpreted (no double-expansion, no injection via `$1`).
 */
function substituteTokens(
  text: string,
  args: string[],
  named: NamedArgValues,
  missingPositional: Set<string>,
  missingNamed: Set<string>,
): string {
  SUBSTITUTE_TOKEN_RE.lastIndex = 0;
  return text.replace(SUBSTITUTE_TOKEN_RE, (_m, token: string) => {
    if (token === 'ARGUMENTS') return args.join(' ');
    if (/^[1-9]$/.test(token)) {
      const value = args[Number.parseInt(token, 10) - 1];
      if (value === undefined) {
        missingPositional.add(`$${token}`);
        return '';
      }
      return value;
    }
    const value = named[token];
    if (value === undefined) {
      missingNamed.add(`$${token}`);
      return '';
    }
    return value;
  });
}

/**
 * F6: obtains a `$NAME` value interactively. Return undefined to leave the
 * placeholder empty (the caller adds the missing-value notice).
 */
export type NamedArgPrompt = (
  placeholder: string,
  commandName: string,
) => Promise<string | undefined>;

/** Substitution + missing-value notices + the wire-cap gate, shared by both expanders. */
function finishExpansion(
  cmd: LoadedUserCommand,
  text: string,
  notices: string[],
  args: string[],
  named: NamedArgValues,
): ExpandedCommand | ExpandFailure {
  const missingPositional = new Set<string>();
  const missingNamed = new Set<string>();
  const message = substituteTokens(text, args, named, missingPositional, missingNamed).trim();
  for (const m of [...missingPositional].sort()) {
    notices.push(`No value for ${m} - substituted an empty string.`);
  }
  for (const m of [...missingNamed].sort()) {
    const name = m.slice(1);
    notices.push(`No value for ${m} - substituted an empty string (supply with --arg ${name}=value).`);
  }
  if (message.length === 0) {
    return { ok: false, error: `/${cmd.name} expanded to an empty message.` };
  }
  if (message.length > WIRE_MESSAGE_MAX_CHARS) {
    return {
      ok: false,
      error: `/${cmd.name} expanded to ${message.length} characters - the limit is ${WIRE_MESSAGE_MAX_CHARS}. Trim the template or its @includes.`,
    };
  }
  return { ok: true, message, notices };
}

/**
 * Expand a command template: `@path` includes FIRST (author-controlled only),
 * then ONE single-pass `$ARGUMENTS` / `$1..$9` / `$NAME` substitution.
 * `namedArgs` supplies `$NAME` values (`--arg` flags feed here via the
 * resolver). A missing positional or named value becomes the empty string
 * with a notice. The expanded message must fit the wire cap - over-budget
 * fails, never a silent trim.
 */
export function expandUserCommand(
  cmd: LoadedUserCommand,
  args: string[],
  namedArgs: NamedArgValues = {},
): ExpandedCommand | ExpandFailure {
  const { text, notices } = resolveTemplateIncludes(cmd.body, cmd.baseDir, cmd.boundary);
  return finishExpansion(cmd, text, notices, args, namedArgs);
}

/**
 * F6: async variant of expandUserCommand. Every `$NAME` placeholder with no
 * value in `namedArgs` is offered to `prompt` (in first-appearance order);
 * a prompt returning undefined/empty leaves the placeholder empty + a
 * notice. The TUI passes a prompt backed by its input dialog.
 */
export async function expandUserCommandWithPrompt(
  cmd: LoadedUserCommand,
  args: string[],
  namedArgs: NamedArgValues,
  prompt: NamedArgPrompt,
): Promise<ExpandedCommand | ExpandFailure> {
  const { text, notices } = resolveTemplateIncludes(cmd.body, cmd.baseDir, cmd.boundary);
  const filled: NamedArgValues = { ...namedArgs };
  for (const name of extractNamedPlaceholders(text)) {
    if (filled[name] !== undefined) continue;
    const value = await prompt(name, cmd.name);
    if (value !== undefined && value !== '') filled[name] = value;
  }
  return finishExpansion(cmd, text, notices, args, filled);
}

/**
 * Build the registry's `resolveUserCommand` hook from a loaded command map.
 * Consulted only in the registry's default arm - built-ins always win.
 *
 * F6: `--arg NAME=value` flags are stripped from `args` here (positional
 * matching never sees them) and feed `$NAME` substitution, on both
 * surfaces - no surface-side parsing needed. Malformed-flag notices are
 * appended to a successful outcome's notices, or prefixed onto an
 * expansion error.
 */
export function makeUserCommandResolver(
  commands: ReadonlyMap<string, LoadedUserCommand>,
): (name: string, args: string[]) => SlashOutcome | null {
  return (name, args) => {
    const cmd = commands.get(name);
    if (!cmd) return null;
    const { positional, named, notices: flagNotices } = splitNamedArgFlags(args);
    const expanded = expandUserCommand(cmd, positional, named);
    if (!expanded.ok) {
      const flagPrefix = flagNotices.length > 0 ? `${flagNotices.join(' ')} ` : '';
      return { kind: 'user-command-error', name: cmd.name, message: `${flagPrefix}${expanded.error}` };
    }
    return {
      kind: 'user-command',
      name: cmd.name,
      source: cmd.source,
      message: expanded.message,
      notices: [...flagNotices, ...expanded.notices],
    };
  };
}

/**
 * F6: async variant of makeUserCommandResolver for surfaces that can prompt.
 * Missing `$NAME` values are collected through `prompt` (the TUI wires its
 * input dialog here); omit `prompt` and it behaves exactly like the sync
 * resolver. Returns the registry's `resolveUserCommandAsync` hook.
 */
export function makeUserCommandResolverAsync(
  commands: ReadonlyMap<string, LoadedUserCommand>,
  prompt?: NamedArgPrompt,
): (name: string, args: string[]) => Promise<SlashOutcome | null> {
  return async (name, args) => {
    const cmd = commands.get(name);
    if (!cmd) return null;
    const { positional, named, notices: flagNotices } = splitNamedArgFlags(args);
    const expanded = prompt
      ? await expandUserCommandWithPrompt(cmd, positional, named, prompt)
      : expandUserCommand(cmd, positional, named);
    if (!expanded.ok) {
      const flagPrefix = flagNotices.length > 0 ? `${flagNotices.join(' ')} ` : '';
      return { kind: 'user-command-error', name: cmd.name, message: `${flagPrefix}${expanded.error}` };
    }
    return {
      kind: 'user-command',
      name: cmd.name,
      source: cmd.source,
      message: expanded.message,
      notices: [...flagNotices, ...expanded.notices],
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
