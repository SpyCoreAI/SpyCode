/**
 * `spycore skills create` support: name derivation/validation, collision
 * checks against every source that could own a skill name, the generation
 * prompts, defensive output parsing (fence-stripping), the validation floor
 * with its single auto-retry, and the atomic write.
 *
 * Generation is a plain provider `streamChat` call — NOT a runAgent run: the
 * agent's tools are sandboxed to the cwd so they could never write the
 * user-global skills dir, and skill generation is a one-shot writing task,
 * not repo exploration. Everything here is pure logic + filesystem over the
 * provider seam, so it works identically on the SpyCore backend and every
 * BYOK adapter (regeneration rides the same conversation: server-side history
 * for SpyCore, adapter-kept history for BYOK).
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  discoverSkills,
  parseSkillFile,
  projectSkillsDir,
  userSkillsDir,
  type ParsedSkillFile,
} from './agent/skills.js';
import { officialSkillNames } from './skills-sync.js';
import type { Provider } from './providers/types.js';
import { EXIT_USER_ERROR, SpycoreCliError } from './errors.js';

/** Hard cap on a skill name (an explicit --name may use the full length). */
export const MAX_NAME_LENGTH = 64;
/** Cap on a name DERIVED from the description (kept short for readability). */
export const DERIVED_NAME_CAP = 40;
/** Validation floor: the generated body must have at least this many non-empty lines. */
export const MIN_BODY_LINES = 20;

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Derive a kebab-case skill name from the description: lowercase, strip
 * non-alphanumerics, join words with dashes, and truncate at a word boundary
 * to DERIVED_NAME_CAP. Returns '' when the description has no usable words
 * (the caller errors and asks for --name).
 */
export function deriveSkillName(description: string): string {
  const words = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  let out = '';
  for (const w of words) {
    const next = out.length === 0 ? w : `${out}-${w}`;
    if (next.length > DERIVED_NAME_CAP) break;
    out = next;
  }
  // A single overlong first word: hard-truncate rather than give up.
  if (out.length === 0 && words.length > 0) {
    out = (words[0] as string).slice(0, DERIVED_NAME_CAP).replace(/-+$/, '');
  }
  return out;
}

/** Validate a skill name; returns a human-readable problem or null when valid. */
export function validateSkillName(name: string): string | null {
  if (name.length === 0) return 'the name is empty';
  if (name.length > MAX_NAME_LENGTH) {
    return `the name is too long (${name.length} chars; max ${MAX_NAME_LENGTH})`;
  }
  if (!NAME_RE.test(name)) {
    return 'the name must be kebab-case: lowercase letters/digits in dash-separated words (e.g. redis-caching-patterns)';
  }
  return null;
}

/**
 * Refuse any name that something already owns. Three sources, all checked:
 *   1. The sync ledger (.sync.json) — even when the file is missing, because
 *      the next `skills sync` would rewrite that name and clobber ours.
 *   2. Discovered skills (project + user), matched by catalog name.
 *   3. An existing `<root>/<name>/` directory under either root — covers
 *      dirs discovery skipped (unreadable / missing SKILL.md). Never overwrite.
 * Returns a description of the collision, or null when the name is free.
 */
export function checkSkillNameCollision(name: string, cwd: string): string | null {
  if (officialSkillNames().has(name)) {
    return `"${name}" is an official skill (managed by \`spycore skills sync\`)`;
  }
  const existing = discoverSkills(cwd).find((s) => s.name === name);
  if (existing) {
    return `a ${existing.source} skill named "${name}" already exists`;
  }
  for (const root of [userSkillsDir(), projectSkillsDir(cwd)]) {
    if (existsSync(join(root, name))) {
      return `the directory ${join(root, name)} already exists`;
    }
  }
  return null;
}

/** Absolute SKILL.md path the new skill will be written to. */
export function skillTargetFile(name: string, cwd: string, project: boolean): string {
  return join(project ? projectSkillsDir(cwd) : userSkillsDir(), name, 'SKILL.md');
}

/** Atomic write (tmp + rename), creating the skill dir. Ensures a trailing newline. */
export function writeSkillFileAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content.endsWith('\n') ? content : `${content}\n`, 'utf8');
  renameSync(tmp, file);
}

/**
 * Defensive parse: models sometimes wrap the whole file in a markdown fence
 * despite instructions. Strip ONE balanced outer fence pair (any info string);
 * inner fences (code examples) are untouched. Content without an outer fence
 * passes through unchanged apart from trimming.
 */
export function stripFences(raw: string): string {
  let t = raw.trim();
  const open = /^```[^\n]*\n/.exec(t);
  if (open && t.endsWith('```')) {
    t = t.slice(open[0].length, t.length - 3).trim();
  }
  return t;
}

export type SkillContentValidation =
  | { ok: true; parsed: ParsedSkillFile }
  | { ok: false; error: string };

/**
 * Validate generated SKILL.md content before anything is written:
 * frontmatter present, an explicit `description:` field, `name:` exactly the
 * requested name (parsed with a sentinel fallback so a missing name can't
 * masquerade as a match), and a body of at least MIN_BODY_LINES non-empty
 * lines. Error strings are written to be fed back to the model on retry.
 */
export function validateSkillContent(content: string, expectedName: string): SkillContentValidation {
  const fmMatch = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!fmMatch) {
    return {
      ok: false,
      error:
        'missing YAML frontmatter — the file must START with a `---` line, contain `name:` and `description:`, then a closing `---` line',
    };
  }
  if (!/^description[ \t]*:/m.test(fmMatch[1] ?? '')) {
    return { ok: false, error: 'the frontmatter has no `description:` field' };
  }
  const parsed = parseSkillFile(content, '');
  if (parsed.name !== expectedName) {
    return {
      ok: false,
      error: `the frontmatter \`name:\` must be exactly "${expectedName}" (got "${parsed.name || '(empty)'}")`,
    };
  }
  const bodyLines = parsed.body.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
  if (bodyLines < MIN_BODY_LINES) {
    return {
      ok: false,
      error: `the body is too short (${bodyLines} non-empty lines; need at least ${MIN_BODY_LINES}) — expand the guidance with concrete patterns, examples and pitfalls`,
    };
  }
  return { ok: true, parsed };
}

// ───────────────────────── generation prompts ─────────────────────────

/** System prompt for skill generation (identity-safe: no provider/model names). */
export const SKILL_GEN_SYSTEM = `You are an expert technical writer producing an "agent skill": a reusable SKILL.md instruction guide that an autonomous coding agent loads on demand when a task matches the skill's topic.

Output rules (strict):
- Output ONLY the complete SKILL.md file content — no preamble, no commentary, no surrounding code fences.
- The file starts with YAML frontmatter:
---
name: <the exact skill name you are given>
description: <1-2 lines, trigger-rich: what the skill covers AND when an agent should load it — name the concrete tasks, keywords and situations>
---
- Then a markdown body containing, in order:
  1. A short overview of the topic.
  2. "When to use" — the concrete task triggers.
  3. Core guidance — the key patterns, decisions and steps, with concrete code examples where applicable.
  4. Pitfalls — common mistakes and how to avoid them.
- Be specific and actionable; prefer concrete commands and code over generic advice.
- Target 100-400 lines.`;

export function buildCreateMessage(name: string, description: string): string {
  return `Write the skill now.

Skill name (the frontmatter \`name:\` must be EXACTLY this): ${name}
Topic: ${description}

Output only the complete SKILL.md content, starting with the opening \`---\` line.`;
}

export function buildRetryMessage(error: string): string {
  return `That output failed validation: ${error}.
Output the corrected COMPLETE SKILL.md content again — only the file, starting with the opening \`---\` line.`;
}

export function buildFeedbackMessage(feedback: string): string {
  return `The user reviewed the skill and asked for changes: "${feedback}"
Revise it and output the COMPLETE revised SKILL.md content — only the file, starting with the opening \`---\` line.`;
}

// ───────────────────────── generation over the provider seam ─────────────────────────

/** Everything one generation conversation needs; provider-agnostic. */
export interface GenerationSession {
  provider: Provider;
  conversationId: string;
  /** Wire model id — a SpyCore slug or a BYOK model id. */
  model: string;
  apiUrlOverride?: string | undefined;
  signal?: AbortSignal | undefined;
}

/** Stream one assistant reply and return the full text (errors throw). */
async function streamText(
  session: GenerationSession,
  message: string,
  system: string | undefined,
): Promise<string> {
  let text = '';
  for await (const ev of session.provider.streamChat({
    conversationId: session.conversationId,
    message,
    system,
    model: session.model,
    apiUrlOverride: session.apiUrlOverride,
    signal: session.signal,
  })) {
    if (ev.type === 'text') text += ev.text;
    else if (ev.type === 'error') throw new SpycoreCliError(ev.message, EXIT_USER_ERROR);
    else if (ev.type === 'done') break;
  }
  return text;
}

export interface GeneratedSkill {
  /** The fence-stripped, validated SKILL.md content. */
  content: string;
  parsed: ParsedSkillFile;
  /** True when the single validation retry was needed. */
  retried: boolean;
}

/**
 * One generation cycle: send `message`, defensively parse, validate; on a
 * validation failure auto-retry ONCE with the error appended (same
 * conversation), then fail clearly. `firstTurn` sends the generation system
 * prompt — set it only on the very first message of a fresh conversation
 * (stateless BYOK adapters remember it per session; SpyCore folds it into the
 * first message server-side).
 */
export async function generateValidSkill(
  session: GenerationSession,
  name: string,
  message: string,
  opts: { firstTurn?: boolean; onStatus?: (note: string) => void } = {},
): Promise<GeneratedSkill> {
  const first = stripFences(await streamText(session, message, opts.firstTurn ? SKILL_GEN_SYSTEM : undefined));
  const v1 = validateSkillContent(first, name);
  if (v1.ok) return { content: first, parsed: v1.parsed, retried: false };

  opts.onStatus?.(`generated content failed validation (${v1.error}) — retrying once`);
  const second = stripFences(await streamText(session, buildRetryMessage(v1.error), undefined));
  const v2 = validateSkillContent(second, name);
  if (v2.ok) return { content: second, parsed: v2.parsed, retried: true };

  throw new SpycoreCliError(
    `Generated skill still failed validation after a retry: ${v2.error}`,
    EXIT_USER_ERROR,
    'Nothing was written. Try again, refine the description, or pick a different --model.',
  );
}
