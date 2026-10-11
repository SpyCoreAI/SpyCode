[![CI](https://github.com/SpyCoreAI/SpyCode/actions/workflows/ci.yml/badge.svg)](https://github.com/SpyCoreAI/SpyCode/actions/workflows/ci.yml)

<div align="center">

```
 ____    ____   __   __   ____    ___    ____    _____
/ ___|  |  _ \  \ \ / /  / ___|  / _ \  |  _ \  | ____|
\___ \  | |_) |  \ V /  | |     | | | | | | | | |  _|
 ___) | |  __/    | |   | |___  | |_| | | |_| | | |___
|____/  |_|       |_|    \____|  \___/  |____/  |_____|
```

**SpyCode - SpyCore's AI coding agent in your terminal.**

An autonomous agent loop with explicit approval gates, checkpoints with
one-command rewind, self-verification, streaming chat, bring-your-own-key
providers, skills, an MCP client, and an ACP server for IDE integration.

[![npm](https://img.shields.io/npm/v/%40spycore%2Fcli?color=8A63D2&label=npm)](https://www.npmjs.com/package/@spycore/cli)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20WSL-lightgrey)](#install)
[![docs](https://img.shields.io/badge/docs-spycore.ai%2Fspycode-6E56CF)](https://spycore.ai/spycode)

</div>

## Why SpyCode

- **Autonomous agent loop, gated** - every file write is shown as a diff and
  every shell command verbatim; nothing mutating runs without your approval.
- **One-command rewind** - a run journals the files it changes in your
  workspace, including the ones shell commands, MCP tools and hooks change and
  not just the file tools, so `spycore rewind` puts them back. It does not
  journal paths outside the workspace, ignored paths, or binary files - the run
  says so at the time and `rewind` states the boundary before it acts. **Off by
  default**, because the scan reads and stores the text of every file the ignore
  rules do not hide: `--observe` turns it on for a run, or `spycore config set
  agentObserveWorkspace true` for good. With it off, file-tool writes are still
  journaled and still rewind.
- **Self-verify** - point a check at a run with `--verify` and the agent reads
  the failure output and fixes it.
- **Bring your own key** - run against your own `openai`, `anthropic`, or
  `google` endpoints with no SpyCore account.
- **Skills, MCP, and ACP** - reusable instruction sets, Model Context Protocol
  tools, and an Agent Client Protocol server for your editor.

[Install](#install) · [Quickstart](#quickstart) · [Models](#models-and-routing) ·
[Agent](#the-agent-in-practice) · [BYOK](#bring-your-own-key) · [Skills](#skills) ·
[MCP](#mcp) · [IDE (ACP)](#ide-integration-acp) · [Security](#security-model) ·
[Commands](#all-commands)

---

## Install

```bash
npm install -g @spycore/cli
```

Requirements: **Node 20+**. macOS and Linux are supported; Windows via WSL.

Alternatively, the installer at [spycore.ai/spycode](https://spycore.ai/spycode)
sets up the same package (a dependency-free binary distribution is planned).
Download it, read it, then run it - never pipe a downloader straight into a
shell; SpyCode's own command screen blocks that pattern:

```bash
curl -fsSL -o spycore-install.sh https://spycore.ai/install
sh spycore-install.sh
```

Verify: `spycore --version`

---

## Quickstart

```bash
spycore login                              # authorize this device in the browser
spycore agent "add input validation to src/api.ts and run the tests"
```

The agent explores your project with read-only tools, then proposes every file
write as a diff and every shell command verbatim - nothing mutating runs
without your approval (`a` accept, `A` accept all, `r` reject). When it's
done, you get a final answer and a change journal:

```bash
spycore rewind                             # undo the workspace files the last run changed
```

`spycore chat "question"` gives you plain streaming chat with the same models.

---

## Models and routing

SpyCore models, picked automatically by task complexity - or pinned with
`-m`:

| Model | Role |
| --- | --- |
| **Hermes** | fast chat and triage |
| **Minos** | vision + general reasoning |
| **Styx** | the coding workhorse (agent default) |
| **Styx Max** | the coding workhorse at higher effort |
| **Charon** | deep reasoning for complex tasks |

```bash
spycore agent "rename the User type across the repo" -m charon
spycore chat "explain this stack trace" -m charon --effort high   # deeper reasoning
spycore usage                              # quota: 5-hour window, weekly cap, per-model credits
```

Control how deeply a model thinks with `--effort` (`auto`, `low`, `medium`,
`high`, `max`) - or `/effort` inside the interactive session. Levels are
model-aware: an unsupported level steps down to the nearest one the model offers.
Set a default with `spycore config set defaultEffort high`.

---

## The agent, in practice

- **Plan mode** - `--plan` investigates first and proposes a numbered plan you
  approve before anything executes (auto-enabled for complex tasks; `--no-plan`
  to skip). At the approval prompt you can `[e]dit` the plan before accepting.
- **Web access** - the agent can search the web and read a page when the answer
  is outside your repo (recent releases, library docs, unfamiliar errors). On by
  default; `--no-web` disables it per run, or `config set agentWebTools false`
  globally. Fetched content is treated as untrusted.
- **Attachments** - `--attach <path>` (repeatable) adds images and text files to
  the task; images upload, text files inline.
- **Resume** - an interrupted run continues in place with
  `--resume [session|latest]` (`spycore rewind --list` shows resumable
  sessions); budgets carry over and approvals are never inherited.
- **Checkpoints** - the journal covers a workspace file whichever tool changed
  it: the file tools report themselves, and `run_command`, MCP tools and tool
  hooks are captured by observing the workspace around each call. `spycore
  rewind` restores what is journaled, skipping anything you changed yourself
  since. Editing your own files while a call waits at an approval prompt is safe:
  the wait is excluded from the comparison, so those edits are named in a notice
  and left out of the journal rather than attributed to the call. Outside the
  journal, and stated rather than implied: paths outside the
  workspace, ignored paths (`.gitignore`, `node_modules`, `.git`, `build`,
  `dist`), binary and very large files, effects that are not file contents, and
  session-level hooks (`session-start`, `prompt-submit`, `session-end`), which
  fire outside any tool call. Observing the workspace costs about a fifth of a
  second per shell command on a 2,500-file project and grows with the file
  count; `--observe` enables it for a run, or `config set
  agentObserveWorkspace true` for good, and `--no-observe` turns it off again.
  **It is off by default**, because the scan reads and stores the text of every
  file the ignore rules do not hide, and a feature that copies your file
  contents onto disk should be one you asked for. With it off, file-tool writes
  are still journaled and still rewind, the opaque ones are not, and the run
  says so the first time one runs.
- **Self-verify** - `--verify "npm test"` runs your check after the task; on
  failure the agent reads the output and fixes it (`--verify-attempts 3`). The
  check goes through the same approval gate as any other command - it re-runs
  against a workspace the agent has since edited - so it prompts each attempt,
  or pre-approve it with `--yes` or an `allow` command rule.
- **Budgets** - `--max-turns`, `--max-tokens`, `--max-time 120` stop a run
  gracefully at a cap. The turn cap no longer cuts the run off mid-thought:
  when it is hit, the model gets one final **summary-only** turn - no tool
  calls are dispatched there, the prose it writes becomes the final answer.
- **Loop guard** - the agent watches for no-progress loops: the same tool
  call repeated, an unchanged file re-read, or turns that change nothing.
  The response escalates in three steps:

  ```mermaid
  flowchart LR
      A[Same call repeated / file re-read / no-progress turns] --> B[Warn\nnudge the model to change approach]
      B --> C[Veto\nguide it to the final answer now]
      C --> D[Soft breaker\nstop the run, keep the session]
  ```

  A warning is a nudge, a veto steers the model toward its final answer, and
  the breaker ends the run gracefully with your session intact. Tool-less
  thinking turns and the final answer are never gated.
- **Evidence check** - when the run ends, claims in the final answer like
  "tests passed" or "build succeeded" are matched against what the run
  actually did. A claim with no matching successful tool call shows a
  warning - it never blocks the answer.
- **Sub-agents** - the `delegate` tool spawns a sub-agent for a
  self-contained task. Pass `output_schema` (a JSON string like
  `{"type":"object","required":["files_changed"]}`) to have the child's
  final answer validated against it: the result reports `schema_valid` and
  the child's raw text is always preserved, never dropped. Sub-agents are
  **leaf** runs: they cannot delegate further and cannot write your durable
  memory files - what they learn comes back in their report to the parent.
- **Steering** - in the TUI, typing a message while a task is running folds
  it into the in-flight run at the next step boundary instead of queueing
  behind it (a `!` shell command still queues). The agent treats the steer
  as a new user message from the next step on - it does not restart work
  already done.
- **Guardian** - after 3 consecutive approval rejections the agent gets a
  hard-stop note appended to the rejection (it stops asking and finishes
  up instead of hammering the gate). Tune it with
  `config set guardianThreshold 5`, or `SPYCODE_GUARDIAN_THRESHOLD`.
- **Trace** - `spycore agent --trace` records a structured JSONL trace of the
  run (one line per event; detached runs trace automatically). Replay it
  any time with `spycore runs replay <id>` for a turn-by-turn timeline of
  what happened - the debugging view of a run.
- **Compaction** - when the transcript fills up, `/compact` works in two
  stages: first it deterministically prunes old tool outputs and notices
  without any model call (instant and free), then it asks the cheap pinned
  model for a dense summary of what is left and replaces the transcript with
  it, in place.
- **Headless / CI** - `--yes` pre-approves writes and commands; `--json` emits
  machine-readable events; without a TTY writes and MCP tool calls are
  auto-rejected unless `--yes` is passed. A shell command matching an `allow`
  command rule is the one exception: a rule pre-approves it in every mode,
  `--yes` or not, which is what configuring one means. An `allow` rule can only
  ever pre-approve a **command** - never a write, never an MCP call.

---

## Memory

The agent keeps two small files it manages itself, in
`<config>/memories/` - no embeddings, no database, just text you can read and
edit:

- **`MEMORY.md`** - the agent's own notes across sessions (what it learned
  about your projects, your conventions, your corrections).
- **`USER.md`** - the user profile: how you like to work, what to call you,
  your standing preferences.

At session start the agent sees a **frozen snapshot** of both files - what it
writes during the session takes effect on the *next* session, never mid-run.
Each file has a hard 48k-character cap: when full, a write **fails with an
error** telling you to merge or delete entries first. Nothing is ever
silently deleted.

The files are yours to read and edit directly - they are plain Markdown in
`<config>/memories/`. Inside an agent run the `memory` tool manages them
(view/add/remove entries).

**Session search** is the complement: every detached run is indexed for
full-text search, so the agent (and you) can recall what a past session did
without re-reading logs:

```bash
spycore runs search "billing cron"      # search past runs
spycore runs search "billing cron" --reindex   # rebuild the index first
```

In an agent run the `session_search` tool queries the same index.

---

## Git workflow

AI-assisted git for the everyday loop - each generates text through the same
charged chat contract, then commits/creates only after you approve:

```bash
spycore commit                             # Conventional-Commit message from the staged diff
spycore pr --draft                         # open a pull request (title + body) via gh
spycore branch --for "add rate limiting"   # suggest and switch to a descriptive branch
```

`commit` reviews before committing (`--all` stages first, `--push` pushes after a
confirm); `pr` needs a remote and the `gh` CLI; a generated message never carries
an attribution trailer. `/commit` also works inside an interactive session.

---

## Interactive session

Inside `spycore chat`:

- **Modes** - **ask** (default), **plan**, and **agent**; switch with
  `/mode [ask|plan|agent]` or cycle with Shift+Tab.
- **Attach** - `/attach <path>` queues an image or text file onto your next
  message.
- **Context** - a live `context ~N%` meter in the status bar, and `/compact` to
  condense the conversation behind a summary (older messages are archived and
  stay recoverable, never deleted).
- **Custom slash-commands** - drop a `.md` prompt template at
  `<config>/commands/<name>.md` (or `./.spycore/commands/<name>.md` in a trusted
  workspace) and run it as `/name`.

Type `/help` in a session for the full list. Slash-commands, `/attach`,
`/compact` and the context meter are chat-session features; the `agent --plan`
TUI has its own approval flow rather than a slash surface.

**Lifecycle hooks** apply to both `chat` and `agent`: run your own commands at
`session-start`, `prompt-submit`, `pre-tool`, `post-tool`, and `session-end` via
`hooks.json`. A `prompt-submit` or `pre-tool` hook blocks the action by exiting
with **code 2** - that specific code, not any non-zero exit. Any other non-zero
exit is reported and the action continues, so a guard written to `exit 1` will
not stop anything.

Edit a local image instead of generating one:

```bash
spycore image edit ./logo.png -p "make the background transparent"
```

---

## Command allowlist

Pre-approve or deny specific `run_command` invocations for the agent so trusted
commands don't prompt every time:

```bash
spycore command-rules                      # show the effective allow/deny rules (read-only)
```

Rules live in `./.spycore/command-rules.json` (project) or your user rules file.
The immutable catastrophic-command guard always wins; deny beats allow beats ask,
and deny beats `--yes`. A command containing shell metacharacters can never match
an **allow rule** - it is structurally ineligible, so no rule can auto-approve it.
That is a property of rule matching, not of approval in general: `--yes` and
session accept-all approve without consulting rules, and on those paths the
catastrophic guard is the control that stops a destructive command.

---

## Toolsets

The agent's tools are grouped into named toolsets - `files`, `write`,
`shell`, `web`, `skills`, `memory`, `sessions`, `delegation` - and you can
disable any of them per surface (`cli`, `tui`, `acp`). A disabled toolset's
tools are withheld from the agent entirely on that surface: they are removed
from the prompt catalogue and refused at dispatch.

```bash
spycore toolsets                            # list toolsets + per-surface state
spycore toolsets disable web --surface tui  # no web tools in the TUI
spycore toolsets enable web --surface tui
```

---

## Bring your own key

Agent runs work against your own model endpoints - no SpyCore account needed:

```bash
spycore agent "fix the failing test" --provider openai --base-url http://localhost:11434/v1 --model my-local-model
spycore provider add work --type anthropic --api-key-env MY_KEY --model your-model-id
spycore provider use work                  # make it the default
```

Types: `openai` (any OpenAI-compatible endpoint, including local servers -
keyless works), `anthropic`, `google`. Keys are read from env vars and never
written to disk unless you explicitly choose `--api-key`.

---

## Skills

Reusable instruction sets the agent loads on demand (`SKILL.md` files,
project-level `./.spycore/skills/` overrides user-global):

```bash
spycore skills sync                        # download the official catalog
spycore skills create "how we write database migrations"
spycore skills list
```

When the catalog grows, the curator keeps it healthy:

```bash
spycore skills curator                     # show usage stats, stale and pinned skills
spycore skills curator --stale-days 30     # tune the inactivity threshold
spycore skills curator --pin pdf-extract   # pin: exempt from every curator transition
spycore skills curator --archive           # archive every listed stale skill (.archive/, never deleted)
spycore skills lint                        # check every skill against the authoring standard
```

The authoring standard is simple: a one-sentence description under 60
characters, native tools named in backticks (never a shell utility that a
native tool covers), a `platforms:` gate when the skill ships `scripts/`,
and "When to Use" + "Verification" sections. `skills lint` enforces it
automatically.

---

## Import from other tools

Moving from Claude Code? Bring your skills, MCP servers, and agent memory
with you. The import always shows a dry-run preview first, and it never
overwrites anything without `--force`:

```bash
spycore import                              # preview from Claude Code
spycore import --apply                      # actually import it
spycore import --apply --force              # also overwrite conflicts
spycore import --from-dir ~/my-skills --apply   # generic: any <name>/SKILL.md tree
```

Skills land in your user skills dir (`~/.claude/skills` → SpyCode's
skills), MCP servers merge into your user MCP config, and `~/.claude/CLAUDE.md`
appends to your durable `MEMORY.md`. Add `--include-project` to also import
`./.claude/*` into the project scope (`./.spycore/*`).

---

## MCP

Connect Model Context Protocol servers - local (stdio) or remote (streamable
HTTP); their tools join the agent's registry on every provider, gated by the
same approval prompts:

```bash
spycore mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
spycore mcp add docs --url https://mcp.example.com/  --header "Authorization: Bearer ${MY_TOKEN}"
spycore mcp test files                     # handshake + list the tools
spycore mcp list
```

Local servers run with a minimal environment (PATH/HOME + the vars you pass
with `--env`), never your full shell env. Remote servers require `https://` off
loopback; header values may reference secrets as `${ENV_VAR}` so tokens stay out
of your config. If you paste one in literally anyway, no command prints it:
`mcp list` shows each header's name and whether its value comes from the
environment, and the config dumps (`config get --json`, `config list`) show the
name and the `${ENV_VAR}` it reads from - never the value itself.

---

## IDE integration (ACP)

`spycore acp` serves the agent over the [Agent Client Protocol](https://agentclientprotocol.com)
on stdio - point Zed (or any ACP client) at it for streaming sessions,
permission prompts, and cancellation inside your editor:

```json
{ "agent_servers": { "SpyCode": { "command": "spycore", "args": ["acp"] } } }
```

---

## Security model

The approval gate is the primary control: what you approve is byte-for-byte
what runs. Files are sandboxed to the working directory (symlink-aware),
sensitive paths (`.env*`, keys, `.git/`, `.ssh/`) are blocked for read and
write, obviously catastrophic commands are refused even under `--yes`, and
everything a model or MCP server prints is sanitized before it reaches your
terminal.

- **Invisible unicode flag** - a command carrying zero-width or
  bidi-control characters looks different from what the shell runs, so the
  approval card flags it: the character is named with its position, and you
  are asked to inspect the exact bytes before approving.
- **Clean spawn environment** - shell commands, tool hooks, and MCP/language
  servers start without secret-keyed environment variables (`*_TOKEN`,
  `*_API_KEY`, `*_PASSWORD`, and friends); only deliberately configured
  per-server variables are passed through.
- **Frozen `--yes`** - the bypass flag is read once at startup and cannot be
  flipped mid-run by any skill or in-process code.

Details and reporting: [SECURITY.md](./SECURITY.md).

---

## All commands

`login` · `logout` · `whoami` · `chat` · `agent` (`--detached` runs it in the
background; `runs` lists, attaches to, kills, replays, and searches those
runs) · `rewind` · `usage` · `conversations` · `files` · `memory` · `image` ·
`commit` · `pr` · `branch` · `command-rules` · `provider` · `skills` · `mcp` ·
`acp` · `config` · `cron` (scheduled prompts) · `projects` (registered
workspaces) · `init` · `import` (from other tools) · `toolsets` (per-surface
tool gates) · `completion` · `schema` · `update` · `ping` · `version`

Run `spycore <command> --help` for flags.

---

## License

Apache-2.0 © 2026 SpyCore AI, Inc. See [LICENSE](./LICENSE) and
[NOTICE](./NOTICE).
