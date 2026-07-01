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

/** JSON-RPC 2.0 standard error codes + the ACP auth-required code. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
/** ACP: "Authentication is required before this operation can be performed." */
export const ACP_AUTH_REQUIRED = -32000;

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
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export class JsonRpcEndpoint {
  private buf = '';
  private nextId = 1;
  private closed = false;
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private readonly pending = new Map<number, PendingOutbound>();
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
      this.input.setEncoding('utf8');
      this.input.on('data', (chunk: string) => this.onData(chunk));
      const finish = (): void => {
        if (this.closed) return;
        this.closed = true;
        for (const [, p] of this.pending) p.reject(new Error('connection closed'));
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

  /** Outbound request (e.g. session/request_permission). */
  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(frame: Record<string, unknown>): void {
    if (this.closed) return;
    try {
      this.output.write(`${JSON.stringify(frame)}\n`);
    } catch {
      /* a dying pipe — the close handler will settle pending state */
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let nl = this.buf.indexOf('\n');
    while (nl !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line.length > 0) this.handleLine(line);
      nl = this.buf.indexOf('\n');
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

    // A response to one of OUR outbound requests.
    if (typeof msg.id === 'number' && !('method' in msg) && (('result' in msg) || ('error' in msg))) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
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
