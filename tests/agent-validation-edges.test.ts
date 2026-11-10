// Leftover branch arms for src/commands/agent.ts, kept apart from the main
// validation file so the additions stay reviewable on their own.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { freshConfigDir } from './helpers.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown>; [Symbol.asyncIterator]?: () => AsyncIterator<Buffer> };
}
let responder: ((url: string, init: { method: string }) => MockResp) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET' });
  }),
}));

let workDir: string;
let origCwd: string;
let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  origCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), 'spycli-agent-edge-'));
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

const stdout = (): string => stdoutChunks.join('');
const stderr = (): string => stderrChunks.join('');

async function setToken(): Promise<void> {
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
}

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

interface Turn {
  reply?: string;
  error?: string;
}
function turnResp(t: Turn): MockResp {
  const events: Array<Record<string, unknown>> = [];
  if (t.reply !== undefined) {
    events.push({ type: 'text', content: t.reply });
    events.push({ type: 'done', finishReason: 'stop' });
  }
  if (t.error !== undefined) events.push({ type: 'error', message: t.error });
  const buf = Buffer.from(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''));
  return {
    statusCode: 200,
    headers: {},
    body: {
      json: async () => ({}),
      [Symbol.asyncIterator]: async function* () {
        yield buf;
      },
    },
  };
}
function scripted(turns: Turn[]): (url: string, init: { method: string }) => MockResp {
  let i = 0;
  return (url, init) => {
    if (init.method === 'GET' && url.includes('/auth/cli/whoami')) {
      return jsonResp(200, { success: true, data: { plan: 'pro', planDisplay: 'pro' } });
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

async function configDir(): Promise<string> {
  const { getConfigPath } = await import('../src/lib/config.js');
  return dirname(getConfigPath());
}

describe('agent leftover arms', () => {
  test('JSON dry-run without --tool-protocol defaults it to auto', async () => {
    await runAgentCli(['do a thing', '--dry-run', '--json', '--model', 'styx']);
    const parsed = JSON.parse(stdout());
    expect(parsed.toolProtocol).toBe('auto');
  });

  test('dry-run prints command-rule notices', async () => {
    writeFileSync(
      join(await configDir(), 'command-rules.json'),
      JSON.stringify({ allow: ['*'], deny: [] }),
    );
    await runAgentCli(['do a thing', '--dry-run']);
    expect(stdout()).toMatch(/note: Command rules: skipped allow entry/);
  });

  test('non-numeric tool/timeout flags error instead of falling back to defaults', async () => {
    // 4b1 item 1: the old silent fallback is the defect under fix - an
    // unparseable numeric flag must error, never silently default. The
    // previous pin (dry-run prints `timeout: 120s per run_command` for
    // `--cmd-timeout abc`) asserted the defective behaviour and is
    // replaced, not deleted.
    await expect(
      runAgentCli(['do a thing', '--dry-run', '--max-tool-calls-per-turn', 'abc']),
    ).rejects.toThrow(/Invalid --max-tool-calls-per-turn/);
    await expect(
      runAgentCli(['do a thing', '--dry-run', '--cmd-timeout', 'abc']),
    ).rejects.toThrow(/Invalid --cmd-timeout/);
  });

  test('a final reply already ending in a newline gains no second one', async () => {
    await setToken();
    responder = scripted([{ reply: 'Done.\n' }]);
    await runAgentCli(['do a thing', '--model', 'styx', '--yes']);
    expect(stdout()).toBe('Done.\n');
  });

  test('a passing verify prints the passed line', async () => {
    await setToken();
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do a thing', '--model', 'styx', '--yes', '--verify', 'true']);
    expect(stderr()).toMatch(/verification passed/);
  });

  test('a failing verify with output prints the tail', async () => {
    await setToken();
    responder = scripted([{ reply: 'Done.' }]);
    // `;` is not a separator under cmd.exe: `echo oops; false` prints the
    // literal `oops; false` and exits 0, so the verify passes and no exit
    // code is ever set. The Windows spelling chains with `&` and fails with
    // a builtin instead of relying on a POSIX `false` binary.
    const verifyCmd = process.platform === 'win32' ? 'echo oops & exit 1' : 'echo oops; false';
    await runAgentCli([
      'do a thing', '--model', 'styx', '--yes',
      '--verify', verifyCmd, '--verify-attempts', '1',
    ]);
    expect(stderr()).toMatch(/oops/);
    expect(process.exitCode).toBe(1);
  });

  test('verify with a command rule present threads the rules through', async () => {
    await setToken();
    writeFileSync(
      join(await configDir(), 'command-rules.json'),
      JSON.stringify({ allow: ['true'], deny: [] }),
    );
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do a thing', '--model', 'styx', '--yes', '--verify', 'true']);
    expect(stderr()).toMatch(/verification passed/);
  });

  test('a failing verify with two attempts reports the plural', async () => {
    await setToken();
    responder = scripted([{ reply: 'Done.' }, { reply: 'Done.' }]);
    await runAgentCli([
      'do a thing', '--model', 'styx', '--yes',
      '--verify', 'false', '--verify-attempts', '2',
    ]);
    expect(stderr()).toMatch(/verification still failing after 2 attempts/);
    expect(process.exitCode).toBe(1);
  }, 30_000);

  test('explicit --plan with --yes runs the plan note path', async () => {
    await setToken();
    responder = scripted([{ reply: '1. Do the thing' }, { reply: 'Done.' }]);
    await runAgentCli(['do a thing', '--model', 'styx', '--yes', '--plan']);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);
});
