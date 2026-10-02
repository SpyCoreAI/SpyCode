/**
 * Configurable command allow/deny rules for run_command — PHASE-1 1.10.
 *
 * Users declare literal command-prefix patterns that auto-approve (allow) or
 * auto-reject (deny) run_command calls. Config is file-based (the 1.6
 * hooks.json pattern):
 *   global   <configDir>/command-rules.json    { "allow": [..], "deny": [..] }
 *   project  ./.spycore/command-rules.json     same shape
 *
 * SECURITY MODEL (RULE 9):
 *  - The built-in catastrophic guard (tools.ts matchesCatastrophic) is
 *    IMMUTABLE and sits ABOVE everything here: run_command consults it and
 *    throws BEFORE these rules are ever evaluated, so an allow entry that
 *    matches a catastrophic pattern can never win — structurally, not by
 *    convention. The loader additionally warns about such entries.
 *  - METACHAR RULE: a command containing ANY shell metacharacter — ; & | < >
 *    ( ) { } $ ` \ newline/CR/NUL, an unbalanced quote, or an
 *    env-assignment/glob first token — is INELIGIBLE for auto-approval.
 *    Structurally: `tokenizeSimpleCommand` returns null for such commands and
 *    allow matching exists ONLY inside the non-null branch of
 *    `evaluateCommandRules`. There is no code path from a compound command to
 *    an allow match.
 *  - Precedence: built-in catastrophic guard > deny (user OR project) >
 *    allow > default ask. A deny fires BEFORE the approval prompt is
 *    consulted, so neither --yes nor a session accept_all can override it.
 *  - Deny matches BROADER than allow (basename first-token match, any token
 *    offset, raw word-scan on compound commands): a false-positive deny costs
 *    a rejection message; a false-negative allow would be a hole — the
 *    asymmetry only ever errs toward asking/denying.
 *  - PROJECT entries are repo-supplied approval-behavior changes and are
 *    double-gated: workspace trust (CL1, `spycore mcp trust`) AND a per-entry
 *    one-time approval keyed to the exact entry string (config.ts
 *    approvedProjectCommandRules). Headless with an unapproved project entry
 *    SKIPS it with a warning — never auto-applies.
 *  - Failure isolation: unparseable config and invalid entries degrade to
 *    notices; the session never dies from a bad rule.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  approveProjectCommandRule,
  getConfigPath,
  isProjectCommandRuleApproved,
  isWorkspaceTrusted,
} from '../config.js';
import { sanitizeForDisplay } from '../sanitize-display.js';
// Import cycle note: tools.ts imports evaluateCommandRules from here, and we
// import matchesCatastrophic (a hoisted function declaration, called only at
// load time) from tools.ts — safe under ESM, no init-order dependency.
import { matchesCatastrophic } from './tools.js';
// ⭐ F-2c-42 — the ONE expansion model, from the layer both modules import.
import { stripExpansions } from './shell-parse.js';
import { osFold } from '../os-fold.js';

export type RuleKind = 'allow' | 'deny';
export type RuleScope = 'user' | 'project';

/** One validated, active rule. `tokens` is the pre-split entry. */
export interface CommandRule {
  entry: string;
  tokens: string[];
  kind: RuleKind;
  scope: RuleScope;
}

export interface EffectiveCommandRules {
  allow: CommandRule[];
  deny: CommandRule[];
}

export type RuleDecision =
  | { action: 'allow'; rule: CommandRule }
  | { action: 'deny'; rule: CommandRule }
  | { action: 'ask' };

// ─────────────────────── tokenizer (the metachar gate) ───────────────────────

/**
 * Characters that make a command INELIGIBLE for allow-rule auto-approval,
 * ANYWHERE in the string — even inside quotes. `$`, backtick and backslash are
 * banned unconditionally so no expansion/substitution/escape can ever diverge
 * between this tokenizer and the real shell. `>>`, `<<`, `&&`, `||` and
 * `$( )` are covered by their constituent characters.
 */
// eslint-disable-next-line no-control-regex
const INELIGIBLE_CHARS = /[;&|<>(){}$`\\\r\n\u0000]/;

/** Glob characters: banned in rule entries and in a candidate's first token. */
const GLOB_CHARS = /[*?[\]]/;

/**
 * Tokenize a candidate command IF it is a plain simple command: whitespace
 * separation with '…' / "…" grouping only (no escapes exist — backslash is
 * banned outright). Returns null — INELIGIBLE for auto-approval — when the
 * command contains any banned metacharacter, an unbalanced quote, or a first
 * token that is an env assignment (`FOO=bar cmd`) or contains glob characters.
 */
export function tokenizeSimpleCommand(command: string): string[] | null {
  if (INELIGIBLE_CHARS.test(command)) return null;
  const tokens: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        tokens.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (quote !== null) return null; // unbalanced quote
  if (started) tokens.push(cur);
  if (tokens.length === 0) return null;
  const first = tokens[0]!;
  if (first.includes('=') || GLOB_CHARS.test(first)) return null;
  return tokens;
}

// ─────────────────────── matcher ───────────────────────

/** Boundary characters that may follow the last entry token's literal prefix
 *  ("npm run test" → "npm run test:unit" / "test-unit", never "testevil"). */
const CONTINUATION_BOUNDARY = new Set([':', '-', '_', '.', '/']);

const baseName = (token: string): string => token.slice(token.lastIndexOf('/') + 1);

/**
 * Match entry tokens against `words` starting at `start`. First token must be
 * EXACT (deny additionally accepts a basename match — `rm` catches
 * `/bin/rm`); middle tokens exact; the LAST entry token (multi-token entries
 * only) may also be a literal prefix of the candidate token when the boundary
 * character is one of : - _ . /. Candidate tokens beyond the entry are
 * unconstrained arguments.
 */
function matchesAt(
  entryTokens: string[],
  words: string[],
  start: number,
  denyBasename: boolean,
): boolean {
  if (words.length - start < entryTokens.length) return false;
  const w0 = words[start]!;
  const e0 = entryTokens[0]!;
  if (w0 !== e0 && !(denyBasename && baseName(w0) === e0)) return false;
  for (let i = 1; i < entryTokens.length; i++) {
    const e = entryTokens[i]!;
    const w = words[start + i]!;
    if (w === e) continue;
    if (
      i === entryTokens.length - 1 &&
      w.startsWith(e) &&
      CONTINUATION_BOUNDARY.has(w.charAt(e.length))
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/**
 * ⭐⭐ F-2c-42 — THE UNCONFIDENT DENY READING, WHICH WAS NARROWER THAN THE
 * SIBLING THAT SHARES ITS JOB.
 *
 * `tokenizeSimpleCommand` returns null for any command containing a
 * metacharacter — which a backslash and a `$` both are — so `\curl` and
 * `$(echo)curl` land HERE, on the branch whose stated purpose is to be BROADER
 * ("raw word-scan on compound commands", "erring toward denial is the safe
 * direction"). It was measurably NARROWER: it stripped only SURROUNDING quotes,
 * so `\curl` stayed the token `\curl`, `baseName('\curl') !== 'curl'`, no deny
 * rule matched at any offset, and the decision fell through to `ask` — which
 * under `--yes` or session accept-all is approved without a prompt.
 *
 * Measured: **60 of 60 evasions across 10 realistic deny entries executed in a
 * real /bin/sh**, against 10 of 10 controls firing correctly.
 *
 * ⭐ THIS IS THE SIBLING SITE OF THE SCREEN'S OWN HEAD-ATTRIBUTION DEFECT — the
 * command word judged as WRITTEN rather than as it will RESOLVE — in the second
 * of the package's two modules that answer that question. Fixing one and not
 * the other is the "closed at one site, not at the class" shape this arc has
 * now filed thirteen times in a single review.
 *
 * ⭐ TWO READINGS, COUNTED SEPARATELY, because stripping escapes alone closes
 * the backslash rows and leaves the expansion rows open:
 *   1. quote AND escape characters removed from every token — the identical
 *      normalisation `conservativeCommands` in `tools.ts` already applies, and
 *      the reason the two must stop disagreeing;
 *   2. expansions removed from every token, which is what `$(echo)curl`,
 *      `${EMPTY}curl` and `` `echo`curl `` need.
 * Both are OFFERED, never substituted, and the raw reading is kept — so this can
 * only ever make a deny fire MORE, never less.
 *
 * ⭐⭐ THE ALLOW SIDE IS DELIBERATELY UNTOUCHED. Allow matching lives only inside
 * the `tokens !== null` branch, so no escaped spelling can ever auto-approve;
 * measured at 0 of 60 before this change and asserted at 0 after. The asymmetry
 * failing in exactly one direction is what made this a hole rather than a quirk.
 */
function unconfidentDenyWords(command: string): string[][] {
  const raw = command.split(/\s+/).filter((w) => w.length > 0);
  const surroundingQuotes = raw.map((w) => w.replace(/^["']+|["']+$/g, ''));
  const noQuotesOrEscapes = raw.map((w) => w.replace(/['"\\]/g, '')).filter((w) => w.length > 0);
  const noExpansions = raw
    .map((w) => stripExpansions(w.replace(/['"\\]/g, '')))
    .filter((w) => w.length > 0);
  return [surroundingQuotes, noQuotesOrEscapes, noExpansions];
}

/**
 * Evaluate a candidate command against the effective rules.
 * Order: deny (broad) → allow (strict, tokenizable-only) → ask. The built-in
 * catastrophic guard is NOT consulted here — run_command checks it (and
 * throws) BEFORE calling this, which is what makes it unoverridable.
 */
export function evaluateCommandRules(
  command: string,
  rules: EffectiveCommandRules,
): RuleDecision {
  const tokens = tokenizeSimpleCommand(command);
  // Deny scan: quote-aware tokens for a simple command (so a deny phrase
  // inside a quoted argument does not fire); raw whitespace words with
  // surrounding quotes stripped for a compound/ineligible one (broadest —
  // erring toward denial is the safe direction).
  const denyWords: string[][] = tokens !== null ? [tokens] : unconfidentDenyWords(command);
  /**
   * ⭐⭐ F-22 / SPY-389 — THE DENY SIDE DID NO CASE FOLDING AT ALL, so on a
   * case-insensitive filesystem pressing SHIFT escaped every deny rule while
   * `/bin/sh` ran the identical binary. The failure was SILENT: the decision fell
   * through to `ask`, which `--yes` or a session accept-all answers.
   *
   * ⭐ A folded READING is added — both sides folded, since a rule entry may
   * itself be typed in any case — exactly as `unconfidentDenyWords` already adds
   * readings: OFFERED, never substituted, so a deny can only ever fire MORE.
   *
   * ⭐⭐ AND THE ALLOW DIRECTION BELOW IS DELIBERATELY UNTOUCHED. Folding there
   * would let a respelled command AUTO-APPROVE, which is strictly worse than the
   * hole this closes. The asymmetry is the point: deny broadens, allow stays
   * exact. See `lib/os-fold.ts` for why the fold is not NFKC.
   */
  const foldedDenyWords: string[][] = denyWords.map((words) => words.map(osFold));
  for (const rule of rules.deny) {
    const readings: Array<[string[], string[][]]> = [
      [rule.tokens, denyWords],
      [rule.tokens.map(osFold), foldedDenyWords],
    ];
    for (const [entryTokens, candidates] of readings) {
      for (const candidate of candidates) {
        for (let start = 0; start + entryTokens.length <= candidate.length; start++) {
          if (matchesAt(entryTokens, candidate, start, true)) return { action: 'deny', rule };
        }
      }
    }
  }
  // Allow matching exists ONLY inside this branch: a command the strict
  // tokenizer rejected (any metacharacter, unbalanced quote, assignment/glob
  // first token) can never reach it — the structural metachar guarantee.
  if (tokens !== null) {
    for (const rule of rules.allow) {
      if (matchesAt(rule.tokens, tokens, 0, false)) return { action: 'allow', rule };
    }
  }
  return { action: 'ask' };
}

// ─────────────────────── validator ───────────────────────

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish']);
const INTERPRETERS = new Set([
  'node',
  'nodejs',
  'deno',
  'bun',
  'tsx',
  'ts-node',
  'python',
  'python2',
  'python3',
  'pypy',
  'pypy3',
  'perl',
  'ruby',
  'irb',
  'php',
  'lua',
  'luajit',
  'julia',
  'rscript',
]);
/** Commands whose REAL command comes later in the argv — an allow entry
 *  starting with one leaves the eventual binary unconstrained. */
const RUNNERS = new Set([
  'env',
  'sudo',
  'doas',
  'su',
  'xargs',
  'nohup',
  'setsid',
  'stdbuf',
  'timeout',
  'time',
  'nice',
  'ionice',
  'eval',
  'exec',
  'command',
  'builtin',
  'source',
  'script',
  'watch',
]);

/** First token must be a plain command word or a ./ ../ / path. */
const FIRST_TOKEN_RE = /^(?:[A-Za-z0-9_][A-Za-z0-9_.+-]*|\.{0,2}\/[A-Za-z0-9_.+/-]+)$/;

const MAX_ENTRY_CHARS = 200;

export type EntryValidation =
  | { ok: true; tokens: string[]; entry: string }
  | { ok: false; reason: string };

/**
 * Validate one configured rule entry. ALLOW entries carry auto-approval
 * power, so they get the strict structural rejections (bare shells /
 * interpreters / runners, interpreter flags); DENY entries only restrict, so
 * a lone "bash" or "rm" is a legitimate deny. Over-strictness is by design:
 * a rejected entry means "ask", never "less safe".
 */
export function validateRuleEntry(raw: unknown, kind: RuleKind): EntryValidation {
  if (typeof raw !== 'string') return { ok: false, reason: 'not a string' };
  const entry = raw.trim().replace(/\s+/g, ' ');
  if (entry.length === 0) return { ok: false, reason: 'empty' };
  if (entry.length > MAX_ENTRY_CHARS) {
    return { ok: false, reason: `too long (max ${MAX_ENTRY_CHARS} characters)` };
  }
  if (entry === '*') {
    return { ok: false, reason: 'a bare "*" would match everything — write a specific command prefix' };
  }
  if (/["']/.test(entry)) return { ok: false, reason: 'quotes are not allowed in rule entries' };
  if (INELIGIBLE_CHARS.test(entry)) {
    return {
      ok: false,
      reason: 'contains shell metacharacters — such commands can never be auto-approved',
    };
  }
  if (GLOB_CHARS.test(entry)) {
    return { ok: false, reason: 'wildcards/globs are not supported — rules are literal word prefixes' };
  }
  const tokens = entry.split(' ');
  const first = tokens[0]!;
  if (!FIRST_TOKEN_RE.test(first)) {
    return { ok: false, reason: 'first token must be a plain command word or path' };
  }
  if (kind === 'allow') {
    const base = baseName(first).toLowerCase();
    const isShellOrInterp = SHELLS.has(base) || INTERPRETERS.has(base);
    if (tokens.length === 1 && (isShellOrInterp || RUNNERS.has(base))) {
      return { ok: false, reason: `a bare "${base}" would auto-approve arbitrary code execution` };
    }
    if (RUNNERS.has(base)) {
      return {
        ok: false,
        reason: `starts with a command runner ("${base}") — allowlist the underlying command instead`,
      };
    }
    if (isShellOrInterp) {
      for (const t of tokens.slice(1)) {
        if (t.startsWith('-')) {
          return {
            ok: false,
            reason: `flags on a shell/interpreter ("${t}") cannot be auto-approved — allowlist a plain script form instead`,
          };
        }
      }
    }
  }
  return { ok: true, tokens, entry };
}

// ─────────────────────── config files + loader ───────────────────────

export function userCommandRulesPath(): string {
  return join(dirname(getConfigPath()), 'command-rules.json');
}

export function projectCommandRulesPath(cwd: string): string {
  return join(cwd, '.spycore', 'command-rules.json');
}

interface RawRuleFile {
  allow: unknown[];
  deny: unknown[];
}

/** Parse one command-rules.json into raw entry lists. Never throws. */
function readRuleFile(path: string, label: string, notices: string[]): RawRuleFile {
  const empty: RawRuleFile = { allow: [], deny: [] };
  let raw: string;
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return empty;
    raw = readFileSync(path, 'utf8');
  } catch {
    return empty;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    notices.push(`Command rules: ${label} is not valid JSON — ignored.`);
    return empty;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    notices.push(`Command rules: ${label} must be an object with "allow"/"deny" arrays — ignored.`);
    return empty;
  }
  const obj = parsed as { allow?: unknown; deny?: unknown };
  const out: RawRuleFile = { allow: [], deny: [] };
  for (const kind of ['allow', 'deny'] as const) {
    const list = obj[kind];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      notices.push(`Command rules: "${kind}" in ${label} is not an array — ignored.`);
      continue;
    }
    out[kind] = list;
  }
  return out;
}

const shortEntry = (entry: unknown): string => {
  const flat = sanitizeForDisplay(String(entry)).replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
};

export interface LoadedCommandRules {
  rules: EffectiveCommandRules;
  /** Load-time diagnostics (display-ready). */
  notices: string[];
  /** True when at least one active rule exists. */
  hasAny: boolean;
}

/**
 * Load the effective command rules for a cwd. User-global entries are
 * user-authored → active as-is. Project entries require BOTH workspace trust
 * (CL1) and a per-entry approval; `approveProjectEntry` (interactive surfaces
 * only) is asked ONCE per unapproved entry and a yes is persisted keyed to
 * the exact string. Without the callback (headless), unapproved project
 * entries are SKIPPED with a warning. Invalid entries are skipped + warned;
 * an allow entry that matches the built-in catastrophic guard is kept but
 * flagged — it can never win (the guard throws before rules are evaluated).
 */
export async function loadCommandRules(
  cwd: string,
  opts?: {
    approveProjectEntry?: (e: { kind: RuleKind; entry: string }) => Promise<boolean>;
  },
): Promise<LoadedCommandRules> {
  const notices: string[] = [];
  const rules: EffectiveCommandRules = { allow: [], deny: [] };

  const addValidated = (raw: unknown, kind: RuleKind, scope: RuleScope, label: string): string | null => {
    const v = validateRuleEntry(raw, kind);
    if (!v.ok) {
      notices.push(`Command rules: skipped ${kind} entry in ${label} (${shortEntry(raw)}) — ${v.reason}.`);
      return null;
    }
    if (kind === 'allow') {
      const danger = matchesCatastrophic(v.entry);
      if (danger) {
        notices.push(
          `Command rules: the ${scope} allow entry "${shortEntry(v.entry)}" matches the built-in catastrophic guard (${danger}) and can never auto-approve.`,
        );
      }
    }
    rules[kind].push({ entry: v.entry, tokens: v.tokens, kind, scope });
    return v.entry;
  };

  const userFile = readRuleFile(userCommandRulesPath(), 'the global command-rules.json', notices);
  for (const kind of ['allow', 'deny'] as const) {
    for (const raw of userFile[kind]) addValidated(raw, kind, 'user', 'the global command-rules.json');
  }

  const projectPath = projectCommandRulesPath(cwd);
  let projectPresent = false;
  try {
    projectPresent = existsSync(projectPath) && statSync(projectPath).isFile();
  } catch {
    projectPresent = false;
  }
  if (projectPresent) {
    if (!isWorkspaceTrusted(cwd)) {
      notices.push(
        'Project command rules (.spycore/command-rules.json) not loaded — untrusted workspace. Trust it with `spycore mcp trust`.',
      );
    } else {
      const label = '.spycore/command-rules.json';
      const projectFile = readRuleFile(projectPath, label, notices);
      for (const kind of ['allow', 'deny'] as const) {
        for (const raw of projectFile[kind]) {
          const v = validateRuleEntry(raw, kind);
          if (!v.ok) {
            notices.push(`Command rules: skipped ${kind} entry in ${label} (${shortEntry(raw)}) — ${v.reason}.`);
            continue;
          }
          if (isProjectCommandRuleApproved(cwd, kind, v.entry)) {
            addValidated(v.entry, kind, 'project', label);
            continue;
          }
          if (!opts?.approveProjectEntry) {
            notices.push(
              `Skipped unapproved project ${kind} rule: ${shortEntry(v.entry)} — approve it in an interactive session.`,
            );
            continue;
          }
          let approved = false;
          try {
            approved = await opts.approveProjectEntry({ kind, entry: v.entry });
          } catch {
            approved = false;
          }
          if (approved) {
            approveProjectCommandRule(cwd, kind, v.entry);
            addValidated(v.entry, kind, 'project', label);
          } else {
            notices.push(`Skipped project ${kind} rule (${shortEntry(v.entry)}) — not approved.`);
          }
        }
      }
    }
  }

  return { rules, notices, hasAny: rules.allow.length + rules.deny.length > 0 };
}

// ─────────────────────── "always allow" (user scope only) ───────────────────────

/**
 * Derive the SAFE minimal allow entry for a just-approved command: the full
 * tokenized command (most specific), only when the command is
 * metachar-eligible, validates as an allow entry, and round-trips through the
 * tokenizer unchanged (a quoted argument containing spaces would not).
 * Returns null when no entry can be safely derived — the option is then
 * simply not offered.
 */
export function deriveAlwaysAllowEntry(command: string): string | null {
  const tokens = tokenizeSimpleCommand(command);
  if (tokens === null) return null;
  const entry = tokens.join(' ');
  const v = validateRuleEntry(entry, 'allow');
  if (!v.ok) return null;
  const roundTrip = tokenizeSimpleCommand(v.entry);
  if (
    roundTrip === null ||
    roundTrip.length !== tokens.length ||
    roundTrip.some((t, i) => t !== tokens[i])
  ) {
    return null;
  }
  return v.entry;
}

/**
 * Append an allow entry to the USER command-rules file (never project scope)
 * and return the live rule. Throws on a validation failure — callers gate on
 * deriveAlwaysAllowEntry first.
 */
export function appendUserAllowRule(entry: string): CommandRule {
  const v = validateRuleEntry(entry, 'allow');
  if (!v.ok) throw new Error(`invalid allow entry: ${v.reason}`);
  const path = userCommandRulesPath();
  const notices: string[] = [];
  const current = readRuleFile(path, 'the global command-rules.json', notices);
  const allow = current.allow.filter((e): e is string => typeof e === 'string');
  if (!allow.includes(v.entry)) allow.push(v.entry);
  const deny = current.deny.filter((e): e is string => typeof e === 'string');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ allow, deny }, null, 2)}\n`, 'utf8');
  return { entry: v.entry, tokens: v.tokens, kind: 'allow', scope: 'user' };
}

// ─────────────────────── read-only inspection ───────────────────────

export interface RuleInspectionRow {
  scope: RuleScope;
  kind: RuleKind;
  entry: string;
  /** active — in effect; invalid — skipped; unapproved / untrusted — project gate. */
  status: 'active' | 'invalid' | 'unapproved' | 'untrusted';
  detail?: string;
}

/**
 * Enumerate every configured entry with its scope and effect — the read-only
 * surface behind `spycore command-rules`. Performs no writes and no prompts.
 */
export function inspectCommandRules(cwd: string): RuleInspectionRow[] {
  const rows: RuleInspectionRow[] = [];
  const notices: string[] = [];

  const userFile = readRuleFile(userCommandRulesPath(), 'the global command-rules.json', notices);
  for (const kind of ['allow', 'deny'] as const) {
    for (const raw of userFile[kind]) {
      const v = validateRuleEntry(raw, kind);
      if (!v.ok) {
        rows.push({ scope: 'user', kind, entry: shortEntry(raw), status: 'invalid', detail: v.reason });
        continue;
      }
      const danger = kind === 'allow' ? matchesCatastrophic(v.entry) : null;
      rows.push({
        scope: 'user',
        kind,
        entry: v.entry,
        status: 'active',
        ...(danger ? { detail: `can never auto-approve — built-in catastrophic guard (${danger})` } : {}),
      });
    }
  }

  const projectPath = projectCommandRulesPath(cwd);
  let projectPresent = false;
  try {
    projectPresent = existsSync(projectPath) && statSync(projectPath).isFile();
  } catch {
    projectPresent = false;
  }
  if (projectPresent) {
    const trusted = isWorkspaceTrusted(cwd);
    const projectFile = readRuleFile(projectPath, '.spycore/command-rules.json', notices);
    for (const kind of ['allow', 'deny'] as const) {
      for (const raw of projectFile[kind]) {
        const v = validateRuleEntry(raw, kind);
        if (!v.ok) {
          rows.push({ scope: 'project', kind, entry: shortEntry(raw), status: 'invalid', detail: v.reason });
          continue;
        }
        if (!trusted) {
          rows.push({
            scope: 'project',
            kind,
            entry: v.entry,
            status: 'untrusted',
            detail: 'workspace not trusted — `spycore mcp trust`',
          });
          continue;
        }
        if (!isProjectCommandRuleApproved(cwd, kind, v.entry)) {
          rows.push({
            scope: 'project',
            kind,
            entry: v.entry,
            status: 'unapproved',
            detail: 'approve it in an interactive agent/chat session',
          });
          continue;
        }
        const danger = kind === 'allow' ? matchesCatastrophic(v.entry) : null;
        rows.push({
          scope: 'project',
          kind,
          entry: v.entry,
          status: 'active',
          ...(danger ? { detail: `can never auto-approve — built-in catastrophic guard (${danger})` } : {}),
        });
      }
    }
  }

  return rows;
}
