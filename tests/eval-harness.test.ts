/**
 * A-4 - the behavioral eval harness: a fixed task set + automatic scoring
 * for agent-behavior regression. A dev tool - it has no product surface.
 *
 * Run: `pnpm eval`
 *
 * Each task in `scripts/eval/tasks.json` drives `runAgent` end to end with
 * a SCRIPTED provider (no network, no model, fully deterministic): the
 * "model" replies are fixed strings, so the harness measures the LOOP's
 * behavior - dispatch, approvals, journaling, the final-answer path - not
 * any model's judgement. A task scores 1.0 when every check passes; the
 * suite fails when any task scores below 1.0.
 *
 * Checks (see tasks.json):
 *   tool-called / tool-not-called   the loop dispatched (or never did) a tool
 *   final-contains                  the final answer carries expected text
 *   file-created / file-not-created the workspace gained (or never gained) a file
 *   file-contains                   a workspace file carries expected text
 *   no-mutation                     the run changed zero files
 *   turns-under                      the run finished within n turns
 *
 * ADDING A TASK: append to tasks.json. `turns` are the scripted model
 * replies in order (fenced ```spycore:tool blocks for tool calls, plain
 * text for narration/final answers); the last turn's prose is the final
 * answer. `files` seeds the task workspace. `approval` is "accept" or
 * "reject" for the whole run.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { runAgent, type AgentEvent } from '../src/lib/agent/loop.js';
import type { Provider, ProviderEvent } from '../src/lib/providers/types.js';

const HERE = dirname(fileURLToPath(new URL(import.meta.url)));
const TASKS_FILE = join(HERE, '..', 'scripts', 'eval', 'tasks.json');

interface EvalCheck {
  type: string;
  tool?: string;
  text?: string;
  path?: string;
  n?: number;
}

interface EvalTask {
  id: string;
  title: string;
  task: string;
  files: Record<string, string>;
  turns: string[];
  approval: 'accept' | 'reject';
  checks: EvalCheck[];
}

/** A scripted provider: turn N of streamChat yields turns[N] (last repeats). */
function scriptedProvider(turns: string[]): Provider {
  let n = 0;
  return {
    id: 'openai',
    async createConversation(): Promise<string> {
      return 'cnv_eval';
    },
    async *streamChat(): AsyncIterable<ProviderEvent> {
      const text = turns[Math.min(n, turns.length - 1)] ?? '';
      n += 1;
      yield { type: 'text', text };
      yield { type: 'usage', input: 100, output: 50 };
      yield { type: 'done' };
    },
  };
}

interface CheckResult {
  check: EvalCheck;
  pass: boolean;
  detail: string;
}

function runChecks(
  task: EvalTask,
  result: { finalText: string; turns: number; changedFiles: number },
  cwd: string,
  calledTools: string[],
): CheckResult[] {
  const out: CheckResult[] = [];
  const readWorkspaceFile = (p: string): string | null => {
    try {
      return readFileSync(join(cwd, p), 'utf8');
    } catch {
      return null;
    }
  };
  for (const check of task.checks) {
    switch (check.type) {
      case 'tool-called': {
        const times = calledTools.filter((t) => t === check.tool).length;
        out.push({
          check,
          pass: times > 0,
          detail: times > 0 ? `${check.tool} called ${times}x` : `${check.tool} was never called`,
        });
        break;
      }
      case 'tool-not-called': {
        const times = calledTools.filter((t) => t === check.tool).length;
        out.push({
          check,
          pass: times === 0,
          detail: times === 0 ? `${check.tool} never called` : `${check.tool} called ${times}x`,
        });
        break;
      }
      case 'final-contains': {
        const pass = result.finalText.includes(check.text ?? '');
        out.push({ check, pass, detail: pass ? 'final answer carries the text' : `final answer missing "${check.text}"` });
        break;
      }
      case 'file-created': {
        const pass = readWorkspaceFile(check.path ?? '') !== null;
        out.push({ check, pass, detail: pass ? `${check.path} exists` : `${check.path} was not created` });
        break;
      }
      case 'file-not-created': {
        const pass = readWorkspaceFile(check.path ?? '') === null;
        out.push({ check, pass, detail: pass ? `${check.path} absent` : `${check.path} exists but must not` });
        break;
      }
      case 'file-contains': {
        const content = readWorkspaceFile(check.path ?? '');
        const pass = content !== null && content.includes(check.text ?? '');
        out.push({ check, pass, detail: pass ? `${check.path} carries the text` : `${check.path} missing "${check.text}"` });
        break;
      }
      case 'no-mutation': {
        const pass = result.changedFiles === 0;
        out.push({ check, pass, detail: pass ? 'no files changed' : `${result.changedFiles} files changed` });
        break;
      }
      case 'turns-under': {
        const pass = result.turns <= (check.n ?? 0);
        out.push({ check, pass, detail: pass ? `${result.turns} turns` : `${result.turns} turns (limit ${check.n})` });
        break;
      }
      default:
        out.push({ check, pass: false, detail: `unknown check type "${check.type}"` });
    }
  }
  return out;
}

const { tasks } = JSON.parse(readFileSync(TASKS_FILE, 'utf8')) as { tasks: EvalTask[] };

describe('A-4 behavioral eval harness', () => {
  for (const task of tasks) {
    test(`${task.id} - ${task.title}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'spycode-eval-'));
      try {
        for (const [rel, content] of Object.entries(task.files)) {
          const abs = join(cwd, rel);
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content, 'utf8');
        }
        const calledTools: string[] = [];
        const onEvent = (e: AgentEvent): void => {
          if (e.type === 'tool_call') calledTools.push(e.tool);
        };
        const result = await runAgent({
          task: task.task,
          cwd,
          provider: scriptedProvider(task.turns),
          toolProtocol: 'fenced',
          maxTurns: 10,
          requestApproval:
            task.approval === 'accept'
              ? () => Promise.resolve({ approved: true })
              : () => Promise.resolve({ approved: false, reason: 'rejected by user' }),
          onEvent,
        });
        const checks = runChecks(task, result, cwd, calledTools);
        const failed = checks.filter((c) => !c.pass);
        const score = `${checks.length - failed.length}/${checks.length}`;
        // The score line is the harness's whole output contract - CI greps it.
        process.stdout.write(`[eval] ${task.id}: ${score}\n`);
        for (const f of failed) {
          process.stdout.write(`[eval]   FAIL ${f.check.type}: ${f.detail}\n`);
        }
        expect(failed, `${task.id} scored ${score}`).toEqual([]);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }, 30_000);
  }

  test('the task set is non-trivial (the harness cannot pass by construction)', () => {
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    const ids = new Set(tasks.map((t) => t.id));
    expect(ids.size).toBe(tasks.length); // no duplicate ids
    for (const t of tasks) {
      expect(t.turns.length).toBeGreaterThan(0);
      expect(t.checks.length).toBeGreaterThan(0);
    }
  });
});
