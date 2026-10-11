#!/usr/bin/env node
/**
 * Test-only LSP server speaking the stdio transport: Content-Length-framed
 * JSON-RPC 2.0 over stdin/stdout. NOT shipped — exists purely so the LSP
 * client/manager tests run against a real handshake instead of a mock.
 *
 * Behaviour:
 * - `initialize` → `{ capabilities: { textDocumentSync: 1 }, serverInfo }`.
 * - After `initialized`, sends a `window/workDoneProgress/create` REQUEST —
 *   the client must answer it (we gate diagnostics on the reply, so a client
 *   that leaves server requests hanging never produces diagnostics).
 * - `textDocument/didOpen` → `textDocument/publishDiagnostics` with one canned
 *   error diagnostic (0-based range → the client must normalise to 1-based).
 * - Any other request → `{ result: null }`.
 * - `shutdown` → `{ result: null }`; `exit` notification → process exits 0.
 *
 * Env knobs (read at startup):
 *   LSP_FIXTURE_CRASH=1    exit(1) immediately (tests client crash handling)
 *   LSP_FIXTURE_NO_DIAG=1  never publish diagnostics (tests the wait timeout)
 */
import { stdin, stdout, exit, env } from 'node:process';

if (env.LSP_FIXTURE_CRASH === '1') {
  exit(1);
}

const NO_DIAG = env.LSP_FIXTURE_NO_DIAG === '1';

let buf = Buffer.alloc(0);
let workDoneReplied = false;
const pendingDiagUris = [];

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  stdout.write(Buffer.concat([header, body]));
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function publishDiagnostics(uri) {
  send({
    jsonrpc: '2.0',
    method: 'textDocument/publishDiagnostics',
    params: {
      uri,
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 9 },
          },
          severity: 1,
          code: 'TS2304',
          source: 'ts',
          message: "Cannot find name 'foo'.",
        },
      ],
    },
  });
}

function maybeFlushDiags() {
  if (!workDoneReplied || NO_DIAG) return;
  while (pendingDiagUris.length > 0) {
    const uri = pendingDiagUris.shift();
    // Small delay so the client's waitForDiagnostics is genuinely waiting.
    setTimeout(() => publishDiagnostics(uri), 30);
  }
}

function handleMessage(msg) {
  if (msg.id !== undefined && typeof msg.method === 'string') {
    // A request.
    if (msg.method === 'initialize') {
      respond(msg.id, {
        capabilities: { textDocumentSync: 1 },
        serverInfo: { name: 'lsp-fixture', version: '0.0.0' },
      });
    } else if (msg.method === 'shutdown') {
      respond(msg.id, null);
    } else {
      respond(msg.id, null);
    }
    return;
  }
  if (typeof msg.method === 'string') {
    // A notification.
    if (msg.method === 'initialized') {
      // Server→client request: the client MUST answer for diagnostics to flow.
      send({
        jsonrpc: '2.0',
        id: 1000,
        method: 'window/workDoneProgress/create',
        params: { token: 'fixture-token' },
      });
    } else if (msg.method === 'textDocument/didOpen') {
      const uri = msg.params?.textDocument?.uri;
      if (typeof uri === 'string') {
        pendingDiagUris.push(uri);
        maybeFlushDiags();
      }
    } else if (msg.method === 'exit') {
      // Flush stdout before exiting so the shutdown response isn't lost.
      setImmediate(() => exit(0));
    }
    return;
  }
  // A response (to our workDoneProgress/create request).
  if (msg.id === 1000) {
    workDoneReplied = true;
    maybeFlushDiags();
  }
}

stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;
    const headerText = buf.subarray(0, headerEnd).toString('ascii');
    const m = /content-length\s*:\s*(\d+)/i.exec(headerText);
    if (!m) {
      exit(3); // protocol violation by the client under test
    }
    const length = parseInt(m[1], 10);
    const bodyStart = headerEnd + 4;
    if (buf.length < bodyStart + length) return;
    const body = buf.subarray(bodyStart, bodyStart + length).toString('utf8');
    buf = buf.subarray(bodyStart + length);
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      continue;
    }
    handleMessage(msg);
  }
});
