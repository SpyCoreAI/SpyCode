/**
 * A minimal, hand-rolled MCP client over the stdio transport (no SDK, no deps).
 *
 * Wire facts implemented (verified against the MCP spec, protocol revision
 * 2025-06-18 — basic/transports + basic/lifecycle):
 *  - Framing: newline-delimited JSON-RPC 2.0. Each message is one line of UTF-8
 *    JSON terminated by '\n' and MUST NOT contain embedded newlines. Content-
 *    Length framing is NOT used for stdio. The server's stdout carries ONLY MCP
 *    messages; stderr is free-form logging (we capture a capped tail for
 *    diagnostics and otherwise ignore it).
 *  - Handshake: `initialize` request → server result → `notifications/initialized`
 *    notification, then `tools/list` / `tools/call`. We send no request other
 *    than `initialize` until its response arrives (per spec).
 *  - protocolVersion: we advertise "2025-06-18". Version negotiation is lenient:
 *    we record whatever the server echoes back and proceed (tools/list + tools/
 *    call are stable across these revisions); a hard disconnect-on-mismatch is
 *    deliberately avoided so slightly-older real servers still work.
 *  - Shutdown (spec stdio order): close the child's stdin, wait briefly for it to
 *    exit, then SIGTERM the process group, then SIGKILL after a grace period.
 *
 * The child is spawned DETACHED (its own process group) so the whole tree can be
 * signalled with `process.kill(-pid, …)`, mirroring run_command's discipline.
 * We declare no client capabilities, so a well-behaved server sends us no
 * requests; if one arrives anyway we reply with a JSON-RPC "method not found"
 * error so it is never left hanging.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** Default timeouts. The init handshake is short; per-call defaults to run_command's. */
export const DEFAULT_INIT_TIMEOUT_MS = 10_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const SIGTERM_GRACE_MS = 2_000;
const STDERR_CAP_BYTES = 8 * 1024;
/**
 * Hard ceiling on UNPARSED stdout (a single in-flight JSON-RPC line before its
 * terminating newline). stdout is newline-framed, so a legitimate message — even
 * a large tools/list or tool result — is well under this. A hostile/buggy server
 * that streams without a newline would otherwise grow the buffer without bound
 * (OOM DoS); exceeding the cap fails the connection instead of accumulating.
 */
export const STDOUT_CAP_BYTES = 8 * 1024 * 1024;
/** Hard ceiling on tools surfaced from one server (paginated). */
const MAX_TOOLS = 200;

/** A tool as described by `tools/list`. `inputSchema` is the raw JSON Schema. */
export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** A single content item from `tools/call`. Text is first-class; others are noted by type. */
export interface McpTextContent {
  type: 'text';
  text: string;
}
export interface McpUnknownContent {
  type: string;
  [key: string]: unknown;
}
export type McpContent = McpTextContent | McpUnknownContent;

export interface McpCallResult {
  content: McpContent[];
  isError: boolean;
}

export interface McpClientStartOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  initTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Expected MCP failure (spawn error, timeout, protocol error). */
export class McpError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class McpStdioClient {
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private stderrTail = '';
  private closed = false;
  private exited = false;
  private readonly requestTimeoutMs: number;
  private serverInfoValue: { name?: string; version?: string } | null = null;
  private protocolVersionValue: string | null = null;
  private readonly exitWaiters: Array<() => void> = [];

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    opts: McpClientStartOptions,
  ) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_CAP_BYTES);
    });
    const onGone = (): void => this.onExit();
    this.child.on('close', onGone);
    this.child.on('exit', onGone);
  }

  get pid(): number | undefined {
    return this.child.pid;
  }
  get serverInfo(): { name?: string; version?: string } | null {
    return this.serverInfoValue;
  }
  get protocolVersion(): string | null {
    return this.protocolVersionValue;
  }
  /** Last bytes the server wrote to stderr (for `mcp test` diagnostics). */
  get stderr(): string {
    return this.stderrTail;
  }
  get hasExited(): boolean {
    return this.exited;
  }

  /**
   * Spawn the server and run the initialize handshake. Resolves once the server
   * has answered `initialize` and we've sent `notifications/initialized`.
   * Rejects (and kills the child) on spawn failure or handshake timeout.
   */
  static async start(opts: McpClientStartOptions): Promise<McpStdioClient> {
    const child = spawn(opts.command, opts.args, {
      env: opts.env,
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
        reject(new McpError(`failed to spawn "${opts.command}": ${err instanceof Error ? err.message : String(err)}`));
      });
    });

    const client = new McpStdioClient(child, opts);
    try {
      const initResult = await client.request(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'spycore', version: readClientVersion() },
        },
        opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS,
      );
      client.applyInitResult(initResult);
      // Per spec, signal readiness before any operation request.
      client.notify('notifications/initialized');
      return client;
    } catch (err) {
      client.kill();
      throw err instanceof McpError ? err : new McpError(String(err));
    }
  }

  private applyInitResult(result: unknown): void {
    if (!isObject(result)) throw new McpError('initialize returned a non-object result');
    if (typeof result.protocolVersion === 'string') this.protocolVersionValue = result.protocolVersion;
    if (isObject(result.serverInfo)) {
      const si = result.serverInfo;
      this.serverInfoValue = {
        ...(typeof si.name === 'string' ? { name: si.name } : {}),
        ...(typeof si.version === 'string' ? { version: si.version } : {}),
      };
    }
  }

  /** `tools/list`, following `nextCursor` pagination, capped at MAX_TOOLS. */
  async listTools(): Promise<McpToolDef[]> {
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request('tools/list', cursor === undefined ? {} : { cursor });
      if (!isObject(result) || !Array.isArray(result.tools)) break;
      for (const t of result.tools) {
        if (!isObject(t) || typeof t.name !== 'string') continue;
        out.push({
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          inputSchema: isObject(t.inputSchema) ? t.inputSchema : { type: 'object' },
        });
        if (out.length >= MAX_TOOLS) return out;
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    return out;
  }

  /** `tools/call`. Normalises the result to `{ content[], isError }`. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<McpCallResult> {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (!isObject(result)) return { content: [], isError: false };
    const content = Array.isArray(result.content)
      ? result.content.filter(isObject).map((c) => c as McpContent)
      : [];
    return { content, isError: result.isError === true };
  }

  // ─────────────────────── framing ───────────────────────

  private send(message: Record<string, unknown>): void {
    if (this.closed || this.exited) {
      throw new McpError('server connection is closed');
    }
    const line = `${JSON.stringify(message)}\n`;
    try {
      this.child.stdin.write(line);
    } catch (err) {
      throw new McpError(`failed to write to server: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    try {
      this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
    } catch {
      /* a dropped notification on a dying server is non-fatal */
    }
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new McpError(`request "${method}" timed out after ${timeoutMs ?? this.requestTimeoutMs}ms`));
        }
      }, timeoutMs ?? this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof McpError ? err : new McpError(String(err)));
      }
    });
  }

  private onStdout(chunk: string): void {
    if (this.closed || this.exited) return;
    this.buf += chunk;
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.length > 0) this.handleLine(line);
      nl = this.buf.indexOf('\n');
    }
    // OOM guard: after draining complete lines, the residual is a single
    // unterminated line. If it blows the cap the server is streaming an
    // unframed/oversized message — tear the connection down rather than grow
    // unbounded. (stderr is tail-capped; stdout can't be, since we must parse
    // whole lines from the front — so we fail closed instead.)
    if (this.buf.length > STDOUT_CAP_BYTES) this.failOverflow();
  }

  /** Reject all pending requests and kill the child after a stdout overflow. */
  private failOverflow(): void {
    this.buf = '';
    const err = new McpError(
      `server stdout exceeded ${STDOUT_CAP_BYTES} bytes without a newline-framed message; closing the connection`,
    );
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.kill();
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not a valid MCP message — ignore (spec forbids non-message stdout)
    }
    if (!isObject(msg)) return;
    // A response to one of our requests (has a numeric id + result/error).
    if (typeof msg.id === 'number' && (('result' in msg) || ('error' in msg))) {
      const res = msg as unknown as JsonRpcResponse;
      const pending = this.pending.get(res.id);
      if (!pending) return;
      this.pending.delete(res.id);
      clearTimeout(pending.timer);
      if (res.error) pending.reject(new McpError(`${res.error.message} (code ${res.error.code})`));
      else pending.resolve(res.result);
      return;
    }
    // A request FROM the server (method + id). We advertise no capabilities, so
    // reply with "method not found" rather than leaving the server hanging.
    if (typeof msg.method === 'string' && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
      this.notifyError(msg.id, -32601, `method not found: ${msg.method}`);
      return;
    }
    // Otherwise it's a server notification (e.g. logging) — ignore.
  }

  private notifyError(id: number | string, code: number, message: string): void {
    try {
      this.send({ jsonrpc: '2.0', id, error: { code, message } });
    } catch {
      /* server already gone */
    }
  }

  private onExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new McpError('server process exited'));
    }
    this.pending.clear();
    for (const w of this.exitWaiters.splice(0)) w();
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
  }

  /**
   * Graceful shutdown per the spec's stdio order: close stdin, wait for the
   * server to exit, then SIGTERM, then SIGKILL after a grace period.
   */
  async shutdown(graceMs = SIGTERM_GRACE_MS): Promise<void> {
    if (this.exited) return;
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
  }
}

/**
 * Read the CLI's own version for `clientInfo.version`, walking up from this
 * module to the package.json (depth differs between the bundled build and the
 * unbundled test run). Falls back to '0.0.0'. Identity-safe: only our own name.
 */
function readClientVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === '@spycore/cli' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      /* keep walking toward the package root */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}
