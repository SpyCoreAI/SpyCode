# Changelog

All notable changes to `@spycore/cli` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/).

## 0.5.0 — 2026-07-01

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
  (and localhost for self-hosting) — matching the rest of the CLI. A custom
  `--api-url` / `SPYCORE_API_URL` pointing elsewhere no longer receives it.
- **Stronger `--yes` command guard.** The catastrophic-command check now also
  catches whole-tree `find … -delete` / `find … -exec rm` aimed at the root,
  home, or a system directory; piping a network download straight into a shell
  (`curl … | sh`); recursive `chmod`/`chown` on the root, home, or a system
  directory; and redirects that overwrite SSH, shell-init, or system auth files
  — even under `--yes`.
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
  project-scoped tool (MCP) servers run — the trust gate remains fail-closed by
  default, and `spycore mcp list` now shows whether the current workspace is
  trusted.

### Internal
- Renamed the internal auto-routing wire event the CLI listens for, to match
  the current server. The routed-model indicator continues to display a neutral
  label.

## 0.4.0 — 2026-06-29

A security-focused release that hardens how the CLI treats untrusted projects,
dangerous commands, network access, and external tool servers. One default
behavior changes — see the first item below.

### Security
- **Workspace trust for project tool servers.** Tool (MCP) servers defined
  inside a project — in its `.spycore/mcp.json` — now require explicit trust
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

## 0.3.0 — 2026-06-27

For anyone upgrading from the published 0.2.0, this release adds a new
selectable model, graduated reasoning effort, an in-repo project-memory
system, and bring-your-own-key providers.

### Models
- **Styx Max** is now a selectable chat model in the lineup — choose it with
  `chat -m styx_max`, or `/model styx_max` in an interactive session, alongside
  Hermes, Minos, Styx, and Charon.

### Reasoning effort
- Graduated reasoning **effort**: choose how deeply a model thinks with
  `chat --effort <auto|low|medium|high|max>` or the in-session `/effort`
  command. Levels are model-aware — an unsupported level steps **down** to the
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
- Bring-your-own-key (BYOK) providers — run the agent against your own
  OpenAI-compatible (including keyless local servers), Anthropic, or Google AI
  endpoints with no SpyCore account. Save named configs with `provider
  add|list|use|test`; keys are read from environment variables and are never
  written to disk or logs.

## 0.2.0 — 2026-06-24

First full public release. SpyCode is SpyCore's AI coding agent and CLI for the
terminal — the prior 0.1.0 was a placeholder.

### Agent
- Autonomous coding agent that edits files, runs shell commands in a sandbox,
  performs git operations, and builds a repository map for context — with
  explicit per-action approval gates, checkpoints, one-command `rewind`, and
  self-verification of its own changes.
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

## 0.1.0 — 2026-06-11

Initial placeholder release, superseded by 0.2.0.

### Agent

- Autonomous coding agent (`spycore agent`) with cwd-sandboxed file tools
  (read/list/glob/grep/repo-map/write/edit) and shell execution — every
  mutating action pauses for explicit approval (diff for writes, verbatim
  command echo; `a`/`A`/`r`, `--yes` for CI, auto-reject without a TTY).
- Native tool-calling when the SpyCore backend supports it, with a fenced
  text protocol as the universal fallback (`--tool-protocol auto|native|fenced`).
- Plan mode (`--plan`, auto-enabled for complex tasks): investigate → numbered
  plan → approve → execute, with read-only tools during planning.
- Checkpoints: every applied change is journaled; `spycore rewind` restores
  exactly the files a run touched (symlink-resolved targets).
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
  v1 (stdio) for Zed and other ACP clients — streaming session updates,
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
