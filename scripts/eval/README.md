# Behavioral eval harness (A-4)

A fixed task set + automatic scoring for agent-behavior regression.
A dev tool: it has no product surface and ships no user-facing behavior.

## Run

```sh
pnpm eval        # vitest run tests/eval-harness.test.ts
```

Each task in `scripts/eval/tasks.json` drives `runAgent` end to end with a
**scripted provider** - no network, no model, fully deterministic. The
"model" replies are fixed strings, so the harness measures the **loop's**
behavior (dispatch, approvals, journaling, the final-answer path), not any
model's judgement.

A task scores `n/n` when every check passes; the suite fails when any task
scores below 1.0. Each task prints its score line on stdout (`[eval] <id>:
n/n`) for CI to grep.

## Task format

```json
{
  "id": "read-then-report",
  "title": "Read a file and report its contents",
  "task": "Read src/greet.ts and tell me what the greet function returns.",
  "files": { "src/greet.ts": "export function greet(): string {\n  return 'hello';\n}\n" },
  "turns": [
    "```spycore:tool\n{\"tool\": \"read_file\", \"args\": {\"path\": \"src/greet.ts\"}}\n```",
    "The greet function returns 'hello'."
  ],
  "approval": "accept",
  "checks": [
    { "type": "tool-called", "tool": "read_file" },
    { "type": "final-contains", "text": "hello" },
    { "type": "no-mutation" }
  ]
}
```

- `turns`: the scripted model replies in order. Fenced
  ```` ```spycore:tool ```` blocks become tool calls; plain text is
  narration, and the last turn's prose is the final answer. If the loop
  keeps going past the script, the last turn repeats.
- `files`: seed files written into a fresh temp workspace per task.
- `approval`: `"accept"` or `"reject"` for the whole run's approval gate.
- `checks`: deterministic assertions over the run. Supported types:
  `tool-called` / `tool-not-called` (with `tool`), `final-contains` (with
  `text`), `file-created` / `file-not-created` (with `path`),
  `file-contains` (with `path` + `text`), `no-mutation`,
  `turns-under` (with `n`).

## Adding a task

Append to `tasks.json`. Keep ids unique and the set small enough to stay
fast (the whole harness should finish in seconds). Prefer checks that pin
loop behavior - approval outcomes, dispatch, mutation - over checks that
would depend on any model's judgement.
