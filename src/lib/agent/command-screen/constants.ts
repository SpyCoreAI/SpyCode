import { SHELL_OPERATORS } from '../shell-parse.js';

/**
 * Screen tables (M-8 split of command-screen.ts). `export` here means
 * "shared with a sibling screen module", not public API: the barrel
 * (command-screen.ts) re-exports only the original public names.
 */

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
export const DOWNLOADERS = new Set(['curl', 'wget', 'fetch']);

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
export const SAFE_DEVICE_TERMINALS = /^\/dev\/(?:console|tty[0-9]+|ttys[0-9]+|tty[p-za-e][0-9a-f])$/;

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
export const DISK_IDENTIFIER = /^disk\d+(?:s\d+){0,2}$/;

/** SSH keys, shell-init files and system auth databases - injection or lockout. */
export const SENSITIVE_FILE =
  /^(?:(?:~|\$\{?home\}?)\/\.(?:ssh(?:\/|$)|bash_profile|bash_login|bashrc|zshrc|zshenv|zprofile|profile|inputrc)|\/etc\/(?:passwd|shadow|sudoers))/i;

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

export const SYSTEM_DIR = new RegExp(`^/(${SYSTEM_TREE_SEGMENTS.join('|')})(/|$)`, 'i');

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
export const DATA_CONTAINER = new RegExp(`^/(${DATA_CONTAINER_SEGMENTS.join('|')})(/\\*?|/[^/]+/?)?$`, 'i');

/** The container itself only. */
export const INSTALL_CONTAINER = new RegExp(`^/(${INSTALL_CONTAINER_SEGMENTS.join('|')})(/\\*?)?$`, 'i');

export const ROOT_OR_TILDE = new Set(['/', '/*', '~', '~/', '~/*']);

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
export const LEADING_EXPANSION = /^(?:\$\(|`|\$\{|\$[A-Za-z_])/;

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

export interface DeviceWriteVerb {
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

export const RECURSIVE_FLAG = (f: string): boolean => /^-[a-z]*r/i.test(f) || f === '--recursive';

export const FORCE_FLAG = (f: string): boolean => /^-[a-z]*f/i.test(f) || f === '--force';

/**
 * The operators that SEPARATE commands, derived from `SHELL_OPERATORS` by
 * removing the four GROUPING characters. Grouping is excluded deliberately: the
 * fallback splits raw text, and splitting on `{`/`}`/`(`/`)` shreds `${HOME}`
 * and `$(…)` into fragments that no rule can recognise. Every token still gets
 * screened as a candidate head, so a group's contents are not lost.
 */
const FALLBACK_SEPARATORS = SHELL_OPERATORS.filter((o) => !['(', ')', '{', '}'].includes(o));

/** Longest-match-first alternation, CAPTURING so the operator itself survives. */
export const OPERATOR_SPLIT = new RegExp(
  `(${[...FALLBACK_SEPARATORS]
    .sort((a, b) => b.length - a.length)
    .map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})`,
);

/** The operators that introduce a redirection - mirrors the parser's set. */
export const FALLBACK_REDIRECTS = new Set(['>', '>>', '<', '<<', '2>', '&>', '>&']);

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
