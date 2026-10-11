/**
 * H-14 - the skill authoring standard, enforced by automated catalog tests.
 *
 * A SKILL.md passes the standard when:
 * 1. `description` is at most 60 chars, ONE sentence, ends with a period,
 *    and carries no marketing words (it is a trigger line, not an ad).
 * 2. The body names the agent's NATIVE tools in backticks (read_file,
 *    run_command, …) - never the shell utilities the agent wraps
 *    (`grep` the command when the `grep` tool exists).
 * 3. The platforms gate: a skill shipping `scripts/` must declare
 *    `platforms:` in its frontmatter, limited to darwin/linux/win32.
 * 4. The body carries the standard structure: a "When to Use" section and
 *    a "Verification" section.
 * 5. The skill name is kebab-case (the discovery contract).
 *
 * `validateSkillAuthoring` is pure - `spycore skills lint` runs it over the
 * installed catalog and the tests run it over fixtures + the `skills
 * create` template output.
 */
import { validateSkillName } from '../skills-create.js';

/** Max chars for the frontmatter description (the catalog trigger line). */
export const SKILL_DESCRIPTION_MAX_CHARS = 60;

/** Marketing words that never belong in a trigger line. */
export const MARKETING_WORDS = [
  'ultimate',
  'powerful',
  'revolutionary',
  'seamless',
  'cutting-edge',
  'best-in-class',
  'best in class',
  'world-class',
  'world class',
  'game-changing',
  'game changing',
  'blazing',
  'supercharge',
  'unleash',
  'next-gen',
  'next gen',
  'state-of-the-art',
  'state of the art',
  'effortless',
  'magical',
  'amazing',
  'incredible',
];

/** The agent's native tools a skill body should reference (backticked). */
export const NATIVE_TOOL_NAMES = [
  'read_file',
  'list_dir',
  'glob',
  'grep',
  'repo_map',
  'diagnostics',
  'load_skill',
  'web_search',
  'fetch_url',
  'write_file',
  'edit_file',
  'run_command',
  'memory',
  'session_search',
  'delegate',
] as const;

/**
 * Shell utilities the agent already wraps as native tools: naming the bare
 * utility in backticks (without the native counterpart) teaches the model
 * the long way round.
 */
const SHELL_UTIL_TO_NATIVE: Record<string, string> = {
  grep: 'grep',
  sed: 'edit_file',
  awk: 'edit_file',
  find: 'glob',
  curl: 'fetch_url',
  wget: 'fetch_url',
  xargs: 'run_command',
  jq: 'read_file',
};

/** Platforms a skill's `scripts/` may claim. */
export const SKILL_PLATFORMS = ['darwin', 'linux', 'win32'] as const;

/** Headings the standard structure requires (case-insensitive match). */
export const REQUIRED_SECTIONS = ['when to use', 'verification'] as const;

export interface SkillAuthoringInput {
  /** Frontmatter `name:` (or the directory name fallback). */
  name: string;
  /** Frontmatter `description:`. */
  description: string;
  /** The markdown body (frontmatter removed). */
  body: string;
  /** Parsed frontmatter (lowercased keys). */
  frontmatter: Record<string, string>;
  /** True when the skill ships a `scripts/` directory. */
  hasScripts: boolean;
}

/** One standard violation. */
export interface SkillStandardFinding {
  /** Stable rule id (e.g. 'description-length'). */
  rule: string;
  /** Human-readable explanation. */
  message: string;
}

/** Parse the simple `key: value` frontmatter of a SKILL.md (lenient, no YAML dep). */
export function parseSkillFrontmatter(raw: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return fm;
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!kv) continue;
    let v = (kv[2] ?? '').trim();
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
      v = v.slice(1, -1).trim();
    }
    fm[(kv[1] as string).toLowerCase()] = v;
  }
  return fm;
}

/**
 * Check one skill against the authoring standard. Pure - returns every
 * violation found ([] when the skill passes).
 */
export function validateSkillAuthoring(input: SkillAuthoringInput): SkillStandardFinding[] {
  const findings: SkillStandardFinding[] = [];
  const desc = input.description.trim();

  // 1. description: length, one sentence, trailing period, no marketing.
  if (desc.length === 0) {
    findings.push({ rule: 'description-present', message: 'the frontmatter needs a `description:` - one trigger sentence' });
  } else {
    if (desc.length > SKILL_DESCRIPTION_MAX_CHARS) {
      findings.push({
        rule: 'description-length',
        message: `description is ${desc.length} chars (max ${SKILL_DESCRIPTION_MAX_CHARS}) - shorten to one trigger sentence`,
      });
    }
    const body = desc.endsWith('.') ? desc.slice(0, -1) : desc;
    if (/[.!?]/.test(body)) {
      findings.push({
        rule: 'description-sentence',
        message: 'description must be ONE sentence - no interior periods, exclamations, or questions',
      });
    }
    if (!desc.endsWith('.')) {
      findings.push({ rule: 'description-period', message: 'description must end with a period' });
    }
    const lowered = ` ${desc.toLowerCase()} `;
    for (const w of MARKETING_WORDS) {
      if (lowered.includes(` ${w} `) || lowered.includes(` ${w}.`) || lowered.includes(` ${w},`)) {
        findings.push({
          rule: 'description-marketing',
          message: `description reads like marketing ("${w}") - describe the trigger, not the hype`,
        });
        break;
      }
    }
  }

  // 2. native-tool references (backticked) + the shell-utility trap.
  const nativeMentioned = new Set<string>();
  for (const t of NATIVE_TOOL_NAMES) {
    if (input.body.includes(`\`${t}\``)) nativeMentioned.add(t);
  }
  if (nativeMentioned.size === 0) {
    findings.push({
      rule: 'native-tool-reference',
      message: `the body never names a native tool in backticks (e.g. \`read_file\`, \`run_command\`) - name the tools the agent should use`,
    });
  }
  const backticked = new Set<string>();
  for (const m of input.body.matchAll(/`([a-z0-9_-]+)`/gi)) backticked.add((m[1] as string).toLowerCase());
  for (const [util, native] of Object.entries(SHELL_UTIL_TO_NATIVE)) {
    if (backticked.has(util) && !nativeMentioned.has(native)) {
      findings.push({
        rule: 'shell-utility-instead-of-native',
        message: `the body reaches for the shell utility \`${util}\` - reference the native \`${native}\` tool instead`,
      });
    }
  }

  // 3. the platforms gate: scripts/ ⇒ frontmatter `platforms:`.
  if (input.hasScripts) {
    const platforms = (input.frontmatter['platforms'] ?? '').trim();
    if (platforms.length === 0) {
      findings.push({
        rule: 'platforms-gate',
        message: 'the skill ships `scripts/` but the frontmatter declares no `platforms:` - list the OSes the scripts run on (darwin, linux, win32)',
      });
    } else {
      const bad = platforms
        .split(/[,\s]+/)
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p.length > 0 && !(SKILL_PLATFORMS as readonly string[]).includes(p));
      if (bad.length > 0) {
        findings.push({
          rule: 'platforms-values',
          message: `unknown platforms: ${bad.join(', ')} (allowed: ${SKILL_PLATFORMS.join(', ')})`,
        });
      }
    }
  }

  // 4. the standard structure.
  const headings = new Set<string>();
  for (const m of input.body.matchAll(/^#{1,4}\s+(.+?)\s*$/gim)) {
    headings.add((m[1] as string).trim().toLowerCase());
  }
  for (const required of REQUIRED_SECTIONS) {
    if (![...headings].some((h) => h === required || h.endsWith(` ${required}`) || h.startsWith(`${required} `))) {
      findings.push({
        rule: 'structure-section',
        message: `the body has no "${required}" section - follow the standard structure (When to Use / … / Verification)`,
      });
    }
  }

  // 5. the name contract.
  const nameProblem = validateSkillName(input.name);
  if (nameProblem) {
    findings.push({ rule: 'name-shape', message: `skill name: ${nameProblem}` });
  }

  return findings;
}
