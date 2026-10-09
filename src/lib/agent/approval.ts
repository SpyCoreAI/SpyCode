/**
 * Approval gate for mutating tools.
 *
 * Mutating tools pause by awaiting `ctx.requestApproval(request)`. The Ink UI
 * resolves that promise from a keypress; headless callers resolve it
 * immediately (auto-reject, or auto-approve with --yes). The state machine is
 * factored here (UI-agnostic) so it can be unit-tested directly.
 */
import type { DiffLine } from './diff.js';
// No import cycle: this module imports `tokenizeSimpleCommand` from
// command-rules.ts, which takes the screener from the leaf module
// command-screen.ts and imports nothing from this module or from tools.ts.
// The tokenizer is shared rather than re-implemented here, because two copies
// of one matching model is the drift class this arc keeps re-filing (see the
// `stripExpansions` note in command-rules.ts).
import { tokenizeSimpleCommand } from './command-rules.js';

export type MutationOutcome = 'applied' | 'rejected' | 'blocked';
/** UI glyph hint for a tool result (writes share MutationOutcome; commands add 'command'). */
export type ToolResultKind = MutationOutcome | 'command';

/** A file write/edit awaiting approval - the diff is what the user approves. */
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

/** A shell command awaiting approval - the command string is what to approve. */
export interface CommandApprovalRequest {
  kind: 'command';
  command: string;
}

/**
 * An MCP tool call awaiting approval. MCP servers are external and opaque, so
 * EVERY call is gated like a mutating built-in - the preview shows the server,
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

/**
 * The `allow` command rule that pre-approved a command, carried INTO the
 * channel rather than used to skip it. Structural (not the `CommandRule` type)
 * so this module needs no value import from the rules layer.
 */
export interface CommandPreApproval {
  scope: 'user' | 'project';
  entry: string;
}

/**
 * A control that must run for EVERY gated action, including a pre-approved one.
 * Returning `null` means "no opinion"; returning an outcome ends the decision.
 */
export type ApprovalChannelCheck = (request: ApprovalRequest) => ApprovalOutcome | null;

/**
 * DELIBERATELY EMPTY, AND SAID SO RATHER THAN PADDED. The seam exists because
 * `resolveApproval` is now unskippable; it is where a protection that must
 * reach rule-configured users goes (ruling 4's Option B for the unset-variable
 * hazard is the named candidate). A floor over zero cases is worth nothing, so
 * `approval-channel.test.ts` asserts this array is EMPTY and proves the seam
 * carries a control by PLANTING one - the emptiness is a stated fact, not a
 * control dressed up as one.
 */
export const MANDATORY_APPROVAL_CHECKS: readonly ApprovalChannelCheck[] = [];

/**
 * F-2c-45 - THE APPROVAL CHANNEL. EVERY GATED ACTION TRAVERSES THIS.
 *
 * `C-PR34`: `run_command` evaluated the command rules first and, on an `allow`
 * match, set a local flag that skipped the entire block containing the only
 * `requestApproval` call. `verify.ts` carried the same shape. Measured at HEAD
 * by execution before this existed: with a matching allow rule the resolver was
 * consulted **0 times** at both sites and the command **ran**.
 *
 * WHAT WAS WRONG WAS NOT THE AUTO-APPROVAL. An allow rule is a documented
 * pre-approval route in every mode, including a non-interactive run without
 * `--yes`, and that behaviour is UNCHANGED here and pinned in both directions.
 * What was wrong is that the rule skipped the CHANNEL instead of supplying a
 * DECISION inside it: any protection delivered through approval was therefore
 * void for exactly the users who had configured a rule - the ones who believe
 * they are covered. A protection a user's own configuration silently voids is
 * worse than no protection.
 *
 * Order, and it is the whole design:
 * 1. the mandatory checks - they see EVERY request, pre-approved or not;
 * 2. the pre-approval, re-verified against the eligibility the README ships
 * as a safety property, then honoured and ATTRIBUTED;
 * 3. the caller's resolver, fail-closed when absent.
 */
export async function resolveApproval(
  resolve: RequestApproval | undefined,
  request: ApprovalRequest,
  preApproved?: CommandPreApproval | undefined,
  absentResolverReason?: string | undefined,
  checks: readonly ApprovalChannelCheck[] = MANDATORY_APPROVAL_CHECKS,
): Promise<ApprovalOutcome> {
  // 1. Nothing skips these - that is the property this function exists to hold.
  for (const check of checks) {
    const verdict = check(request);
    if (verdict) return verdict;
  }

  // 2. A pre-approval only speaks for a command, and only for one the rule
  // table could actually have matched. README: "A command containing shell
  // metacharacters can never match an allow rule - it is structurally
  // ineligible." Re-derived HERE, at the point of use, so a caller that
  // builds a pre-approval by some other route cannot restore the hole.
  // An ineligible one falls THROUGH to the resolver rather than
  // hard-refusing: failing toward "ask" is the only direction that cannot
  // over-block someone.
  if (preApproved && request.kind === 'command' && tokenizeSimpleCommand(request.command) !== null) {
    return {
      approved: true,
      reason: `auto-approved by the ${preApproved.scope} allow rule "${preApproved.entry}"`,
    };
  }

  // 3. Fail closed when no resolver was wired: a caller that forgets one must
  // not silently inherit the ungated path.
  if (!resolve) {
    return {
      approved: false,
      reason: absentResolverReason ?? 'approval is unavailable in this context',
    };
  }
  return resolve(request);
}

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
