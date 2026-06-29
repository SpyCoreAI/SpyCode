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
  /** Text outside every tool block — narration or, when there are no calls,
   *  the final answer. Trimmed. */
  prose: string;
  /** True when an opening `spycore:tool` fence has no matching close — a
   *  streaming partial we must not act on yet. */
  hasUnclosedBlock: boolean;
}

// Matches a complete fenced block: opening fence + `spycore:tool` info string,
// a newline, the body (non-greedy), then the closing triple-backtick fence.
// `[\s\S]*?` lets the body span lines without the `s` flag.
const COMPLETE_BLOCK_RE = /```[ \t]*spycore:tool[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/g;
// Matches an opening fence regardless of whether it is ever closed.
const OPENING_FENCE_RE = /```[ \t]*spycore:tool/g;

/** Parse one assistant turn into tool calls + prose. Never throws. */
export function parseTurn(raw: string): ParsedTurn {
  const text = typeof raw === 'string' ? raw : '';
  const calls: ParsedToolCall[] = [];
  const errors: ToolBlockError[] = [];

  // Strip complete blocks from the prose as we find them.
  let prose = '';
  let lastIndex = 0;
  let completeBlocks = 0;
  COMPLETE_BLOCK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMPLETE_BLOCK_RE.exec(text)) !== null) {
    completeBlocks += 1;
    prose += text.slice(lastIndex, match.index);
    lastIndex = match.index + match[0].length;
    const body = (match[1] ?? '').trim();
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
 * that drives tool execution — it only affects what is rendered.
 */
export function stripToolBlocksForDisplay(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  // Local regex instances so we never disturb the module-level regexes'
  // lastIndex (which parseTurn relies on).
  const completeRe = /```[ \t]*spycore:tool[ \t]*\r?\n[\s\S]*?\r?\n?[ \t]*```/g;
  let out = text.replace(completeRe, '');
  // After removing complete blocks, any remaining opening fence must be an
  // unclosed/partial block still streaming in — hide it (and anything after).
  const openIdx = out.search(/```[ \t]*spycore:tool/);
  if (openIdx !== -1) out = out.slice(0, openIdx);
  return out;
}
