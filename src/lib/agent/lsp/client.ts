/**
 * A minimal, hand-rolled LSP client over the stdio transport (no SDK, no deps).
 *
 * Wire facts implemented (verified against the LSP 3.17 base protocol):
 * - Framing: Content-Length headers (`\r\n\r\n` + UTF-8 body, length in BYTES),
 *   handled by protocol.ts. The server's stdout carries ONLY framed messages;
 *   stderr is free-form logging (capped tail kept for crash diagnostics).
 * - Lifecycle: `initialize` request → server result → `initialized`
 *   notification, then `textDocument/didOpen` etc. Shutdown is the spec order:
 *   `shutdown` request → `exit` notification → close stdin → wait → SIGTERM the
 *   process group → SIGKILL after a grace period.
 * - Diagnostics are PUSH: the server sends `textDocument/publishDiagnostics`
 *   notifications; we store the latest per URI and `waitForDiagnostics`
 *   resolves on the first publish (or the timeout).
 * - Server→client requests (e.g. `window/workDoneProgress/create`,
 *   `workspace/configuration`) are ANSWERED, never left hanging: several real
 *   servers stall their diagnostics pipeline until these resolve.
 *
 * The child is spawned DETACHED (its own process group) so the whole tree can
 * be signalled with `process.kill(-pid, …)`, mirroring the MCP client's
 * discipline. stdio handles are released via `releaseChildStdio` at settle so
 * a lingering server child can never hold the CLI's event loop open.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { releaseChildStdio } from '../../child-stdio.js';
import { isObject } from '../../text.js';
import { readClientVersion } from '../mcp-client.js';
import { LspFramer, encodeLspMessage } from './protocol.js';
import {
  LspError,
  mapLspSeverity,
  type LspDiagnostic,
  type LspRawDiagnostic,
} from './types.js';

export const DEFAULT_LSP_INIT_TIMEOUT_MS = 15_000;
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 30_000;
const SHUTDOWN_REQUEST_TIMEOUT_MS = 5_000;
const SIGTERM_GRACE_MS = 2_000;
const STDERR_CAP_BYTES = 8 * 1024;

export interface LspClientStartOptions {
  command: string;
  args: string[];
  /** Workspace root as a `file://` URI (sent as rootUri + workspaceFolders). */
  rootUri: string;
  env?: NodeJS.ProcessEnv | undefined;
  initTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  /** Fired on every `textDocument/publishDiagnostics` (already normalised). */
  onDiagnostics?: ((uri: string, diagnostics: LspDiagnostic[]) => void) | undefined;
  /** Fired once when the server process exits (clean or crash). */
  onExit?: ((info: { code: number | null; signal: string | null }) => void) | undefined;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class LspClient {
  private readonly framer = new LspFramer();
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly diagnostics = new Map<string, LspDiagnostic[]>();
  private readonly diagWaiters = new Map<string, Array<() => void>>();
  private readonly openDocs = new Map<string, { version: number; languageId: string }>();
  private stderrTail = '';
  private closed = false;
  private exited = false;
  private readonly exitWaiters: Array<() => void> = [];
  private serverCaps: Record<string, unknown> | null = null;
  private readonly requestTimeoutMs: number;
  private readonly onDiagnostics: ((uri: string, diagnostics: LspDiagnostic[]) => void) | undefined;
  private readonly onExitCb: ((info: { code: number | null; signal: string | null }) => void) | undefined;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    opts: LspClientStartOptions,
  ) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS;
    this.onDiagnostics = opts.onDiagnostics;
    this.onExitCb = opts.onExit;
    // Same EPIPE guard as the MCP client: server death between our write check
    // and the flush emits 'error' on stdin, and an unhandled stream 'error'
    // is an uncaught exception. onExit() does the real handling.
    this.child.stdin.on('error', () => {
      /* server gone mid-write; onExit does the real handling */
    });
    this.child.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_CAP_BYTES);
    });
    const onGone = (code: number | null, signal: NodeJS.Signals | null): void =>
      this.onChildExit(code, signal);
    this.child.on('close', onGone);
    this.child.on('exit', onGone);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }
  /** Capabilities the server returned from `initialize` (null before then). */
  get serverCapabilities(): Record<string, unknown> | null {
    return this.serverCaps;
  }
  /** Last bytes the server wrote to stderr (for crash diagnostics). */
  get stderr(): string {
    return this.stderrTail;
  }
  get hasExited(): boolean {
    return this.exited;
  }

  /**
   * Spawn the server and run the initialize handshake. Resolves once the
   * server has answered `initialize` and we've sent `initialized`.
   * Rejects (and kills the child) on spawn failure or handshake timeout.
   */
  static async start(opts: LspClientStartOptions): Promise<LspClient> {
    const child = spawn(opts.command, opts.args, {
      env: opts.env ?? process.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    // Wait for the OS to actually start the process (or fail to).
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      child.once('error', (err) => {
        if (settled) return;
        settled = true;
        reject(
          new LspError(
            `failed to spawn "${opts.command}": ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      });
    });

    const client = new LspClient(child, opts);
    try {
      const result = await client.request(
        'initialize',
        {
          processId: process.pid,
          clientInfo: { name: 'spycore', version: readClientVersion() },
          rootUri: opts.rootUri,
          capabilities: {
            textDocument: {
              synchronization: { didSave: true },
              publishDiagnostics: {
                relatedInformation: true,
                versionSupport: true,
                tagSupport: { valueSet: [1, 2] },
              },
            },
            workspace: { workspaceFolders: true },
          },
          workspaceFolders: [{ uri: opts.rootUri, name: 'workspace' }],
        },
        opts.initTimeoutMs ?? DEFAULT_LSP_INIT_TIMEOUT_MS,
      );
      if (isObject(result) && isObject(result.capabilities)) {
        client.serverCaps = result.capabilities;
      }
      client.notify('initialized');
      return client;
    } catch (err) {
      client.kill();
      throw err instanceof LspError ? err : new LspError(String(err));
    }
  }

  // ─────────────────────── documents ───────────────────────

  /**
   * Open a document (or send a full-text didChange when already open).
   * `languageId` is the LSP language id, e.g. 'typescript'.
   */
  openDocument(uri: string, languageId: string, text: string): void {
    const existing = this.openDocs.get(uri);
    if (existing) {
      const version = existing.version + 1;
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      });
      existing.version = version;
      return;
    }
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId, version: 1, text },
    });
    this.openDocs.set(uri, { version: 1, languageId });
  }

  closeDocument(uri: string): void {
    if (!this.openDocs.has(uri)) return;
    this.openDocs.delete(uri);
    this.notify('textDocument/didClose', { textDocument: { uri } });
  }

  /** Latest pushed diagnostics for a URI ([] when none have arrived). */
  getDiagnostics(uri: string): LspDiagnostic[] {
    return this.diagnostics.get(uri) ?? [];
  }

  /**
   * Resolve with the latest diagnostics for `uri` — immediately when a push
   * has already arrived, otherwise on the next `publishDiagnostics` for it,
   * or with whatever has arrived when `timeoutMs` elapses. Never rejects on
   * timeout: no news is an empty list, not an error.
   */
  waitForDiagnostics(uri: string, timeoutMs: number): Promise<LspDiagnostic[]> {
    const current = this.diagnostics.get(uri);
    if (current !== undefined) return Promise.resolve(current);
    return new Promise<LspDiagnostic[]>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve(this.diagnostics.get(uri) ?? []);
      };
      const timer = setTimeout(() => {
        removeWaiter();
        finish();
      }, timeoutMs);
      // Don't let a long diagnostics wait hold the process open by itself.
      (timer as unknown as { unref?: () => void }).unref?.();
      const wake = (): void => {
        clearTimeout(timer);
        finish();
      };
      const removeWaiter = (): void => {
        const list = this.diagWaiters.get(uri);
        if (!list) return;
        const i = list.indexOf(waiter);
        if (i !== -1) list.splice(i, 1);
        if (list.length === 0) this.diagWaiters.delete(uri);
      };
      // Wraps wake so list removal happens exactly once however we settle.
      const waiter = (): void => {
        removeWaiter();
        wake();
      };
      const list = this.diagWaiters.get(uri) ?? [];
      list.push(waiter);
      this.diagWaiters.set(uri, list);
    });
  }

  /** Generic request (used by shutdown and exposed for tests/future tools). */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const ms = timeoutMs ?? this.requestTimeoutMs;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new LspError(`request "${method}" timed out after ${ms}ms`));
        }
      }, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params: params ?? {} });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof LspError ? err : new LspError(String(err)));
      }
    });
  }

  // ─────────────────────── wire ───────────────────────

  private send(message: Record<string, unknown>): void {
    if (this.closed || this.exited) {
      throw new LspError('language server connection is closed');
    }
    try {
      this.child.stdin.write(encodeLspMessage(message));
    } catch (err) {
      throw new LspError(
        `failed to write to language server: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    try {
      this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    } catch {
      /* a dropped notification on a dying server is non-fatal */
    }
  }

  private onStdout(chunk: Buffer): void {
    if (this.closed || this.exited) return;
    let bodies: string[];
    try {
      bodies = this.framer.feed(chunk);
    } catch (err) {
      // Malformed/oversized framing: fail the connection closed rather than
      // accumulate. Pending requests are rejected in kill()'s wake via onExit,
      // but do it explicitly here so the error names the real cause.
      const lspErr = err instanceof LspError ? err : new LspError(String(err));
      this.failAllPending(lspErr);
      this.kill();
      return;
    }
    for (const body of bodies) this.handleBody(body);
  }

  private handleBody(body: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(body);
    } catch {
      return; // not valid JSON — ignore (spec forbids non-message stdout)
    }
    if (!isObject(msg)) return;
    // A response to one of our requests.
    if ((typeof msg.id === 'number' || typeof msg.id === 'string') && ('result' in msg || 'error' in msg)) {
      const pending = this.pending.get(msg.id as number);
      if (!pending) return;
      this.pending.delete(msg.id as number);
      clearTimeout(pending.timer);
      if ('error' in msg && isObject(msg.error)) {
        const e = msg.error as { code?: unknown; message?: unknown };
        pending.reject(
          new LspError(
            `language server error: ${typeof e.message === 'string' ? e.message : 'unknown'} (code ${typeof e.code === 'number' ? e.code : '?'})`,
          ),
        );
      } else {
        pending.resolve((msg as { result?: unknown }).result);
      }
      return;
    }
    // A request FROM the server — answer it, never leave it hanging. Several
    // real servers gate their diagnostics pipeline on these resolving.
    if (typeof msg.method === 'string' && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
      this.answerServerRequest(msg.id, msg.method, msg.params);
      return;
    }
    // Otherwise a notification.
    if (typeof msg.method === 'string') this.handleNotification(msg.method, msg.params);
  }

  private answerServerRequest(id: number | string, method: string, params: unknown): void {
    let result: unknown = null;
    if (method === 'workspace/configuration' && isObject(params) && Array.isArray(params.items)) {
      // One (null) config per requested item — servers treat null as "no config".
      result = params.items.map(() => null);
    } else if (
      method === 'window/workDoneProgress/create' ||
      method === 'client/registerCapability' ||
      method === 'client/unregisterCapability'
    ) {
      result = null;
    } else {
      try {
        this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
      } catch {
        /* server already gone */
      }
      return;
    }
    try {
      this.send({ jsonrpc: '2.0', id, result });
    } catch {
      /* server already gone */
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'textDocument/publishDiagnostics' && isObject(params)) {
      const uri = typeof params.uri === 'string' ? params.uri : undefined;
      if (!uri) return;
      const raw = Array.isArray(params.diagnostics) ? params.diagnostics : [];
      const file = uriToPath(uri);
      const diags: LspDiagnostic[] = [];
      for (const item of raw) {
        const d = normaliseDiagnostic(item, file);
        if (d) diags.push(d);
      }
      this.diagnostics.set(uri, diags);
      for (const w of this.diagWaiters.get(uri)?.splice(0) ?? []) {
        try {
          w();
        } catch {
          /* waiter teardown is best-effort */
        }
      }
      this.diagWaiters.delete(uri);
      try {
        this.onDiagnostics?.(uri, diags);
      } catch {
        /* listener throw must never disturb the connection */
      }
    }
    // window/showMessage, $/progress, etc. — intentionally ignored.
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.closed = true;
    this.failAllPending(
      new LspError(
        `language server exited${code !== null ? ` with code ${code}` : ''}${signal ? ` on ${signal}` : ''}`,
      ),
    );
    // Wake diagnostics waiters with whatever arrived (possibly nothing).
    for (const [, waiters] of this.diagWaiters) {
      for (const w of waiters.splice(0)) {
        try {
          w();
        } catch {
          /* ignore */
        }
      }
    }
    this.diagWaiters.clear();
    // Same discipline as the MCP client: release our hold on the pipes so a
    // server helper that inherited stdio can't keep the CLI alive at exit.
    releaseChildStdio(this.child);
    for (const w of this.exitWaiters.splice(0)) w();
    try {
      this.onExitCb?.({ code, signal });
    } catch {
      /* listener is best-effort */
    }
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this.exited) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (val: boolean): void => {
        if (done) return;
        done = true;
        resolve(val);
      };
      const timer = setTimeout(() => finish(false), ms);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        finish(true);
      });
    });
  }

  /** Signal the whole process group, falling back to the child alone. */
  private signalGroup(sig: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        this.child.kill(sig);
      } catch {
        /* already gone */
      }
    }
  }

  /** Immediate, best-effort teardown for abort/Ctrl+C — SIGTERM then SIGKILL. */
  kill(): void {
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    this.signalGroup('SIGTERM');
    setTimeout(() => {
      if (!this.exited) this.signalGroup('SIGKILL');
    }, SIGTERM_GRACE_MS).unref?.();
    releaseChildStdio(this.child);
  }

  /**
   * Graceful shutdown per the LSP spec order: `shutdown` request → `exit`
   * notification → close stdin → wait → SIGTERM → SIGKILL.
   */
  async shutdown(graceMs = SIGTERM_GRACE_MS): Promise<void> {
    if (this.exited) return;
    try {
      await this.request('shutdown', undefined, SHUTDOWN_REQUEST_TIMEOUT_MS);
    } catch {
      /* a server that won't answer shutdown still gets the exit notification */
    }
    try {
      this.send({ jsonrpc: '2.0', method: 'exit' });
    } catch {
      /* already gone */
    }
    this.closed = true;
    try {
      this.child.stdin.end();
    } catch {
      /* ignore */
    }
    if (await this.waitForExit(graceMs)) return;
    this.signalGroup('SIGTERM');
    if (await this.waitForExit(graceMs)) return;
    this.signalGroup('SIGKILL');
    await this.waitForExit(graceMs);
    releaseChildStdio(this.child);
  }
}

/** Convert a `file://` URI back to a filesystem path (best-effort). */
function uriToPath(uri: string): string {
  try {
    const u = new URL(uri);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname);
  } catch {
    /* fall through */
  }
  return uri;
}

/**
 * Normalise one raw diagnostic: 0-based LSP range → 1-based agent range.
 * Returns null for items too malformed to place.
 */
function normaliseDiagnostic(item: unknown, file: string): LspDiagnostic | null {
  if (!isObject(item) || typeof item.message !== 'string') return null;
  const range = item.range as LspRawDiagnostic['range'] | undefined;
  const start = range?.start;
  const end = range?.end;
  if (
    !start ||
    typeof start.line !== 'number' ||
    typeof start.character !== 'number' ||
    !end ||
    typeof end.line !== 'number' ||
    typeof end.character !== 'number'
  ) {
    return null;
  }
  const diag: LspDiagnostic = {
    file,
    line: start.line + 1,
    column: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
    severity: mapLspSeverity(typeof item.severity === 'number' ? item.severity : undefined),
    message: item.message,
  };
  if (typeof item.code === 'string' || typeof item.code === 'number') diag.code = item.code;
  if (typeof item.source === 'string') diag.source = item.source;
  return diag;
}
