/**
 * Tool-call wire protocol for the client-side agent loop.
 *
 * Because the CLI talks to the text-streaming /api/chat/stream surface (native
 * backend tool-use is a later phase), the model emits tool calls as strict,
 * parseable TEXT. We use a fenced block tagged `spycore:tool` whose body is a
 * single JSON object:
 *
 *     ```spycore:tool
 *     {"tool": "read_file", "args": {"path": "src/index.ts"}}
 *     ```
 *
 * Rules this parser enforces:
 *  - A turn may contain ZERO OR MORE complete blocks. Zero complete blocks +
 *    no dangling fence ⇒ the message is the model's final answer.
 *  - Only blocks whose CLOSING fence has arrived are acted on. A trailing
 *    opening fence with no close is a streaming partial (`hasUnclosedBlock`)
 *    and is never executed.
 *  - Surrounding prose/whitespace is tolerated; prose is returned separately.
 *  - Malformed blocks (bad JSON / wrong shape) are collected as structured
 *    errors so the loop can ask the model to retry rather than crashing.
 */

/** A successfully parsed, complete tool-call block. */
export interface ParsedToolCall {
  tool: string;
  args: Record<string, unknown>;
  /** The raw JSON body of the block (for tracing). */
  raw: string;
}

/** A complete block whose body was not a valid tool call. */
export interface ToolBlockError {
  raw: string;
  message: string;
}

export interface ParsedTurn {
  /** Valid tool calls, in document order. */
  calls: ParsedToolCall[];
  /** Complete-but-invalid blocks. */
  errors: ToolBlockError[];
  /** Text outside every tool block - narration or, when there are no calls,
   *  the final answer. Trimmed. */
  prose: string;
  /** True when an opening `spycore:tool` fence has no matching close - a
   *  streaming partial we must not act on yet. */
  hasUnclosedBlock: boolean;
}

// Matches an opening fence regardless of whether it is ever closed.
const OPENING_FENCE_RE = /```[ \t]*spycore:tool/g;

/** One complete fenced block: its span in the turn plus its raw body. */
interface CompleteBlock {
  start: number;
  end: number;
  body: string;
}

/**
 * True when `body` parses as a JSON object - the shape every tool block
 * must have. Used to pick the REAL closing fence: a `write_file` whose
 * content holds a fenced code block contains ``` lines INSIDE the JSON
 * string, and the old non-greedy regex stopped at the first of them and
 * truncated the block. A truncated body cannot parse (the string is
 * unterminated / the braces unbalanced), so a fence that yields a
 * parseable object is the close, and any earlier fence is content.
 */
function parsesAsToolBlockBody(body: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(body.trim());
  } catch {
    return false;
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Find every complete tool block in `text`, in document order. For each
 * opening fence, the closing fence is the FIRST ``` after it whose
 * preceding body parses as a JSON object; when no fence yields a
 * parseable body the block is malformed and the FIRST fence is its close
 * (so the error is still reported, exactly as before, instead of the
 * block silently becoming "unclosed").
 */
function findCompleteBlocks(text: string): CompleteBlock[] {
  const blocks: CompleteBlock[] = [];
  const openRe = /```[ \t]*spycore:tool[ \t]*\r?\n/g;
  let open: RegExpExecArray | null;
  while ((open = openRe.exec(text)) !== null) {
    const bodyStart = open.index + open[0].length;
    const fenceRe = /```/g;
    fenceRe.lastIndex = bodyStart;
    let fence: RegExpExecArray | null;
    let firstFence: { start: number; end: number } | null = null;
    let accepted: CompleteBlock | null = null;
    while ((fence = fenceRe.exec(text)) !== null) {
      const fenceStart = fence.index;
      const fenceEnd = fence.index + fence[0].length;
      if (!firstFence) firstFence = { start: fenceStart, end: fenceEnd };
      if (parsesAsToolBlockBody(text.slice(bodyStart, fenceStart))) {
        accepted = { start: open.index, end: fenceEnd, body: text.slice(bodyStart, fenceStart) };
        break;
      }
    }
    if (accepted) {
      blocks.push(accepted);
      openRe.lastIndex = accepted.end;
    } else if (firstFence) {
      blocks.push({
        start: open.index,
        end: firstFence.end,
        body: text.slice(bodyStart, firstFence.start),
      });
      openRe.lastIndex = firstFence.end;
    } else {
      // No closing fence at all: an unclosed/streaming block - stop here;
      // `hasUnclosedBlock` is derived from the opening count below.
      break;
    }
  }
  return blocks;
}

/** Parse one assistant turn into tool calls + prose. Never throws. */
export function parseTurn(raw: string): ParsedTurn {
  const text = typeof raw === 'string' ? raw : '';
  const calls: ParsedToolCall[] = [];
  const errors: ToolBlockError[] = [];

  // Strip complete blocks from the prose as we find them.
  let prose = '';
  let lastIndex = 0;
  let completeBlocks = 0;
  for (const block of findCompleteBlocks(text)) {
    completeBlocks += 1;
    prose += text.slice(lastIndex, block.start);
    lastIndex = block.end;
    const body = block.body.trim();
    const parsed = parseBlockBody(body);
    if ('error' in parsed) {
      errors.push({ raw: body, message: parsed.error });
    } else {
      calls.push(parsed.call);
    }
  }
  prose += text.slice(lastIndex);

  // An opening fence with no completed match ⇒ a dangling/partial block.
  OPENING_FENCE_RE.lastIndex = 0;
  const openingCount = (text.match(OPENING_FENCE_RE) ?? []).length;
  const hasUnclosedBlock = openingCount > completeBlocks;

  return { calls, errors, prose: prose.trim(), hasUnclosedBlock };
}

type BlockParse = { call: ParsedToolCall } | { error: string };

function parseBlockBody(body: string): BlockParse {
  if (body.length === 0) {
    return { error: 'empty tool block' };
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { error: `block body is not valid JSON (${detail})` };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: 'block body must be a JSON object' };
  }
  const obj = value as Record<string, unknown>;
  const tool = obj.tool;
  if (typeof tool !== 'string' || tool.trim().length === 0) {
    return { error: 'block is missing a string "tool" field' };
  }
  let args: Record<string, unknown> = {};
  if (obj.args !== undefined) {
    if (typeof obj.args !== 'object' || obj.args === null || Array.isArray(obj.args)) {
      return { error: '"args" must be a JSON object' };
    }
    args = obj.args as Record<string, unknown>;
  }
  return { call: { tool: tool.trim(), args, raw: body } };
}

/**
 * DISPLAY-ONLY: strip `spycore:tool` fenced blocks from assistant text so the
 * raw tool JSON is never shown in the agent UI (the `⚙ tool …` lines convey
 * the action instead). Removes every COMPLETE block, then drops a trailing
 * UNCLOSED/partial block so a streaming turn never flashes half-written JSON.
 * Surrounding prose is preserved. This does NOT touch `parseTurn` or anything
 * that drives tool execution - it only affects what is rendered.
 */
export function stripToolBlocksForDisplay(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  // Remove every complete block by span (same JSON-aware scan as
  // parseTurn, so display and execution agree on where a block ends).
  let out = '';
  let lastIndex = 0;
  for (const block of findCompleteBlocks(text)) {
    out += text.slice(lastIndex, block.start);
    lastIndex = block.end;
  }
  out += text.slice(lastIndex);
  // After removing complete blocks, any remaining opening fence must be an
  // unclosed/partial block still streaming in - hide it (and anything after).
  const openIdx = out.search(/```[ \t]*spycore:tool/);
  if (openIdx !== -1) out = out.slice(0, openIdx);
  return out;
}
