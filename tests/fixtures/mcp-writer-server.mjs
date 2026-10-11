#!/usr/bin/env node
/**
 * Test-only MCP server whose tools really MUTATE the filesystem - the echo
 * fixture next to it is read-only and therefore structurally unable to show
 * whether an MCP tool's writes reach the checkpoint journal.
 *
 *  It exists because F-2c-26 measured "every MCP wrapper is `mutating: true`
 * and `recordChange` appears nowhere in that module" and could only demonstrate
 * the flag, not the effect. A tool that writes a real file turns that from a
 * grep into a measurement.
 *
 * NOT shipped - manifest-excluded with the rest of `tests/`.
 *
 * Tools:
 *   - write_probe   write `text` to an absolute `path`
 *   - delete_probe  delete an absolute `path`
 */
import { createInterface } from 'node:readline';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

const PROTOCOL_VERSION = '2025-06-18';
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const result = (id, res) => send({ jsonrpc: '2.0', id, result: res });

const TOOLS = [
  {
    name: 'write_probe',
    description: 'Write text to an absolute path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, text: { type: 'string' } },
      required: ['path', 'text'],
    },
  },
  {
    name: 'delete_probe',
    description: 'Delete an absolute path.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
];

function callTool(name, args) {
  try {
    if (name === 'write_probe') {
      writeFileSync(args.path, args.text, 'utf8');
      return { content: [{ type: 'text', text: `wrote ${args.path}` }], isError: false };
    }
    if (name === 'delete_probe') {
      if (existsSync(args.path)) unlinkSync(args.path);
      return { content: [{ type: 'text', text: `deleted ${args.path}` }], isError: false };
    }
  } catch (e) {
    return { content: [{ type: 'text', text: String(e) }], isError: true };
  }
  return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
}

function handle(msg) {
  if (msg === null || typeof msg !== 'object') return;
  const { id, method, params } = msg;
  if (method === 'notifications/initialized') return;
  if (id === undefined) return;
  if (method === 'initialize') {
    result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'spycore-writer-fixture', version: '0.0.1' },
    });
    return;
  }
  if (method === 'tools/list') {
    result(id, { tools: TOOLS });
    return;
  }
  if (method === 'tools/call') {
    result(id, callTool(params?.name, params?.arguments ?? {}));
    return;
  }
  if (method === 'ping') {
    result(id, {});
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
