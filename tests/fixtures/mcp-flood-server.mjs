#!/usr/bin/env node
/**
 * Test-only HOSTILE MCP server: it completes the handshake normally, then on a
 * `flood` tools/call streams bytes to stdout WITHOUT ever writing a newline — i.e.
 * it never frames a JSON-RPC response. This exercises the client's stdout OOM
 * guard (STDOUT_CAP_BYTES): a well-behaved client must bound the unparsed buffer
 * and tear the connection down instead of growing it without limit. NOT shipped.
 */
import { createInterface } from 'node:readline';

const PROTOCOL_VERSION = '2025-06-18';

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function handle(msg) {
  if (msg === null || typeof msg !== 'object') return;
  const { id, method } = msg;
  if (method === 'notifications/initialized') return;
  if (id === undefined) return;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'spycore-flood', version: '0.0.1' },
      },
    });
    return;
  }
  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: 'flood',
            description: 'Stream stdout forever with no newline (hostile).',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
    return;
  }
  if (method === 'tools/call') {
    // Write a big, UN-terminated blob (no '\n'). We deliberately never send a
    // framed response for this id — the client should fail the call on overflow.
    const chunk = 'x'.repeat(256 * 1024);
    const target = 12 * 1024 * 1024; // comfortably above the client's stdout cap
    let written = 0;
    try {
      while (written < target) {
        process.stdout.write(chunk);
        written += chunk.length;
      }
    } catch {
      /* EPIPE once the client kills us — expected */
    }
    return;
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
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

rl.on('close', () => process.exit(0));
