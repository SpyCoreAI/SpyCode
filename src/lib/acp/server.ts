/**
 * ACP (Agent Client Protocol) agent server — https://agentclientprotocol.com,
 * protocol version 1 (schema/v1/schema.json, meta.json `version: 1`).
 *
 * Exposes the SpyCode agent loop to ACP clients (Zed, JetBrains, …) over the
 * stdio transport: newline-delimited JSON-RPC 2.0, stdout protocol-only.
 *
 * Agent-side methods implemented: initialize, authenticate, session/new,
 * session/prompt, and the session/cancel notification. Client-side methods we
 * call: session/update (notification) and session/request_permission.
 *
 * v1 capability decisions (each deliberate):
 *  - promptCapabilities: text-only (image/audio/embeddedContext false). Vision
 *    rides through /api/chat attachments on the web, not the agent loop.
 *  - loadSession: false — sessions are process-lifetime (no persistence).
 *  - session/new `mcpServers` is accepted but IGNORED: the agent connects the
 *    user's OWN configured MCP servers (spycore mcp add) per run, exactly like
 *    `spycore agent`. Client-delegated fs/terminal are likewise unused — our
 *    tools are local, gated by ACP permission requests instead.
 *  - auth: when the spycore provider has no stored token we advertise one auth
 *    method (`spycore-login`) instructing the user to run `spycore login`;
 *    session/new + session/prompt return error -32000 (auth required) until
 *    then. `authenticate` re-checks the local token (the browser flow cannot
 *    run inside a stdio server).
 */
import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import {
  ACP_AUTH_REQUIRED,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INTERNAL_ERROR,
  JsonRpcEndpoint,
  JsonRpcError,
} from './jsonrpc.js';
import { runAgent, DEFAULT_MAX_TURNS, type AgentEvent } from '../agent/loop.js';
import type { Provider } from '../providers/types.js';
import type { ApprovalRequest, ApprovalOutcome, RequestApproval } from '../agent/approval.js';

export const ACP_PROTOCOL_VERSION = 1;
const AUTH_METHOD_ID = 'spycore-login';
/** Cap on rawOutput tails relayed to the client. */
const RAW_OUTPUT_CAP = 4000;

// ─────────────────────── wire shapes (ACP v1) ───────────────────────

type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';
type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

interface TextContentBlock {
  type: 'text';
  text: string;
}
interface ToolContentItem {
  type: 'content';
  content: TextContentBlock;
}
interface ToolLocation {
  path: string;
  line?: number;
}

interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AcpServerOptions {
  endpoint: JsonRpcEndpoint;
  provider: Provider;
  /** Wire model id handed to the provider (SpyCore slug or BYOK id). */
  model: string;
  toolProtocol: 'auto' | 'native' | 'fenced';
  apiUrlOverride?: string | undefined;
  /** True when the provider needs SpyCore auth (the spycore provider). */
  requiresSpycoreAuth: boolean;
  /** Auth probe (stored-token check). Injected for testability. */
  isAuthenticated: () => Promise<boolean>;
  /** Agent name/version advertised in initialize. */
  agentVersion: string;
  /** run_command timeout (ms). */
  commandTimeoutMs?: number | undefined;
  /** Max model round-trips per prompt turn. */
  maxTurns?: number | undefined;
}

interface AcpSession {
  id: string;
  cwd: string;
  /** Provider conversation handle — created by the first prompt, reused after. */
  conversationId: string | null;
  /** A prompt turn is currently running (one at a time per session). */
  running: boolean;
  abort: AbortController | null;
  /** allow_always was selected → auto-approve for the rest of the session. */
  autoApproveAll: boolean;
  /** Skills already loaded across this session's prompts. */
  loadedSkills: Set<string>;
  /** The currently-dispatching tool call (for permission correlation + cancel). */
  currentTool: { id: string; terminal: boolean; title: string } | null;
  /** Cancel requested for the in-flight prompt (drives the stopReason). */
  cancelRequested: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Map a SpyCode tool name to the ACP tool kind taxonomy. */
function toolKind(tool: string): ToolKind {
  switch (tool) {
    case 'read_file':
    case 'repo_map':
      return 'read';
    case 'list_dir':
    case 'glob':
    case 'grep':
      return 'search';
    case 'write_file':
    case 'edit_file':
      return 'edit';
    case 'run_command':
      return 'execute';
    case 'load_skill':
      return 'think';
    default:
      return 'other'; // MCP tools — semantics unknowable from here
  }
}

/** File locations for the editor to follow along, where cheap. */
function toolLocations(cwd: string, tool: string, args: Record<string, unknown>): ToolLocation[] {
  if (tool === 'read_file' || tool === 'write_file' || tool === 'edit_file') {
    const p = args.path;
    if (typeof p === 'string' && p.length > 0) {
      return [{ path: isAbsolute(p) ? p : resolvePath(cwd, p) }];
    }
  }
  return [];
}

/** Identity-safe one-line title for a tool call. */
function toolTitle(tool: string, arg: string): string {
  return arg.length > 0 ? `${tool}: ${arg}` : tool;
}

/** Title + kind for a permission request derived from the ApprovalRequest. */
function permissionToolInfo(req: ApprovalRequest): { title: string; kind: ToolKind } {
  if (req.kind === 'command') return { title: `$ ${req.command}`, kind: 'execute' };
  if (req.kind === 'mcp') return { title: `${req.server}: ${req.tool}`, kind: 'other' };
  return { title: `${req.tool}: ${req.path}`, kind: 'edit' };
}

export class AcpAgentServer {
  private readonly sessions = new Map<string, AcpSession>();

  constructor(private readonly opts: AcpServerOptions) {
    const e = opts.endpoint;
    e.on('initialize', (params) => this.initialize(params));
    e.on('authenticate', (params) => this.authenticate(params));
    e.on('session/new', (params) => this.sessionNew(params));
    e.on('session/prompt', (params) => this.sessionPrompt(params));
    e.onNotification('session/cancel', (params) => this.sessionCancel(params));
  }

  // ─────────────────────── initialize / authenticate ───────────────────────

  private async initialize(params: unknown): Promise<unknown> {
    // Version negotiation per spec: respond with the requested version when we
    // support it, else with the latest we support. We support exactly v1, so
    // the negotiated version is always 1 — a client that can't speak v1 SHOULD
    // close the connection on seeing our response.
    const negotiated = ACP_PROTOCOL_VERSION;
    void params;

    const needsAuth = this.opts.requiresSpycoreAuth && !(await this.opts.isAuthenticated());
    return {
      protocolVersion: negotiated,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      agentInfo: { name: 'spycore', version: this.opts.agentVersion },
      authMethods: needsAuth
        ? [
            {
              id: AUTH_METHOD_ID,
              name: 'Log in with SpyCore',
              description: 'Run `spycore login` in a terminal, then retry.',
            },
          ]
        : [],
    };
  }

  private async authenticate(params: unknown): Promise<unknown> {
    const p = isObject(params) ? params : {};
    if (p.methodId !== AUTH_METHOD_ID) {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, `unknown auth method: ${String(p.methodId)}`);
    }
    // The browser login flow cannot run inside a stdio server — re-check the
    // stored token; the user completes `spycore login` in their own terminal.
    if (await this.opts.isAuthenticated()) return {};
    throw new JsonRpcError(
      ACP_AUTH_REQUIRED,
      'Not logged in. Run `spycore login` in a terminal, then call authenticate again.',
    );
  }

  private async requireAuth(): Promise<void> {
    if (!this.opts.requiresSpycoreAuth) return;
    if (await this.opts.isAuthenticated()) return;
    throw new JsonRpcError(ACP_AUTH_REQUIRED, 'Authentication required. Run `spycore login`, then retry.');
  }

  // ─────────────────────── sessions ───────────────────────

  private async sessionNew(params: unknown): Promise<unknown> {
    await this.requireAuth();
    const p = isObject(params) ? params : {};
    const cwd = typeof p.cwd === 'string' ? p.cwd : '';
    if (!isAbsolute(cwd)) {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, 'cwd must be an absolute path');
    }
    let isDir = false;
    try {
      isDir = existsSync(cwd) && statSync(cwd).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, `cwd does not exist or is not a directory: ${cwd}`);
    }
    // `mcpServers` (required by the spec shape) is accepted but ignored — the
    // agent runs the user's own configured MCP servers per prompt, exactly
    // like `spycore agent`. Documented in the class header.
    const id = `sess_${randomUUID()}`;
    this.sessions.set(id, {
      id,
      cwd,
      conversationId: null,
      running: false,
      abort: null,
      autoApproveAll: false,
      loadedSkills: new Set<string>(),
      currentTool: null,
      cancelRequested: false,
    });
    return { sessionId: id };
  }

  private getSession(params: unknown): AcpSession {
    const p = isObject(params) ? params : {};
    const id = typeof p.sessionId === 'string' ? p.sessionId : '';
    const session = this.sessions.get(id);
    if (!session) {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, `unknown sessionId: ${id || '(missing)'}`);
    }
    return session;
  }

  private sessionCancel(params: unknown): void {
    let session: AcpSession;
    try {
      session = this.getSession(params);
    } catch {
      return; // unknown session on a notification — nothing to answer
    }
    session.cancelRequested = true;
    session.abort?.abort();
  }

  // ─────────────────────── prompt turn ───────────────────────

  private async sessionPrompt(params: unknown): Promise<unknown> {
    await this.requireAuth();
    const session = this.getSession(params);
    if (session.running) {
      throw new JsonRpcError(JSONRPC_INTERNAL_ERROR, 'a prompt is already running for this session');
    }
    const p = isObject(params) ? params : {};
    const text = extractPromptText(p.prompt);
    if (text.length === 0) {
      throw new JsonRpcError(JSONRPC_INVALID_PARAMS, 'prompt must contain at least one non-empty text block');
    }

    session.running = true;
    session.cancelRequested = false;
    // Typed write (not a bare null) so TS doesn't narrow the property to null
    // for the rest of the function — onEvent mutates it during the await below.
    session.currentTool = null as AcpSession['currentTool'];
    const abort = new AbortController();
    session.abort = abort;

    try {
      const result = await runAgent({
        task: text,
        model: this.opts.model,
        provider: this.opts.provider,
        maxTurns: this.opts.maxTurns ?? DEFAULT_MAX_TURNS,
        apiUrlOverride: this.opts.apiUrlOverride,
        signal: abort.signal,
        cwd: session.cwd,
        commandTimeoutMs: this.opts.commandTimeoutMs,
        requestApproval: this.makeApprovalBridge(session),
        toolProtocol: this.opts.toolProtocol,
        loadedSkills: session.loadedSkills,
        onEvent: (e) => this.onAgentEvent(session, e),
        // Reuse the session's conversation after the first prompt.
        ...(session.conversationId
          ? { conversationId: session.conversationId, continueMessage: text }
          : {}),
      });
      session.conversationId = result.conversationId;

      // Cancellation: terminal-status any in-flight tool call, per the spec.
      // (Read through a typed local — onEvent mutates currentTool during the
      // await above, which TS's narrowing can't see.)
      const inFlight: AcpSession['currentTool'] = session.currentTool;
      if ((result.cancelled || session.cancelRequested) && inFlight && !inFlight.terminal) {
        this.sendToolUpdate(session, { toolCallId: inFlight.id, status: 'failed' });
        inFlight.terminal = true;
      }

      const stopReason: StopReason =
        result.cancelled || session.cancelRequested
          ? 'cancelled'
          : result.budgetStop === 'tokens'
            ? 'max_tokens'
            : result.budgetStop !== null || result.reachedMaxTurns
              ? 'max_turn_requests'
              : 'end_turn';
      return { stopReason };
    } catch (err) {
      // A cancel that surfaced as a thrown 'Cancelled' resolves the prompt
      // with the semantic stopReason rather than a JSON-RPC error (spec).
      if (session.cancelRequested || abort.signal.aborted) {
        const inFlight: AcpSession['currentTool'] = session.currentTool;
        if (inFlight && !inFlight.terminal) {
          this.sendToolUpdate(session, { toolCallId: inFlight.id, status: 'failed' });
          inFlight.terminal = true;
        }
        return { stopReason: 'cancelled' satisfies StopReason };
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new JsonRpcError(JSONRPC_INTERNAL_ERROR, message);
    } finally {
      session.running = false;
      session.abort = null;
    }
  }

  // ─────────────────────── event → session/update mapping ───────────────────────

  private sendUpdate(session: AcpSession, update: Record<string, unknown>): void {
    this.opts.endpoint.notify('session/update', { sessionId: session.id, update });
  }

  private sendChunk(session: AcpSession, text: string): void {
    if (text.trim().length === 0) return;
    this.sendUpdate(session, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text } satisfies TextContentBlock,
    });
  }

  private sendToolUpdate(
    session: AcpSession,
    fields: { toolCallId: string } & Partial<{
      status: ToolCallStatus;
      title: string;
      content: ToolContentItem[];
      locations: ToolLocation[];
      rawInput: Record<string, unknown>;
      rawOutput: Record<string, unknown>;
    }>,
  ): void {
    this.sendUpdate(session, { sessionUpdate: 'tool_call_update', ...fields });
  }

  private onAgentEvent(session: AcpSession, e: AgentEvent): void {
    switch (e.type) {
      // Assistant prose. The loop emits the streamed tokens AND consolidated
      // narration/final blocks; we forward only the consolidated blocks — they
      // are already free of fenced tool JSON in BOTH protocols, so the client
      // never sees wire artifacts. (Token-level streaming is a later
      // refinement — it needs the loop to expose protocol-clean deltas.)
      case 'narration':
        this.sendChunk(session, e.text);
        break;
      case 'final':
        this.sendChunk(session, e.text);
        break;

      // NATIVE mode: the model named a tool mid-stream — announce it early.
      case 'tool_call_started': {
        const id = `call_t${e.turn}_${e.index}`;
        if (session.currentTool?.id !== id) {
          session.currentTool = { id, terminal: false, title: e.name };
          this.sendUpdate(session, {
            sessionUpdate: 'tool_call',
            toolCallId: id,
            title: e.name,
            kind: toolKind(e.name),
            status: 'pending' satisfies ToolCallStatus,
          });
        }
        break;
      }

      // Dispatch begins (both modes). Announce (if not already) + in_progress.
      case 'tool_call': {
        const id = `call_t${e.turn}_${e.index}`;
        const title = toolTitle(e.tool, e.arg);
        const announced = session.currentTool?.id === id;
        session.currentTool = { id, terminal: false, title };
        if (!announced) {
          this.sendUpdate(session, {
            sessionUpdate: 'tool_call',
            toolCallId: id,
            title,
            kind: toolKind(e.tool),
            status: 'pending' satisfies ToolCallStatus,
            locations: toolLocations(session.cwd, e.tool, e.args),
            rawInput: e.args,
          });
          this.sendToolUpdate(session, { toolCallId: id, status: 'in_progress' });
        } else {
          // Already announced from tool_call_started — enrich + advance.
          this.sendToolUpdate(session, {
            toolCallId: id,
            status: 'in_progress',
            title,
            locations: toolLocations(session.cwd, e.tool, e.args),
            rawInput: e.args,
          });
        }
        break;
      }

      case 'tool_result': {
        const id = `call_t${e.turn}_${e.index}`;
        const rawOutput: Record<string, unknown> = { summary: e.summary };
        if (e.command) rawOutput.command = e.command;
        if (e.outputTail) rawOutput.outputTail = e.outputTail.slice(0, RAW_OUTPUT_CAP);
        this.sendToolUpdate(session, {
          toolCallId: id,
          status: e.ok ? 'completed' : 'failed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: e.summary },
            } satisfies ToolContentItem,
          ],
          rawOutput,
        });
        if (session.currentTool?.id === id) session.currentTool.terminal = true;
        break;
      }

      // Informational events with no ACP mapping in v1.
      case 'assistant_token': // superseded by narration/final blocks (above)
      case 'parse_error':
      case 'skills':
      case 'mcp_notice':
      case 'budget':
      case 'budget_stop':
      case 'max_turns':
        break;
    }
  }

  // ─────────────────────── permission bridge ───────────────────────

  private makeApprovalBridge(session: AcpSession): RequestApproval {
    return async (request: ApprovalRequest): Promise<ApprovalOutcome> => {
      if (session.autoApproveAll) return { approved: true };
      const signal = session.abort?.signal;
      if (signal?.aborted) return { approved: false, reason: 'cancelled' };

      const info = permissionToolInfo(request);
      // Correlate with the current tool call when one is announced (the loop
      // dispatches sequentially, so the pending approval IS the current call).
      const toolCall: Record<string, unknown> = session.currentTool
        ? { toolCallId: session.currentTool.id, title: info.title, kind: info.kind }
        : { toolCallId: `call_${randomUUID().slice(0, 8)}`, title: info.title, kind: info.kind };
      if (request.kind === 'mcp') toolCall.rawInput = request.args;

      const options: PermissionOption[] = [
        { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Allow for this session', kind: 'allow_always' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ];

      const outcomePromise = this.opts.endpoint
        .request('session/request_permission', { sessionId: session.id, toolCall, options })
        .catch(() => null); // client error / unsupported → safe default below

      // session/cancel must unstick a pending permission even if the client
      // never answers it (the spec obliges the client to answer cancelled;
      // this race is our belt-and-suspenders).
      const aborted = new Promise<'aborted'>((resolveRace) => {
        if (!signal) return; // no signal → never resolves; outcome wins
        if (signal.aborted) resolveRace('aborted');
        else signal.addEventListener('abort', () => resolveRace('aborted'), { once: true });
      });

      const winner = await Promise.race([outcomePromise, aborted]);
      if (winner === 'aborted' || winner === null || !isObject(winner)) {
        return { approved: false, reason: winner === 'aborted' ? 'cancelled' : 'permission request failed' };
      }
      const outcome = isObject(winner.outcome) ? winner.outcome : null;
      if (!outcome || outcome.outcome === 'cancelled') {
        return { approved: false, reason: 'cancelled' };
      }
      if (outcome.outcome === 'selected') {
        const optionId = typeof outcome.optionId === 'string' ? outcome.optionId : '';
        if (optionId === 'allow-once') return { approved: true };
        if (optionId === 'allow-always') {
          session.autoApproveAll = true;
          return { approved: true };
        }
        return { approved: false, reason: 'rejected by user' };
      }
      return { approved: false, reason: 'rejected by user' };
    };
  }
}

/** Concatenate the text blocks of an ACP prompt (text-only capability). */
function extractPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return '';
  const parts: string[] = [];
  for (const block of prompt) {
    if (isObject(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}
