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
   session/run; in non-interactive contexts everything mutating is
   auto-rejected unless `--yes` was passed. **What you approve is
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
3. **Filesystem sandbox = the working directory, post-realpath.** File tools
   resolve paths lexically AND through symlinks: a path whose real target
   (or nearest existing ancestor) escapes `realpath(cwd)` is rejected for
   read, write, and edit. Sensitive paths are blocked for both read and
   write regardless of approval: `.env*`, key/credential files, and the
   entire `.git/`, `.ssh/`, `.aws/`, `.gnupg/` subtrees (so e.g. git hooks
   cannot be planted), plus anything matched by a project `.spycoreignore`.
   The checkpoint journal records the **resolved** target of every applied
   change, so `spycore rewind` restores exactly the file that was modified.
4. **Catastrophic-command denylist (best-effort safety net, NOT a sandbox).**
   `run_command` hard-blocks obvious destroyers (`rm -rf /`, mkfs, dd to a
   block device, fork bombs) BEFORE the approval prompt, so even `--yes`
   cannot run them. The matcher also scans inside common shell wrappers
   (`sh|bash|zsh|dash|ksh -c '…'`) and quote-prefixed forms. It is
   deliberately not exhaustive — encoded or spliced payloads
   (`base64 | sh`, `$IFS`, eval chains) are out of scope; the approval
   prompt remains the real control.
5. **Secrets.** The CLI config (token, optional inline provider keys) is
   written `0600` in a `0700` directory; bulk dumps are redacted. BYOK keys
   travel only in request headers (never argv, never logged; provider error
   chains carry status + endpoint, not credentials). MCP servers run with a
   **minimal child environment** (PATH/HOME + explicitly configured vars
   only); `mcp list`/`add` never echo env VALUES, only names.
6. **Non-TTY defaults are conservative.** Without a TTY, approvals
   auto-reject (unless `--yes`), destructive commands require explicit
   flags, and `spycore acp` (the IDE protocol server) keeps stdout
   protocol-only with rejection as the safe default when a client cannot
   answer a permission request.

## Platform stance (v1)

**Supported: macOS and Linux.** Windows is supported **via WSL**; native
Windows is untested in this release (sandbox path semantics and
process-group kill behavior differ) and prints a warning. Native Windows
support is planned post-launch.

Linux verified 2026-06-11 via `scripts/linux-verify.sh` (full suite + offline
agent smoke in Debian-based `node` images): node 20 + node 22 on arm64, and
node 22 on amd64 — 620 passed | 4 skipped each, with the symlink-escape,
catastrophic-guard, and config-0600 checks green.

## Out of scope (v1)

- OS-level sandboxing (seccomp/sandbox-exec) — the cwd sandbox + approval
  gate are the v1 boundary; approved shell commands run with your user's
  full privileges by design.
- Network egress control for approved commands and MCP servers.
- Defending a malicious MCP server beyond env minimization + per-call
  approval: a server you configure is code you chose to run.
