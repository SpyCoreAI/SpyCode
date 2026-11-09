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
 * `close` - a killed run leaves no half-written trace behind. The buffer is
 * BOUNDED (MAX_TRACE_EVENTS / MAX_TRACE_BYTES): past the cap further events
 * are dropped and the count is recorded on the closing line, so a runaway
 * run cannot grow the buffer without limit. Nothing touches disk until
 * `close` - the bound is in memory only, by design.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfigPath } from '../config.js';
import { redactFreeText } from '../redact.js';
import { truncateSafe } from '../text.js';
import type { AgentEvent } from './loop.js';

/** Trace file version (bumped if the line schema ever changes). */
export const RUN_TRACE_VERSION = 1;
/** Subdirectory of the CLI config dir holding trace files. */
export const RUN_TRACE_DIRNAME = 'traces';
/** Max event lines buffered in memory per trace (past this, events drop). */
export const MAX_TRACE_EVENTS = 10_000;
/** Max buffered JSON bytes per trace (past this, events drop). */
export const MAX_TRACE_BYTES = 32 * 1024 * 1024;

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
  /**
   * Events dropped by the writer's memory cap (MAX_TRACE_EVENTS /
   * MAX_TRACE_BYTES). Present only when > 0 - the trace is otherwise whole.
   */
  droppedEvents?: number | undefined;
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
      task: truncateSafe(redactFreeText(opts.task), 2000),
      model: opts.model,
      startedAt: new Date().toISOString(),
      detached: opts.detached,
    } satisfies RunTraceHeader),
  ];
  // Bounded buffer: the header line is always kept; event lines stop being
  // appended past either cap and the dropped count is recorded on close.
  let eventCount = 0;
  let bufferedBytes = lines[0]!.length;
  let droppedEvents = 0;
  return {
    traceId: opts.traceId,
    append: (event: AgentEvent): void => {
      try {
        const line = JSON.stringify(scrubEvent(event));
        if (eventCount >= MAX_TRACE_EVENTS || bufferedBytes + line.length > MAX_TRACE_BYTES) {
          droppedEvents += 1;
          return;
        }
        lines.push(line);
        eventCount += 1;
        bufferedBytes += line.length;
      } catch {
        /* an unserializable event must not break the run */
      }
    },
    close: (result): string => {
      const ended: RunTraceResult = {
        ...result,
        finalText: truncateSafe(redactFreeText(result.finalText), 20_000),
        endedAt: new Date().toISOString(),
        ...(droppedEvents > 0 ? { droppedEvents } : {}),
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
    // Newest first by file mtime, not by id string: lexicographic order is
    // only chronological for `trace-<ts>-<rand>` ids, while detached runs
    // use `run_<hex>` ids whose hex suffix sorts arbitrarily. Name is the
    // tie-break for files written within the same millisecond.
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length))
      .map((id) => {
        let mtimeMs = 0;
        try {
          mtimeMs = statSync(join(dir, `${id}.jsonl`)).mtimeMs;
        } catch {
          /* an unreadable file sorts last */
        }
        return { id, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id))
      .map((e) => e.id);
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
