/**
 * Approval gate for mutating tools.
 *
 * Mutating tools pause by awaiting `ctx.requestApproval(request)`. The Ink UI
 * resolves that promise from a keypress; headless callers resolve it
 * immediately (auto-reject, or auto-approve with --yes). The state machine is
 * factored here (UI-agnostic) so it can be unit-tested directly.
 */
import type { DiffLine } from './diff.js';

export type MutationOutcome = 'applied' | 'rejected' | 'blocked';
/** UI glyph hint for a tool result (writes share MutationOutcome; commands add 'command'). */
export type ToolResultKind = MutationOutcome | 'command';

/** A file write/edit awaiting approval — the diff is what the user approves. */
export interface WriteApprovalRequest {
  kind: 'write';
  tool: 'write_file' | 'edit_file';
  /** Path relative to cwd, for display. */
  path: string;
  isNew: boolean;
  added: number;
  removed: number;
  diff: DiffLine[];
  truncated: boolean;
  hiddenLines: number;
}

/** A shell command awaiting approval — the command string is what to approve. */
export interface CommandApprovalRequest {
  kind: 'command';
  command: string;
}

/**
 * An MCP tool call awaiting approval. MCP servers are external and opaque, so
 * EVERY call is gated like a mutating built-in — the preview shows the server,
 * the tool, and the exact JSON arguments the model wants to send.
 */
export interface McpApprovalRequest {
  kind: 'mcp';
  /** The configured server name. */
  server: string;
  /** The server-side tool name (un-prefixed). */
  tool: string;
  /** The model-facing tool id, `mcp__<server>__<tool>`. */
  fullName: string;
  /** The arguments the model passed (already parsed JSON). */
  args: Record<string, unknown>;
}

/** What the model wants to do, awaiting a user decision. */
export type ApprovalRequest = WriteApprovalRequest | CommandApprovalRequest | McpApprovalRequest;

export interface ApprovalOutcome {
  approved: boolean;
  /** Why it was not approved (shown to the model on rejection). */
  reason?: string;
}

export type RequestApproval = (request: ApprovalRequest) => Promise<ApprovalOutcome>;

export type ApprovalDecision = 'accept' | 'accept_all' | 'reject';

export interface ApprovalController {
  /** Passed to runAgent as `requestApproval`. */
  request: RequestApproval;
  pending(): ApprovalRequest | null;
  hasPending(): boolean;
  /** Resolve the currently-pending request from a user keypress. */
  resolvePending(decision: ApprovalDecision): void;
  /** Reject the pending request (e.g. Ctrl+C) with a custom reason. */
  reject(reason?: string): void;
  /** Preemptively turn session-wide auto-approval on/off (e.g. plan "approve & auto-run"). */
  setAutoApproveAll(on: boolean): void;
}

export interface ApprovalControllerOptions {
  /** Start in accept-all mode (the --yes flag). */
  autoApproveAll?: boolean;
  /** Called when a request needs a UI prompt (skipped while approve-all). */
  onRequest?: (request: ApprovalRequest) => void;
  /** Called after a pending request is resolved. */
  onSettled?: () => void;
}

/**
 * A small state machine shared by the Ink UI and tests. `request` is awaited
 * by the mutating tool; `resolvePending`/`reject` are driven by keypresses.
 * `accept_all` flips on session-wide auto-approval so later writes resolve
 * immediately with no prompt.
 */
export function createApprovalController(
  opts: ApprovalControllerOptions = {},
): ApprovalController {
  let approveAll = opts.autoApproveAll ?? false;
  let pending: { request: ApprovalRequest; resolve: (o: ApprovalOutcome) => void } | null = null;

  const settle = (outcome: ApprovalOutcome): void => {
    const current = pending;
    pending = null;
    if (current) {
      current.resolve(outcome);
      opts.onSettled?.();
    }
  };

  const request: RequestApproval = (req) => {
    if (approveAll) return Promise.resolve({ approved: true });
    return new Promise<ApprovalOutcome>((resolve) => {
      pending = { request: req, resolve };
      opts.onRequest?.(req);
    });
  };

  return {
    request,
    pending: () => pending?.request ?? null,
    hasPending: () => pending !== null,
    resolvePending: (decision) => {
      if (decision === 'accept') settle({ approved: true });
      else if (decision === 'accept_all') {
        approveAll = true;
        settle({ approved: true });
      } else settle({ approved: false, reason: 'rejected by user' });
    },
    reject: (reason) => settle({ approved: false, reason: reason ?? 'rejected by user' }),
    setAutoApproveAll: (on) => {
      approveAll = on;
    },
  };
}

/**
 * Headless approval policy used by the non-interactive / --json path: reject
 * every write (with guidance) unless --yes was passed, which auto-approves.
 * Secret-protected paths are blocked earlier, so --yes can never write them.
 */
export function headlessApproval(yes: boolean): RequestApproval {
  return () =>
    Promise.resolve(
      yes
        ? { approved: true }
        : {
            approved: false,
            reason: 'approval required (non-interactive); re-run with --yes to allow writes',
          },
    );
}
