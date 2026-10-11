/**
 * Tool dispatch for `runAgent`: the observation window, the lifecycle-hook
 * bridge, and the per-turn scheduler (parallel read-only batches, serial
 * mutating calls, malformed-argument results, the per-turn tool-call cap).
 *
 * Imports from loop.ts are type-only. The dispatcher is created once per
 * `runAgent` call. It holds the run's tool context by reference and reads its
 * fields at call time, never as a copy: `extraTools` is assigned after the
 * dispatcher exists, and the window swaps and restores `recordChange` and the
 * approval resolver on the context of each call.
 */
import type { AgentEvent, RunAgentOptions } from './loop.js';
import {
  describeCallArg,
  dispatchTool,
  REGISTRY,
  type ToolContext,
  type ToolResult,
} from './tools.js';
import { DELEGATE_TOOL_NAME } from './delegate.js';
import type { RecordedChange } from './checkpoint.js';
import {
  closePause,
  diffWorkspace,
  openPause,
  pauseNotice,
  snapshotWorkspace,
  uncapturedNotice,
  type PauseCensus,
  type WorkspaceSnapshot,
} from './workspace-delta.js';

/**
 * The run's tool-call counters. Created inside each `runAgent` call; the
 * dispatcher advances them and the turn loop resets and reports them.
 */
export interface TurnCounters {
  toolCalls: number;
  /** Tool calls dispatched when the current turn started - the per-turn cap's baseline. */
  turnCallStart: number;
  /** Set when the per-turn tool-call cap fires; fed back to the model in-band. */
  toolCallCapNote: string | null;
}

/** One run's tool dispatcher: observation outside, hooks inside, one turn's calls at a time. */
export function createRunDispatcher({
  opts,
  ctx,
  emit,
  recordDelta,
  maxToolCallsPerTurn,
  counters,
}: {
  opts: RunAgentOptions;
  ctx: ToolContext;
  emit: (e: AgentEvent) => void;
  recordDelta: (delta: readonly RecordedChange[]) => void;
  maxToolCallsPerTurn: number;
  counters: TurnCounters;
}) {
  // PHASE-1 1.6: wrap tool dispatch with the lifecycle-hook bridge - ONE
  // wrapper for both the fenced and native call sites. No hooks → direct
  // dispatchTool, byte-identical behavior. Blocking-only influence: a
  // pre-tool block substitutes an error result WITHOUT dispatching; nothing
  // here touches requestApproval - an allowed call still runs the normal
  // approval flow inside dispatchTool. The hook layer is failure-isolated.
  /**
   * THE OBSERVATION WINDOW - how an OPAQUE mutation reaches the journal.
   *
   * `write_file` / `edit_file` report themselves. `run_command`, every MCP tool
   * and any hook that runs around a tool call hand work to another process, so
   * the only way to know what they changed is to look before and after.
   * Measured at HEAD before this existed: 5 of the 7 mutation paths one run has
   * were outside the journal while three shipped documents promised `rewind`
   * undoes "everything the last run changed".
   *
   * The window wraps the WHOLE bracket - pre-tool hook, dispatch, post-tool
   * hook - because a hook is a user-configured shell command that mutates as
   * freely as `run_command` does. Session-level hooks (`session-start`,
   * `prompt-submit`, `session-end`) fire outside any tool call and are outside
   * the window; that boundary is stated in SECURITY.md rather than blurred.
   *
   * F-2c-48 - BUT THE APPROVAL PAUSE IS NOT PART OF IT. The bracket contains
   * a prompt whose length is a human decision, and everything that wrote during
   * those seconds was journaled as the call's work - including the user's own
   * edits, which `spycore rewind` then reverted and deleted. The pause is now
   * bracketed by a size-and-timestamp census and folded into the baseline; see
   * the barrier below and `closePause`.  The bracket itself is UNCHANGED, which
   * is what keeps the pre-tool hook - which runs before the prompt - journaled.
   *
   * It opens ONLY when there is something to journal into and something
   * opaque to journal: no recorder ⇒ no snapshot; a self-reporting tool with no
   * hooks configured ⇒ no snapshot. So a read-only turn, and a run whose only
   * mutations are file writes, cost exactly what they cost before.
   *
   * AND IT IS OPT-IN, DEFAULT OFF. Measured through these very calls:
   * ~30 ms per opaque call on a 298-file package, ~375 ms on a 2,472-file
   * monorepo, ~1.4 s at the 20,000-file cap - twice per call, because the
   * window takes a before AND an after picture. That is real money for a user
   * who does not want the journal.  AND IT IS NOT ONLY TIME: the snapshot
   * reads the FULL PLAINTEXT of every file the ignore rules do not hide and
   * stores it on disk, which the published `0.6.0` never did - so the DEFAULT
   * IS OFF (), and `--observe` / `agentObserveWorkspace=true` turns it
   * on. The default is pinned rather than merely the flag; a default that flips
   * silently is the whole hazard, in either direction.
   */
  const opaqueTool = (toolCtx: ToolContext, name: string): boolean => {
    if (name === 'write_file' || name === 'edit_file') return false;
    // F1: `delegate` journals precisely - the child's loop reports every file
    // change through the parent's recordChange sink - so the coarse
    // before/after diff must not journal them a second time. Same double-record
    // hazard write_file/edit_file are excluded for: a double record would make
    // `rewind` restore an intermediate state rather than the prior one.
    if (name === DELEGATE_TOOL_NAME) return false;
    const t = toolCtx.extraTools?.get(name) ?? undefined;
    return name === 'run_command' || t?.mutating === true;
  };

  // R-CLI-1 - OPT-IN. Only an explicit `true` - from
  // `--observe` or from `agentObserveWorkspace=true` - opens the window, so a
  // missing option and an undefined config value both leave it CLOSED and
  // nothing is read or written. The default is pinned rather than merely the
  // flag, because a default that flips silently is the whole hazard - and that
  // is as true of flipping ON as of flipping OFF.
  const observeEnabled = opts.observeWorkspace === true;
  let saidUnobserved = false;

  const dispatchObserved = async (
    toolCtx: ToolContext,
    name: string,
    args: Record<string, unknown>,
    run: () => Promise<ToolResult>,
  ): Promise<ToolResult> => {
    const wantsWindow =
      Boolean(toolCtx.recordChange) && (opaqueTool(toolCtx, name) || Boolean(opts.hooks?.hasAny));
    if (wantsWindow && !observeEnabled) {
      // Told ONCE, at the first opaque call, and never on a read-only run:
      // a user who set the key months ago must still learn that THIS run's
      // shell commands are not undoable. Silence here would ship exactly the
      // "rewind undoes everything" gap the observer exists to close.
      if (!saidUnobserved) {
        saidUnobserved = true;
        emit({
          type: 'hook_notice',
          level: 'warn',
          text: 'workspace observation is off (the default) - changes made by shell commands, MCP tools and hooks are NOT journaled and `spycore rewind` will not restore them; file-tool writes still are. Turn it on with --observe, or `spycore config set agentObserveWorkspace true`',
        });
      }
      return run();
    }
    if (!wantsWindow) return run();
    let before: WorkspaceSnapshot | null = null;
    try {
      before = await snapshotWorkspace(opts.cwd);
    } catch {
      before = null;
    }
    // Paths the tool journals itself inside this window are excluded from the
    // diff, so one change can never be recorded twice - a double record would
    // make `rewind` restore an intermediate state rather than the prior one.
    // NOTE: the swaps below run on the CALL's context, not the shared one -
    // parallel read-only batches hand each call a shallow copy (`{...ctx}`),
    // so concurrent swaps can never interleave on one object.
    const selfJournaled = new Set<string>();
    const outer = toolCtx.recordChange;
    toolCtx.recordChange = (c) => {
      selfJournaled.add(c.path);
      outer?.(c);
    };
    /**
     * F-2c-48 · `C-LC8` - THE APPROVAL PAUSE IS TAKEN OUT OF THE WINDOW.
     *
     * The bracket below spans the pre-tool hook, the dispatch and the post-tool
     * hook, and the dispatch contains an approval prompt whose length is a human
     * decision. Everything that wrote during those seconds was a difference the
     * observer could see and could not attribute, so it was journaled as this
     * call's work - and `spycore rewind` then reverted the user's own edits and
     * deleted the user's own new files, with `planRewind`'s no-clobber guard
     * structurally unable to intervene (the foreign content IS the journal's
     * `after`, so the shas match and the restore proceeds).
     *
     * Wrapping `ctx.requestApproval` for the window's lifetime is the same
     * swap-and-restore idiom `ctx.recordChange` uses two lines above, and it is
     * enough BECAUSE F-2c-45 made the approval channel single and unskippable:
     * all three gated sites inside a window - `write_file`/`edit_file`, a command,
     * and every MCP tool - end at `resolveApproval(ctx.requestApproval, …)`. Before
     * that rebuild an `allow` rule skipped the channel entirely, so a barrier
     * installed here would have been void for exactly the users who configured a
     * rule.  The pre-approval path still returns INSIDE `resolveApproval` without
     * reaching the resolver, which is correct: there is no human pause to remove.
     *
     * The pause is FOLDED INTO THE BASELINE rather than excluded - see
     * `closePause`. Attribution stays complete in both directions: the command's
     * own write to a file the user also touched is journaled with the USER's
     * content as `before`, which is what `rewind` should restore.
     */
    const baseline = before;
    const outerApproval = toolCtx.requestApproval;
    if (outerApproval) {
      toolCtx.requestApproval = async (req) => {
        if (baseline === null) return outerApproval(req);
        let census: PauseCensus | null = null;
        try {
          census = await openPause(baseline);
        } catch {
          census = null;
        }
        try {
          return await outerApproval(req);
        } finally {
          if (census !== null) {
            try {
              const notice = pauseNotice(await closePause(baseline, census));
              if (notice) emit({ type: 'hook_notice', level: 'info', text: notice });
            } catch {
              /* observation must never break the run - the decision is already made */
            }
          }
        }
      };
    }
    let res: ToolResult;
    try {
      res = await run();
    } finally {
      toolCtx.recordChange = outer;
      toolCtx.requestApproval = outerApproval;
    }
    if (before === null) {
      // A workspace we could not observe is REPORTED, never silent. This is
      // the branch that keeps the shipped sentence honest when the caps bite.
      if (opaqueTool(toolCtx, name)) {
        emit({
          type: 'hook_notice',
          level: 'warn',
          text: `workspace too large to journal - changes made by "${name}" are NOT undoable with \`spycore rewind\``,
        });
      }
      return res;
    }
    try {
      const delta = await diffWorkspace(before, selfJournaled);
      recordDelta(delta.changes);
      const notice = uncapturedNotice(delta.uncaptured);
      if (notice) emit({ type: 'hook_notice', level: 'warn', text: notice });
    } catch {
      /* observation must never break the run - the tool already succeeded */
    }
    return res;
  };

  const dispatchHooked = async (
    toolCtx: ToolContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const hooks = opts.hooks;
    if (!hooks?.hasAny) return dispatchTool(name, args, toolCtx);
    try {
      const pre = await hooks.preTool(name, args);
      for (const n of pre.notices) emit({ type: 'hook_notice', level: 'warn', text: n });
      if (pre.blocked) {
        return {
          ok: false,
          summary: 'blocked by a user hook',
          content: `Error: this tool call was blocked by a user pre-tool hook${pre.reason ? ` - ${pre.reason}` : ''}. Do not retry the same call; adjust your approach or finish without it.`,
        };
      }
    } catch {
      /* the hook layer can never break the run */
    }
    const res = await dispatchTool(name, args, toolCtx);
    try {
      const post = await hooks.postTool(name, res.ok, res.summary);
      for (const n of post.notices) emit({ type: 'hook_notice', level: 'info', text: n });
      if (post.feedback) {
        // Appended AFTER dispatch's capContent. Safe by arithmetic, not luck:
        // `MAX_RESULT_CHARS` already reserved HOOK_FEEDBACK_APPEND_MAX_CHARS
        // (this `\n\n` + the widest possible block), so the sum still fits the
        // server's 32,000-char wire cap - and the cap can never have cut this
        // block's closing sentinel, because it only ever cuts `res.content`.
        return { ...res, content: `${res.content}\n\n${post.feedback}` };
      }
    } catch {
      /* isolated */
    }
    return res;
  };

  /** The single call the loop uses: observation on the outside, hooks inside. */
  const dispatchWithHooks = async (
    toolCtx: ToolContext,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> =>
    dispatchObserved(toolCtx, name, args, () => dispatchHooked(toolCtx, name, args));

  /**
   * True when a tool call may run concurrently with its siblings in the same
   * turn: every read-only tool (`mutating !== true`) qualifies. `delegate` is
   * deliberately excluded even though it is not marked mutating - a nested
   * agent run must stay serial (one approval UX, one journal, no interleaved
   * event streams). Unknown tools stay serial too, so their "unknown tool"
   * error surfaces exactly as before.
   */
  const isParallelizable = (name: string): boolean => {
    if (name === DELEGATE_TOOL_NAME) return false;
    const tool = ctx.extraTools?.get(name) ?? REGISTRY.get(name);
    return tool !== undefined && tool.mutating !== true;
  };

  /** One event pair per call, in call order - shared by the serial and batch paths. */
  const emitCallEvents = (
    turn: number,
    index: number,
    tool: string,
    args: Record<string, unknown>,
    res: ToolResult,
  ): void => {
    emit({
      type: 'tool_call',
      turn,
      index,
      tool,
      arg: describeCallArg(tool, args),
      args,
    });
    emit({
      type: 'tool_result',
      turn,
      index,
      tool,
      ok: res.ok,
      summary: res.summary,
      kind: res.kind,
      added: res.added,
      removed: res.removed,
      isNew: res.isNew,
      command: res.command,
      outputTail: res.outputTail,
    });
  };

  /**
   * Dispatch one turn's tool calls. CONSECUTIVE read-only calls run
   * concurrently (`Promise.all`); a mutating call - or anything that is not
   * parallelizable - runs alone, in order, exactly as before. A call whose
   * arguments failed to parse is never dispatched: it gets its error result
   * inline, in index order, exactly as before (and still counts as a tool
   * call). Results come back positionally - a `null` slot is a call the
   * per-turn cap skipped - so the model feedback and the event stream keep
   * their index order. Returns `null` when the run was aborted mid-turn (the
   * caller converts that to the cancelled result).
   *
   * The per-turn tool-call cap (`maxToolCallsPerTurn`) is enforced here, in
   * one place for the serial and batch paths alike: the check runs before
   * every call and before every batch, a batch never starts more calls than
   * the remaining allowance, and the `tool_call_cap` event plus the in-band
   * notice fire exactly as the old serial loop did.
   *
   * Each batched call gets a SHALLOW copy of the tool context: the
   * observation window swaps `recordChange`/`requestApproval` on the context
   * it is given, and sharing one object across concurrent calls would let
   * those swaps interleave. The copy keeps every other field identical
   * (delegator, skills, limits, ... are shared by reference, as before).
   */
  const dispatchTurnCalls = async (
    turn: number,
    calls: Array<{
      tool: string;
      args: Record<string, unknown>;
      argError: string | null;
      index: number;
    }>,
  ): Promise<Array<ToolResult | null> | null> => {
    const results: Array<ToolResult | null> = new Array(calls.length).fill(null);
    const fireCap = (from: number): void => {
      const skipped = calls.length - from;
      emit({ type: 'tool_call_cap', turn, cap: maxToolCallsPerTurn, skipped });
      counters.toolCallCapNote = `Tool-call cap reached (${maxToolCallsPerTurn} calls this turn) - ${skipped} further call${skipped === 1 ? '' : 's'} skipped. Continue with the results so far.`;
    };
    let i = 0;
    while (i < calls.length) {
      if (opts.signal?.aborted) return null;
      if (counters.toolCalls - counters.turnCallStart >= maxToolCallsPerTurn) {
        fireCap(i);
        break;
      }
      const call = calls[i]!;
      if (call.argError !== null) {
        // Malformed arguments: never dispatched, error result inline, in
        // index order, exactly as before (still counts as a tool call).
        counters.toolCalls += 1;
        const res: ToolResult = {
          ok: false,
          summary: 'invalid arguments',
          content: `Error: ${call.tool} ${call.argError}. Re-issue the call with valid JSON arguments.`,
        };
        emit({
          type: 'tool_call',
          turn,
          index: call.index,
          tool: call.tool,
          arg: '',
          args: {},
        });
        emit({
          type: 'tool_result',
          turn,
          index: call.index,
          tool: call.tool,
          ok: res.ok,
          summary: res.summary,
          kind: res.kind,
          added: res.added,
          removed: res.removed,
          isNew: res.isNew,
          command: res.command,
          outputTail: res.outputTail,
        });
        results[i] = res;
        i += 1;
        continue;
      }
      if (!isParallelizable(call.tool)) {
        counters.toolCalls += 1;
        const res = await dispatchWithHooks(ctx, call.tool, call.args);
        emitCallEvents(turn, call.index, call.tool, call.args, res);
        results[i] = res;
        i += 1;
        continue;
      }
      // Gather the maximal run of parallelizable, well-formed calls starting
      // here.
      const batch: number[] = [];
      while (i + batch.length < calls.length) {
        const q = calls[i + batch.length]!;
        if (q.argError !== null || !isParallelizable(q.tool)) break;
        batch.push(i + batch.length);
      }
      // The cap binds the whole turn, not the batch: never start more calls
      // than the remaining allowance. `remaining` is >= 1 here - the loop-top
      // check already fired otherwise - so the batch is never empty.
      const remaining = maxToolCallsPerTurn - (counters.toolCalls - counters.turnCallStart);
      const runnable = batch.slice(0, remaining);
      for (const bi of runnable) {
        const c = calls[bi]!;
        counters.toolCalls += 1;
        emit({
          type: 'tool_call',
          turn,
          index: c.index,
          tool: c.tool,
          arg: describeCallArg(c.tool, c.args),
          args: c.args,
        });
      }
      const settled = await Promise.all(
        runnable.map((bi) => {
          const c = calls[bi]!;
          return dispatchWithHooks({ ...ctx }, c.tool, c.args);
        }),
      );
      runnable.forEach((bi, k) => {
        const c = calls[bi]!;
        const res = settled[k]!;
        emit({
          type: 'tool_result',
          turn,
          index: c.index,
          tool: c.tool,
          ok: res.ok,
          summary: res.summary,
          kind: res.kind,
          added: res.added,
          removed: res.removed,
          isNew: res.isNew,
          command: res.command,
          outputTail: res.outputTail,
        });
        results[bi] = res;
      });
      i += runnable.length;
    }
    return results;
  };

  return { dispatchTurnCalls };
}
