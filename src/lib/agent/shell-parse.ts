/**
 * A minimal shell reader for SAFETY SCREENING — F-2c-4b.
 *
 * ⭐ WHY THIS EXISTS. The catastrophic-command net used to be regexes over raw
 * shell text. Measured at `a391ee88`, that axis was wrong in BOTH directions at
 * once: 42 of 59 catastrophic forms were ALLOWED (`rm -rf />/dev/null`,
 * `r\m -rf /`, `rm -r"f" /`) while 7 of 34 benign ones were BLOCKED
 * (`echo "rm -rf /" >> notes.md`). A control that is simultaneously too narrow
 * and too wide is on the WRONG AXIS, not mistuned — no tuning of the character
 * classes can fix both, and widening the terminator was measured to buy 11
 * evasions at the cost of 2 more over-blocks. The right question is "what will
 * the shell actually execute", which means reasoning about WORDS, not text.
 *
 * This is NOT a shell, and deliberately not a complete one. It performs
 * quote-removal, backslash processing, operator splitting and redirection
 * recognition — enough to know which word is the command and which words are
 * its operands. It does NOT expand anything.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⭐⭐ THE STRUCTURAL PROPERTY — read this before changing anything below.
 *
 * The predecessor's safety came from `shellSegments`, which ONLY SPLIT and
 * NEVER REMOVED, so a mis-parse could add blocks but never open a hole. That
 * property is preserved here, lifted from segments to words:
 *
 *   THE PARSE ONLY EVER ADDS WORDS. IT NEVER DROPS ONE.
 *
 * Concretely, and each of these is pinned by a test:
 *   1. Quote-removal deletes only the quote CHARACTERS; the content survives as
 *      a word, so nothing a shell would execute becomes invisible.
 *   2. Expansions are NOT expanded. `$(…)` / `` `…` `` / `${…}` / `$VAR` stay in
 *      the word verbatim, AND the interior of a command substitution is emitted
 *      separately in `substitutions` so it can be screened as its own command
 *      list. That is purely additive.
 *   3. `#` is NEVER treated as a comment. Stripping from `#` would delete the
 *      payload of `X=1#; rm -rf /`, where a real shell runs the `rm`. A parser
 *      guarding a security property must choose the direction that can only
 *      block MORE (PROJECT_PLAN §4 landmine 18).
 *   4. FAIL CLOSED: an unbalanced quote, a trailing backslash, an unterminated
 *      substitution or a depth overflow sets `confident = false`. The caller
 *      MUST then fall back to a conservative screen rather than trust this
 *      parse — a tokenizer that silently dropped a token on malformed input
 *      would open exactly the hole the predecessor could not open.
 *   5. CONSERVATION: every non-whitespace character of the input ends up in a
 *      word's `raw` span or in an operator. Pinned by an explicit test over the
 *      whole corpus, so a future edit cannot quietly start discarding input.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** One word of a command, after quote-removal and backslash processing. */
export interface ShellWord {
  /** The value a shell would pass to the command (no expansion performed). */
  value: string;
  /** The exact source text this word came from — used to prove conservation. */
  raw: string;
  /** True when any character of the value came from inside quotes or an escape. */
  quoted: boolean;
}

/** One simple command: an argv, its assignment prefix, and its redirections. */
export interface SimpleCommand {
  /** Leading `NAME=value` assignments, before the command word. */
  assignments: ShellWord[];
  /** argv — the command word first, then its arguments. */
  words: ShellWord[];
  /** Targets of `>` `>>` `<` `2>` `&>` … in this command. */
  redirects: ShellWord[];
  /**
   * The redirection operators this command consumed. Carried so that CONSERVATION
   * can account for every input character — a redirect operator is consumed
   * inside a command and so never appears as a `terminator`.
   */
  redirectOps: string[];
  /** The operator that FOLLOWED this command (`|`, `&&`, `;`, …), or null. */
  terminator: string | null;
}

export interface ParsedShell {
  commands: SimpleCommand[];
  /** Interiors of every `$( … )` / `` ` … ` `` , for recursive screening. */
  substitutions: string[];
  /**
   * Operators that terminated an EMPTY command — a leading `(`, a `;;`, a
   * doubled separator. Nothing screens them, but they are recorded so that
   * CONSERVATION accounts for every input character rather than letting a
   * silent drop hide here.
   */
  strayOperators: string[];
  /**
   * false ⇒ THE PARSE IS NOT TRUSTWORTHY. Callers must fall back to a
   * conservative screen. Never treat an unconfident parse as "nothing found".
   */
  confident: boolean;
  /**
   * ⭐ R-CLI-4 — set when a construct was found to be balanced but deeper than
   * `MAX_SUBSTITUTION_DEPTH`: the input is well-formed there and we have simply
   * declined to model it.
   *
   * ⭐⭐ R-CLI-5 / `SPY-462` — THE SENTENCE THAT USED TO STAND HERE — *"Never set
   * for malformed input"* — WAS FALSE, and a false sentence about a safety flag
   * is worse than none. This is ONE flag for the WHOLE parse, so an input that
   * is over-deep in one place and malformed in another sets it, and the caller
   * cannot tell those apart from this boolean.
   *
   * ⭐⭐ AND IT LICENSES EXACTLY ONE DECISION, WHICH IS `SPY-460`. It says how the
   * text must be READ — a construct we decline to model is still text a shell
   * applies its own continuation rule to. It does NOT say a word is a MENTION;
   * that is `nested`, and only `nested`, because a command sitting BESIDE an
   * over-deep construct is not inside anything. See `screenShell`.
   */
  boundExceeded: boolean;
}

/**
 * Operators that end one command and begin another. Longest-match first.
 *
 * EXPORTED so `agent-command.test.ts` can DERIVE its boundary corpus from this
 * table rather than from a hand-typed copy of it. That is the difference
 * between a derivation and a hand-list with extra steps: adding an operator
 * here automatically extends the pin, and forgetting to handle one turns it red.
 */
// ⭐⭐ F-2c-42 — `<<<` IS FIRST, AND THE ORDER IS THE WHOLE FIX. The scan is a
// longest-match `find`, so with `<<` ahead of it a here-string lexed as `<<`
// then `<` and the SCRIPT TEXT was filed as a redirect target. Measured: 880
// shapes the published 0.6.0 refuses ran at HEAD.
export const SHELL_OPERATORS = ['&&', '||', ';;', '<<<', '>>', '<<', '2>', '&>', '>&', ';', '&', '|', '<', '>', '(', ')', '{', '}', '\n', '\r'];

/** The operators that introduce a REDIRECTION — the next word is its target. */
const REDIRECT_OPS = new Set(['>', '>>', '<', '<<', '<<<', '2>', '&>', '>&']);

/** The operator whose "target" is not a file at all but a program text. */
export const HERESTRING_OP = '<<<';

/**
 * ⭐⭐ F-2c-42 — ONE EXPANSION MODEL FOR THE WHOLE PACKAGE.
 *
 * This lived in `tools.ts` as a private `stripExpansions` used for TARGETS
 * only. Two things needed it — the target test and the head-word attribution —
 * and a second copy is the drift class this arc keeps re-filing (`SHELLS`
 * declared twice, `COMMAND_CARRIERS` and its sibling in `command-rules.ts`).
 * It is declared once, here, in the lower layer that both import.
 *
 * Remove unexpanded expansions so a word can be judged on what it will BECOME.
 * `/$(true)` and `/${x}` both become `/`; `$(echo)rm` becomes `rm`. The
 * ORIGINAL text is always screened too, never instead — this only ever ADDS a
 * reading.
 */
const EXPANSION_SOURCE = /\$\([^)]*\)|`[^`]*`|\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;

export function stripExpansions(v: string): string {
  return v.replace(new RegExp(EXPANSION_SOURCE.source, 'g'), '');
}

/** Does this word contain an expansion at all? (Non-global: `.test` is safe.) */
export function hasExpansion(v: string): boolean {
  return EXPANSION_SOURCE.test(v);
}

/**
 * ⭐⭐ F-19 / `SPY-370` — BRACE EXPANSION, AS AN EXTRA READING OF THE WHOLE
 * COMMAND LINE.
 *
 * ⭐⭐ WHY THIS EXISTS. `{` and `}` are entries in `SHELL_OPERATORS`, and the
 * operator scan is unconditional, so a brace ANYWHERE — including between two
 * characters of a dangerous literal — ended the word. `dd if=/dev/zero
 * o{f..f}=/dev/sda` lexed as three fragments and every operand-reading rule saw
 * a harmless prefix, with `confident` still TRUE so the fail-closed arm never
 * engaged. The shell does the opposite: it brace-expands FIRST and the
 * characters vanish, so the word it runs is `of=/dev/sda`, byte for byte.
 * Measured against the published `0.6.0`: **101 byte-identical cells across 13
 * rule cores that 0.6.0 BLOCKS and HEAD ALLOWED** (`audits/f19-*`).
 *
 * ⭐⭐ WHY IT IS A READING AND NOT A LEXER CHANGE. `{` really is a shell
 * reserved word in command position — `{ rm -rf /; }` is a group command, and
 * `TRANSFORMS`' `brace-group` carrier depends on it being one. Teaching the
 * LEXER to tell the two apart would put a second, subtler grammar decision on
 * the load-bearing path. Expanding the TEXT instead is what the shell itself
 * does, and it can only ever ADD a reading — the original is always screened
 * too, never instead. That is the direction a guard must err in
 * (`PROJECT_PLAN` §4 landmine 18) and the same shape `candidateArgvs` and
 * `stripExpansions` already use.
 *
 * ⭐ QUOTE-AWARE, BECAUSE THE SHELL IS. Driven string-only through `/bin/sh`'s
 * `printf` builtin: `CO{R..R}E` → `CORE`, but `"CO{R..R}E"` and `'CO{R..R}E'`
 * are left ALONE. An expander that ignored quoting would invent commands the
 * user never wrote — `awk '{print $1}'`, `sed 's/{a}/{b}/'` and `jq '{n: .n}'`
 * are ordinary work, and they are in the benign corpus for exactly this reason.
 *
 * ⭐ AND ONLY THE FORMS THIS SHELL ACTUALLY EXPANDS. `/bin/sh` here is bash
 * 3.2.57 in sh mode. `{=..=}`, `{-..-}` and `{R}` are NOT expanded — measured,
 * with those three as the negative control — so a group is only recognised when
 * it carries a top-level comma or an alphanumeric/numeric `..` range.
 */
const MAX_BRACE_READINGS = 64;
const MAX_BRACE_RANGE = 64;

/** One unquoted `{ … }` group: its span and the alternatives it stands for. */
function firstBraceGroup(s: string, state?: { refused: boolean }, includeRefused = false): { start: number; end: number; parts: string[] } | null {
  let q: '"' | "'" | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i] as string;
    if (c === '\\') { i += 1; continue; }
    if (q === null && (c === '"' || c === "'")) { q = c; continue; }
    if (q !== null) { if (c === q) q = null; continue; }
    if (c !== '{') continue;
    // Walk to the matching `}`, tracking nesting and quoting, and remembering
    // where the TOP-LEVEL commas sit.
    let depth = 0;
    let iq: '"' | "'" | null = null;
    const commas: number[] = [];
    for (let j = i; j < s.length; j += 1) {
      const d = s[j] as string;
      if (d === '\\') { j += 1; continue; }
      if (iq === null && (d === '"' || d === "'")) { iq = d; continue; }
      if (iq !== null) { if (d === iq) iq = null; continue; }
      if (d === '{') { depth += 1; continue; }
      if (d === ',' && depth === 1) { commas.push(j); continue; }
      if (d !== '}') continue;
      depth -= 1;
      if (depth > 0) continue;
      const inner = s.slice(i + 1, j);
      if (commas.length > 0) {
        const cuts = [i, ...commas, j];
        const parts = cuts.slice(0, -1).map((a, k) => s.slice(a + 1, cuts[k + 1] as number));
        return { start: i, end: j, parts };
      }
      const range = /^(?:([A-Za-z0-9])\.\.([A-Za-z0-9])|(-?\d+)\.\.(-?\d+))$/.exec(inner);
      if (range) {
        const parts = range[1] !== undefined
          ? charRange(range[1] as string, range[2] as string)
          : numRange(Number(range[3]), Number(range[4]));
        if (parts !== null) return { start: i, end: j, parts };
        // ⭐ F-21 — the group WAS a range and was REFUSED for exceeding
        // `MAX_BRACE_RANGE`, or for a non-finite endpoint. Its characters stay
        // in every reading, so the parser stays brace-blind here.
        if (state) state.refused = true;
        // ⭐⭐ AND ITS FIRST ALTERNATIVE IS STILL KNOWN WITHOUT GENERATING THE
        // RANGE — the shell's first word is built from exactly that endpoint.
        if (includeRefused) return { start: i, end: j, parts: [(range[1] ?? range[3]) as string] };
      }
      break; // this `{` opens no expandable group — keep scanning past it
    }
  }
  return null;
}

function charRange(a: string, b: string): string[] | null {
  const lo = a.codePointAt(0) as number;
  const hi = b.codePointAt(0) as number;
  const step = lo <= hi ? 1 : -1;
  if (Math.abs(hi - lo) + 1 > MAX_BRACE_RANGE) return null;
  const out: string[] = [];
  for (let c = lo; step > 0 ? c <= hi : c >= hi; c += step) out.push(String.fromCodePoint(c));
  return out;
}

function numRange(a: number, b: number): string[] | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(b - a) + 1 > MAX_BRACE_RANGE) return null;
  const step = a <= b ? 1 : -1;
  const out: string[] = [];
  for (let n = a; step > 0 ? n <= b : n >= b; n += step) out.push(String(n));
  return out;
}

/**
 * Every distinct brace expansion of `input`, EXCLUDING `input` itself.
 *
 * Returns `[]` when there is nothing to expand, so the ordinary command pays
 * nothing. ⭐ Bounded at `MAX_BRACE_READINGS`: a pathological
 * `{a,b}{a,b}{a,b}…` yields a truncated set rather than a hang. Truncation is
 * sound in this direction — the set only ADDS readings, so a shorter set can
 * miss a refusal but can never manufacture one.
 */
export function braceExpansions(input: string): string[] {
  if (!input.includes('{')) return [];
  const seen = new Set<string>([input]);
  const out: string[] = [];
  let frontier = [input];
  while (frontier.length > 0 && out.length < MAX_BRACE_READINGS) {
    const next: string[] = [];
    for (const s of frontier) {
      const g = firstBraceGroup(s);
      if (g === null) continue;
      for (const part of g.parts) {
        const cand = s.slice(0, g.start) + part + s.slice(g.end + 1);
        if (seen.has(cand)) continue;
        seen.add(cand);
        out.push(cand);
        next.push(cand);
        if (out.length >= MAX_BRACE_READINGS) break;
      }
      if (out.length >= MAX_BRACE_READINGS) break;
    }
    frontier = next;
  }
  return out;
}

/**
 * ⭐⭐ F-21 / `SPY-383` · `SPY-386` — THE COLLAPSED READING: EVERY BRACE GROUP
 * REPLACED BY ITS **FIRST** ALTERNATIVE, IN ONE PASS, WHETHER OR NOT ITS RANGE
 * FITS THE BUDGET.
 *
 * ⭐⭐ WHY. `braceExpansions` is the ONLY thing that repairs the parser's
 * brace-blindness, and it is bounded twice. Past either bound it yields nothing
 * and nothing else is looking — so a harmless group placed BEFORE the dangerous
 * one buys silence (`echo {1..64} && rm --{r..r}ecursive --force /`). A bound on
 * a repair is a hole in the thing it repairs.
 *
 * This reading is O(length) and immune to both bounds: it never generates a
 * range, it takes only its first endpoint. It is an ADD — the original and every
 * bounded expansion are still screened, never instead — so it can raise the
 * number of refusals and can never lower one.
 */
const MAX_BRACE_COLLAPSE = 64;

export function braceCollapsed(input: string): string[] {
  if (!input.includes('{')) return [];
  let s = input;
  /** where each group's replacement ended up, and what else it could have been */
  const groups: Array<{ start: number; len: number; parts: string[] }> = [];
  // Each step strictly shortens `s` (a group is at least three characters and
  // its replacement is at most one), so the loop terminates; the bound is a
  // belt-and-braces stop, not the termination argument. A recorded `start`
  // stays valid in the final string: later groups sit at higher indices, so
  // replacing them never moves an earlier replacement.
  for (let n = 0; n < MAX_BRACE_COLLAPSE; n += 1) {
    const g = firstBraceGroup(s, undefined, true);
    if (g === null) break;
    const first = g.parts[0] as string;
    groups.push({ start: g.start, len: first.length, parts: g.parts });
    s = s.slice(0, g.start) + first + s.slice(g.end + 1);
  }
  if (groups.length === 0 || s === input) return [];
  const out: string[] = [s];
  // ⭐⭐ F-21 — AND ONE READING PER **OTHER** ALTERNATIVE, ROUND-ROBIN ACROSS THE
  // GROUPS, WITH EVERY OTHER GROUP HELD AT ITS FIRST.
  //
  // ⭐ WHY THIS EXISTS. Taking only the first alternative reconstructs
  // `r{m,m}` → `rm` because both alternatives are the same — which is true of
  // every cell the corpus generated and NOT true of `rm --{x,r}ecursive`, where
  // the dangerous alternative is second. Measured on the asymmetric respelling
  // of the corpus's own hostile brace cells: **53 regressions** against the
  // published 0.6.0 survived the first-alternative-only collapse.
  //
  // ⭐ ROUND-ROBIN, not group-by-group: a leading `{1..64}` would otherwise
  // spend the whole budget on its own 63 alternatives before the second group's
  // first alternative was ever tried — the same "a pad in front buys silence"
  // shape this function exists to remove, one level up.
  //
  // ⭐ The cost is the SUM of the groups' alternatives, never their product, and
  // it is bounded by `MAX_BRACE_COLLAPSE`. Still an ADD: the original and every
  // bounded expansion are screened too.
  let maxAlts = 0;
  for (const g of groups) if (g.parts.length > maxAlts) maxAlts = g.parts.length;
  for (let k = 1; k < maxAlts && out.length < MAX_BRACE_COLLAPSE; k += 1) {
    for (const g of groups) {
      if (out.length >= MAX_BRACE_COLLAPSE) break;
      const part = g.parts[k];
      if (part === undefined) continue;
      const cand = s.slice(0, g.start) + part + s.slice(g.start + g.len);
      if (cand !== input && !out.includes(cand)) out.push(cand);
    }
  }
  return out;
}

/**
 * ⭐⭐ F-21 — THE SAME BOUNDED EXPANSION, EXPLORED **DEPTH-FIRST**.
 *
 * ⭐ WHY. `braceExpansions` is breadth-first: it expands the FIRST group at
 * every level, so a wide or numerous leading group spends the whole reading
 * budget on partially-resolved intermediates and no fully-resolved reading is
 * ever emitted. That is `SPY-386`'s mechanism, and the per-group collapse only
 * repairs it for readings that need ONE group off its first alternative.
 * `rm --{z,r}ecursi{z,v}e --force /` needs two at once.
 *
 * Depth-first resolves one reading COMPLETELY before starting the next and
 * backtracks from the RIGHT — which is exactly where a payload hidden behind a
 * leading pad sits. Same bound, same additive contract: it can only ADD
 * readings, never remove one, because the breadth-first set is still screened.
 */
export function braceExpansionsDepthFirst(input: string): string[] {
  if (!input.includes('{')) return [];
  const out: string[] = [];
  const seen = new Set<string>([input]);
  const walk = (s: string): void => {
    if (out.length >= MAX_BRACE_READINGS) return;
    const g = firstBraceGroup(s);
    if (g === null) return;
    for (const part of g.parts) {
      if (out.length >= MAX_BRACE_READINGS) return;
      const cand = s.slice(0, g.start) + part + s.slice(g.end + 1);
      if (seen.has(cand)) continue;
      seen.add(cand);
      out.push(cand);
      // ⭐ recurse into THIS alternative before trying the next one — that is
      // the whole difference from `braceExpansions`, and it is what reaches a
      // trailing group while a leading one is still un-enumerated.
      walk(cand);
    }
  };
  walk(input);
  return out;
}

/**
 * ⭐ R-CLI-3 — collect every command-substitution interior in a parameter
 * expansion's WORD, skipping single-quoted regions.
 *
 * A real shell expands the word of `${v:-…}`, so a substitution there is a
 * command context — but a SINGLE-QUOTED region inside that word is not, measured
 * on /bin/sh, /bin/bash and /bin/zsh over all 13 POSIX operators with all three
 * agreeing. Skipping those regions is therefore not caution, it is correctness:
 * the variant that did not skip them removes a capability on `${v:-'$( … )'}`,
 * which nothing runs, and the refusal is thrown before approval so no flag can
 * recover it.
 *
 * Like every other reading in this file it only ever ADDS: it appends to
 * `substitutions` and touches neither `value` nor `raw` nor `confident`.
 */
function substitutionInteriorsOutsideSingleQuotes(text: string, out: string[]): void {
  for (let k = 0; k < text.length; k += 1) {
    const c = text[k];
    if (c === '\\') {
      k += 1;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", k + 1);
      if (close === -1) return; // unterminated — stop rather than guess
      k = close;
      continue;
    }
    if (c === '$' && text[k + 1] === '(') {
      const end = matchClosing(text, k + 2, '(', ')');
      if (end === -1) return;
      out.push(text.slice(k + 2, end));
      k = end;
      continue;
    }
    if (c === '`') {
      const end = text.indexOf('`', k + 1);
      if (end === -1) return;
      out.push(text.slice(k + 1, end));
      k = end;
    }
  }
}

/** Bounded nesting for `$( … )` so a pathological input cannot spin. */
const MAX_SUBSTITUTION_DEPTH = 8;

/**
 * Read `input` as a list of simple commands.
 *
 * Total: never throws. On any construct it cannot model it degrades to treating
 * the remainder as ordinary literal words — it never discards characters.
 */
export function parseShell(input: string): ParsedShell {
  const commands: SimpleCommand[] = [];
  const substitutions: string[] = [];
  // ⭐ R-CLI-4 — WHY the parse became unconfident, when the answer is "the
  // construct is balanced and simply deeper than MAX_SUBSTITUTION_DEPTH". The
  // parse still fails closed; the caller may choose a less inventive fallback.
  let boundExceeded = false;
  const strayOperators: string[] = [];
  let confident = true;

  let cmd: SimpleCommand = { assignments: [], words: [], redirects: [], redirectOps: [], terminator: null };
  let value = '';
  let raw = '';
  let quoted = false;
  let started = false;
  /** Set when the previous operator was a redirection: the next word is a target. */
  let pendingRedirect = false;
  /** ⭐ F-21 / `SPY-385` — set once an unquoted `#` has begun a comment on this line. */
  let inComment = false;

  const flushWord = (): void => {
    if (!started) {
      // ⭐ F-2c-40 — A LINE CONTINUATION CONTRIBUTES NO WORD, BUT ITS CHARACTERS
      // STILL HAVE TO LAND SOMEWHERE. `rm -rf \<newline> /` has a continuation
      // that starts no word (a space follows it), and if its `raw` were simply
      // dropped here the CONSERVATION pin would break silently — which is the
      // failure mode that pin exists to make loud. `strayOperators` is already
      // where this parser records input belonging to no command.
      if (raw !== '') {
        strayOperators.push(raw);
        raw = '';
      }
      return;
    }
    const word: ShellWord = { value, raw, quoted };
    if (pendingRedirect) {
      cmd.redirects.push(word);
      pendingRedirect = false;
    } else if (cmd.words.length === 0 && !quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
      // A leading NAME=value is an assignment, not the command word. Only an
      // UNQUOTED one: `"FOO=bar"` is an ordinary argument to a shell.
      cmd.assignments.push(word);
    } else {
      cmd.words.push(word);
    }
    value = '';
    raw = '';
    quoted = false;
    started = false;
  };

  const flushCommand = (terminator: string | null): void => {
    flushWord();
    cmd.terminator = terminator;
    if (cmd.words.length > 0 || cmd.assignments.length > 0 || cmd.redirects.length > 0) {
      commands.push(cmd);
    } else {
      if (terminator !== null) strayOperators.push(terminator);
      strayOperators.push(...cmd.redirectOps);
    }
    cmd = { assignments: [], words: [], redirects: [], redirectOps: [], terminator: null };
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;

    // ── whitespace ends a word (but not a command) ──
    if (ch === ' ' || ch === '\t') {
      flushWord();
      i += 1;
      continue;
    }

    // ── backslash escape: the NEXT character is literal, the backslash goes ──
    if (ch === '\\') {
      const next = input[i + 1];
      if (next === undefined) {
        // Trailing backslash — a real shell would continue onto another line.
        // We cannot see that line, so we cannot claim to know what runs.
        confident = false;
        raw += ch;
        started = true;
        i += 1;
        continue;
      }
      // ⭐⭐ F-2c-40 — A BACKSLASH BEFORE A NEWLINE IS A LINE CONTINUATION, AND
      // POSIX REMOVES THE PAIR. THIS LINE IS THE ONE THAT DISABLED THE SCREEN.
      //
      // The arm above already knew this for a backslash at END OF INPUT, where
      // it correctly sets `confident = false` because it cannot see the next
      // line. A backslash before a newline INSIDE the same string is the case
      // where we CAN see it — and it fell through to `value += next`, injecting
      // a literal newline into the word. The shell's word is `/`; the parser's
      // was `"\n/"`. Every rule is prefix-anchored or exact-match on that value,
      // so none matched — and `confident` stayed TRUE, so the conservative
      // fallback for unmodellable input was never reached either. A SILENT miss,
      // not a degraded one.
      //
      // ⭐⭐ AND THE CLASS WAS EXAMINED AND RULED HARMLESS. F-2c-25 measured 56
      // residual regressions here, tested ONE of them — `echo a\<nl>rm -rf /`,
      // which really does run `echo arm -rf /` — and generalised "these are
      // 0.6.0 false positives" into `PROJECT_PLAN` §1.51, into its own audit,
      // into `SPY-280`, and into an exclusion in the committed differential.
      // Where the join BREAKS the verb that ruling holds; where it FORMS the
      // verb the same shell runs the destroyer. Measured at F-2c-40 over the
      // differential's own 58 cores: **191 shapes the published 0.6.0 refuses
      // ran at HEAD** (65 on the inter-token construction alone, 42 of 58 cores
      // affected) — and a real directory tree was destroyed through the shipped
      // `run_command` path to prove it.
      //
      // ⭐ Single quotes are deliberately untouched: inside `'…'` the pair is
      // literal, and that is measured against a real `/bin/sh` in the
      // differential rather than asserted here.
      // ⭐⭐ F-21 / `SPY-385` — A `#` COMMENT IS TERMINATED BY <newline>, AND THE
      // ESCAPE CHARACTER IS NOT SPECIAL INSIDE IT. Removing the pair here spliced
      // the comment's last word onto the next line's verb — `# note\` + LF fused
      // `note` and `rm` into `noterm`, and no rule matches a command called
      // `noterm`. Measured unanimous on /bin/sh (bash 3.2.57), /bin/bash, /bin/zsh
      // 5.9 and /bin/dash: the newline is KEPT and a new command starts.
      //
      // ⭐ Consuming ONLY the backslash — as an ordinary comment character — leaves
      // the newline to the operator scan, which is exactly what the shell does. It
      // can only ADD a command boundary, never remove one.
      if (inComment && next === '\n') {
        value += ch;
        raw += ch;
        started = true;
        i += 1;
        continue;
      }
      // ⭐⭐ F-21 / `SPY-384` — AND **ONLY** A BARE NEWLINE. This branch also
      // matched `\\`+CR+LF and deleted the three-byte run as one continuation.
      // NO SHELL DOES THAT: the escape character retains the literal value of
      // the next character, so `\\`+CR escapes the CARRIAGE RETURN, and the LF
      // that follows is an unescaped newline which TERMINATES the command.
      // Deleting all three fused the next line's verb into the previous word —
      // `echo a\\`+CR+LF+`rm -rf /` parsed as the single command
      // `echo arm -rf /`, and the published 0.6.0 refuses it.
      //
      // ⭐ Measured unanimous on /bin/sh (bash 3.2.57 in sh mode), /bin/bash,
      // /bin/zsh 5.9 and /bin/dash. Falling through leaves the CR in the word
      // (escaped, exactly as the shell has it) and hands the LF to the operator
      // scan, which ends the command — so this can only ADD a boundary.
      // ⭐ 0 of the corpus's 32,175 reachable strings contained a CR at all,
      // which is why no test could see it: a corpus that spells an entity one
      // way cannot falsify a claim about another spelling.
      if (next === '\n') {
        const span = 2;
        // `started` is NOT set: the pair vanishes from the character stream, so
        // it can neither begin a word nor end one. `raw` keeps both characters
        // so CONSERVATION stays exact.
        raw += input.slice(i, i + span);
        i += span;
        continue;
      }
      value += next;
      raw += ch + next;
      quoted = true;
      started = true;
      i += 2;
      continue;
    }

    // ── single quotes: everything literal until the closing quote ──
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end === -1) {
        confident = false; // unbalanced — fail closed
        value += input.slice(i + 1);
        raw += input.slice(i);
        quoted = true;
        started = true;
        i = input.length;
        continue;
      }
      value += input.slice(i + 1, end);
      raw += input.slice(i, end + 1);
      quoted = true;
      started = true;
      i = end + 1;
      continue;
    }

    // ── double quotes: backslash escapes a small set; everything else literal ──
    if (ch === '"') {
      let j = i + 1;
      let inner = '';
      let closed = false;
      while (j < input.length) {
        const c = input[j] as string;
        if (c === '\\') {
          const n = input[j + 1];
          if (n === undefined) break;
          // Inside double quotes a backslash is literal UNLESS it precedes one
          // of $ ` " \ or newline — matching POSIX, so we never diverge from
          // the shell in the direction of seeing LESS than it does.
          //
          // ⭐⭐ F-2c-40 — EXCEPT FOR THE NEWLINE, WHICH POSIX REMOVES ENTIRELY.
          // This arm kept it (`inner += n`), which is the same defect as the
          // unquoted arm above and the second site of `F3-N1`: `rm -rf "\<nl>/"`
          // and `rm -rf "/\<nl>"` were both refused by the published 0.6.0 and
          // both ran at HEAD. A continuation inside double quotes is still a
          // continuation.
          if (n === '\n') {
            j += 2;
            continue;
          }
          inner += n === '$' || n === '`' || n === '"' || n === '\\' ? n : c + n;
          j += 2;
          continue;
        }
        // ⭐⭐ R-CLI-3 / `SPY-438` + `SPY-439` — A COMMAND SUBSTITUTION INSIDE
        // THESE QUOTES IS CODE, NOT TEXT, AND THIS ARM USED TO WALK STRAIGHT
        // PAST IT.
        //
        // POSIX performs command substitution INSIDE double quotes. The interior
        // is a fresh command context where `;` is a real operator, so a complete
        // second command can run there that no glue can reach:
        //
        //     echo "$(a\<newline>b ; rm -rf / ; c)"
        //         published 0.6.0 REFUSES · pre-fix REFUSES · HEAD PERMITTED
        //
        // Walking the span character by character cost two separate things:
        //
        //   1. the interior never reached `substitutions`, so it was never
        //      screened by anything — `substitutions` has exactly ONE consumer
        //      and an interior that is not emitted cannot reach it. The file
        //      header above has always PROMISED this emission; only the bare
        //      `$(` and backtick arms below actually kept the promise.
        //   2. a `"` inside the substitution CLOSED THE OUTER SPAN EARLY, so
        //      `echo "'$(rm -rf /)'"` — where the single quotes are literal and
        //      the substitution really runs — was mis-parsed as well as unseen.
        //
        // Skipping the substitution as a UNIT fixes both, and it is purely
        // additive: the text still lands in `inner` verbatim, `raw` still takes
        // the whole span, and an unterminated substitution fails closed exactly
        // as the bare arm does.
        //
        // ⭐ THE FIX IS HERE AND NOT IN `continuationTails`, AND THAT WAS
        // MEASURED RATHER THAN ARGUED: the same combinations with NO continuation
        // at all are refused by the published 0.6.0 and permitted by BOTH trees,
        // so the hole is inherited and belongs to the parser. Restoring a tail
        // for a pair inside `"…"` would have re-opened the 576-cell prose
        // over-block the previous batch correctly closed.
        if (c === '$' && input[j + 1] === '(') {
          const end = matchClosing(input, j + 2, '(', ')');
          if (end === -1) {
            if (spanEnd(input, j + 2, '(', ')') !== -1) boundExceeded = true;
            confident = false; // unterminated — fail closed, as the bare arm does
            inner += input.slice(j);
            j = input.length;
            break;
          }
          substitutions.push(input.slice(j + 2, end));
          inner += input.slice(j, end + 1);
          j = end + 1;
          continue;
        }
        if (c === '`') {
          const end = input.indexOf('`', j + 1);
          if (end === -1) {
            confident = false; // unterminated — fail closed, as the bare arm does
            inner += input.slice(j);
            j = input.length;
            break;
          }
          substitutions.push(input.slice(j + 1, end));
          inner += input.slice(j, end + 1);
          j = end + 1;
          continue;
        }
        if (c === '"') {
          closed = true;
          break;
        }
        inner += c;
        j += 1;
      }
      // `raw` takes the whole span either way, so no input character is lost.
      value += inner;
      quoted = true;
      started = true;
      if (!closed) {
        confident = false; // unbalanced — fail closed
        raw += input.slice(i);
        i = input.length;
        continue;
      }
      raw += input.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    // ── ⭐⭐ F-2c-41 — THE REMAINING TWO QUOTING FORMS: $'…' AND $"…" ──
    //
    // These are the last two of the shell's FIVE quoting constructs. The other
    // three — the backslash escape, '…' and "…" — are handled above. These two
    // were handled nowhere: `$` is not followed by `(` or `{`, so it fell
    // through to the ordinary-character arm, and the quote that followed was
    // then read as an ORDINARY quoted span. `$'rm'` became the value `$rm`,
    // which `commandBasename` does not equal `rm`, so no rule was selected —
    // AND `confident` stayed TRUE, so the conservative fallback never fired.
    // The same silent-miss shape as the line continuation and the fd strip.
    //
    // ⭐⭐ THE THREE-SITE AUDIT WAS SHORT BY ONE, AND EXECUTION IS WHAT FOUND IT.
    // F-2c-40 answered "what else does this parser do with `confident` true and
    // no basis for it?" with exactly three sites, of which it fixed two and
    // filed `$'…'`. Re-derived at HEAD by comparing the parser's words against
    // a REAL /bin/sh argv over both the command word and the operand, the
    // answer is FOUR: `$"…"` diverges identically and was never tested.
    // Review 3's own fix direction had listed it as an open question
    // ("whether the same blind spot exists for `$\"…\"`, which was not tested
    // here") and nothing tested it. ⭐ An audit that enumerates the constructs
    // the PARSER models cannot find a construct the parser does not model; only
    // one driven from the SHELL's own grammar can.
    //
    // ⭐ BOTH ARE REGRESSIONS, NOT SHARED GAPS. Measured against the byte-
    // verbatim published 0.6.0: `$'rm' -rf /` and `$"rm" -rf /` are BLOCKED by
    // 0.6.0 and were ALLOWED here — 0.6.0 matched raw text, in which `rm` is
    // plainly visible. `F3-N2` was filed as a shared gap on the strength of the
    // OPERAND spelling (`rm -rf $'\x2f'`, which 0.6.0 does miss); the COMMAND
    // spelling is a regression, and the two directions were never separated.
    //
    // ⭐ PLATFORM: both forms are bash/ksh/zsh. Under dash they are inert (`$`
    // stays literal). `runShellCommand` spawns `/bin/sh`, which on macOS — the
    // platform this package is developed and primarily tested on — IS bash.
    // Decoding is also the only direction that can BLOCK MORE, which is the
    // rule this parser is required to follow when the shells disagree.
    if (ch === '$' && input[i + 1] === "'") {
      const end = closingSingleQuote(input, i + 2);
      if (end === -1) {
        confident = false; // unbalanced — fail closed, exactly as '…' does
        value += input.slice(i);
        raw += input.slice(i);
        quoted = true;
        started = true;
        i = input.length;
        continue;
      }
      value += decodeAnsiC(input.slice(i + 2, end));
      // `raw` keeps the WHOLE span — the `$`, both quotes and every escape
      // character — so CONSERVATION stays exact even though `value` shrank.
      raw += input.slice(i, end + 1);
      quoted = true;
      started = true;
      i = end + 1;
      continue;
    }
    if (ch === '$' && input[i + 1] === '"') {
      // Locale translation. With no catalogue loaded a shell yields the string
      // itself, under ORDINARY double-quote rules — so the `$` is consumed here
      // (into `raw`, never into `value`) and the existing double-quote arm does
      // the rest. Reusing that arm rather than copying it keeps one
      // implementation of double-quote semantics, which is the property this
      // file has spent four batches establishing elsewhere.
      raw += ch;
      i += 1;
      continue;
    }

    // ── command substitution: kept LITERAL in the word, interior emitted too ──
    if (ch === '$' && input[i + 1] === '(') {
      const end = matchClosing(input, i + 2, '(', ')');
      if (end === -1) {
        if (spanEnd(input, i + 2, '(', ')') !== -1) boundExceeded = true;
        confident = false;
        value += input.slice(i);
        raw += input.slice(i);
        started = true;
        i = input.length;
        continue;
      }
      substitutions.push(input.slice(i + 2, end));
      value += input.slice(i, end + 1);
      raw += input.slice(i, end + 1);
      started = true;
      i = end + 1;
      continue;
    }
    if (ch === '`') {
      const end = input.indexOf('`', i + 1);
      if (end === -1) {
        confident = false;
        value += input.slice(i);
        raw += input.slice(i);
        started = true;
        i = input.length;
        continue;
      }
      substitutions.push(input.slice(i + 1, end));
      value += input.slice(i, end + 1);
      raw += input.slice(i, end + 1);
      started = true;
      i = end + 1;
      continue;
    }
    // ⭐⭐ R-CLI-3 — `${…}` IS NOT A COMMAND, BUT ITS **WORD** IS A COMMAND
    // CONTEXT, AND THE COMMENT THAT USED TO SIT HERE SAID OTHERWISE.
    //
    // It read *"a parameter expansion, not a command: literal, no interior"*.
    // The first half is true and the second is false: a real shell expands the
    // WORD of `${v:-…}`, so `${v:-$(rm -rf /)}` runs the `rm` — measured on
    // /bin/sh, /bin/bash and /bin/zsh. The expansion itself is still kept
    // literal in `value`; what changes is that its word is now screened.
    //
    // ⭐⭐ THE QUOTING RULE HERE IS NOT THE OBVIOUS ONE AND IT WAS MEASURED
    // BEFORE IT WAS WRITTEN DOWN. Over all 13 POSIX parameter-expansion
    // operators × 3 word quotings × 3 host quotings, decided by execution on all
    // three shells:
    //
    //     a single-quoted word inside a BARE `${…}`         runs in  0 of 13
    //     the same single-quoted word inside `"${…}"`       runs in  4 of 13
    //     a single-quoted HOST (whole expansion quoted)     runs in  0 of 39
    //
    // So single quotes ARE protective in a bare expansion and are NOT protective
    // once the expansion sits inside double quotes — which the double-quote arm
    // above already handles correctly, because there the quotes are literal.
    // A descent that ignored the difference was priced and REJECTED: it refuses
    // `${v:-'$(rm -rf /)'}`, which no shell runs, and that is an unrecoverable
    // capability removal. Hence `substitutionInteriorsOutsideSingleQuotes`.
    if (ch === '$' && input[i + 1] === '{') {
      const end = matchClosing(input, i + 2, '{', '}');
      if (end === -1) {
        if (spanEnd(input, i + 2, '{', '}') !== -1) boundExceeded = true;
        confident = false;
        value += input.slice(i);
        raw += input.slice(i);
        started = true;
        i = input.length;
        continue;
      }
      substitutionInteriorsOutsideSingleQuotes(input.slice(i + 2, end), substitutions);
      value += input.slice(i, end + 1);
      raw += input.slice(i, end + 1);
      started = true;
      i = end + 1;
      continue;
    }

    // ── operators ──
    const op = SHELL_OPERATORS.find((o) => input.startsWith(o, i));
    if (op !== undefined) {
      if (op === '\n' || op === '\r') inComment = false;
      // A leading file-descriptor digit belongs to the REDIRECTION, not to the
      // previous word: `rm -rf /1>x` redirects, it does not name a file `/1`.
      // It is moved out of BOTH `value` and `raw` and into the operator, so
      // both conservation pins stay exact.
      //
      // ⭐⭐ F-2c-40 — THREE DEFECTS AT THIS ONE STRIP, AND THEY ARE THE SAME
      // DEFECT SEEN FROM THREE SIDES.
      //
      //  (1) It left an EMPTY first word. `1>/dev/null rm -rf /` is an ordinary
      //      redirection followed by a command; the strip emptied `value` while
      //      `started` stayed true, so `words[0]` was `""`. `screenCommands`
      //      keys every rule on `commandBasename(head.value)`, so NO rule was
      //      selected while a real shell read the redirection and ran the `rm`.
      //      Measured: **2,280 shapes the published 0.6.0 refuses**, across 57
      //      of 65 fd/operator spellings. `2>` was the one digit that worked,
      //      and only because it is a literal entry in `SHELL_OPERATORS` and so
      //      never reached this code — **the table entry was hiding the fact
      //      that the generic path was broken.**
      //  (2) It took ONE digit. `10>` left `words[0] = "1"` and `rm -rf /10>x`
      //      left the target `/1`. The run is now maximal, which is also the
      //      stricter direction.
      //  (3) It sliced `raw` from the END. For a QUOTED digit (`rm -rf "1">x`)
      //      the last character of `raw` is the closing quote, so the strip
      //      removed a quote and reported a digit — review 2's falsified
      //      CONSERVATION property, at this line. The digits are now removed
      //      from `raw` WHEREVER THEY SIT, so both pins hold together.
      //
      // ⭐ The operator set is the whole `REDIRECT_OPS`, not `>` and `<` alone:
      // `1>&2`, `1>>log` and `12>x` are all fd-carrying spellings, and each was
      // measured regressing.
      let fd = '';
      if (REDIRECT_OPS.has(op) && started) {
        const digits = /\d+$/.exec(value)?.[0] ?? '';
        if (digits !== '') {
          fd = digits;
          value = value.slice(0, -digits.length);
          raw = removeLastDigits(raw, digits.length);
          // ⭐ THE WHOLE WORD WAS THE FILE DESCRIPTOR, so there is no word to
          // emit. Leaving `started` true is what manufactured the empty head.
          if (value === '' && raw === '') started = false;
        }
      }
      if (REDIRECT_OPS.has(op)) {
        flushWord();
        cmd.redirectOps.push(fd + op);
        pendingRedirect = true;
      } else {
        flushCommand(op);
      }
      i += op.length;
      continue;
    }

    // ── ordinary character (this includes `#`, deliberately — see the header) ──
    // ⭐ F-21 — an unquoted `#` at WORD START begins a comment. NOTHING is
    // stripped: landmine 3 stands, and `X=1#; rm -rf /` keeps its payload because
    // that `#` is not at word start. The flag only suppresses the continuation
    // REMOVAL above, which can add a word boundary but never drop one.
    if (ch === '#' && !started) inComment = true;
    value += ch;
    raw += ch;
    started = true;
    i += 1;
  }

  flushCommand(null);
  return { commands, substitutions, strayOperators, confident, boundExceeded };
}

/**
 * Remove the last `count` DIGIT characters from `raw`, wherever they sit.
 *
 * ⭐ Not `raw.slice(0, -count)`. A word's `value` has had its quote characters
 * removed, so the digits that are last in the VALUE need not be last in the
 * RAW: for `"1"` the raw ends with a quote. Slicing blindly removed that quote
 * and pushed a digit into the operator, so the two never reconciled — the
 * conservation property review 2 falsified. Removing the digits themselves
 * keeps the character multiset exact for both spellings.
 */
function removeLastDigits(raw: string, count: number): string {
  const chars = [...raw];
  let removed = 0;
  for (let k = chars.length - 1; k >= 0 && removed < count; k -= 1) {
    if (/\d/.test(chars[k] as string)) {
      chars.splice(k, 1);
      removed += 1;
    }
  }
  return chars.join('');
}

/**
 * Index of the `'` that closes a `$'…'` span opened just before `from`, or −1.
 *
 * ⭐ NOT `indexOf("'")`. Inside ANSI-C quoting a backslash escapes the next
 * character, so `$'it\'s'` closes at the SECOND quote, not the first. Reading it
 * with `indexOf` would end the word early and leave `s'` as separate input —
 * the parser would then disagree with the shell in a NEW place while fixing an
 * old one.
 */
function closingSingleQuote(s: string, from: number): number {
  for (let i = from; i < s.length; i += 1) {
    if (s[i] === '\\') {
      i += 1;
      continue;
    }
    if (s[i] === "'") return i;
  }
  return -1;
}

/**
 * Decode the escapes of an ANSI-C `$'…'` span into the bytes a shell produces.
 *
 * ⭐ DECODE, NEVER DELETE. Deleting the construct would turn `$'\x2f'` into the
 * empty string, and an emptied expansion beside a root operand is exactly the
 * `F-N6` over-block shape this repository already carries. The value must be
 * what the shell will pass, because every rule keys on that.
 *
 * ⭐ An UNRECOGNISED escape keeps its backslash, which is what bash does
 * (`$'\q'` is `\q`) — so the fallback direction preserves characters rather
 * than dropping them, and the parser's "only ever adds, never drops" property
 * survives at this site too.
 */
function decodeAnsiC(span: string): string {
  const simple: Record<string, string> = {
    a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n',
    r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?',
  };
  let out = '';
  let i = 0;
  while (i < span.length) {
    const c = span[i] as string;
    if (c !== '\\' || i + 1 >= span.length) {
      out += c;
      i += 1;
      continue;
    }
    const n = span[i + 1] as string;
    const lit = simple[n];
    if (lit !== undefined) {
      out += lit;
      i += 2;
      continue;
    }
    if (n === 'x') {
      const m = /^[0-9A-Fa-f]{1,2}/.exec(span.slice(i + 2));
      if (m) {
        out += String.fromCharCode(parseInt(m[0], 16));
        i += 2 + m[0].length;
        continue;
      }
    }
    if (n === 'u' || n === 'U') {
      const want = n === 'u' ? 4 : 8;
      const m = new RegExp(`^[0-9A-Fa-f]{1,${want}}`).exec(span.slice(i + 2));
      if (m) {
        out += String.fromCodePoint(parseInt(m[0], 16));
        i += 2 + m[0].length;
        continue;
      }
    }
    if (n === 'c') {
      const k = span[i + 2];
      if (k !== undefined) {
        out += String.fromCharCode(k.toUpperCase().charCodeAt(0) ^ 0x40);
        i += 3;
        continue;
      }
    }
    const oct = /^[0-7]{1,3}/.exec(span.slice(i + 1));
    if (oct) {
      out += String.fromCharCode(parseInt(oct[0], 8) & 0xff);
      i += 1 + oct[0].length;
      continue;
    }
    // Unrecognised: bash keeps the backslash AND the character.
    out += c + n;
    i += 2;
  }
  return out;
}

/**
 * ⭐ R-CLI-4 — where does this construct END? Same quote handling as
 * `matchClosing`, and NO depth cap, because the end of a span is a fact about
 * punctuation while the cap is a decision about how deep we model. Returns −1
 * only for genuinely MALFORMED input.
 *
 * It is used ONLY to answer "was the −1 a bound, or was it malformed input?".
 * It never changes `confident`, never changes what is emitted, and never
 * changes where the parse stops.
 */
function spanEnd(s: string, from: number, open: string, close: string): number {
  let depth = 1;
  for (let i = from; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\') { i += 1; continue; }
    if (c === "'") { const end = s.indexOf("'", i + 1); if (end === -1) return -1; i = end; continue; }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue; }
        if (s[j] === '"') { closed = true; break; }
        j += 1;
      }
      if (!closed) return -1;
      i = j;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * Index of the `close` that balances an `open` opened just before `from`.
 *
 * ⭐⭐ F-2c-25 — THIS TRACKS QUOTE STATE, AND THE REASON IS A MEASUREMENT.
 * It used to count every `(` and `)` in the span, quoted or not. A real shell
 * does not: inside `"…"` or `'…'` a parenthesis is an ordinary character. The
 * consequence was not exotic — measured over a 105-command benign corpus,
 * **8 ordinary commands** parsed as malformed, and the cheapest of them was
 * `echo $(grep -c "(" src/index.ts)`: ONE quoted paren is enough, because the
 * unmatched `(` inside the quotes drives depth to 2 and the real `)` only
 * returns it to 1. The same corpus carries **120 parens inside quotes**.
 *
 * That mattered far beyond fidelity: an unbalanced count returns −1, −1 sets
 * `confident = false`, and the caller's fallback is the screen's weakest arm.
 * A parser that mis-reads ordinary input into its fail-closed path makes that
 * path load-bearing for commands that were never malformed.
 *
 * ⭐ The depth BOUND is unchanged (`MAX_SUBSTITUTION_DEPTH`), deliberately:
 * raising a bound moves a boundary and leaves the shape behind it.
 */
function matchClosing(s: string, from: number, open: string, close: string): number {
  let depth = 1;
  for (let i = from; i < s.length; i += 1) {
    const c = s[i];
    if (c === '\\') {
      i += 1;
      continue;
    }
    // A quoted region contributes NO nesting — skip it whole. An unterminated
    // quote is malformed input: return −1 so the caller fails closed, exactly
    // as it does for an unterminated substitution.
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let closed = false;
      while (j < s.length) {
        if (s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === '"') {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) return -1;
      i = j;
      continue;
    }
    if (c === open) {
      depth += 1;
      if (depth > MAX_SUBSTITUTION_DEPTH) return -1;
    } else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Command names that RUN ANOTHER COMMAND given as their arguments. The real
 * command word sits after them, so screening must look past them or
 * `env VAR=1 rm -rf /` reads as an invocation of `env`.
 *
 * ⭐ This list is deliberately SHORT and explicit. It is not "anything that
 * takes a command": `git` must NOT be here, or `git rm -rf src/old` — a pinned
 * BENIGN command — would read as `rm -rf src/old`.
 */
export const COMMAND_WRAPPERS = new Set([
  'env',
  'sudo',
  'doas',
  'nice',
  'ionice',
  'nohup',
  'command',
  'time',
  'timeout',
  'stdbuf',
  'setsid',
  'xargs',
  // ⭐ F-2c-25 — `exec rm -rf /` replaces the shell with `rm`. The published
  // 0.6.0 blocked it (its text net never asked what the head word was); the
  // word-axis screen read the head as `exec` and let it through. 55 shapes.
  'exec',
]);

/**
 * ⭐⭐ F-2c-25 — SHELL RESERVED WORDS ARE NOT COMMANDS.
 *
 * `if true; then rm -rf /; fi` splits into three simple commands whose heads are
 * `if`, `then` and `fi`. Nothing named `rm` is ever a head, so every rule that
 * keys on the head word is silently skipped — including the DEVICE rule, which
 * the published 0.6.0 caught (`if true; then dd … of=/dev/sda; fi`) precisely
 * because its text net never parsed and so never cared what the head was.
 * Measured over a generated corpus: **200 shapes** regressed on this cause
 * alone, across `if/then/else/elif`, `for/while/until … do`, and `case`.
 *
 * These are stripped the same way a wrapper prefix is: they are words that are
 * not the command being run. `in`, `esac`, `fi` and `done` are included so that
 * `for x in 1` and a bare `esac` resolve to something, or to nothing, rather
 * than to a head that happens to match a rule name.
 */
const SHELL_RESERVED = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'for',
  'do',
  'done',
  'case',
  'esac',
  'in',
  'select',
  'function',
  'coproc',
  '!',
]);

/** Wrappers whose first non-flag argument is a NUMBER, not the command. */
const NUMERIC_ARG_WRAPPERS = new Set(['timeout', 'nice', 'ionice']);

/** `/bin/rm` → `rm`. Windows-style separators are not shell paths; ignore them. */
export function commandBasename(token: string): string {
  return token.slice(token.lastIndexOf('/') + 1);
}

/**
 * The effective argv of `cmd` — the command word and its operands with any
 * COMMAND_WRAPPERS prefix removed, so `env X=1 sudo rm -rf /` resolves to
 * `rm -rf /`. Returns the words unchanged when no wrapper is present.
 */
export function effectiveWords(cmd: SimpleCommand): ShellWord[] {
  let words = cmd.words;
  // ⭐ F-2c-25 — the bound is the WORD COUNT, not the constant 4. Each turn of
  // this loop either returns or removes at least one word (`k >= 1` always), so
  // it terminates by construction; the old `guard < 4` could not prevent a hang
  // that was already impossible, and its only measurable effect was to let a
  // FIFTH wrapper through — `env env env env env rm -rf /`, which the published
  // 0.6.0 blocked. 110 shapes measured on this cause.
  const bound = cmd.words.length + 1;
  for (let guard = 0; guard < bound; guard += 1) {
    const first = words[0];
    if (first === undefined) return words;
    const name = commandBasename(first.value).toLowerCase();
    // A leading shell reserved word is not the command; drop it and re-read.
    if (SHELL_RESERVED.has(name)) {
      words = words.slice(1);
      continue;
    }
    if (!COMMAND_WRAPPERS.has(name)) return words;
    let k = 1;
    // Skip the wrapper's own options and any inline NAME=value it carries.
    while (k < words.length) {
      const v = (words[k] as ShellWord).value;
      if (v.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
        k += 1;
        continue;
      }
      break;
    }
    // `timeout 5 rm -rf /` — the duration is not the command.
    const candidate = words[k];
    if (candidate !== undefined && NUMERIC_ARG_WRAPPERS.has(name) && /^[\d.]+[a-z]?$/i.test(candidate.value)) {
      k += 1;
    }
    if (k >= words.length) return words.slice(k);
    words = words.slice(k);
  }
  return words;
}

/**
 * ⭐⭐ F-2c-40 — EVERY ARGV THE SCREEN MUST CONSIDER FOR ONE SIMPLE COMMAND.
 *
 * `effectiveWords` returns ONE reading, and to return one reading it has to
 * decide which word is the command. For a wrapper it decides by skipping words
 * that start with `-` and taking the next one — which is right for `timeout 5
 * rm -rf /` and WRONG for `timeout -s KILL 5 rm -rf /`, because `-s` consumes
 * the following value and the screen was handed `KILL` as the command word.
 * Measured at F-2c-40: **3,800 shapes the published 0.6.0 refuses ran at HEAD**
 * across all 13 wrappers, while the one-token spellings (`--signal=KILL`, `--`)
 * were untouched at 0 — so the defect is the OPTION ARITY, not the name list.
 *
 * ⭐⭐ THE FIX IS NOT AN ARITY TABLE, BECAUSE AN ARITY TABLE IS THE HAND-LIST
 * THAT FAILED ONE LEVEL DOWN. `SAFE_DEVICES`, `SHELL_RESERVED` and
 * `COMMAND_CARRIERS` are three recorded instances of this project widening a
 * list and being overtaken by the next member of it. Nobody can enumerate every
 * option of every wrapper, and the enumeration would have to be right on a host
 * whose `env` is not this one's.
 *
 * So the rule is the one this file already applies wherever it does not know
 * which token is the command — the unconfident fallback, the carrier's second
 * reading, the foreign-code path: **WE DO NOT KNOW, SO EVERY CANDIDATE IS
 * OFFERED.** This returns the wrapper-stripped reading FIRST (unchanged, so
 * adjacency-sensitive rules see the real command first) and then every suffix.
 * It can only ever ADD candidate readings, never remove one, which is the
 * direction a guard must err in (PROJECT_PLAN §4 landmine 18).
 *
 * ⭐ It is FLAT — a `for` loop over suffixes, not recursion. A chain of N
 * wrappers costs N candidates rather than 2^N, so `env env env env env rm -rf /`
 * cannot turn the screen into a hang. Measured over the benign corpora: 0 newly
 * blocked.
 */
export function candidateArgvs(cmd: SimpleCommand): ShellWord[][] {
  const primary = effectiveWords(cmd);
  const key = (ws: ShellWord[]): string => ws.map((w) => w.value).join(' ');
  const out: ShellWord[][] = [primary];
  const seen = new Set<string>([key(primary)]);
  const offer = (ws: ShellWord[]): void => {
    if (ws.length === 0) return;
    const k = key(ws);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(ws);
  };

  // ⭐⭐ F-11 / D7-1 — THE SUFFIX READING IS NO LONGER GATED ON A NAME LIST.
  //
  // This block used to run only when the head was in `COMMAND_WRAPPERS`. That
  // made a 13-name hand-list load-bearing for the whole screen: a binary that
  // execs its argv but is not IN the list produced NO suffix candidate at all,
  // so every rule keyed on the head word and matched nothing. Measured against
  // the published 0.6.0: `arch -arm64 rm -rf /`, `ssh-agent rm -rf /` and
  // `sandbox-exec -p x dd … of=/dev/disk0` were REFUSED by the artifact users
  // run and ALLOWED here — at `matchesCatastrophic`, the one control `--yes`
  // cannot override.
  //
  // ⭐ The class was counted from the EXTERNAL GRAMMAR, not from this file:
  // every man1/man8 page on the host, read as a file, filtered to those whose
  // own SYNOPSIS shows a command operand followed by an args ellipsis. Ten such
  // binaries are present here that NEITHER shipped table names. Widening the
  // list would have closed those ten and left the eleventh — which is the exact
  // failure mode `COMMAND_CARRIERS`' own header records three times.
  //
  // ⭐⭐ So the list comes OUT of the load-bearing path instead. This is the
  // rule the rest of this function already follows — WE DO NOT KNOW WHICH TOKEN
  // IS THE COMMAND, SO EVERY CANDIDATE IS OFFERED — and it can only ADD
  // readings, never remove one. Priced prospectively over 43,401 cells built
  // from this package's own corpora: 234 shapes the published 0.6.0 refuses
  // close, and NEW over-blocks and NEW under-blocks are both ZERO.
  if (cmd.words[0] !== undefined) {
    for (let start = 1; start < cmd.words.length; start += 1) offer(cmd.words.slice(start));
  }

  // ⭐ AN EMPTY HEAD NAMES NOTHING A SHELL CAN RUN. The fd strip above no longer
  // manufactures one, but a quoted empty word (`"" rm -rf /`, `"1">x rm -rf /`)
  // still can, and a rule set keyed on the head word would select nothing for
  // it. Offering the remainder costs one candidate and closes the shape rather
  // than the instance.
  if (primary[0] !== undefined && primary[0].value === '') offer(primary.slice(1));

  // ⭐⭐ F-11 / D7-2 — A WRAPPER WORD CONTAINING WHITESPACE IS A PACKED COMMAND.
  //
  // `env -S "rm -rf /"` and `env --split-string=…` pack a whole command LINE
  // into ONE word. env(1) documents `-S` on BSD and GNU alike as splitting that
  // word back into words, so the command really runs — but after the wrapper
  // prefix is stripped there is either NO head at all (the attached spellings
  // consume every word as an option) or a head that is a STRING rather than a
  // command NAME, and every rule in this screen keys on a name. All four
  // documented spellings were REFUSED by the published 0.6.0 and ALLOWED here.
  //
  // ⭐ This deliberately does NOT model `-S`. Any wrapper option, on any host,
  // that packs a command into one word is covered — the same reasoning that
  // makes the suffix reading above an offer rather than an option-arity table.
  //
  // ⭐⭐ AND IT IS SCOPED TO A WRAPPER'S OWN WORDS ON PURPOSE. The unscoped
  // version — split ANY candidate head containing whitespace — was priced over
  // the same 43,401 cells and REFUSED `echo "rm -rf /" >> notes.md` and
  // `grep -r "rm -rf /" docs/`: an ordinary command's DATA read as a command.
  // Neither the suffix rule nor the split rule does that ALONE; only the two
  // composed do, which is why they were priced composed before either shipped.
  // A wrapper's words are the only place a packed command line stands in
  // COMMAND position. Both benign rows are pinned in `PACKED_WORD_BENIGN`.
  const packHead = cmd.words[0];
  if (packHead !== undefined && COMMAND_WRAPPERS.has(commandBasename(packHead.value).toLowerCase())) {
    for (const w of cmd.words.slice(1)) {
      if (!/\s/.test(w.value)) continue;
      const parts = w.value.trim().split(/\s+/).filter((p) => p.length > 0);
      if (parts.length < 2) continue;
      const mk = (ps: string[]): void => offer(ps.map((v) => ({ value: v, raw: v, quoted: false })));
      mk(parts); // `-S "cmd …"` — the payload is its own word
      const first = parts[0] as string;
      const eq = first.indexOf('=');
      // `--split-string=cmd …` — the payload starts after the '='
      if (eq >= 0) mk([first.slice(eq + 1), ...parts.slice(1)]);
      // `-Scmd …` — an attached short-option value
      else if (/^-[A-Za-z]/.test(first) && first.length > 2) mk([first.slice(2), ...parts.slice(1)]);
    }
  }

  // ⭐⭐ F-2c-42 — A HEAD WORD THE SHELL WILL RESOLVE TO SOMETHING ELSE.
  //
  // Every rule keys on `commandBasename(head.value)` — the head as WRITTEN. A
  // shell resolves `$(echo)rm`, `${NOPE}rm` and `r$(echo)m` all to the single
  // word `rm`, and DROPS an unquoted empty expansion that stands alone, so
  // `$EMPTY rm -rf /` runs `rm`. The primitive that answers this — the
  // expansion stripper — already existed in this package and was applied to
  // TARGETS only, never to the head.
  //
  // ⭐ TWO READINGS, BECAUSE THE TWO SHAPES DIFFER. A decoration GLUED to the
  // word changes what the word IS; a decoration standing as its OWN word makes
  // the field vanish and the NEXT word becomes the command. Both are OFFERED,
  // never substituted — an expansion may also produce something that is not
  // empty (`$(which rm)`), so the written reading has to survive alongside.
  //
  // ⭐ This is the same rule the rest of this function follows: we do not know
  // what the word will become, so every candidate is offered. It can only ever
  // add readings, which is the direction a guard must err in.
  const written = primary[0];
  if (written !== undefined && hasExpansion(written.value)) {
    const resolved = stripExpansions(written.value);
    if (resolved === '') offer(primary.slice(1));
    else if (resolved !== written.value) offer([{ ...written, value: resolved }, ...primary.slice(1)]);
  }

  return out;
}
