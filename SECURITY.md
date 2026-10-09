# SpyCore CLI — Security

Report vulnerabilities to **security@spycore.ai**. Please include reproduction
steps; we aim to acknowledge within 72 hours.

## Threat model

The SpyCode agent executes model-proposed actions on your machine. Model
output, file contents, and MCP server responses are all treated as
**untrusted input**. The controls, in order of authority:

1. **The approval gate is the primary control.** Every mutating action — file
   write/edit (shown as a diff), shell command (shown in full), and EVERY MCP
   tool call (server + tool + JSON args) — pauses for explicit approval.
   `A` (accept-all) and `--yes` are the user's blanket pre-approval for the
   session/run, and an `allow` command rule is a third, standing one that
   applies to shell **commands only** — never to a write, never to an MCP call.
   In non-interactive contexts everything mutating is auto-rejected unless
   `--yes` was passed or an `allow` rule matches that command. **What you approve is
   byte-for-byte what runs**: the approval prompt renders the full command
   (wrapped, never silently truncated); diff truncation is always explicitly
   marked (`+N more diff lines`).
2. **Display sanitization.** All untrusted strings (model narration, tool
   arguments, diffs, command output, MCP output, even the update-check
   version string) pass through a single sanitizer
   (`src/lib/sanitize-display.ts`) before reaching the terminal: ANSI
   CSI/OSC/DCS/SOS/PM/APC sequences are stripped, C1 controls removed, lone
   ESC and `\r` made visible, other C0 controls rendered as control pictures
   (`\n`/`\t` preserved). This prevents terminal-title/clipboard writes
   (OSC 0/52), restyled or overwritten approval prompts, and hidden bytes.
   Sanitization is **display-only**: bytes sent to the model, the server, or
   written to files are never altered. `--json` output is machine-readable
   and relies on JSON string escaping (C0 → `\u00XX` per the JSON spec);
   consumers must parse it as JSON rather than echoing it raw.
   Two exclusions are deliberate, and both are the boundary working rather
   than a gap. **Your own typed input is never sanitized** — the text you type
   is yours, and scrubbing it would mangle your words; the boundary is the
   *transport*, so a message that comes back **from the server** is sanitized
   even when it is recorded as yours. And the surfaces whose job IS terminal
   control emit escape sequences this CLI itself authored, which are never
   data. That set is **enumerated, not summarised** — an enumeration that
   reads complete but is not leaves you unable to tell what else writes
   control bytes. There are **seven**: `/clear` (the only literal escape this
   CLI writes), progress spinners, colour, the markdown and syntax-highlight
   renderers, the interactive full-screen UI, the line editor behind
   confirmation prompts, and raw mode (the theme probe and the
   external-editor handoff toggle it briefly; Ink owns stdin while mounted).
   The set is counted over every source file and pinned
   by the test suite, so an eighth member turns a test red instead of quietly
   making this sentence false. Everything else is measured at **zero**: no
   alternate screen, no bracketed paste, no OSC hyperlinks or terminal-title
   writes, and no direct cursor addressing.
3. **Filesystem sandbox = the working directory, post-realpath.** File tools
   resolve paths lexically AND through symlinks: a path whose real target
   (or nearest existing ancestor) escapes `realpath(cwd)` is rejected for
   read, write, and edit. Sensitive paths are blocked for both read and
   write regardless of approval: `.env*`, key/credential files, and the
   entire `.git/`, `.ssh/`, `.aws/`, `.gnupg/` subtrees (so e.g. git hooks
   cannot be planted), plus anything matched by a project `.spycoreignore`.
   The checkpoint journal records the **resolved** target of every change it
   captures, so `spycore rewind` restores exactly the file that was modified.
   It captures two ways: the file tools report their own writes, and the opaque
   tools — `run_command`, MCP tools, and hooks that run around a tool call — are
   captured by comparing the workspace before and after the call. That
   comparison sees a difference, not an author, so within a call it cannot
   distinguish the command's writes from an edit you made in another window
   during the same moment. Two things follow, and both are stated because the
   difference matters. First, **the time a call spends waiting for your approval
   is not part of the comparison**: when the prompt closes, anything that changed
   while it was open is folded into the "before" picture and named in a notice,
   so it is never journaled as the call's work and `spycore rewind` will not
   revert it. That was the wide part of the window — a decision has no time
   limit. What remains is the call's own execution, which is bounded by the
   command itself. Second, the restore guard — skipping any file whose content is
   not what the run left — protects you against an edit made **after** the run;
   it cannot protect you against one made *during* a call, because in that case
   the journal already recorded your content as the result. Outside its reach
   entirely, by design:
   anything outside the workspace, anything the agent's own read tools cannot
   see, binary and very large files, and every effect that is not a file's
   content. Also outside it, named rather than left to be discovered:
   **session-level hooks** — `session-start`, `prompt-submit` and `session-end`
   fire outside any tool call, so the comparison never brackets them and what
   they change is not journaled. Only `pre-tool` and `post-tool` hooks are
   covered.
   The comparison is turned on with `spycore agent --observe`, or persistently
   with `spycore config set agentObserveWorkspace true`, and `--no-observe`
   turns it off again. It is **off by default**: taking the before-and-after
   picture READS AND STORES THE TEXT of every file the ignore rules do not hide,
   into a journal under your home directory, and a control that copies your file
   contents onto disk is one you should switch on deliberately rather than
   discover. It also costs roughly a fifth of a second per shell command on a
   2,500-file workspace and grows with the file count. With it off, `write_file`
   and `edit_file`
   still journal their own writes and `spycore rewind` still restores them —
   what is lost is exactly the opaque set, and the run says so the first time
   one of those calls runs.
   The same resolved bound governs the `SPYCODE.md` `@import` reader and the
   empty-directory pruning `spycore rewind` performs. Two limits, stated
   because they are real: a **hard link** is a second genuine name for one
   inode, so no name-based containment can see it; and containment is checked
   when a path is validated and again immediately before a write, but Node
   exposes no `openat(2)`, so a sufficiently precise concurrent process
   retains a narrow race. Neither is reachable without local code execution
   or a hostile process already running alongside the agent.

   The check-then-use race is an **accepted residual**, not an oversight. The
   wide, deterministic window — the whole length of an approval prompt, seconds
   or minutes — is closed by the pre-write re-check. What remains is the
   microsecond between that re-check and the rename, and eliminating it needs
   an fd-relative write (`openat(2)`) that this runtime does not offer. The
   alternative — routing every file write through a native binding or a child
   helper — would add a dependency in the most security-sensitive path in the
   package to close a window that already requires a hostile local process.
   That trade raises total risk rather than lowering it, so the residual is
   accepted and recorded here instead. It is pinned by the test suite, so a
   later claim that it is closed turns a test red.
4. **The secret guard covers every path that reaches the model.** The always-on
   denylist is consulted not only by the agent's file tools but by every
   context-assembly reader: the `SPYCODE.md` hierarchy and its `@import` chain
   (through both entry points — memory injection and slash-command templates),
   `CODEBASE_GUIDE.md`, the `CODEBASE_CHANGELOG.md` tail, skill discovery and
   `load_skill`, project and user slash-command templates, and the README
   summary rendered into the generated guide. This matters because containment
   alone cannot stop it: a `.env` is genuinely inside the workspace, so a
   symlink named `notes.md` pointing at it is a perfectly legal target that
   only the secret guard refuses. **One limit, stated because it is real:** the
   context-assembly readers are synchronous, so they carry the built-in
   denylist and the resolved-path check but **not** the optional project
   `.spycoreignore` layer, whose matcher can only be loaded asynchronously. A
   user-declared ignore entry therefore bounds the agent's file tools but not
   the context readers; the built-in denylist bounds both.
5. **Catastrophic-command denylist (best-effort safety net, NOT a sandbox).**
   `run_command` hard-blocks obvious destroyers (`rm -rf /`, mkfs, fork bombs)
   BEFORE the approval prompt, so even `--yes` cannot run them. **Writing to or
   altering a raw block device is refused however the device is named** — not
   only through a redirect, `dd of=` or `tee`, but through any verb whose own
   synopsis puts a path in a write position: `cp`, `mv`, `ln`, `install`,
   `rsync`, `chmod`, `chown`, `chgrp`, `truncate`, `shred`, the archivers
   (`tar`, `pax`, `cpio`) and the disk tools (`wipefs`, `parted`, `sfdisk`,
   `fdisk`, `nvme`, `hdparm`, `diskutil`, `newfs`, …). **Reading a device is
   not blocked**: imaging a disk with `dd if=/dev/sda of=./backup.img`, listing
   a table with `fdisk -l`, `parted /dev/sda print` or `smartctl -a`, and
   extracting an archive with `tar xf` all still run. Pseudo-devices keep
   working as before — `/dev/null`, `/dev/stdout`, `/dev/fd/*`, `/dev/shm/*`,
   `/dev/pts/*` and the terminals are ordinary write targets.
   The matcher also scans inside common shell wrappers
   (`sh|bash|zsh|dash|ksh -c '…'`) and quote-prefixed forms. It is
   deliberately not exhaustive — encoded or spliced payloads
   (`base64 | sh`, `$IFS`, eval chains) are out of scope; the approval
   prompt remains the real control.
6. **Secrets.** The CLI config (token, optional inline provider keys) is
   written `0600` in a `0700` directory. **Every command that dumps config
   redacts by what a value IS, not by what its field is called.** An MCP header
   value is removed whatever name you gave that header; so is a literal `--env`
   value, and so is a credential embedded in any stored URL (`apiUrl`, a
   provider `baseURL`, an MCP server `url`). This is deliberately not a list of
   secret-looking names: header names are yours to choose, so a name list could
   never be complete. What survives is what you need to debug: the endpoint,
   the server and header names, and the `${ENV_VAR}` a header reads from. BYOK keys travel only in request headers
   (never argv, never logged; provider error chains carry status + endpoint,
   not credentials). MCP servers run with a **minimal child environment**
   (PATH/HOME + explicitly configured vars only); `mcp list`/`add` never echo
   env or header VALUES, only names — and `provider list` reports a key's
   SOURCE (`env:VAR`, or the last four characters of a stored key), never the
   key.
7. **Non-TTY defaults are conservative.** Without a TTY, approvals
   auto-reject (unless `--yes`, or an `allow` command rule matching that
   command), destructive commands require explicit
   flags, and `spycore acp` (the IDE protocol server) keeps stdout
   protocol-only with rejection as the safe default when a client cannot
   answer a permission request.

## Platform stance (v1)

**Supported: macOS and Linux.** Windows is supported **via WSL**; native
Windows is untested in this release (sandbox path semantics and
process-group kill behavior differ) and prints a warning. Native Windows
support is planned post-launch.

Linux verified 2026-08-06 via `scripts/linux-verify.sh` (full suite + offline
agent smoke in Debian-based `node` images): node 20 and node 22 on arm64, with
the `multi-tool`, `symlink-escape`, `catastrophic-guard` and `config-0600`
checks green on both.

**amd64 is not verified in this release.** Only emulated amd64 was available
here, and under emulation the heaviest checks exceed their time limits and fail
for reasons unrelated to what they test. Rather than repeat an older amd64
figure, no amd64 result is claimed.

**This verification did not run at all between 2026-08-05 and 2026-08-06.** The
archive the harness builds excluded the repository's git history, which two of
the suite's own checks require, so it could not reach a passing result — and
nothing reported that, because nothing connected the two facts. It is repaired
and was re-run end to end for the statement above. `tests/release-verification.test.ts`
now fails if that archive is ever narrowed below what the suite needs, so this
paragraph is built to stop being true by mechanism rather than by someone
remembering to re-read it.

## Out of scope (v1)

- OS-level sandboxing (seccomp/sandbox-exec) — the cwd sandbox + approval
  gate are the v1 boundary; approved shell commands run with your user's
  full privileges by design.
- Network egress control for approved commands and MCP servers.
- Defending a malicious MCP server beyond env minimization + per-call
  approval: a server you configure is code you chose to run.
