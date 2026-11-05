import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown>; [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> };
}
type Responder = (url: string, init: { method: string; body?: unknown }) => MockResp;
let responder: Responder | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string; body?: unknown } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET', body: init.body });
  }),
}));

let workDir: string;
let origCwd: string;
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origStdin = process.stdin;

beforeEach(() => {
  freshConfigDir();
  responder = null;
  origCwd = process.cwd();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-agentrender-')));
  stdoutChunks = [];
  stderrChunks = [];
  process.stdout.write = ((c: unknown) => {
    stdoutChunks.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    stderrChunks.push(String(c));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  Object.defineProperty(process, 'stdin', { value: origStdin, configurable: true });
  process.exitCode = undefined;
  try {
    process.chdir(origCwd);
  } catch {
    /* ignore */
  }
  vi.resetModules();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function setToken(): Promise<void> {
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
}

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}
function sseResp(events: Array<Record<string, unknown>>): MockResp {
  const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return {
    statusCode: 200,
    headers: { 'content-type': 'text/event-stream' },
    body: { json: async () => ({}), [Symbol.asyncIterator]: () => Readable.from([buf])[Symbol.asyncIterator]() },
  };
}
const toolBlock = (tool: string, args: unknown): string =>
  '```spycore:tool\n' + JSON.stringify({ tool, args }) + '\n```';

interface Turn {
  reply?: string;
  usage?: { input: number; output: number };
  error?: string;
}
function turnResp(t: Turn): MockResp {
  if (t.error !== undefined) return sseResp([{ type: 'error', message: t.error }]);
  const events: Array<Record<string, unknown>> = [];
  if (t.reply !== undefined) events.push({ type: 'text', content: t.reply });
  if (t.usage) events.push({ type: 'usage', input: t.usage.input, output: t.usage.output });
  events.push({ type: 'done' });
  return sseResp(events);
}
function scripted(turns: Turn[], plan = 'pro'): Responder {
  let i = 0;
  return (url, init) => {
    if (init.method === 'GET' && url.includes('/auth/cli/whoami')) {
      return jsonResp(200, { success: true, data: { plan, planDisplay: plan } });
    }
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return jsonResp(200, { success: true, data: { id: 'cnv_test' } });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      const t = turns[i] ?? { reply: 'Done.' };
      i += 1;
      return turnResp(t);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

async function runAgentCli(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerAgentCommand } = await import('../src/commands/agent.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: argv.includes('--json'), color: false });
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerAgentCommand(program);
  process.chdir(workDir);
  await program.parseAsync(['node', 'spycore', 'agent', ...argv]);
}

const stdout = (): string => stdoutChunks.join('');
const stderr = (): string => stderrChunks.join('');

describe('headless event rendering', () => {
  test('prose before a tool call renders as narration', async () => {
    await setToken();
    responder = scripted([
      { reply: `Working on it.\n${toolBlock('write_file', { path: 'n.txt', content: 'hi\n' })}` },
      { reply: 'Done.' },
    ]);
    await runAgentCli(['do the thing', '--model', 'styx', '--yes']);
    expect(stderr()).toContain('Working on it.');
    expect(existsSync(join(workDir, 'n.txt'))).toBe(true);
  });

  test('a tool call without a displayable arg renders bare', async () => {
    await setToken();
    responder = scripted([
      { reply: toolBlock('write_file', { content: 'x\n' }) },
      { reply: 'Done.' },
    ]);
    await runAgentCli(['do the thing', '--model', 'styx', '--yes']);
    expect(stderr()).toContain('⚙ write_file\n');
  });

  test('an edit that removes lines renders the +/- stat', async () => {
    await setToken();
    writeFileSync(join(workDir, 'multi.txt'), 'a\nb\nc\n');
    responder = scripted([
      { reply: toolBlock('edit_file', { path: 'multi.txt', old_str: 'b\nc\n', new_str: 'B\n' }) },
      { reply: 'Done.' },
    ]);
    await runAgentCli(['do the thing', '--model', 'styx', '--yes']);
    expect(readFileSync(join(workDir, 'multi.txt'), 'utf8')).toBe('a\nB\n');
    expect(stderr()).toContain('+1 -2');
  });

  test('a final reply already ending in a newline gains no second one', async () => {
    await setToken();
    responder = scripted([{ reply: 'Done.\n' }]);
    await runAgentCli(['do the thing', '--model', 'styx', '--yes']);
    expect(stdout()).toBe('Done.\n');
  });

  test('valid numeric flags are read (not defaulted)', async () => {
    await setToken();
    responder = scripted([]);
    await runAgentCli([
      'do the thing',
      '--model',
      'styx',
      '--dry-run',
      '--max-tool-calls-per-turn',
      '5',
      '--cmd-timeout',
      '30',
      '--verify-attempts',
      '2',
    ]);
    expect(stdout()).toMatch(/timeout: 30s per run_command/);
  });

  test('a configured guardian threshold is read', async () => {
    await setToken();
    const { getConfigStore } = await import('../src/lib/config.js');
    getConfigStore().set('guardianThreshold', 5);
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do the thing', '--model', 'styx', '--yes']);
    expect(stdout()).toBe('Done.\n');
  });
});

describe('drift prompt on a TTY', () => {
  test('answering no cancels the resume before any run starts', async () => {
    await setToken();
    responder = scripted([
      { reply: toolBlock('write_file', { path: 'marker.txt', content: 'v1\n' }) },
      { error: 'The stream ended unexpectedly.' },
    ]);
    await expect(runAgentCli(['make a marker file', '--model', 'styx', '--yes'])).rejects.toThrow(
      /stream ended unexpectedly/,
    );
    // Drift: the marker changed after the interrupt.
    writeFileSync(join(workDir, 'marker.txt'), 'v2\n');
    stdoutChunks = [];
    stderrChunks = [];
    responder = scripted([{ reply: 'Done.' }]);
    const fakeStdin = Readable.from(['n\n']);
    (fakeStdin as unknown as { isTTY: boolean }).isTTY = true;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
    await runAgentCli(['--resume']);
    expect(stderr()).toContain('Resume cancelled');
  });

  test('answering yes accepts the drift and runs to completion', async () => {
    await setToken();
    responder = scripted([
      { reply: toolBlock('write_file', { path: 'marker.txt', content: 'v1\n' }) },
      { error: 'The stream ended unexpectedly.' },
    ]);
    await expect(runAgentCli(['make a marker file', '--model', 'styx', '--yes'])).rejects.toThrow(
      /stream ended unexpectedly/,
    );
    // Drift: the marker changed after the interrupt.
    writeFileSync(join(workDir, 'marker.txt'), 'v2\n');
    stdoutChunks = [];
    stderrChunks = [];
    responder = scripted([{ reply: 'Done.' }]);
    const fakeStdin = Readable.from(['y\n']);
    (fakeStdin as unknown as { isTTY: boolean }).isTTY = true;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    (process.stdin as unknown as { isTTY: boolean }).isTTY = true;
    await runAgentCli(['--resume']);
    expect(stdout()).toBe('Done.\n');
  });
});

describe('SIGINT cancellation', () => {
  // Windows: these three tests deliver Ctrl+C as a synthetic
  // `process.emit('SIGINT')` inside the vitest worker, and that emission
  // kills the worker on Windows. Deterministic across four consecutive
  // branch CI runs: the job fails with 0 failed tests and one unhandled
  // error, "[vitest-pool]: Worker forks emitted error", and this file is
  // the only one with no summary line - 8 of its 14 tests report, 6 never
  // run. This is the only file in the suite that emits SIGINT, and the
  // worker dies with no JS error reported (vitest forwards uncaught
  // exceptions, so none occurred). The product behaviour is platform-neutral
  // - one AbortController line plus signal checks - and stays covered on
  // Linux/macOS; the emission technique is what Windows cannot run.
  test.skipIf(process.platform === 'win32')('a SIGINT between turns cancels the run', async () => {
    await setToken();
    let calls = 0;
    const base = scripted([
      { reply: toolBlock('write_file', { path: 's.txt', content: 'hi\n' }) },
      { reply: 'Done.' },
    ]);
    responder = (url, init) => {
      calls += 1;
      // Delivered synchronously, NOT through a zero-delay timer: under
      // vitest 4 the run can finish before a timer fires, and by then the
      // run has already removed its SIGINT listener (measured: zero
      // listeners attached at emit time), so the signal is lost and the run
      // completes normally. Emitting here lands while the run is in progress
      // and its listener is attached; the product behaviour under test - a
      // SIGINT arriving mid-run cancels it - is unchanged.
      if (calls === 1) process.emit('SIGINT');
      return base(url, init);
    };
    await runAgentCli(['do the thing', '--model', 'styx', '--yes']);
    expect(stderr()).toContain('Interrupted.');
  });

  test.skipIf(process.platform === 'win32')('a SIGINT during the plan phase cancels the plan', async () => {
    await setToken();
    writeFileSync(join(workDir, 'x.txt'), 'x\n');
    let calls = 0;
    const base = scripted([
      { reply: toolBlock('read_file', { path: 'x.txt' }) },
      { reply: 'Done.' },
    ]);
    responder = (url, init) => {
      calls += 1;
      // Delivered synchronously, NOT through a zero-delay timer: under
      // vitest 4 the run can finish before a timer fires, and by then the
      // run has already removed its SIGINT listener (measured: zero
      // listeners attached at emit time), so the signal is lost and the run
      // completes normally. Emitting here lands while the run is in progress
      // and its listener is attached; the product behaviour under test - a
      // SIGINT arriving mid-run cancels it - is unchanged.
      if (calls === 1) process.emit('SIGINT');
      return base(url, init);
    };
    await runAgentCli(['do the thing', '--model', 'styx', '--plan', '--yes']);
    expect(stderr()).toContain('Interrupted.');
  });

  test.skipIf(process.platform === 'win32')('a SIGINT-cancelled plan in JSON mode reports cancelled structurally', async () => {
    await setToken();
    writeFileSync(join(workDir, 'x.txt'), 'x\n');
    let calls = 0;
    const base = scripted([
      { reply: toolBlock('read_file', { path: 'x.txt' }) },
      { reply: 'Done.' },
    ]);
    responder = (url, init) => {
      calls += 1;
      // Delivered synchronously, NOT through a zero-delay timer: under
      // vitest 4 the run can finish before a timer fires, and by then the
      // run has already removed its SIGINT listener (measured: zero
      // listeners attached at emit time), so the signal is lost and the run
      // completes normally. Emitting here lands while the run is in progress
      // and its listener is attached; the product behaviour under test - a
      // SIGINT arriving mid-run cancels it - is unchanged.
      if (calls === 1) process.emit('SIGINT');
      return base(url, init);
    };
    await runAgentCli(['do the thing', '--model', 'styx', '--plan', '--yes', '--json']);
    expect(stdout()).toMatch(/"cancelled":\s*true/);
  });
});

describe('image attachments', () => {
  test('an attached image uploads before the first turn', async () => {
    await setToken();
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(workDir, 'pic.png'), png);
    let uploadHit = false;
    const base = scripted([{ reply: 'Done.' }]);
    responder = (url, init) => {
      if (url.includes('/api/files/upload')) {
        uploadHit = true;
        return jsonResp(201, {
          success: true,
          data: { id: 'f_img', url: 'https://x/f_img', size: png.length, mime: 'image/png', filename: 'pic.png' },
        });
      }
      return base(url, init);
    };
    await runAgentCli(['do the thing', '--model', 'hermes', '--yes', '--attach', 'pic.png']);
    expect(uploadHit).toBe(true);
    expect(stdout()).toBe('Done.\n');
  });
});

describe('MCP notices', () => {
  test('a failing server renders a warning notice', async () => {
    await setToken();
    const { setStoredMcpServers } = await import('../src/lib/config.js');
    setStoredMcpServers([{ name: 'broken', command: 'definitely-not-a-real-binary-xyz' }]);
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do the thing', '--model', 'styx', '--yes']);
    expect(stderr()).toContain('⚠');
  });

  test('a working server renders the ready summary', async () => {
    await setToken();
    const serverFile = join(workDir, 'fake-mcp.mjs');
    writeFileSync(
      serverFile,
      `import { createInterface } from 'node:readline';
const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0' } } }) + '\\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
  }
});
`,
    );
    const { setStoredMcpServers } = await import('../src/lib/config.js');
    setStoredMcpServers([{ name: 'fake', command: process.execPath, args: [serverFile] }]);
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do the thing', '--model', 'styx', '--yes']);
    expect(stderr()).toContain('1 MCP tool from 1 server');
  });
});
