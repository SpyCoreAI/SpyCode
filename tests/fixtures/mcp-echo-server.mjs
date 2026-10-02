#!/usr/bin/env node
/**
 * Test-only MCP server speaking the stdio transport: newline-delimited JSON-RPC
 * 2.0 over stdin/stdout. NOT shipped — exists purely so the MCP client/bridge
 * tests run against a real handshake instead of a mock.
 *
 * Tools:
 *   - echo       returns the `text` argument back as text content
 *   - big        returns a large text payload (to exercise byte-capping)
 *   - env_probe  returns selected env vars (to prove the minimal-env sandbox)
 *
 * Env knobs (read at startup):
 *   FIXTURE_NO_TOOL_FOR=<name>  make tools/call for <name> return an isError result
 */
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function result(id, res) {
  send({ jsonrpc: '2.0', id, result: res });
}

function errorResponse(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echo the provided text back to the caller.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to echo' } },
      required: ['text'],
    },
  },
  {
    name: 'big',
    description: 'Return a large text payload to exercise output capping.',
    inputSchema: {
      type: 'object',
      properties: { size: { type: 'integer', description: 'Bytes to return' } },
    },
  },
  {
    name: 'env_probe',
    description: 'Report selected environment variables visible to the server.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function callTool(name, args) {
  if (process.env.FIXTURE_NO_TOOL_FOR === name) {
    return { content: [{ type: 'text', text: `tool ${name} is unavailable` }], isError: true };
  }
  if (name === 'echo') {
    const text = typeof args?.text === 'string' ? args.text : '';
    return { content: [{ type: 'text', text }], isError: false };
  }
  if (name === 'big') {
    const size = Number.isInteger(args?.size) ? args.size : 100_000;
    return { content: [{ type: 'text', text: 'x'.repeat(Math.max(0, size)) }], isError: false };
  }
  if (name === 'env_probe') {
    const env = {
      SPYCORE_TEST_SECRET: process.env.SPYCORE_TEST_SECRET ?? null,
      MCP_ALLOWED: process.env.MCP_ALLOWED ?? null,
      LITERAL: process.env.LITERAL ?? null,
      HAS_PATH: Boolean(process.env.PATH),
    };
    return { content: [{ type: 'text', text: JSON.stringify(env) }], isError: false };
  }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
}

function handle(msg) {
  if (msg === null || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  // Notifications (no id) — nothing to answer.
  if (method === 'notifications/initialized') return;
  if (id === undefined) return;

  if (method === 'initialize') {
    result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'spycore-fixture', version: '0.0.1' },
    });
    return;
  }
  if (method === 'tools/list') {
    result(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    result(id, callTool(name, args));
    return;
  }
  if (method === 'ping') {
    result(id, {});
    return;
  }
  errorResponse(id, -32601, `method not found: ${method}`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  handle(msg);
});

// Exit when stdin closes (the client shut us down by closing the pipe).
rl.on('close', () => process.exit(0));
