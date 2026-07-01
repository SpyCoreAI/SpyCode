<div align="center">

```
 ____    ____   __   __   ____    ___    ____    _____
/ ___|  |  _ \  \ \ / /  / ___|  / _ \  |  _ \  | ____|
\___ \  | |_) |  \ V /  | |     | | | | | | | | |  _|
 ___) | |  __/    | |   | |___  | |_| | | |_| | | |___
|____/  |_|       |_|    \____|  \___/  |____/  |_____|
```

**SpyCode — SpyCore's AI coding agent in your terminal.**

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

- **Autonomous agent loop, gated** — every file write is shown as a diff and
  every shell command verbatim; nothing mutating runs without your approval.
- **One-command rewind** — every applied change is journaled, so `spycore
  rewind` restores the exact files a run touched.
- **Self-verify** — point a check at a run with `--verify` and the agent reads
  the failure output and fixes it.
- **Bring your own key** — run against your own `openai`, `anthropic`, or
  `google` endpoints with no SpyCore account.
- **Skills, MCP, and ACP** — reusable instruction sets, Model Context Protocol
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
sets up the same package (a dependency-free binary distribution is planned):

```bash
curl -fsSL https://spycore.ai/install | sh
```

Verify: `spycore --version`

---

## Quickstart

```bash
spycore login                              # authorize this device in the browser
spycore agent "add input validation to src/api.ts and run the tests"
```

The agent explores your project with read-only tools, then proposes every file
write as a diff and every shell command verbatim — nothing mutating runs
without your approval (`a` accept, `A` accept all, `r` reject). When it's
done, you get a final answer and a change journal:

```bash
spycore rewind                             # undo everything the last run changed
```

`spycore chat "question"` gives you plain streaming chat with the same models.

---

## Models and routing

SpyCore models, picked automatically by task complexity — or pinned with
`-m`:

| Model | Role |
| --- | --- |
| **Hermes** | fast chat and triage |
| **Minos** | vision + general reasoning |
| **Styx** | the coding workhorse (agent default) |
| **Charon** | deep reasoning for complex tasks |

```bash
spycore agent "rename the User type across the repo" -m charon
spycore chat "explain this stack trace" -m charon --effort high   # deeper reasoning
spycore usage                              # quota: 5-hour window, weekly cap, per-model credits
```

Control how deeply a model thinks with `--effort` (`auto`, `low`, `medium`,
`high`, `max`) — or `/effort` inside the interactive session. Levels are
model-aware: an unsupported level steps down to the nearest one the model offers.
Set a default with `spycore config set defaultEffort high`.

---

## The agent, in practice

- **Plan mode** — `--plan` investigates first and proposes a numbered plan you
  approve before anything executes (auto-enabled for complex tasks; `--no-plan`
  to skip).
- **Checkpoints** — every applied change is journaled; `spycore rewind`
  restores the exact files a run touched.
- **Self-verify** — `--verify "npm test"` runs your check after the task; on
  failure the agent reads the output and fixes it (`--verify-attempts 3`).
- **Budgets** — `--max-turns`, `--max-tokens`, `--max-time 120` stop a run
  gracefully at a cap.
- **Headless / CI** — `--yes` pre-approves writes and commands;
  `--format json` emits machine-readable events; without a TTY everything
  mutating is auto-rejected unless `--yes` is passed.

---

## Bring your own key

Agent runs work against your own model endpoints — no SpyCore account needed:

```bash
spycore agent "fix the failing test" --provider openai --base-url http://localhost:11434/v1 --model my-local-model
spycore provider add work --type anthropic --api-key-env MY_KEY --model your-model-id
spycore provider use work                  # make it the default
```

Types: `openai` (any OpenAI-compatible endpoint, including local servers —
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

---

## MCP

Connect Model Context Protocol servers (stdio); their tools join the agent's
registry on every provider, gated by the same approval prompts:

```bash
spycore mcp add files -- npx -y @modelcontextprotocol/server-filesystem .
spycore mcp test files                     # handshake + list the tools
spycore mcp list
```

MCP servers run with a minimal environment (PATH/HOME + the vars you pass
with `--env`), never your full shell env.

---

## IDE integration (ACP)

`spycore acp` serves the agent over the [Agent Client Protocol](https://agentclientprotocol.com)
on stdio — point Zed (or any ACP client) at it for streaming sessions,
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
terminal. Details and reporting: [SECURITY.md](./SECURITY.md).

---

## All commands

`login` · `logout` · `whoami` · `chat` · `agent` · `rewind` · `usage` ·
`conversations` · `files` · `memory` · `image` · `provider` · `skills` ·
`mcp` · `acp` · `config` · `completion` · `schema` · `update` · `ping` ·
`version`

Run `spycore <command> --help` for flags.

---

## License

Apache-2.0 © 2026 SpyCore AI, Inc. See [LICENSE](./LICENSE) and
[NOTICE](./NOTICE).
