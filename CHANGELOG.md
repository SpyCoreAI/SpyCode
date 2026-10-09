# Changelog

All notable changes to `@spycore/cli` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## 0.9.3 - 2026-10-09

Security maintenance release. No behavior change. No flag changes in this
release: every command, flag (`--json`, `--max-turns`, `--max-tool-calls-per-turn`
and `--tool-protocol` included), default, prompt and event stream behaves
exactly as in 0.9.2.

### Fixed

- **Patched development dependencies.** `source-map-js` 1.2.1 → 1.2.2.
- **CI hardening.** Workflow now runs with `permissions: contents: read`.

## 0.9.2 - 2026-10-09

Internal restructuring release with zero behavior change. No flag changes in
this release: every command, flag (`--json`, `--max-turns`,
`--max-tool-calls-per-turn` and `--tool-protocol` included), default, prompt
and event stream behaves exactly as in 0.9.1.

### Changed

- **Agent loop decomposed.** `runAgent` (`src/lib/agent/loop.ts`) is now an
  orchestrator over six focused modules: `run-events.ts` (event sink and
  budget reporting), `run-context.ts` (skills, change journal, tool context
  and approval tracking), `run-delegate.ts` (sub-agent delegation),
  `run-dispatch.ts` (observation window, lifecycle hooks and per-turn
  dispatch), `run-session.ts` (MCP bring-up, conversation open and
  tool-protocol negotiation) and `run-prompt.ts` (first-turn prompt
  assembly). The exports of `loop.ts` are unchanged.
- **Tool module split.** `src/lib/agent/tools.ts` is split into
  `tool-core.ts` (tool contracts and sandbox helpers), `command-screen.ts`
  (the command screener), `builtin-tools.ts` (the built-in tools and shell
  execution) and a slimmed `tools.ts` (registry, dispatch and declarations).
  `tools.ts` re-exports every moved public name, so all existing imports keep
  working.
- **No runtime import cycles.** `command-rules.ts` now imports the screener
  from `command-screen.ts`, which removes the only runtime import cycle in
  `src/`.

### Tests

- New pins for the restructured seams: golden fenced and native runs,
  first-turn prompt bytes, per-run state isolation, the per-turn tool-call
  cap, delegation inheritance, MCP and language-server teardown, tool order
  and the prompt catalogue, the public export surface, lazy imports, and the
  absence of runtime import cycles.

## 0.9.1 - 2026-10-08

### Added

- **`/new` session command.** Start a fresh session without quit+relaunch;
  resets transcript, undo history, title, sidebar, and metering.
- **Transcript search (Ctrl+F).** Search bar with live hit count,
  Enter/Shift+Enter navigation, and inline match highlighting.
- **Composer word-wise editing.** Alt+Left/Right or Ctrl+Left/Right jumps by
  word with readline semantics.
- **`agent --dry-run`.** Zero-cost preview of what the agent would do; no
  model calls, no execution.
- **MCP approval arg expansion.** `[e]` expands truncated args in approval view.
- **`--format` flag.** Added to memory, projects, runs, skills, mcp, and
  provider list commands.

### Changed

- **Parallel read-only dispatch.** Consecutive read-only tool calls in a turn
  now run concurrently; mutating calls stay serial. Results keep index order.
- **Unified run configuration.** Chat and agent front-ends share single
  resolvers for web tools, observe mode, max turns, and budget caps.
- **Unified command screening.** One canonical shell-safety implementation.
- **Unified secret handling.** Clear ownership: redact.ts scrubs values,
  secrets.ts guards paths, sanitize-display.ts handles terminal safety.
- **Shared text utilities.** New `src/lib/text.ts` consolidates duplicated
  helpers.
- **Skill trust-gating.** Project skills require trusted workspace, like
  MCP/hooks.
- **LSP diagnostics.** Replaces slow `npx tsc` subprocess with direct LSP.

### Fixed

- **SSE stall timeout.** Quiet-but-open sockets abort after 60s idle instead
  of hanging forever.
- **Tool-call cap per turn.** Default 50, configurable via
  `--max-tool-calls-per-turn`; excess calls skipped with notice.
- **CLI-wide dispatch timeout.** 10-minute bound on dispatchTool; approval
  time not billed.
- **Grep hardening.** 1000-char pattern limit, 10k match cap with marker,
  shared realpath cache.
- **Temp file security.** O_EXCL creation prevents symlink attacks.
- **Runs log sanitization.** Raw log bytes now pass through display sanitizer.
- **BYOK warnings.** Warns on http:// base-url and vendor key mismatches.
- **Confirm on remove.** `mcp remove` / `provider remove` prompt y/N.
- **Undo honesty.** All undo surfaces state file-changes-only bound.
- **Undo lists files.** Confirm shows filenames, not just count.
- **Events array cap.** Bounded at 10k to prevent memory growth.
- **Per-run guard memoization.** Secret/gitignore checks cached per run.

### Documentation

- **ARCHITECTURE.md.** New document mapping the codebase.
- **CONTRIBUTING.md.** Expanded from 632 bytes with setup, conventions, and
  checklists.

### Tests

- 205 new tests across 20 modules; gap-fill tests for memory.ts; LSP
  subsystem tests (31); transcript search tests; SSE timeout tests.

## 0.9.0 - 2026-10-07

### Added

- **Sub-agent delegation.** The agent can delegate sub-tasks to child agent
  runs via a `delegate` tool, with strict depth limits and token budgets.
  Delegation depth renders in the transcript as a tree (`└`/`+` prefixes,
  width-compensated).
- **LSP integration.** Language-server client (TypeScript, Go, Python,
  Rust) with live compiler diagnostics surfaced through a `diagnostics`
  tool and status-bar diagnostic counts.
- **Scheduled prompts CLI.** `spycode cron add/list/remove` manages the
  platform's scheduled prompts from the terminal (`cron add` takes
  `--prompt`, `--schedule`, and `--model`; `cron remove` takes `--yes`).
- **Auto-compact.** At ~95% context usage the session auto-summarizes and
  starts fresh carrying the summary; manual `/compact` remains. The TUI
  shows a context-full warning before the limit is reached.
- **Customizable keybindings.** User rebinds via the `keybindings` config;
  a resolved keybinding table drives input dispatch with fail-closed
  resolution, and `/help` renders from the table.
- **Theme gallery and picker.** `/theme` opens a visual picker; gallery
  themes apply immediately and persist across restarts.
- **External editor.** `Ctrl+O` opens `$EDITOR` for composing long messages.
- **Named arguments in custom commands.** `$NAME`-style placeholders
  prompt for values before running.
- **Session share.** Publishable share link for a session via
  `conversations share`.

### Changed

- **Message visual language.** Role-colored left borders on messages,
  muted borders for tool calls, assistant footers showing model and
  elapsed time.
- **Typed tool-result rendering.** Diffs for edits, syntax-highlighted
  code blocks for file views, shell-styled blocks for bash output, and
  error color for failures.

## 0.8.0 - 2026-10-06

### Added

- **Interactive TUI.** Bare `spycore` (no arguments) on a real terminal now
  opens a Claude-Code-class interactive TUI: composer with history and slash
  commands (`/help /model /diff /undo /usage /compact /resume /theme /clear
  /exit`), `@` file mentions, `!` shell mode, Ctrl+P command palette, inline
  approval panels, live token streaming, session persistence, and OS
  notifications. All existing commands, flags, piped input, and non-TTY
  behavior are unchanged. No flag changes in this release - `spycore --help`
  and every other command, flag, and default behave exactly as in 0.7.5.

## 0.7.5 - 2026-10-04

### Fixed

- **Dependency updates.** Updated fast-uri to 3.1.8 (security fix) and pinned
  braces to 3.0.3. No flag changes in this release - `spycore whoami --json`
  and every other command, flag, and default behave exactly as in 0.7.4.
- **Config file permissions.** Config files written by earlier versions are
  tightened to owner-only (0600) when loaded.

## 0.7.4 - 2026-10-03

### Fixed

- **Internal comment cleanup.** Reworded internal code comments for clarity.
  No flag changes in this release - `spycore whoami --json` and every other
  command, flag, and default behave exactly as in 0.7.3.

## 0.7.3 - 2026-10-03

### Fixed

- **Internal comment cleanup.** Reworded internal code comments for clarity.
  No flag changes in this release - `spycore whoami --json` and every other
  command, flag, and default behave exactly as in 0.7.2.

## 0.7.2 - 2026-10-03

### Fixed

- **Dependency updates.** Updated undici to 6.28.1 (security fix). No flag
  changes in this release - `spycore whoami --json` and every other command,
  flag, and default behave exactly as in 0.7.1.

## 0.7.1 - 2026-10-02

### Fixed

- **Minor refinements.** Small refinements to wording in user-facing text
  across the CLI. No flag changes in this release - `spycore whoami --json`
  and every other command, flag, and default behave exactly as in 0.7.0.

## 0.7.0 - 2026-08-28

Security hardening plus one capability change to `rewind`, and one new flag for
it, and the completion/schema surface brought up to the code. No new commands,
no dependency changes.

### Changed - user-visible

- **A destructive command hidden behind ordinary-looking punctuation is refused
  again.** The command screen works out what a line will actually run before
  anything runs it. When a line contained a command substitution nested more
  deeply than the screen modelled, it stopped forming its own reading of the
  text - and at the top level that is not a statement about the line at all, so
  a `$(…)` chain in front of a command could switch off the check that stops
  it. The `$` is what carries it: a run of plain parentheses never did, and the
  same hole opened for a parameter expansion such as `${v:-…}`, which needs no
  parentheses at all. That state of this package was never released - the
  published 0.6.0 refuses `arch -arm64 rm -rf /` behind every one of those
  shapes, so it was never a gap you had. It is refused here too.
- **A command wrapped in quotes inside another command is now read all the way
  in.** The screen's double-quote handling walked a quoted span character by
  character and never descended into a command substitution inside it, so the
  inside of `"$(…)"` was never handed to the one check that reads it. It is now
  read to four levels of nesting; beyond that the screen does not descend.
- **A mention of a command is no longer treated as the command.** Writing a
  dangerous command's name as *data* - passing it to `echo`, or naming it inside
  a string - is not running it, and the screen used to conflate the two in one
  direction. Telling them apart is what lets the tightening above happen without
  refusing ordinary work.

  Measured against the published 0.6.0 over this package's own corpus of
  **27,001** command shapes: **7,567** shapes that 0.6.0 permits are refused
  here, and **19,156** are refused by both. **70** shapes go the other way - all
  **70** are inside a set this package names and pins as spellings 0.6.0 refused
  for the wrong reason, and **0** fall outside it. Against the separate corpus of
  **3,520** ordinary everyday commands, **0** became newly refused, and **5**
  commands the published 0.6.0 wrongly refuses now run.

- **Editing your own files while a run waits for your approval no longer makes
  `spycore rewind` undo your work.** The change journal for an opaque call -
  `run_command`, an MCP tool, a tool hook - is built by comparing the workspace
  before and after the call, and the approval prompt sat inside that comparison.
  A decision has no time limit, so anything you typed in another window during it
  was recorded as the call's own work: measured through the shipped journal, a
  `run_command true` that changed **nothing** journaled an edit made at the
  prompt as a modification and a new file as a creation, and `spycore rewind`
  then reverted the edit and **deleted the file** - `restored=2 skipped=0`. The
  no-clobber guard could not help, because the content it compares against is the
  content the journal recorded. The wait is now excluded: when the prompt closes,
  whatever changed while it was open joins the "before" picture and is named in a
  notice instead. Counted from the operating system's side rather than from the
  observer - the three operations a second writer can perform × approve and
  reject × the two shapes that open a window - **12 of 12 forms were attributed
  before this change and 0 after**, including a one-character edit that leaves the
  byte length unchanged. The call's own writes are unaffected: a file you touch at
  the prompt and the command then edits too is still journaled, with **your**
  content as the state `rewind` restores.
   Journal coverage is unchanged in every direction, and that was the constraint
  rather than an afterthought: a pre-tool hook runs **before** the prompt, so
  simply moving the snapshot later would have silently stopped journaling it.
  Measured on one 2,500-file workspace before the approach was chosen, re-taking
  the whole picture at both ends of the wait costs **2.00×** the observation; this
  costs **1.03×**, because the wait is bracketed by a size-and-timestamp census
  rather than a second read of every file.
- **A run that changes hundreds of files at once writes its journal once instead
  of once per file.** The journal is rewritten whole on every record, so a single
  command that touched N files cost O(N²): measured at 4 KB per record, 25/50/100/
  200/400 records took 7.3/19.7/54.7/150.8/504.6 ms, and nothing bounded N - an
  ordinary repository-wide formatter run touching 2,000 files extrapolates to
  **10.3 s and 8.2 GB** of journal rewrites, and 819 GB at the observer's file
  cap. The
  workspace comparison now hands its whole result over at once, so **one call is
  one journal write** whatever N is, and the hash each record carries is computed
  once rather than recomputed on every subsequent write. The journal file itself
  is byte-for-byte what it was.
- **Writing to a raw block device is now refused whatever verb names it -
  and reading one still is not.** The guard already refused `dd if=… of=/dev/sda`,
  `tee /dev/sda` and `echo x > /dev/sda`, and it correctly recognised every one
  of those paths as a raw device. What it never did was ask the same question
  about any other verb, so `cp ./f /dev/sda` and `chmod 666 /dev/sda` ran - as
  did 32 more. Counted from the utilities' own synopses rather than from the
  guard: **34 verbs × 21 raw devices = 714 forms, all 714 allowed before this
  change and 0 after**, plus **136 of 136** attempts to walk out of a safe
  device family with `..` (`cp ./f /dev/fd/../sda`). Each verb is screened only
  in the operand position its own synopsis calls a destination - `cp
  source_file target_file`, `chmod mode file ...` - so **reading a device is
  untouched**: `dd if=/dev/sda of=./backup.img`, `cp /dev/sda ./backup.img`,
  `fdisk -l /dev/sda`, `parted /dev/sda print`, `smartctl -a /dev/sda` and
  `tar xf /dev/st0` all still run. Measured against the guard's benign corpus,
  extended for this change from 1,264 to **2,071** ordinary commands: **0 became
  refused.** (That corpus has kept growing since, and the figure quoted below
  is an earlier snapshot of the same set, not a competing count: it stood at
  **1,264** before this change, **2,071** after it, and **3,520** at this
  release. Against all 3,520, **0** are newly refused.)
   Three cheaper-looking versions of this fix were measured first and rejected
  on that number. All three refuse exactly as much of the dangerous grid, and
  all three refuse disk imaging, which is a legitimate thing to do: screening
  the same write positions without a read-mode allowlist costs **273**
  over-blocks, screening every operand of the named verbs costs **315**, and
  screening every operand of every command costs **462**.
- **A catastrophic command hidden inside another command's argument is now
  refused too.** The guard used to ask "what is this command?" and answer it
  from the first word, so a destructive command handed to something else to run
  - `trap 'rm -rf /' EXIT`, `find . -exec rm -rf / ';'`, `ksh 'rm -rf /'`,
  `csh -c 'rm -rf /'` - was never looked at. It now screens the operands of a
  command that runs another command, using the same rules and the same refusal
  message. Measured against the published 0.6.0 over the guard's own grid of 58
  destructive commands × 33 carrier spellings: **312 forms that 0.6.0 allows are
  refused here**, and **0 ordinary commands became refused** across the everyday
  commands the guard's own corpora carry - `trap 'echo done' EXIT`,
  `find . -name '*.log' -exec rm -f {} ';'`, `caffeinate -i npm test` and
  `npx tsc --noEmit` all still run. Two spellings in that grid are controls that
  carry nothing (a bare command, and one run through `env`); they contribute
  **16** of the 312 - eight cores whose own verdict changed, counted once under
  each control - and each of the other **31** spellings contributes as well.
   A number quoted here previously - 988 - described something else, and it is
  corrected rather than dropped: it counted forms that 0.6.0 already refused and
  an *unreleased* intermediate state of this package briefly allowed. Nobody ran
  that state, so it was never a gap you had. **312 is the figure that describes
  what changes for you.**
   The benign corpus this was measured against was once too narrow to support
  the claim - 116 everyday commands, almost none of the one shape newly being
  refused. It carried **1,199** by the time that was fixed and **3,520** at this
  release, and it now derives the relevant part of itself from the guard's own
  protected list - see the next bullet, which is what it found.

- **Ordinary commands that build a path out of a shell variable are no longer
  refused.** `rm -rf "$OUT/lib"`, `chmod -R 755 "$OUT/bin"`,
  `find "$BUILD/var" -name '*.log' -delete` and
  `echo x > "$FIXTURES/etc/passwd"` were all refused by this tree and allowed by
  0.6.0. The guard removes an unexpanded `$VAR` so it can judge what a word will
  become - which is right for `/$(true)`, and wrong when the variable is the
  *first* thing in the word, because deleting it does not reveal where the path
  starts, it invents a beginning. `"$OUT/lib"` became `/lib`, a relative path
  read as an absolute one. **Measured: 924 such forms refused here and 0 by
  0.6.0**, and - because the refusal is raised before approval, before the
  command rules and before `--yes` - it was the only refusal in the package that
  nothing could override. A word whose first character starts an expansion is
  now judged only on what its own text actually says.

- **`rm -rf /Users`, `rm -rf /home` and their kin are now refused.** The
  protected list was the Unix system tree - `/usr`, `/etc`, `/var` - and did not
  include the directory that holds every user's home. On macOS `rm -rf /Users`
  destroyed every home directory on the machine and no check in the package said
  anything; the same was true of `/home`, `/Volumes`, `/mnt`, `/media`, `/srv`,
  `/Applications`, `/Library` and `/System`, in this version **and in 0.6.0**.
  The container and one whole unit inside it (`/Users/alice`, a mounted volume)
  are refused; ordinary work below that (`/Users/alice/project/build`) is not,
  and neither is removing a single app or library bundle.

- **Two path spellings that resolve to `/` are no longer missed.**
  `rm -rf $HOME/../..` and `rm -rf /tmp/../..` both resolve to the filesystem
  root in any shell. The first was refused by 0.6.0 and allowed here (42 forms);
  the second was missed by 0.6.0 **and** by this tree. The identical shape
  spelled `rm -rf ~/../..` was always refused - the rule existed at one spelling
  and not its sibling.
- **The interactive chat session no longer prints server-supplied text to the
  terminal unfiltered.** The activated-skill names, the routed model label and
  the model-switch notice went to the screen exactly as received; they now pass
  through the same sanitizer everything else already used, so a hostile string
  cannot emit terminal control sequences from them.

- **`spycore rewind` now undoes what shell commands, MCP tools and hooks did,
  not only what the file tools did.** Previously the journal was written by
  `write_file` and `edit_file` alone: a run that deleted a file with
  `run_command`, wrote one with `echo >`, edited one with `sed -i`, or let an
  MCP tool or a `post-tool` hook touch your files left nothing to rewind - while
  this changelog, the README and SECURITY.md all said `rewind` undoes everything
  a run changed. The agent now takes a bounded before/after picture of your
  workspace around each of those calls and journals the difference, so all of it
  is reversible with the same command and the same no-clobber guard (a file you
  changed yourself after the run is never overwritten).
  **What is still not journaled, and is now stated instead of implied:** paths
  outside the working directory; paths the agent's own read tools cannot see
  (`.gitignore`d files, `node_modules`, `.git`, `build`, `dist`); binary files
  and files above the observer's per-file cap; and effects that are not file
  contents at all - a `git push`, a network call, a package installed into a
  global cache. A change that is detected but cannot be captured is reported
  during the run, `rewind` prints the boundary before it acts, and the
  "N files changed" line now says "in this workspace".
  Also not journaled, and now named: session-level hooks (`session-start`,
  `prompt-submit`, `session-end`) fire outside any tool call, so only `pre-tool`
  and `post-tool` hooks are covered.
   The observation is not free, and the numbers are measured rather than
  estimated: about 30 ms per shell command on a 300-file package, about 375 ms
  on a 2,500-file monorepo, and about 1.4 s on a 20,000-file workspace - twice
  per call, because it takes a before and an after picture. It grows with the
  file count, not the byte count. See `--no-observe` below. If a workspace is
  too large to observe within the caps, the run tells you the command is not
  undoable rather than staying silent.

- **Tab completion and `spycore schema` now describe the whole CLI.** Both are
  generated from one internal command spec, and that spec had fallen behind the
  code: **14 commands and 43 flags** shipped without an entry in it. `spycore
  rewind`, `spycore commit`, `spycore pr`, `spycore branch`, `spycore acp` and
  every `spycore mcp` subcommand could not be tab-completed in any shell, and
  `spycore schema --json` - the machine-readable description of this CLI -
  listed **51** commands where the binary registers **65**. Twelve `agent` flags
  were missing, among them `--resume`, `--verify`, `--plan`, `--tool-protocol`
  and `--no-observe`. Everything registered is now advertised: 65 commands and
  112 flags on both sides, checked in both directions. Nothing was removed and
  no command changed behaviour.
   Two descriptions were **wrong**, not merely absent, and both are corrected.
  `agent --yes` was described as skipping file-write confirmations; it also
  auto-approves **commands** - the same approval resolver handles both, so the
  old text understated what the flag permits. `agent --max-turns` was described
  as a cap on tool calls; it bounds model round-trips, which is a different
  quantity.

### Added - user-visible

- **`spycore agent --observe` turns the workspace observation on**, and
  `spycore config set agentObserveWorkspace true` makes that persistent;
  `--no-observe` turns it off again. It is **off by default**, because the scan
  READS AND STORES THE TEXT of every file the ignore rules do not hide - and a
  control that copies your file contents onto disk is one to switch on
  deliberately. It is also real cost on a large project, and a user who does not
  want the journal should not pay it. The flag wins over the config
  key for a single run, exactly like `--no-web`.
  **What "off" means, precisely:** `write_file` and `edit_file` keep reporting
  their own writes, so those stay journaled and `spycore rewind` still restores
  them. What is lost is exactly the opaque set - shell commands, MCP tools and
  tool hooks. The run says so once, the first time one of those calls runs, so a
  setting made months ago cannot quietly weaken a rewind you are relying on.
  `spycore agent --resume` reports the current setting in its banner.

### Changed - user-visible

- **IPv6 loopback now receives the bearer token.** `--api-url http://[::1]:3001`
  (or any other spelling of the IPv6 loopback address) previously received no
  `Authorization` header at all, so a local server listening on `::1` answered
  401 - a functional defect, not a protection. Measured against the published
  0.6.0: the only addresses that newly receive the token are the bracketed
  spellings of the IPv6 loopback, and under `https:` no other host's verdict
  moved in either direction. Every verdict that was lost was lost on a scheme
  other than `https:` - the next bullet's doing, not this one's. Neighbouring
  literals stay refused, including `[::ffff:127.0.0.1]`, and plain HTTP is
  accepted for loopback only.
- **The bearer token no longer travels over plain HTTP to a SpyCore host.** The
  token has always been restricted to `api.spycore.ai`, `api.spycore.ca` and
  loopback - but the check read the *host* and ignored the *scheme*, so a base
  URL of `http://api.spycore.ai` (from `--api-url` or `SPYCORE_API_URL`) put the
  token on the wire in the clear. The check is now scheme-aware and **only ever
  attaches the token in fewer cases than before**: SpyCore hosts require HTTPS;
  `localhost` and `127.0.0.1` additionally accept plain HTTP, which is what a
  local dev server serves. If you deliberately point the CLI at an `http://`
  SpyCore URL you will now get 401s instead of a leaked credential.

- **`spycore mcp test` now refuses a project-scoped server in an untrusted
  workspace.** `spycore agent` has always required `spycore mcp trust` before
  running a server configured by the repository you happen to be in; `mcp test`
  did not, so a cloned repository's server could be started by testing it. It
  now applies the same fail-closed gate, for both stdio and remote servers, and
  names `spycore mcp trust` in the refusal. **User-scoped servers (the ones you
  configured yourself) are unaffected.**

- **One prompt lost its bold.** Prompts and progress spinners now sanitize their
  own text, so a hostile string cannot repaint or forge them no matter which
  code path produced it. The price is paid in exactly one place: the
  accept/reject/edit prompt in `spycore skills create` used bold `[a]` `[r]`
  `[e]` markers, and those now render as plain text. The wording is unchanged -
  only the emphasis is gone. Every other prompt, every spinner label and every
  progress bar is byte-for-byte what it was, and the CLI's colour everywhere
  else is untouched.

- **Self-verification now goes through the approval gate.** `--verify` was the
  one execution path in the CLI with no approval control in any mode. It now
  behaves exactly like `run_command`: interactively it prompts once per attempt
  (suppressible with an `allow` command rule); under `--yes` it is unchanged.
  **A non-interactive run without `--yes` auto-rejects it** - unless an `allow`
  rule matches it, which pre-approves it in every mode exactly as it does for
  `run_command` - rather than
  running it silently. Such a run already had every write auto-rejected, so
  the agent could not act on the result, but a run that used `--verify` purely
  for its exit status will now see it refused. The refusal names both
  pre-approval routes (`--yes`, or an `allow` rule) instead of failing quietly.

### Fixed - security
- **A credential stored in your config is no longer printed in cleartext by
  `config get --json`, `config list` or `mcp list`.** `SECURITY.md` promised
  that bulk dumps are redacted, and the redactor keyed on the field's NAME - so
  it caught `apiKey` and the stored token, and missed every credential a user
  can name themselves. Measured by driving the shipped commands: an MCP
  server's `Authorization`, `Cookie`, `Proxy-Authorization` and `X-Api-Key`
  headers all printed in full, as did a literal value under `--env` and a
  password embedded in a stored URL - while `X-Auth-Token` happened to be
  redacted, which is the tell that the screen was on the wrong axis rather than
  merely too small. Header names are yours to choose, so no list of names can
  ever close that space. Redaction now screens what a value **is** in the shape
  that holds it, at every sink that dumps config.  `mcp list` - the command
  built never to echo a header value - was disclosing a URL credential too, and
  that had not been reported; it was found by deriving the sinks from the source
  rather than from the report, and every one is closed together. **Nothing that
  was hidden before became visible**: the new screen runs over the old one's
  output, so it can only ever tighten. What you still need is still there - the
  endpoint, the server name, the header name, and the `${ENV_VAR}` a header
  reads from, because a redactor that hides the field you need to debug is a
  different defect wearing a safer name.

- **An `allow` command rule no longer skips the approval channel - it supplies a
  decision inside it.** Nothing changes about what an allow rule does: it still
  pre-approves the command it matches, in every mode, `--yes` or not, and the
  before/after decision table is identical across both sites, all three modes
  and all four rule states. What changed is *where* the decision is made. The
  rule used to set a local flag that skipped the entire block containing the
  only approval call, so **any protection delivered through the approval
  channel was silently void for exactly the users who had configured a rule** -
  the ones most likely to believe they were covered. There is now one channel
  that every gated action traverses (writes, commands, MCP calls, and
  `--verify`), and a pre-approval is re-checked there against the eligibility
  this file already promised: a command containing shell metacharacters can
  never be auto-approved, and a command rule can never pre-approve a write or an
  MCP call.  The same skip existed in `--verify` and had not been reported; it
  was found by deriving the affected sites from the source instead of reading
  the one report, and both are closed together. The three documents that stated
  "without a TTY everything mutating is auto-rejected" are corrected here,
  because on the allow-rule path that sentence was false.

- **Prompts and spinners now sanitize at the sink, not only at the call site.**
  Approval prompts and progress spinners previously relied on each caller
  remembering to sanitize the values it interpolated. Every caller does, and
  that is checked automatically - but "every call site remembers" is a property
  that has already failed once in this package, and the check that enforces it
  cannot see a value arriving through a helper it does not recognise. Both
  surfaces now sanitize their own text as well, so a hostile string is stopped
  by either layer independently. Nothing else changed: a spinner's own cursor
  and redraw sequences still reach the terminal untouched, so progress
  rendering is unaffected, and your own typed answers are never scrubbed.

- **Display sanitization now covers every sink it was documented to cover.**
  `SECURITY.md` promised that all untrusted strings pass through one sanitizer
  before reaching the terminal; measured across the package, **62 display sites
  did not** - the global error sink (inherited by every command), server-returned
  record fields in `whoami`/`memory`/`conversations`/`files`/`usage`/`ping`, the
  npm-registry version string in `spycore update`, the streamed conversation
  title in the persistent status bar, MCP server details read from project
  config, model-generated skill previews, and repository-authored notices. All
  62 now route through the existing sanitizer.
   That census keyed on commands, and a census keyed on commands cannot see a
  sibling module nobody named - nine further sites survived it. The check was
  rebuilt to key on where a value *came from* and trace it forward instead, and
  it is run on every build with a known defect planted first to prove it can
  still see one. Across the 161 files it scans, it now reports **0** display
  sites left unscreened. Nothing about the promise was
  softened: the code was raised to it. Two directions are deliberately
  unchanged - your own typed input is never scrubbed, and `--json` output stays
  raw because JSON escaping already makes it terminal-safe when parsed.

- **The secret guard now covers every path that reaches the model.** It was
  consulted by the agent's file tools but by none of the context-assembly
  readers, so a file that is legitimately inside the workspace - a `.env`, or
  an innocuously-named symlink pointing at one - could be read straight into
  the model's context through project memory and its `@import` chain (both
  entry points), `CODEBASE_GUIDE.md`, the `CODEBASE_CHANGELOG.md` tail, skill
  discovery and `load_skill`, slash-command templates, or the README summary
  rendered into the generated guide. Containment could not stop this: the
  targets are genuinely inside the workspace. Measured across 12 such paths,
  all 12 now refuse; ordinary imports, guides, skills and commands are
  unaffected. One limit is documented in SECURITY.md: the context readers are
  synchronous and so carry the built-in denylist but not the optional project
  `.spycoreignore` layer.

## 0.6.0 - 2026-07-09

A feature release. The agent gains web access, attachments, and resumable runs;
the interactive session gets modes, compaction, and a context meter; and the
everyday git loop, custom slash-commands, lifecycle hooks, remote tool servers,
and a command allowlist all land. No breaking changes - every prior command and
flag behaves as before.

### Agent
- **Web tools.** The agent can now search the web and read a page when the
  answer is outside your repository - two read-only tools served through the
  SpyCore API (results are treated as untrusted content). On by default; turn
  them off per-run with `agent --no-web`, or globally with
  `config set agentWebTools false`.
- **Resumable runs.** An interrupted or crashed agent run can be continued in
  place with `agent --resume [session|latest]`; list resumable sessions with
  `rewind --list`. Budgets carry over cumulatively, so a resume can never reset
  a run's spend allowance, and approvals are never inherited.
- **Editable plans.** In plan mode you can now choose `[e]dit` to revise the
  proposed plan before approving it (a numbered-line editor - no external
  `$EDITOR`). An edited plan pre-approves nothing.

### Chat & images
- **Attachments.** Attach images and text files to a message with
  `chat --attach <path>` / `agent --attach <path>` (repeatable), or `/attach`
  inside an interactive session. Images upload; text files inline into the task.
- **Image editing.** Edit a local image with
  `image edit <file> -p "<instruction>"` - the counterpart to `image` generation.
- **Session modes.** The chat TUI now has three modes - **ask** (default),
  **plan**, and **agent** - switch with `/mode [ask|plan|agent]` or cycle with
  Shift+Tab. Switching mid-session is confirmed, never silent.
- **Context management.** The status bar shows a live `context ~N%` meter with a
  warning as you approach the model's window, and `/compact` condenses the
  conversation - older messages are archived behind a summary and remain
  recoverable, never deleted.

### Git workflow
- **First-class git.** `commit` generates a Conventional-Commit message from the
  staged diff, `pr` opens a pull request with a generated title and body (via
  `gh`), and `branch` suggests and creates a descriptive branch name - each with
  an interactive review gate and headless `--yes` flags. A generated message can
  never carry an attribution trailer. `/commit` also runs inside the chat TUI.

### Customization
- **Custom slash-commands.** Drop a `.md` prompt template at
  `<config>/commands/<name>.md` (global) or `./.spycore/commands/<name>.md`
  (project, trusted workspaces only) and invoke it as `/name` in the session.
- **Lifecycle hooks.** Run your own commands at five points in a session -
  `session-start`, `prompt-submit`, `pre-tool`, `post-tool`, `session-end` - via
  a `hooks.json` (global or `./.spycore/hooks.json`). `prompt-submit` and
  `pre-tool` hooks block the action by exiting with **code 2**; any other
  non-zero exit is reported and the action continues. (Corrected: this entry
  originally said "exiting non-zero", which never described the behaviour -
  blocking has always required that one specific exit code.)
- **Command allowlist.** Pre-approve or deny specific `run_command` invocations
  for the agent with `./.spycore/command-rules.json` (project) or your user
  rules file; inspect the effective set with `command-rules`. The immutable
  catastrophic-command guard always wins, deny beats allow beats ask, and deny
  beats `--yes`.

### Tool servers (MCP)
- **Remote MCP over HTTP.** Beyond local (stdio) servers, `mcp add <name>
  --url <url>` now connects a remote Model Context Protocol server over the
  streamable HTTP transport (`https://` required off loopback). Pass request
  headers with `--header "Name: value"`, referencing secrets as `${ENV_VAR}`.

## 0.5.0 - 2026-07-01

A security-hardening release that closes gaps in how the agent's read tools,
file upload, external tool servers, and injected project context handle
untrusted input. No changes to the command surface.

### Security
- **Read tools stay inside your workspace.** The `glob` and `grep` tools now
  reject patterns that point outside the working directory (`../…` or absolute
  paths) and filter their results to files inside it, so a task can no longer
  read files in sibling or parent directories. Writes were already confined.
- **Upload sends your token only to official endpoints.** `spycore files
  upload` now attaches your API token exclusively to official SpyCore endpoints
  (and localhost for self-hosting) - matching the rest of the CLI. A custom
  `--api-url` / `SPYCORE_API_URL` pointing elsewhere no longer receives it.
- **Stronger `--yes` command guard.** The catastrophic-command check now also
  catches whole-tree `find … -delete` / `find … -exec rm` aimed at the root,
  home, or a system directory; piping a network download straight into a shell
  (`curl … | sh`); recursive `chmod`/`chown` on the root, home, or a system
  directory; and redirects that overwrite SSH, shell-init, or system auth files
  - even under `--yes`.
- **Safer project-context injection.** Content loaded from `SPYCODE.md`,
  `CODEBASE_GUIDE.md`, and `CODEBASE_CHANGELOG.md` can no longer break out of
  the context block it is wrapped in; the block's own markers are neutralized
  inside untrusted file content.
- **Skill listings are terminal-safe.** `spycore skills list` and `spycore
  skills show` now sanitize skill names, descriptions, and bodies before
  printing, so a malicious skill file can't emit terminal-control sequences.

### Fixed
- **Project tool servers can now be enabled.** Added `spycore mcp trust` /
  `spycore mcp untrust` to explicitly trust (or revoke) a workspace so its
  project-scoped tool (MCP) servers run - the trust gate remains fail-closed by
  default, and `spycore mcp list` now shows whether the current workspace is
  trusted.

- **Routing indicator reliability.** The routing indicator now stays in sync
  with the server across updates.

## 0.4.0 - 2026-06-29

A security-focused release that hardens how the CLI treats untrusted projects,
dangerous commands, network access, and external tool servers. One default
behavior changes - see the first item below.

### Security
- **Workspace trust for project tool servers.** Tool (MCP) servers defined
  inside a project - in its `.spycore/mcp.json` - now require explicit trust
  before they run. Opening an unfamiliar repository no longer starts its tool
  servers automatically; you confirm first. In non-interactive runs (CI,
  `--yes`, or any headless session) project tool servers are skipped entirely.
  This stops a checked-out repository from launching tool servers without your
  knowledge.
- **Stronger dangerous-command guard.** Closed additional ways a destructive
  command could slip past the safety check, including path-qualified and
  home-directory variants.
- **Tokens stay on official endpoints.** Your API token is now sent only to
  official SpyCore endpoints, never to any other host.
- **Bounded tool-server output.** Output read from an external tool server is
  now capped, so a misbehaving or hostile server can't exhaust memory.

## 0.3.0 - 2026-06-27

For anyone upgrading from the published 0.2.0, this release adds a new
selectable model, graduated reasoning effort, an in-repo project-memory
system, and bring-your-own-key providers.

### Models
- **Styx Max** is now a selectable chat model in the lineup - choose it with
  `chat -m styx_max`, or `/model styx_max` in an interactive session, alongside
  Hermes, Minos, Styx, and Charon.

### Reasoning effort
- Graduated reasoning **effort**: choose how deeply a model thinks with
  `chat --effort <auto|low|medium|high|max>` or the in-session `/effort`
  command. Levels are model-aware - an unsupported level steps **down** to the
  nearest one the model offers (never up), with a one-line notice. Set a session
  default via `config set defaultEffort <level>`. The interactive status bar
  shows the active effort for models that expose a choice; switching model
  in-session re-clamps it automatically.

### Project memory
- Living project docs kept in your repository: **SPYCODE.md** (project notes
  and conventions), **CODEBASE_GUIDE.md** (a generated map of your codebase),
  and **CODEBASE_CHANGELOG.md** (a running log of changes). Chat and the agent
  load them at the start of a task for context and append to them at the end.
  Create and manage them with `/init`, `/memory`, `/remember`, `/guide`, and
  `/changelog`.

### Providers
- Bring-your-own-key (BYOK) providers - run the agent against your own
  OpenAI-compatible (including keyless local servers), Anthropic, or Google AI
  endpoints with no SpyCore account. Save named configs with `provider
  add|list|use|test`; keys are read from environment variables and are never
  written to disk or logs.

## 0.2.0 - 2026-06-24

First full public release. SpyCode is SpyCore's AI coding agent and CLI for the
terminal - the prior 0.1.0 was a placeholder.

### Agent
- Autonomous coding agent that edits files inside a working-directory sandbox,
  runs shell commands behind an approval gate, performs git operations, and
  builds a repository map for context - with explicit per-action approval
  gates, checkpoints, one-command `rewind`, and self-verification of its own
  changes. Shell commands are **not** sandboxed: an approved command runs with
  your user's full privileges (see SECURITY.md).
- Model Context Protocol (MCP) client: connect the agent to external stdio
  servers; every tool call is approved.
- ACP server (`acp`) to drive the agent from IDE clients over stdio.
- 60-skill library of loadable `SKILL.md` guides, with `skills` create/sync.

### Chat & account
- Interactive streaming chat TUI, plus a one-shot `chat` command.
- `conversations`, `memory`, `usage`, and `image` (generation) commands.
- Device-code `login` / `logout` / `whoami` / `ping`, and `config`.

### Tooling
- `files` management, shell tab-completion (`completion`), a machine-readable
  `schema`, global `--json` output mode, and `update` checks.

## 0.1.0 - 2026-06-11

Initial placeholder release, superseded by 0.2.0.

### Agent

- Autonomous coding agent (`spycore agent`) with cwd-sandboxed file tools
  (read/list/glob/grep/repo-map/write/edit) and shell execution - every
  mutating action pauses for explicit approval (diff for writes, verbatim
  command echo; `a`/`A`/`r`, `--yes` for CI, auto-reject without a TTY).
- Native tool-calling when the SpyCore backend supports it, with a fenced
  text protocol as the universal fallback (`--tool-protocol auto|native|fenced`).
- Plan mode (`--plan`, auto-enabled for complex tasks): investigate → numbered
  plan → approve → execute, with read-only tools during planning.
- Checkpoints: changes made by the file tools are journaled; `spycore rewind`
  restores exactly those files (symlink-resolved targets). (Corrected: this
  entry originally said "every applied change is journaled", which never
  described 0.1.0 - `run_command` was not journaled at all until the workspace
  observer landed. See the Unreleased section.)
- Self-verify (`--verify "<command>"`): runs your check after the task and
  feeds failures back for fixing (`--verify-attempts`).
- Budgets: `--max-turns`, `--max-tokens`, `--max-time` stop a run gracefully.
- Automatic model routing by task complexity across the SpyCore lineup
  (Hermes / Minos / Styx / Charon), pin with `-m`.

### Providers (BYOK)

- Agent runs against your own endpoints with no SpyCore account:
  OpenAI-compatible (including keyless local servers), Anthropic, and
  Google AI types. Saved named configs (`spycore provider add|list|use|test`),
  keys read from env vars.

### Skills, MCP, ACP

- Skills: reusable `SKILL.md` instruction sets, project-over-user precedence,
  official catalog sync (`spycore skills sync`), generation
  (`skills create`), loaded on demand by the agent on every provider.
- MCP client: connect stdio Model Context Protocol servers
  (`spycore mcp add|list|test|enable|disable|remove`); their tools join the
  agent registry as `mcp__server__tool` behind the same approval gate, with a
  minimal child environment.
- ACP server: `spycore acp` serves the agent over the Agent Client Protocol
  v1 (stdio) for Zed and other ACP clients - streaming session updates,
  permission requests, cancellation.

### Chat and account

- Streaming chat (`spycore chat`) with an interactive TTY REPL, image
  generation (`spycore image`), conversations / files / memory management,
  device-flow login, quota view (`spycore usage`: 5-hour window, weekly cap,
  per-model credits), shell completion, `--format text|json|markdown|yaml`
  on read commands, structured exit codes, and JSON event output for CI.

### Security

- Approval-first design; what you approve is byte-for-byte what runs.
- Working-directory sandbox enforced after symlink resolution; sensitive
  paths (`.env*`, keys, `.git/`, `.ssh/`, …) blocked for read and write.
- Catastrophic-command guard (wrapper-aware) that even `--yes` cannot bypass.
- All model/file/MCP-controlled output is sanitized before reaching the
  terminal (ANSI/OSC/control-sequence stripping).
- Config stored 0600; secrets redacted in every dump; BYOK keys never
  persisted unless explicitly requested, never in logs.
- See SECURITY.md for the threat model. Verified on macOS and Linux
  (node 20/22); Windows via WSL.
