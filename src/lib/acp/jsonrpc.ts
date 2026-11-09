/**
 * Server-side newline-delimited JSON-RPC 2.0 endpoint for the ACP transport
 * (mirror of the MCP client's framing in mcp-client.ts, with us on the agent
 * side this time). Per the ACP spec (protocol/v1/transports): one UTF-8 JSON
 * message per line, no embedded newlines, stdout carries ONLY protocol frames,
 * stderr is free for logging.
 *
 * Supports all four JSON-RPC flows the ACP needs:
 *   - inbound requests  → registered async handlers (result or JsonRpcError)
 *   - inbound notifications → registered void handlers
 *   - outbound notifications (session/update)
 *   - outbound requests (session/request_permission) with a pending map
 */
import type { Readable, Writable } from 'node:stream';
import { isObject } from '../text.js';

/** JSON-RPC 2.0 standard error codes + the ACP auth-required code. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
/** ACP: "Authentication is required before this operation can be performed." */
export const ACP_AUTH_REQUIRED = -32000;
/**
 * Cap on one newline-delimited frame held in the inbound buffer: a client
 * sending a single huge newline-less line otherwise grows `buf` without
 * bound. Oversized lines are dropped with a parse-error frame, never kept.
 */
export const JSONRPC_MAX_LINE_BYTES = 1_048_576;
/** Default timeout for an outbound request (e.g. session/request_permission). */
export const JSONRPC_REQUEST_TIMEOUT_MS = 120_000;

/** Throw from a request handler to control the JSON-RPC error response. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export type RequestHandler = (params: unknown) => Promise<unknown>;
export type NotificationHandler = (params: unknown) => void;

interface PendingOutbound {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class JsonRpcEndpoint {
  /**
   * Inbound bytes, accumulated as a Buffer so the line cap binds in BYTES
   * (R2-8): the old code set the input encoding to utf8 and measured
   * `buf.length` in UTF-16 code units, so a 1,048,576-char line of 2-byte
   * chars (2,097,152 wire bytes) fit under the "1 MB" cap and was
   * answered `parse error` instead of `line too long`.
   */
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private closed = false;
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly pending = new Map<number | string, PendingOutbound>();
  private readonly closeListeners: Array<() => void> = [];

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
  ) {}

  on(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  /** Begin reading frames. Resolves when the input stream ends. */
  start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.input.on('data', (chunk: Buffer) => this.onData(chunk));
      const finish = (): void => {
        if (this.closed) return;
        this.closed = true;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new Error('connection closed'));
        }
        this.pending.clear();
        for (const l of this.closeListeners.splice(0)) l();
        resolve();
      };
      this.input.on('end', finish);
      this.input.on('close', finish);
      this.input.on('error', finish);
    });
  }

  /** Outbound notification (e.g. session/update). */
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /**
   * Outbound request (e.g. session/request_permission). Rejects after
   * `timeoutMs` (default JSONRPC_REQUEST_TIMEOUT_MS) so a client that never
   * answers cannot hang the approval bridge forever - previously the
   * promise only settled on a response or on session/cancel.
   */
  request(
    method: string,
    params: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? JSONRPC_REQUEST_TIMEOUT_MS;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(
          new JsonRpcError(
            JSONRPC_INTERNAL_ERROR,
            `request timed out after ${Math.round(timeoutMs / 1000)}s: ${method}`,
          ),
        );
      }, timeoutMs);
      // The timer must not hold the process open on its own.
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(frame: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.output.write(`${JSON.stringify(frame)}\n`);
    } catch {
      /* a dying pipe - the close handler will settle pending state */
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    // A newline-less buffer past the cap is a runaway line, not a frame:
    // drop it with a parse-error reply instead of growing memory forever.
    // The cap is measured in BYTES (buf.length on a Buffer), not chars.
    if (this.buf.indexOf(0x0a) === -1 && this.buf.length > JSONRPC_MAX_LINE_BYTES) {
      this.buf = Buffer.alloc(0);
      this.send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_PARSE_ERROR, message: 'line too long' } });
      return;
    }
    let nl = this.buf.indexOf(0x0a);
    while (nl !== -1) {
      const rawLine = this.buf.subarray(0, nl);
      this.buf = this.buf.subarray(nl + 1);
      if (rawLine.length > 0) {
        if (rawLine.length > JSONRPC_MAX_LINE_BYTES) {
          this.send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_PARSE_ERROR, message: 'line too long' } });
        } else {
          this.handleLine(rawLine.toString('utf8').trim());
        }
      }
      nl = this.buf.indexOf(0x0a);
    }
  }

  private handleLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      // No id is recoverable from an unparseable frame; per JSON-RPC, respond
      // with a null-id parse error.
      this.send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_PARSE_ERROR, message: 'parse error' } });
      return;
    }
    if (!isObject(msg)) {
      this.send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_INVALID_REQUEST, message: 'invalid request' } });
      return;
    }

    // A response to one of OUR outbound requests. JSON-RPC ids may be
    // strings as well as numbers - a string id is a response, not an
    // invalid request. The pending map is keyed by the NUMERIC id
    // request() generated, and Map uses SameValueZero, so a client that
    // echoes the id as a string ("1" instead of 1) never resolved the
    // pending request and every permission hung until the 120 s timeout
    // (R2-7): coerce a numeric string id to its number for the lookup.
    if (
      (typeof msg.id === 'number' || typeof msg.id === 'string') &&
      !('method' in msg) &&
      (('result' in msg) || ('error' in msg))
    ) {
      const lookupId =
        typeof msg.id === 'string' && /^\d+$/.test(msg.id) ? Number(msg.id) : msg.id;
      const pending = this.pending.get(lookupId);
      if (!pending) return;
      this.pending.delete(lookupId);
      clearTimeout(pending.timer);
      if ('error' in msg && msg.error !== undefined && msg.error !== null) {
        const err = msg.error as { code?: number; message?: string };
        pending.reject(new JsonRpcError(err.code ?? JSONRPC_INTERNAL_ERROR, err.message ?? 'request failed'));
      } else {
        pending.resolve((msg as { result?: unknown }).result);
      }
      return;
    }

    if (typeof msg.method !== 'string') {
      this.send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_INVALID_REQUEST, message: 'invalid request' } });
      return;
    }

    // Notification (no id).
    if (!('id' in msg) || msg.id === undefined || msg.id === null) {
      const handler = this.notificationHandlers.get(msg.method);
      try {
        handler?.(msg.params);
      } catch {
        /* notifications never produce error responses */
      }
      return;
    }

    // Request.
    const id = msg.id as number | string;
    const handler = this.handlers.get(msg.method);
    if (!handler) {
      this.send({ jsonrpc: '2.0', id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: `method not found: ${msg.method}` } });
      return;
    }
    void handler(msg.params)
      .then((result) => {
        this.send({ jsonrpc: '2.0', id, result: result ?? {} });
      })
      .catch((err: unknown) => {
        if (err instanceof JsonRpcError) {
          this.send({
            jsonrpc: '2.0',
            id,
            error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) },
          });
        } else {
          const message = err instanceof Error ? err.message : String(err);
          this.send({ jsonrpc: '2.0', id, error: { code: JSONRPC_INTERNAL_ERROR, message } });
        }
      });
  }
}
