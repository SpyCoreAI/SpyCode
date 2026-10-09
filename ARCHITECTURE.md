# SpyCode Architecture

This document maps the codebase for contributors. It describes what lives
where, how a run flows through the system, and the invariants each layer
is responsible for holding.

## Bird's eye

SpyCode is a single TypeScript CLI (`@spycore/cli`, Node 20+, built with
tsup). Three surfaces share one agent engine:

- `spycore agent "<task>"` - one-shot run with a streaming renderer.
- `spycore` (bare) - the interactive full-screen TUI.
- `spycore chat` - streaming chat against the SpyCore backend.
- `spycore acp` - an Agent Client Protocol server, so IDEs can drive the
  same engine.

Plus a set of management commands (`mcp`, `provider`, `runs`, `cron`,
`memory`, `skills`, `projects`, `conversations`, `files`, `git-workflow`,
`rewind`, `config`, `auth`, ...) that are mostly independent of the agent.

```
src/index.ts            CLI entry: builds the commander program,
                        registers every command group.
src/commands/           One directory per command group.
src/lib/                Shared library: agent engine, providers,
                        output, config, sanitization.
src/ui/                 Ink/React renderers: tui, agent, chat.
tests/                  Vitest suites, one file per area.
```

## The agent engine (`src/lib/agent/`)

`runAgent(opts)` in `loop.ts` is the whole run. It orchestrates six
per-run modules: `run-events.ts` (event log and budget reporting),
`run-context.ts` (skills, change journal, tool context),
`run-delegate.ts` (the `delegate` back-end), `run-dispatch.ts`
(observation window, lifecycle hooks, per-turn dispatch), `run-session.ts`
(MCP bring-up, conversation, tool-protocol choice) and `run-prompt.ts`
(first-turn prompt assembly). Everything else in the directory is a
service the loop calls.

**The turn loop.** Each turn: stream the model's reply (`streamTurn`),
extract tool calls, dispatch them (consecutive read-only calls run in
parallel; mutating calls and `delegate` run alone, in order), assemble the
results into the next turn's message, repeat until the model answers in
prose, the turn budget runs out, or a budget/abort stop fires. Tool calls
arrive two ways:

- *Native mode* (SpyCore backend, when the server advertises it): the
  provider's native `tool_calls` come from the wire.
- *Fenced mode* (BYOK providers, older SpyCore servers, or
  `--tool-protocol fenced`): the model emits `spycore:tool` fenced blocks;
  `protocol.ts` parses them.

Dispatch is the same path either way (`dispatchWithHooks` in
`run-dispatch.ts`): approval gate, catastrophic-command guard, secret guard,
byte caps, and the checkpoint journal. `tools.ts` holds the static tool
registry and `dispatchTool` (read, write, edit, glob, grep, run_command,
delegate, web tools, skills, MCP bridge tools layered per run); each tool
validates args against its schema, then executes against a `ToolContext`
the run builds fresh (`run-context.ts`). The tools themselves live in
`builtin-tools.ts`, the tool contracts and sandbox core in `tool-core.ts`,
and the run_command screener in `command-screen.ts`; `tools.ts` re-exports
their public names.

**Key services around the loop:**

- `approval.ts` - the approval channel. Every gated action (file write,
  shell command, MCP call) pauses on `resolveApproval`; the UI resolves it
  from a keypress, headless runs from policy. Nothing mutating may bypass
  it.
- `checkpoint.ts` - the run journal. Every file mutation records its
  before/after content hash; `planRewind`/`applyRewind` reverse it for
  `/undo` and `spycore rewind`. A sha guard skips files the user touched
  since the run - rewind never clobbers.
- `workspace-delta.ts` - the observation window: with `--observe`, the
  loop snapshots the workspace around each tool call so shell commands,
  MCP tools, and hooks' file effects are journaled too.
- `secrets.ts` - the secret guard. Refuses `.env`, private keys, `.ssh`,
  `.aws`, credential files - including through in-workspace symlinks -
  plus an optional project `.spycoreignore` layer.
- `budget.ts` - shared cost/runaway budget (tokens, wall-clock, turns).
  Caps stop the run gracefully with a `budget_stop` event.
- `mcp-client.ts`, `mcp-http-client.ts`, `mcp.ts`, `mcp-config.ts` - the
  MCP client: stdio + streamable-HTTP transports, per-run tool bridging
  as `mcp__<server>__<tool>`.
- `skills.ts` - skill discovery (`SKILL.md` under project/user dirs) and
  injection.
- `router.ts` - model routing/triage for the TUI's auto model selection.
- `delegate.ts` - sub-agent orchestration (`delegate` tool); children get
  a fresh context with the parent's approval gate, rules, and budget
  inherited.
- `resume.ts`, `session-title.ts`, `task-memory.ts`, `todo.ts` - session
  persistence, titles, cross-run memory, and the session todo list.
- `verify.ts`, `diagnostics.ts` - self-verification (`--verify`) and
  TypeScript diagnostics.
- `repo-map.ts`, `diff.ts`, `shell-parse.ts`, `command-rules.ts` -
  repo orientation, diff rendering, shell parsing, and the user/project
  command allow/deny rules.
- `lsp/` - optional language-server clients for symbol-aware tools.
- `effort.ts` (in `src/lib/`) - the effort-level configuration.

**Events.** The loop emits an ordered `AgentEvent` stream
(`assistant_token`, `tool_call`, `tool_result`, `final`, `budget_stop`,
...) via `onEvent`. UIs render from this stream; nothing else. `AgentResult`
carries the final text, turn/tool counts, and the retained event log.

## Providers (`src/lib/providers/`)

- `spycore.ts` - the SpyCore backend (default). Server-side conversation
  state; the client assembles system+message into one field under the
  wire cap (`wire-clamp.ts`, `wire-limits.ts`).
- `byok-config.ts` - named BYOK provider storage (`openai`, `anthropic`,
  `google` types; `openai` doubles as any OpenAI-compatible endpoint).
- `openai-compatible.ts`, `anthropic.ts`, `google.ts` - the BYOK
  implementations behind the native tool-calling path.
- `factory.ts`, `types.ts` - provider selection and the shared interface.

Auth lives in `src/lib/auth.ts` / `src/lib/oauth.ts`; the config store in
`src/lib/config.ts`.

## Commands (`src/commands/`)

Each group registers itself on the commander program from `index.ts`
(`registerAgentCommand`, `registerMcpCommand`, ...). Conventions:

- Output goes through `src/lib/output.ts`: `print`/`success`/`info`/`warn`
  for text, `json()` for structured output, `--format <text|json|markdown|yaml>`
  via `formatOption()`/`resolveFormat()`. The global `--json` flag maps to
  `--format json`.
- Failures throw `SpycoreCliError(message, code, hint)` from
  `src/lib/errors.ts`; the top level prints message + hint and exits.
- List commands sanitize untrusted fields with `sanitizeForDisplay`
  before printing (see CONTRIBUTING.md - display boundaries sanitize).

Notable commands: `agent` (one-shot runs, `--detached` spawns a
background run managed by `runs`), `rewind` (reverses a session's file
changes), `runs` (list/attach/kill detached runs; attach tails the log),
`cron` (scheduled prompts), `git-workflow` (commit/PR flows).

## UI (`src/ui/`)

All renderers are Ink (React for the terminal).

- `tui/` - the interactive TUI (`TuiApp.tsx`, ~2500 lines). One
  `useInput` owns all keys; `commands.ts` is the slash-command registry
  backing `/` commands, the Ctrl+P palette, and `/help`. Session state
  (transcript, totals, undo history, sidebar) lives in component state;
  each submitted task runs `runAgent` with the same approval controller.
- `agent/` - the one-shot `spycore agent` renderer (`AgentApp.tsx`) and
  `shared.tsx` (approval cards, item views shared with the TUI).
- `chat/` - the streaming chat UI (`ChatApp.tsx`).
- `theme/`, `components/`, `markdown/`, `preview/`, `lib/` - themes,
  shared components, markdown rendering, previews.

The TUI and the one-shot renderer share the approval *view*; the approval
*decisions* flow through the same `ApprovalController` in both.

## Cross-cutting invariants

- **Display sanitizer** (`src/lib/sanitize-display.ts`): the single
  module through which untrusted strings pass before terminal display.
  Strips OSC/CSI sequences (clipboard writes, cursor moves, fake
  prompts), makes lone `\r` and stray controls visible.
- **Approval channel** (`src/lib/agent/approval.ts`): unskippable by
  construction; mandatory checks run before any pre-approval or resolver.
- **Secret handling** (`src/lib/redact.ts`, `secrets.ts`): keys masked in
  listings, credentials redacted from URLs, secret paths unreadable to
  tools.
- **No silent truncation**: every cap (wire message, tool args echo,
  diff display, MCP args) leaves an explicit in-band marker.
- **Per-run isolation**: tool contexts, budgets, skill sets, and MCP
  bridges are built fresh per run and torn down in the loop's `finally`;
  children inherit policy, never conversation state.
