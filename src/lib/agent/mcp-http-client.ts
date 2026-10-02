/**
 * A minimal, hand-rolled MCP client over the STREAMABLE HTTP transport (MCP
 * spec revision 2025-06-18, basic/transports) — the remote sibling of
 * mcp-client.ts. No SDK, no new dependencies: undici (already the CLI's HTTP
 * layer) + the existing SSE parser (lib/sse.ts).
 *
 * Wire facts implemented:
 *  - Single endpoint. Every JSON-RPC message goes up as an HTTP POST with
 *    `Accept: application/json, text/event-stream`. The server answers either
 *    with a plain JSON body (one response) or upgrades to an SSE stream whose
 *    events each carry one JSON-RPC message; we consume it via the REUSED
 *    parseSSEStream and stop at the response matching our request id.
 *  - Session: an `Mcp-Session-Id` response header captured at `initialize` is
 *    replayed on every subsequent request (and DELETE'd best-effort on
 *    shutdown). HTTP 404 = session expired → ONE re-initialize, then ONE
 *    replay of the failed request (safe: 404 means it was never processed),
 *    then clean failure.
 *  - `MCP-Protocol-Version` request header carries the negotiated version on
 *    every post-initialize request, per spec.
 *  - Dialect identical to stdio: initialize {protocolVersion, capabilities:{},
 *    clientInfo} → notifications/initialized → tools/list (paginated, capped
 *    at MAX_TOOLS) / tools/call. We declare no client capabilities; a request
 *    FROM the server gets a best-effort "method not found" POSTed back.
 *
 * HARD BOUNDS (nothing here is unbounded):
 *  - https:// required off-loopback — enforced at config load AND re-checked
 *    here (defense in depth, no escape hatch).
 *  - Response cap: HTTP_RESPONSE_CAP_BYTES (8 MiB, aligned with the stdio
 *    STDOUT_CAP_CHARS, whose unit differs — see there) on a JSON body and on cumulative SSE bytes; exceeding
 *    it destroys the connection and fails the call.
 *  - Timeouts: HTTP_CONNECT_TIMEOUT_MS (10 s) to first response headers; an
 *    overall per-request deadline (DEFAULT_REQUEST_TIMEOUT_MS = 120 s, or the
 *    caller's per-call timeout) enforced by an AbortController.
 *  - Reconnects: ZERO mid-call re-POSTs (a tools/call must never risk double
 *    execution — a broken stream fails that call); ONE re-initialize on
 *    session expiry; after HTTP_MAX_CONSECUTIVE_FAILURES (3) consecutive
 *    transport failures the server is marked FAILED FOR THE SESSION (one
 *    notice via onPermanentFailure; further calls fail fast).
 *
 * IDENTITY / SECRET SAFETY: header values (auth) appear in NO error, log, or
 * notice produced here; HTTP failures surface as status codes only (response
 * bodies are never echoed); remote JSON-RPC error messages are control-
 * stripped and length-capped before they surface.
 */
import { request } from 'undici';
import { parseSSEStream } from '../sse.js';
import {
  DEFAULT_INIT_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_TOOLS,
  MCP_PROTOCOL_VERSION,
  McpError,
  readClientVersion,
  type McpCallResult,
  type McpContent,
  type McpToolDef,
} from './mcp-client.js';
import { validateRemoteMcpUrl } from './mcp-config.js';

/** Cap on one HTTP response (JSON body bytes, or cumulative SSE bytes). */
export const HTTP_RESPONSE_CAP_BYTES = 8 * 1024 * 1024;
/** Time allowed to receive the response HEADERS (connection establishment). */
export const HTTP_CONNECT_TIMEOUT_MS = 10_000;
/** Consecutive transport failures before the server is failed for the session. */
export const HTTP_MAX_CONSECUTIVE_FAILURES = 3;
/** Cap on a remote JSON-RPC error message before it surfaces anywhere. */
const REMOTE_ERROR_TEXT_CAP = 300;

export interface McpHttpClientOptions {
  url: string;
  /** Already-expanded header values (see expandServerHeaders). Never logged. */
  headers: Record<string, string>;
  initTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  /**
   * Fired ONCE when the client marks itself failed for the session (after
   * HTTP_MAX_CONSECUTIVE_FAILURES consecutive transport failures). The reason
   * is our own fixed text — never remote-controlled bytes.
   */
  onPermanentFailure?: ((reason: string) => void) | undefined;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
  [key: string]: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Strip control chars (incl. ANSI) and cap remote-authored error text. */
function sanitizeRemoteText(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : String(raw ?? '');
  // eslint-disable-next-line no-control-regex
  const clean = s.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, ' ').trim();
  return clean.length > REMOTE_ERROR_TEXT_CAP ? `${clean.slice(0, REMOTE_ERROR_TEXT_CAP)}…` : clean;
}

/** First value of a possibly-multi response header. */
function headerValue(h: string | string[] | undefined): string | undefined {
  if (Array.isArray(h)) return h[0];
  return h;
}

/**
 * Wrap a body iterable with a cumulative byte cap. Throwing out of the
 * generator makes the consumer's return() destroy the underlying connection.
 */
async function* capBytes(
  body: AsyncIterable<Buffer | Uint8Array>,
  cap: number,
): AsyncGenerator<Buffer | Uint8Array> {
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > cap) {
      throw new McpError(`server response exceeded ${cap} bytes; closing the connection`);
    }
    yield chunk;
  }
}

export class McpHttpClient {
  private nextId = 1;
  private closed = false;
  private failedForSession = false;
  private consecutiveFailures = 0;
  private sessionId: string | null = null;
  private serverInfoValue: { name?: string; version?: string } | null = null;
  private protocolVersionValue: string | null = null;
  private readonly inflight = new Set<AbortController>();
  private readonly url: string;
  private readonly customHeaders: Record<string, string>;
  private readonly requestTimeoutMs: number;
  private readonly initTimeoutMs: number;
  private readonly onPermanentFailure: ((reason: string) => void) | undefined;

  private constructor(opts: McpHttpClientOptions) {
    this.url = opts.url;
    this.customHeaders = opts.headers;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.initTimeoutMs = opts.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
    this.onPermanentFailure = opts.onPermanentFailure;
  }

  /** Mirrors McpStdioClient's surface; remote servers have no local pid. */
  get pid(): number | undefined {
    return undefined;
  }
  get serverInfo(): { name?: string; version?: string } | null {
    return this.serverInfoValue;
  }
  get protocolVersion(): string | null {
    return this.protocolVersionValue;
  }
  get hasExited(): boolean {
    return this.closed || this.failedForSession;
  }

  /** Connect + run the initialize handshake. Rejects on any handshake failure. */
  static async connect(opts: McpHttpClientOptions): Promise<McpHttpClient> {
    // Defense in depth: the loader and `mcp add` already refuse these, but the
    // transport itself must never speak plaintext off-loopback either.
    const urlErr = validateRemoteMcpUrl(opts.url);
    if (urlErr) throw new McpError(urlErr);
    const client = new McpHttpClient(opts);
    await client.initialize();
    return client;
  }

  private async initialize(): Promise<void> {
    this.sessionId = null;
    this.protocolVersionValue = null;
    const result = await this.rpc(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'spycore', version: readClientVersion() },
      },
      this.initTimeoutMs,
      { captureSession: true, allowReinit: false },
    );
    if (!isObject(result)) throw new McpError('initialize returned a non-object result');
    if (typeof result.protocolVersion === 'string') this.protocolVersionValue = result.protocolVersion;
    if (isObject(result.serverInfo)) {
      const si = result.serverInfo;
      this.serverInfoValue = {
        ...(typeof si.name === 'string' ? { name: sanitizeRemoteText(si.name) } : {}),
        ...(typeof si.version === 'string' ? { version: sanitizeRemoteText(si.version) } : {}),
      };
    }
    // Per spec, signal readiness before any operation request. A dropped
    // notification is non-fatal (mirrors the stdio client).
    try {
      await this.notify('notifications/initialized');
    } catch {
      /* non-fatal */
    }
  }

  /** `tools/list`, following `nextCursor` pagination, capped at MAX_TOOLS. */
  async listTools(): Promise<McpToolDef[]> {
    const out: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await this.rpc('tools/list', cursor === undefined ? {} : { cursor }, this.requestTimeoutMs);
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
    const result = await this.rpc('tools/call', { name, arguments: args }, timeoutMs ?? this.requestTimeoutMs);
    if (!isObject(result)) return { content: [], isError: false };
    const content = Array.isArray(result.content)
      ? result.content.filter(isObject).map((c) => c as McpContent)
      : [];
    return { content, isError: result.isError === true };
  }

  // ─────────────────────── transport core ───────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      ...this.customHeaders,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId !== null) headers['mcp-session-id'] = this.sessionId;
    if (this.protocolVersionValue !== null) headers['mcp-protocol-version'] = this.protocolVersionValue;
    return headers;
  }

  private failFast(): McpError {
    return new McpError(
      this.failedForSession
        ? 'server was disabled for this session after repeated transport failures'
        : 'server connection is closed',
    );
  }

  /** One transport failure; trips the failed-for-session breaker at the max. */
  private noteTransportFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= HTTP_MAX_CONSECUTIVE_FAILURES && !this.failedForSession) {
      this.failedForSession = true;
      try {
        this.onPermanentFailure?.(
          `disabled for this session after ${HTTP_MAX_CONSECUTIVE_FAILURES} consecutive transport failures`,
        );
      } catch {
        /* notice is best-effort */
      }
    }
  }

  /**
   * POST one JSON-RPC request and return its `result`. Handles JSON and
   * SSE-upgraded responses, the session header, the single 404 re-init, the
   * response cap, and the per-request deadline.
   */
  private async rpc(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    opts: { captureSession?: boolean; allowReinit?: boolean } = {},
  ): Promise<unknown> {
    if (this.closed || this.failedForSession) throw this.failFast();
    const allowReinit = opts.allowReinit !== false;
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const controller = new AbortController();
    this.inflight.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      let res;
      try {
        res = await request(this.url, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: payload,
          signal: controller.signal,
          headersTimeout: HTTP_CONNECT_TIMEOUT_MS,
          bodyTimeout: timeoutMs,
        });
      } catch (err) {
        this.noteTransportFailure();
        if (timedOut) throw new McpError(`request "${method}" timed out after ${timeoutMs}ms`);
        if (this.closed) throw this.failFast();
        throw new McpError(`request "${method}" failed: could not reach the server`);
      }

      // Session expired (404 per spec): the request was NOT processed, so ONE
      // re-initialize + ONE replay is safe — including for tools/call.
      if (res.statusCode === 404 && allowReinit && this.sessionId !== null) {
        await drainQuietly(res.body);
        await this.initialize();
        return this.rpc(method, params, timeoutMs, { ...opts, allowReinit: false });
      }

      if (res.statusCode >= 400) {
        await drainQuietly(res.body);
        this.noteTransportFailure();
        // Status only — the response body is never echoed (identity/redaction).
        throw new McpError(`server returned HTTP ${res.statusCode} for "${method}"`);
      }

      if (opts.captureSession) {
        const sid = headerValue(res.headers['mcp-session-id']);
        if (typeof sid === 'string' && sid.length > 0) this.sessionId = sid;
      }

      const contentType = (headerValue(res.headers['content-type']) ?? '').toLowerCase();
      let message: JsonRpcMessage;
      try {
        if (contentType.includes('text/event-stream')) {
          message = await this.readSseResponse(res.body as AsyncIterable<Buffer>, id);
        } else {
          message = await readJsonResponse(res.body as AsyncIterable<Buffer>, id);
        }
      } catch (err) {
        this.noteTransportFailure();
        if (timedOut) throw new McpError(`request "${method}" timed out after ${timeoutMs}ms`);
        throw err instanceof McpError ? err : new McpError(`request "${method}" failed while reading the response`);
      }

      // A well-formed transport round-trip — reset the failure breaker even if
      // the payload is a JSON-RPC error (the server is alive and speaking MCP).
      this.consecutiveFailures = 0;
      if (message.error !== undefined && message.error !== null) {
        const msg = sanitizeRemoteText(isObject(message.error) ? message.error.message : '');
        const code = isObject(message.error) && typeof message.error.code === 'number' ? message.error.code : 0;
        throw new McpError(`${msg.length > 0 ? msg : 'server error'} (code ${code})`);
      }
      return message.result;
    } finally {
      clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  /**
   * Consume an SSE-upgraded response through the REUSED parser until the
   * message answering `id` arrives. Other frames: notifications are ignored;
   * a request FROM the server gets a best-effort method-not-found POSTed back
   * (we advertise no capabilities). Byte-capped cumulatively.
   */
  private async readSseResponse(body: AsyncIterable<Buffer>, id: number): Promise<JsonRpcMessage> {
    for await (const event of parseSSEStream(capBytes(body, HTTP_RESPONSE_CAP_BYTES))) {
      const data = event.data;
      if (!isObject(data)) continue;
      const msg = data as JsonRpcMessage;
      if (msg.id === id && ('result' in msg || 'error' in msg)) {
        return msg; // breaking out of for-await destroys the rest of the stream
      }
      if (typeof msg.method === 'string' && (typeof msg.id === 'number' || typeof msg.id === 'string')) {
        this.postErrorReply(msg.id, -32601, `method not found: ${msg.method}`);
      }
      // else: a notification — ignore.
    }
    throw new McpError('server closed the stream before answering the request');
  }

  /** Fire-and-forget JSON-RPC error reply to a server-initiated request. */
  private postErrorReply(id: number | string, code: number, message: string): void {
    const body = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
    request(this.url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body,
      headersTimeout: HTTP_CONNECT_TIMEOUT_MS,
      bodyTimeout: HTTP_CONNECT_TIMEOUT_MS,
    })
      .then((r) => drainQuietly(r.body))
      .catch(() => {
        /* best-effort */
      });
  }

  /** POST a notification (no id). Any 2xx (usually 202 Accepted) is success. */
  private async notify(method: string): Promise<void> {
    if (this.closed || this.failedForSession) return;
    const controller = new AbortController();
    this.inflight.add(controller);
    const timer = setTimeout(() => controller.abort(), HTTP_CONNECT_TIMEOUT_MS);
    try {
      const res = await request(this.url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ jsonrpc: '2.0', method }),
        signal: controller.signal,
        headersTimeout: HTTP_CONNECT_TIMEOUT_MS,
        bodyTimeout: HTTP_CONNECT_TIMEOUT_MS,
      });
      await drainQuietly(res.body);
      if (res.statusCode >= 400) throw new McpError(`server returned HTTP ${res.statusCode} for "${method}"`);
    } finally {
      clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  /** Immediate teardown for abort/Ctrl+C: cancel every in-flight request. */
  kill(): void {
    this.closed = true;
    for (const c of this.inflight) c.abort();
  }

  /**
   * Graceful shutdown: best-effort DELETE of the session (spec: the client
   * SHOULD terminate its session explicitly), then close.
   */
  async shutdown(): Promise<void> {
    if (!this.closed && this.sessionId !== null) {
      try {
        const res = await request(this.url, {
          method: 'DELETE',
          headers: this.buildHeaders(),
          headersTimeout: 3_000,
          bodyTimeout: 3_000,
        });
        await drainQuietly(res.body);
      } catch {
        /* best-effort */
      }
    }
    this.kill();
  }
}

/** Read + parse a JSON body under the response cap; find the response for `id`. */
async function readJsonResponse(body: AsyncIterable<Buffer>, id: number): Promise<JsonRpcMessage> {
  const chunks: Buffer[] = [];
  for await (const chunk of capBytes(body, HTTP_RESPONSE_CAP_BYTES)) {
    chunks.push(chunk instanceof Buffer ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpError('server returned a malformed response');
  }
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  for (const c of candidates) {
    if (isObject(c) && c.id === id && ('result' in c || 'error' in c)) return c as JsonRpcMessage;
  }
  throw new McpError('server response did not answer the request');
}

/** Consume and discard a body so the connection can be reused (never throws). */
async function drainQuietly(body: AsyncIterable<Buffer> | { destroy?: () => void }): Promise<void> {
  try {
    // Cap even the drain — a hostile server must not stream forever into it.
    for await (const _chunk of capBytes(body as AsyncIterable<Buffer>, HTTP_RESPONSE_CAP_BYTES)) {
      /* discard */
    }
  } catch {
    /* discarded */
  }
}
