/**
 * Local agent skills: discovery, lenient SKILL.md parsing, and the compact
 * catalog injected into the agent system prompt.
 *
 * A skill is a directory containing SKILL.md - YAML-ish frontmatter with
 * `name:` and `description:` followed by the instruction body. Two roots:
 *   project  ./.spycore/skills/<name>/SKILL.md   (cwd-relative)
 *   user     <configDir>/skills/<name>/SKILL.md  (global)
 * On a name collision the PROJECT skill wins. Both roots are optional; with
 * zero skills the catalog is the empty string and the agent prompt is
 * byte-identical to before skills existed.
 *
 * Parsing is deliberately hand-rolled and lenient (no YAML dep): a missing
 * name falls back to the directory name, a missing description to the first
 * non-empty body line. Discovery never throws - unreadable entries are
 * skipped. Works identically on every provider (the catalog rides in the
 * system prompt; load_skill is a plain read-only tool).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigPath, isWorkspaceTrusted } from '../config.js';
import { loadSecretGuardSync } from './secrets.js';

export interface DiscoveredSkill {
  /** Unique lookup key (frontmatter `name:`, else the directory name). */
  name: string;
  /** One-line description for the catalog. */
  description: string;
  source: 'project' | 'user';
  /** Absolute path to SKILL.md - discovered by the CLI, never model input. */
  path: string;
}

/** Cap on the catalog section appended to the system prompt. */
export const SKILLS_CATALOG_CAP = 4096;
/** Cap on a single catalog description line. */
const DESCRIPTION_CAP = 160;

export function userSkillsDir(): string {
  return join(dirname(getConfigPath()), 'skills');
}

export function projectSkillsDir(cwd: string): string {
  return join(cwd, '.spycore', 'skills');
}

/** Strip matching surrounding quotes from a frontmatter value. */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function oneLine(s: string, cap = DESCRIPTION_CAP): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

export interface ParsedSkillFile {
  name: string;
  description: string;
  /** The instruction body (frontmatter removed). */
  body: string;
}

/**
 * Lenient SKILL.md parse. Frontmatter is the block between a leading `---`
 * line and the next `---` line; inside it only simple `key: value` lines are
 * read (quotes stripped). Missing name → `fallbackName`; missing description →
 * the first non-empty body line (heading markers stripped).
 */
export function parseSkillFile(raw: string, fallbackName: string): ParsedSkillFile {
  let body = raw;
  const fm: Record<string, string> = {};
  const fmMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    const lines = (fmMatch[1] ?? '').split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(lines[i] as string);
      if (!kv) continue;
      const key = (kv[1] as string).toLowerCase();
      let value = unquote(kv[2] ?? '');
      // YAML block scalar (`description: |` / `>` …): the value is the
      // following indented lines, joined. Lenient - indentation just means
      // "starts with whitespace".
      if (/^[|>][+-]?$/.test(value)) {
        const collected: string[] = [];
        while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1] as string)) {
          collected.push((lines[i + 1] as string).trim());
          i += 1;
        }
        value = collected.join(' ');
      }
      fm[key] = value;
    }
  }
  const name = (fm.name ?? '').trim() || fallbackName;
  let description = (fm.description ?? '').trim();
  if (description.length === 0) {
    const firstLine = body
      .split(/\r?\n/)
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l.length > 0);
    description = firstLine ?? '(no description)';
  }
  return { name, description: oneLine(description), body: body.replace(/^\s*\n/, '') };
}

/** Scan one root for `<dir>/SKILL.md` entries. Unreadable entries are skipped. */
function scanRoot(root: string, source: 'project' | 'user'): DiscoveredSkill[] {
  const out: DiscoveredSkill[] = [];
  let dirents;
  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) return out;
    dirents = readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  // A SKILL.md is a repository-supplied path. Its parsed DESCRIPTION lands in
  // the system prompt before any tool call, and `load_skill` later returns its
  // whole body - so an unguarded read here leaks twice over.
  const isSecret = loadSecretGuardSync(root);
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const file = join(root, d.name, 'SKILL.md');
    try {
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      if (isSecret(file)) continue;
      const raw = readFileSync(file, 'utf8');
      const parsed = parseSkillFile(raw, d.name);
      out.push({ name: parsed.name, description: parsed.description, source, path: file });
    } catch {
      /* skip unreadable skill */
    }
  }
  return out;
}

/**
 * Discover all installed skills for a run. Project skills override user-global
 * ones on name collision. Sorted by name. Never throws - any failure degrades
 * to fewer (or zero) skills.
 */
/** Options for {@link discoverSkills}. */
export interface DiscoverSkillsOpts {
  /**
   * Management commands (`spycore skills list/show/remove`, `skills-create`)
   * pass true: the user explicitly invoked skill management, so every skill
   * is visible regardless of workspace trust. The agent run leaves this
   * unset - project skills load only from trusted workspaces, the same
   * trust gate project MCP servers and project hooks go through.
   */
  includeUntrustedProject?: boolean;
}

/**
 * Every installed skill, user roots first so a project skill of the same
 * name wins. Project skills (`.spycore/skills/` under the cwd) are
 * repo-supplied content that injects into the system prompt, so they are
 * trust-gated like project MCP servers and project hooks: from an untrusted
 * workspace they are skipped unless `includeUntrustedProject` is set.
 */
export function discoverSkills(cwd: string, opts: DiscoverSkillsOpts = {}): DiscoveredSkill[] {
  const byName = new Map<string, DiscoveredSkill>();
  for (const s of scanRoot(userSkillsDir(), 'user')) byName.set(s.name, s);
  const projectTrusted = opts.includeUntrustedProject === true || isWorkspaceTrusted(cwd);
  if (projectTrusted) {
    for (const s of scanRoot(projectSkillsDir(cwd), 'project')) byName.set(s.name, s); // project wins
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether the cwd holds project skills that the trust gate is currently
 * withholding - the agent loop uses this to say so out loud instead of
 * silently running without them.
 */
export function hasWithheldProjectSkills(cwd: string): boolean {
  if (isWorkspaceTrusted(cwd)) return false;
  return scanRoot(projectSkillsDir(cwd), 'project').length > 0;
}

/**
 * The compact `# Skills` section for the agent system prompt - '' when no
 * skills are installed (the prompt is then byte-identical to pre-skills).
 * Capped at SKILLS_CATALOG_CAP: full `- name: description` entries while they
 * fit, then a names-only overflow line so every skill stays loadable by name.
 */
export function buildSkillsCatalog(skills: DiscoveredSkill[]): string {
  if (skills.length === 0) return '';
  const header =
    '\n\n# Skills\nInstalled skill guides (reusable instructions). When one is clearly relevant to the TASK, call load_skill with its exact name FIRST and follow the loaded instructions.\n';
  let out = header;
  let i = 0;
  for (; i < skills.length; i += 1) {
    const s = skills[i] as DiscoveredSkill;
    const entry = `- ${s.name}: ${s.description}\n`;
    if (out.length + entry.length > SKILLS_CATALOG_CAP) break;
    out += entry;
  }
  if (i < skills.length) {
    const rest = skills.slice(i).map((s) => s.name);
    let namesLine = `…plus ${rest.length} more, loadable by exact name: `;
    let shown = 0;
    for (const n of rest) {
      const piece = `${shown > 0 ? ', ' : ''}${n}`;
      if (namesLine.length + piece.length > 500) break;
      namesLine += piece;
      shown += 1;
    }
    if (shown < rest.length) namesLine += `, +${rest.length - shown} more`;
    out += `${namesLine}\n`;
  }
  return out.replace(/\n$/, '');
}
