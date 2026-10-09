# Contributing to SpyCode

Thanks for your interest. This document covers how to work on this
repository: setup, the checks we expect to be green, and the conventions the
codebase holds itself to. Read it before opening a pull request.

## How to contribute

- **Issues are welcome** - bug reports and feature requests alike. Please use
  the issue templates. A good bug report names the command, the input, what
  you expected, and what you got; logs help.
- **Pull requests are reviewed** here and, when accepted, ported into the
  source tree this mirror is published from - your authorship is credited in
  the ported commit.
- **Security reports** go to security@spycore.ai (see
  [SECURITY.md](./SECURITY.md)), never the public tracker.
- **Code of conduct:** be kind and constructive - harassment of any kind is
  not tolerated.

## Development setup

Requirements: **Node 20+**, pnpm.

```bash
pnpm install      # dependencies
pnpm build        # tsup bundle into dist/
pnpm test         # build, then the full vitest suite
```

The test script runs the build first, so `pnpm test` alone is enough before
a PR. Individual suites: `npx vitest run <test-file>` (e.g.
`npx vitest run approval-channel.test.ts`).

Lint is two TypeScript passes, no separate linter:

```bash
pnpm lint          # tsc --noEmit && tsc -p tsconfig.test.json
```

Keep both green. The second pass covers the `tests/` tree, which has its
own tsconfig.

## Where things live

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full map. The short version:

- `src/index.ts` - CLI entry; registers every command.
- `src/commands/` - one directory per command group (`agent`, `mcp`,
  `provider`, `runs`, `cron`, `memory`, `skills`, `projects`,
  `conversations`, `files`, `git-workflow`, `rewind`, ...). Each exposes a
  `register*Command(program)` function.
- `src/lib/agent/` - the agent engine: `loop.ts` (the turn loop) and its
  per-run modules `run-events.ts`, `run-context.ts`, `run-delegate.ts`,
  `run-dispatch.ts`, `run-session.ts`, `run-prompt.ts`; `tools.ts` (the
  tool registry and dispatch) with `tool-core.ts` (tool contracts and
  sandbox core), `builtin-tools.ts` (the built-in tools) and
  `command-screen.ts` (the run_command screener); `approval.ts` (the
  approval channel), `checkpoint.ts` (the run journal), `budget.ts`,
  `secrets.ts`, `mcp-*.ts`, `skills.ts`, `delegate.ts`, `verify.ts`,
  `resume.ts`.
- `src/lib/providers/` - the SpyCore backend plus BYOK
  (OpenAI/Anthropic/Google-compatible) providers.
- `src/ui/tui/` - the interactive full-screen TUI (`TuiApp.tsx`).
  `src/ui/agent/` - the one-shot `spycore agent` renderer (`AgentApp.tsx`).
  `src/ui/chat/` - the streaming chat UI.

## Conventions that are load-bearing

These are not style preferences; the test suite pins several of them and
review will push back if you break them.

**Display boundaries sanitize.** Every model/file/MCP/registry-controlled
string passes through `sanitizeForDisplay` (in `src/lib/sanitize-display.ts`)
before it reaches the terminal. It strips ESC sequences (OSC clipboard
writes, CSI cursor moves), maps stray control bytes to visible pictures, and
makes lone `\r` visible. The `display\`...\`` template tag sanitizes
interpolations automatically. `print`/`success`/`info`/`warn` deliberately do
*not* sanitize - callers' own styling must survive - so sanitize at the
interpolation, not the sink. Never apply the sanitizer to bytes bound for the
model, the server, files, or `--json` output (JSON.stringify already escapes
C0 controls).

**Every gated action traverses the approval channel.** Mutating tools pause
via `resolveApproval` in `src/lib/agent/approval.ts`; the Ink UI resolves
the promise from a keypress, headless callers resolve it per policy
(`--yes` auto-approves, otherwise auto-reject). Do not add a code path that
decides "approved" without going through it - that shape of bug has been
found here before, and `approval-channel.test.ts` exists to keep it found.

**Errors are `SpycoreCliError` with an exit code.** User-facing failures
throw `SpycoreCliError(message, EXIT_USER_ERROR, hint)` from
`src/lib/errors.ts`; the top level prints the message plus the hint and
exits with the code. Reserve `EXIT_NETWORK_ERROR` for transport failures.
Never `process.exit` from library code.

**Secrets never touch the terminal or the disk casually.** API keys are
masked in `provider list`, redacted from URLs (`redactUrlCredentials`), and
never echoed by `mcp list`. The secret guard (`src/lib/agent/secrets.ts`)
refuses to read `.env`, private keys, `.ssh`, `.aws`, and credential files,
including through in-workspace symlinks. If your change moves a value
toward a display surface, a file, or the network, check it against this
list first.

**The run journal is the undo story.** File mutations are recorded through
the checkpoint journal (`src/lib/agent/checkpoint.ts`) so `/undo` and
`spycore rewind` can put them back. A new mutating tool must record through
the same sink - journaling is what makes a change revertible.

**ESM with explicit `.js` suffixes.** Imports of sibling modules use the
`.js` extension (`'../../lib/text.js'`), matching the tsup ESM output.
Type-only imports use `import type`.

**Keep behaviour identical when refactoring.** When you extract shared
helpers or rename internals, the observable output must not move. Where two
near-identical helpers differ in an edge case, keep both (or document the
difference) rather than silently unifying them.

## Tests

Tests live in `tests/` and run under vitest. Match the existing style:
focused unit tests for pure functions (`*.test.ts` next to nothing - they
all live in the one directory), with names that state the property being
pinned. If you fix a bug, add a regression test that fails without the fix.
If you change a pinned behaviour (approval keys, output formats, exit
codes), update the pinning test in the same commit and say so in the PR
description - silent pin changes are the fastest way to get a review kicked
back.

## Pull request checklist

1. `pnpm lint && pnpm test` green, locally.
2. New behaviour has tests; bug fixes have regression tests.
3. User-facing changes update the relevant docs (`README.md`,
   `ARCHITECTURE.md`, or command help text).
4. No secrets, tokens, or machine-specific paths in the diff.
5. The PR description states what changed and why, and names any pinned
   behaviour it alters.

Small, reviewable PRs beat large ones. When in doubt, open an issue first
and sketch the approach - it is cheaper than reworking a finished PR.
