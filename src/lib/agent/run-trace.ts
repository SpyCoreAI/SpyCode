/**
 * A-5 - structured trace + replay. A dev tool: every run can record a
 * structured trace (one JSONL file per run: a header line, one line per
 * `AgentEvent`, one closing line with the run's outcome), and
 * `spycore runs replay <id>` re-presents it deterministically for
 * debugging - the exact turn/tool-call/result sequence as it happened.
 *
 * Traces live in `<configDir>/traces/<traceId>.jsonl` at 0600 (a transcript
 * may contain pasted secrets). Recording is opt-in per invocation
 * (`spycore agent --trace`) and automatic for detached runs (the run id is
 * the trace id), so a background run is always replayable.
 *
 * The writer buffers in memory and commits atomically (tmp + rename) on
 * `close` - a killed run leaves no half-written trace behind.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigPath } from '../config.js';
import { redactFreeText } from '../redact.js';
import type { AgentEvent } from './loop.js';

/** Trace file version (bumped if the line schema ever changes). */
export const RUN_TRACE_VERSION = 1;
/** Subdirectory of the CLI config dir holding trace files. */
export const RUN_TRACE_DIRNAME = 'traces';

/** Where trace files live (created on first write, never on read). */
export function runTraceDir(configDir?: string): string {
  const base = configDir ?? dirname(getConfigPath());
  return join(base, RUN_TRACE_DIRNAME);
}

/** Trace ids are generated internally (`trace-<ts>-<rand>` for --trace,
 * `run_<hex>` for detached runs). Anything else is rejected so
 * `spycore runs replay <id>` can never read outside the traces dir. */
export function isValidTraceId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,64}$/.test(id);
}

/** Absolute path of one trace file. */
export function runTracePath(traceId: string, configDir?: string): string {
  return join(runTraceDir(configDir), `${traceId}.jsonl`);
}

/** The trace's first line. */
export interface RunTraceHeader {
  v: typeof RUN_TRACE_VERSION;
  traceId: string;
  /** The task text, secret-scrubbed. */
  task: string;
  model: string;
  startedAt: string;
  /** True for a detached background run (trace id = run id). */
  detached: boolean;
}

/** The trace's last line: the run's outcome. */
export interface RunTraceResult {
  finalText: string;
  turns: number;
  toolCalls: number;
  changedFiles: number;
  cancelled: boolean;
  reachedMaxTurns: boolean;
  budgetStop: string | null;
  endedAt: string;
}

export interface RunTraceWriter {
  /** Append one event (secret-scrubbed free text). */
  append(event: AgentEvent): void;
  /** Commit the trace atomically; returns the trace file path. */
  close(result: Omit<RunTraceResult, 'endedAt'>): string;
  readonly traceId: string;
}

/** Scrub free-text fields of one event before it touches disk. */
function scrubEvent(event: AgentEvent): AgentEvent {
  // Only string fields that can carry user/model free text are scrubbed;
  // numeric/boolean fields pass through untouched.
  const out: Record<string, unknown> = { ...event };
  for (const k of ['chunk', 'text', 'arg', 'summary', 'command', 'outputTail', 'message']) {
    const v = out[k];
    if (typeof v === 'string') out[k] = redactFreeText(v);
  }
  if (typeof out['args'] === 'object' && out['args'] !== null) {
    try {
      out['args'] = JSON.parse(redactFreeText(JSON.stringify(out['args']))) as unknown;
    } catch {
      out['args'] = {};
    }
  }
  return out as AgentEvent;
}

/** Create a trace writer. Nothing touches disk until `close`. */
export function createRunTraceWriter(opts: {
  traceId: string;
  task: string;
  model: string;
  detached: boolean;
  configDir?: string;
}): RunTraceWriter {
  const lines: string[] = [
    JSON.stringify({
      v: RUN_TRACE_VERSION,
      traceId: opts.traceId,
      task: redactFreeText(opts.task).slice(0, 2000),
      model: opts.model,
      startedAt: new Date().toISOString(),
      detached: opts.detached,
    } satisfies RunTraceHeader),
  ];
  return {
    traceId: opts.traceId,
    append: (event: AgentEvent): void => {
      try {
        lines.push(JSON.stringify(scrubEvent(event)));
      } catch {
        /* an unserializable event must not break the run */
      }
    },
    close: (result): string => {
      const ended: RunTraceResult = {
        ...result,
        finalText: redactFreeText(result.finalText).slice(0, 20_000),
        endedAt: new Date().toISOString(),
      };
      lines.push(JSON.stringify({ v: RUN_TRACE_VERSION, result: ended }));
      const dir = runTraceDir(opts.configDir);
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `${opts.traceId}.jsonl.tmp-${process.pid}`);
      writeFileSync(tmp, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
      const dest = runTracePath(opts.traceId, opts.configDir);
      renameSync(tmp, dest);
      return dest;
    },
  };
}

/** Trace ids with a file on disk (newest first). */
export function listRunTraces(configDir?: string): string[] {
  const dir = runTraceDir(configDir);
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** Read a trace file's lines (parsed JSON, header first). Null when missing or the id is invalid. */
export function readRunTrace(
  traceId: string,
  configDir?: string,
): Array<Record<string, unknown>> | null {
  if (!isValidTraceId(traceId)) return null;
  const p = runTracePath(traceId, configDir);
  try {
    if (!existsSync(p)) return null;
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return null;
  }
}
