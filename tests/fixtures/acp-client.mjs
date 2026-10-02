#!/usr/bin/env node
/**
 * Test-only scripted ACP CLIENT over real stdio — the counterpart of the
 * mcp-echo-server fixture, on the client side. NOT shipped. Spawns an ACP
 * agent (everything after `--`), drives a scenario, and prints a trimmed
 * transcript of BOTH directions.
 *
 * Usage:
 *   node acp-client.mjs --scenario hello  -- node build/index.js acp -m styx
 *   node acp-client.mjs --scenario cancel -- node build/index.js acp -m styx
 *
 * Scenarios:
 *   hello  initialize → session/new (cwd from $ACP_CWD or a temp dir) →
 *          prompt (create hello.txt with HELLO ACP, read it back), permissions
 *          auto-allowed → prints stopReason.
 *   cancel same setup, long prompt; sends session/cancel on the first
 *          tool_call update, answers pending permissions cancelled → expects
 *          stopReason cancelled.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const sep = args.indexOf('--');
const scenario = args[args.indexOf('--scenario') + 1] ?? 'hello';
const agentCmd = args.slice(sep + 1);
if (sep === -1 || agentCmd.length === 0) {
  console.error('usage: acp-client.mjs --scenario <hello|cancel> -- <agent command...>');
  process.exit(2);
}

const cwd = process.env.ACP_CWD || mkdtempSync(join(tmpdir(), 'acp-real-'));
const child = spawn(agentCmd[0], agentCmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', (d) => process.stderr.write(`[agent stderr] ${d}`));

let nextId = 1;
const pending = new Map();
let buf = '';
let cancelSent = false;
let sawToolCall = false;

const log = (dir, msg) => {
  const s = JSON.stringify(msg);
  console.log(`${dir} ${s.length > 400 ? s.slice(0, 400) + '…' : s}`);
};
const send = (msg) => {
  log('→', msg);
  child.stdin.write(JSON.stringify(msg) + '\n');
};
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: '2.0', id, method, params });
  });

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`[NOT JSON-RPC — purity violation] ${line}`);
      process.exitCode = 1;
      continue;
    }
    log('←', msg);
    if (typeof msg.id === 'number' && !msg.method && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      continue;
    }
    if (msg.method === 'session/request_permission') {
      if (scenario === 'cancel') {
        // Spec: on cancel, the client answers pending permissions cancelled.
        maybeCancel();
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } });
      } else {
        send({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
      }
      continue;
    }
    if (msg.method === 'session/update') {
      const u = msg.params?.update;
      if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') {
        sawToolCall = true;
        if (scenario === 'cancel') maybeCancel();
      }
    }
  }
});

let sessionId = null;
function maybeCancel() {
  if (cancelSent || !sessionId) return;
  cancelSent = true;
  send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
}

const timeout = setTimeout(() => {
  console.error('TIMEOUT');
  child.kill('SIGKILL');
  process.exit(1);
}, 180_000);

try {
  const init = await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    clientInfo: { name: 'acp-fixture-client', version: '0.0.1' },
  });
  if (init.result?.protocolVersion !== 1) throw new Error('bad protocolVersion');

  const created = await request('session/new', { cwd, mcpServers: [] });
  sessionId = created.result?.sessionId;
  if (!sessionId) throw new Error(`session/new failed: ${JSON.stringify(created)}`);

  const promptText =
    scenario === 'cancel'
      ? 'Create twenty numbered files file1.txt through file20.txt, one run_command at a time, slowly.'
      : "Create a file named hello.txt containing exactly 'HELLO ACP', then read it back and tell me its contents. Keep it brief.";
  const resp = await request('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: promptText }],
  });
  const stopReason = resp.result?.stopReason;
  console.log(`\nRESULT stopReason=${stopReason} sawToolCall=${sawToolCall} cwd=${cwd}`);
  const expected = scenario === 'cancel' ? 'cancelled' : 'end_turn';
  process.exitCode = stopReason === expected ? 0 : 1;
} catch (err) {
  console.error('CLIENT ERROR', err);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  setTimeout(() => child.kill('SIGTERM'), 500);
}
