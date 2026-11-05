import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

// ───────────────────── mocked undici ─────────────────────

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

beforeEach(() => {
  freshConfigDir();
  responder = null;
  origCwd = process.cwd();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-agentval-')));
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

/** One scripted stream turn. */
interface Turn {
  reply?: string;
  usage?: { input: number; output: number };
  extraEvents?: Array<Record<string, unknown>>;
  error?: string;
}
function turnResp(t: Turn): MockResp {
  if (t.error !== undefined) return sseResp([{ type: 'error', message: t.error }]);
  const events: Array<Record<string, unknown>> = [...(t.extraEvents ?? [])];
  if (t.reply !== undefined) events.push({ type: 'text', content: t.reply });
  if (t.usage) events.push({ type: 'usage', input: t.usage.input, output: t.usage.output });
  events.push({ type: 'done' });
  return sseResp(events);
}

/** Responder: whoami + conversation create + queued stream turns (then 'Done.'). */
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

/** A responder that answers every stream turn with the same tool call. */
function repeatingTool(tool: string, args: unknown): Responder {
  return (url, init) => {
    if (init.method === 'GET' && url.includes('/auth/cli/whoami')) {
      return jsonResp(200, { success: true, data: { plan: 'pro', planDisplay: 'pro' } });
    }
    if (init.method === 'POST' && url.endsWith('/conversations')) {
      return jsonResp(200, { success: true, data: { id: 'cnv_test' } });
    }
    if (init.method === 'POST' && url.includes('/api/chat/stream')) {
      return turnResp({ reply: toolBlock(tool, args) });
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

/** Interrupted first run: writes marker.txt, then a stream error. */
async function interruptedFirstRun(extraTurns: Turn[] = []): Promise<void> {
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
  responder = scripted([
    { reply: toolBlock('write_file', { path: 'marker.txt', content: 'v1\n' }), usage: { input: 10_000, output: 20_000 } },
    ...extraTurns,
    { error: 'The stream ended unexpectedly.' },
  ]);
  await expect(
    runAgentCli(['make a marker file', '--model', 'styx', '--yes']),
  ).rejects.toThrow(/stream ended unexpectedly/);
  stdoutChunks = [];
  stderrChunks = [];
}

// ───────────────────── A. detached / resume / task validation ─────────────────────

describe('agent validation throws', () => {
  test('--detached cannot combine with --resume', async () => {
    await expect(runAgentCli(['--detached', '--resume', 'do a thing'])).rejects.toThrow(
      /--detached cannot be combined with --resume/,
    );
  });

  test('--detached cannot combine with --dry-run', async () => {
    await expect(runAgentCli(['--detached', '--dry-run', 'do a thing'])).rejects.toThrow(
      /--dry-run cannot be combined with --detached/,
    );
  });

  test('--detached without a task is rejected', async () => {
    await expect(runAgentCli(['--detached'])).rejects.toThrow(/Task description is required/);
  });

  test('--resume cannot combine with a task description', async () => {
    await expect(runAgentCli(['do a thing', '--resume'])).rejects.toThrow(
      /Cannot combine --resume with a task description/,
    );
  });

  test('--resume cannot combine with --attach', async () => {
    await expect(runAgentCli(['--resume', '--attach', 'note.txt'])).rejects.toThrow(
      /--attach cannot be combined with --resume/,
    );
  });

  test('--resume cannot combine with --plan', async () => {
    await expect(runAgentCli(['--resume', '--plan'])).rejects.toThrow(
      /--plan\/--no-plan cannot be combined with --resume/,
    );
  });

  test('--resume cannot combine with provider options', async () => {
    await expect(runAgentCli(['--resume', '--provider', 'openai'])).rejects.toThrow(
      /Provider options cannot be combined with --resume/,
    );
    await expect(runAgentCli(['--resume', '--base-url', 'https://example.invalid'])).rejects.toThrow(
      /Provider options cannot be combined with --resume/,
    );
    await expect(runAgentCli(['--resume', '--api-key-env', 'MY_KEY'])).rejects.toThrow(
      /Provider options cannot be combined with --resume/,
    );
  });

  test('--resume cannot combine with --tool-protocol', async () => {
    await expect(runAgentCli(['--resume', '--tool-protocol', 'native'])).rejects.toThrow(
      /--tool-protocol cannot be combined with --resume/,
    );
  });

  test('a fresh run without a task is rejected', async () => {
    await expect(runAgentCli([])).rejects.toThrow(/Task description is required/);
  });

  test('--dry-run cannot combine with --resume', async () => {
    await expect(runAgentCli(['--resume', '--dry-run'])).rejects.toThrow(
      /--dry-run cannot be combined with --resume/,
    );
  });

  test('a fresh SpyCore run without a login is rejected', async () => {
    await expect(runAgentCli(['do a thing'])).rejects.toThrow(/Not logged in/);
  });

  test('--resume without a login is rejected before any session lookup', async () => {
    await expect(runAgentCli(['--resume'])).rejects.toThrow(/Not logged in/);
  });
});

// ───────────────────── B. dry-run preview matrix ─────────────────────

describe('agent --dry-run preview', () => {
  test('default preview names the auto model and the auto plan note', async () => {
    await runAgentCli(['do a thing', '--dry-run']);
    expect(stdout()).toMatch(/dry-run/);
    expect(stdout()).toMatch(/model:\s+\(auto/);
    expect(stdout()).toMatch(/plan:\s+off \(auto:/);
    expect(stdout()).toMatch(/web on/);
    expect(stdout()).toMatch(/observe: off/);
    expect(stdout()).toMatch(/verify:\s+none/);
    expect(stdout()).toMatch(/approve: prompt per write/);
  });

  test('an explicit model is shown, an unknown model is rejected', async () => {
    await runAgentCli(['do a thing', '--dry-run', '--model', 'hermes']);
    expect(stdout()).toMatch(/model:\s+hermes/);
    await expect(runAgentCli(['do a thing', '--dry-run', '--model', 'bogus'])).rejects.toThrow(
      /Unknown model: bogus/,
    );
  });

  test('--plan turns the plan label on, --no-plan turns it off without the auto note', async () => {
    await runAgentCli(['do a thing', '--dry-run', '--plan']);
    expect(stdout()).toMatch(/plan:\s+on/);
    expect(stdout()).not.toMatch(/auto:/);
    stdoutChunks = [];
    await runAgentCli(['do a thing', '--dry-run', '--no-plan']);
    expect(stdout()).toMatch(/plan:\s+off/);
    expect(stdout()).not.toMatch(/auto:/);
  });

  test('flags flow into the preview lines', async () => {
    await runAgentCli([
      'do a thing', '--dry-run', '--yes',
      '--verify', 'npm test', '--verify-attempts', '9',
      '--max-turns', '5', '--max-tokens', '1000', '--max-time', '60',
      '--cmd-timeout', '5', '--no-web', '--observe',
    ]);
    const out = stdout();
    expect(out).toMatch(/approve: auto-approve \(--yes\)/);
    expect(out).toMatch(/verify:\s+npm test \(up to 9 attempts\)/);
    expect(out).toMatch(/turns:\s+up to 5/);
    expect(out).toMatch(/1000 tokens/);
    expect(out).toMatch(/60s/);
    expect(out).toMatch(/5 turns/);
    expect(out).toMatch(/web off; --no-web/);
    expect(out).toMatch(/observe: on/);
    expect(out).toMatch(/timeout: 5s per run_command/);
  });

  test('--json dry-run emits the structured preview', async () => {
    await runAgentCli(['do a thing', '--dry-run', '--json', '--model', 'styx', '--tool-protocol', 'fenced']);
    const parsed = JSON.parse(stdout());
    expect(parsed).toMatchObject({ dryRun: true, task: 'do a thing', model: 'styx', toolProtocol: 'fenced' });
    expect(parsed.tools.length).toBeGreaterThan(0);
  });
});

// ───────────────────── C. fresh-run validation ─────────────────────

describe('agent fresh-run validation', () => {
  test('an unknown model is rejected for the SpyCore provider', async () => {
    await setToken();
    await expect(runAgentCli(['do a thing', '--model', 'bogus'])).rejects.toThrow(
      /Unknown model: bogus/,
    );
  });

  test('image attachments need the SpyCore provider', async () => {
    await setToken();
    writeFileSync(join(workDir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(
      runAgentCli(['do a thing', '--provider', 'openai', '--model', 'gpt-x', '--attach', 'pic.png']),
    ).rejects.toThrow(/Image attachments require the SpyCore provider/);
  });

  test('image attachments need a vision-capable model', async () => {
    await setToken();
    writeFileSync(join(workDir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    await expect(
      runAgentCli(['do a thing', '--model', 'styx', '--attach', 'pic.png']),
    ).rejects.toThrow(/vision/i);
  });

  test('a text attachment is inlined and echoed as a chip', async () => {
    await setToken();
    writeFileSync(join(workDir, 'note.txt'), 'hello attach\n');
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do a thing', '--attach', 'note.txt', '--model', 'styx']);
    expect(stderr()).toMatch(/\+ attached/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('a stdin.isTTY stub still runs headless (second && operand evaluated)', async () => {
    await setToken();
    const saved = (process.stdin as unknown as { isTTY: unknown }).isTTY;
    (process.stdin as unknown as { isTTY: unknown }).isTTY = true;
    try {
      responder = scripted([{ reply: 'Done.' }]);
      await runAgentCli(['do a thing', '--model', 'styx']);
      expect(stdout()).toMatch(/Done\./);
    } finally {
      (process.stdin as unknown as { isTTY: unknown }).isTTY = saved;
    }
  }, 30_000);
});

// ───────────────────── D. headless event rendering ─────────────────────

describe('agent headless event rendering', () => {
  test('command results render the sigil, the summary and a non-empty tail', async () => {
    await setToken();
    responder = scripted([
      { reply: toolBlock('run_command', { command: 'echo hello' }) },
      { reply: toolBlock('run_command', { command: 'true' }) },
      { reply: toolBlock('run_command', { command: 'false' }) },
      { reply: 'Done.' },
    ]);
    await runAgentCli(['run some commands', '--model', 'styx', '--yes']);
    expect(stderr()).toMatch(/hello/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('applied edits and writes render distinct glyphs and stats', async () => {
    await setToken();
    writeFileSync(join(workDir, 'f.txt'), 'a\nb\n');
    responder = scripted([
      { reply: toolBlock('edit_file', { path: 'f.txt', old_str: 'a', new_str: 'x' }) },
      { reply: toolBlock('write_file', { path: 'new.txt', content: 'fresh\n' }) },
      { reply: 'Done.' },
    ]);
    await runAgentCli(['edit and write', '--model', 'styx', '--yes']);
    expect(stderr()).toMatch(/✎/);
    expect(stderr()).toMatch(/✚/);
    expect(readFileSync(join(workDir, 'f.txt'), 'utf8')).toBe('x\nb\n');
    expect(existsSync(join(workDir, 'new.txt'))).toBe(true);
  }, 30_000);

  test('a blocked tool in plan mode renders the planning error', async () => {
    await setToken();
    responder = scripted([
      { reply: 'COMPLEX' },
      { reply: toolBlock('write_file', { path: 'should_not.txt', content: 'nope' }) },
      { reply: '1. Create PLANMARKER.txt' },
    ]);
    await runAgentCli(['write a marker file']);
    expect(stderr()).toMatch(/error: planning mode/);
    expect(stdout()).toMatch(/PLANMARKER\.txt/);
    expect(existsSync(join(workDir, 'should_not.txt'))).toBe(false);
  }, 30_000);

  test('a headless write without --yes renders as rejected', async () => {
    await setToken();
    responder = scripted([
      { reply: toolBlock('write_file', { path: 'nope.txt', content: 'x\n' }) },
      { reply: 'Done.' },
    ]);
    await runAgentCli(['write a file', '--model', 'styx']);
    expect(stderr()).toMatch(/rejected write_file/);
    expect(existsSync(join(workDir, 'nope.txt'))).toBe(false);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('a malformed fenced tool block renders a parse error and retries', async () => {
    await setToken();
    responder = scripted([
      { reply: '```spycore:tool\n{bad json\n```' },
      { reply: 'Done.' },
    ]);
    await runAgentCli(['do a thing', '--model', 'styx']);
    expect(stderr()).toMatch(/no valid tool call/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('server-side skills events render the skills line', async () => {
    await setToken();
    responder = scripted([
      { reply: 'Done.', extraEvents: [{ type: 'skills_activated', skills: ['alpha', 'beta'] }] },
    ]);
    await runAgentCli(['do a thing', '--model', 'styx']);
    expect(stderr()).toMatch(/skills: alpha, beta/);
  }, 30_000);

  test('an unbacked "tests passed" claim warns but does not block', async () => {
    await setToken();
    responder = scripted([{ reply: 'All tests passed.' }]);
    await runAgentCli(['do a thing', '--model', 'styx']);
    expect(stderr()).toMatch(/tests passed/);
    expect(stdout()).toMatch(/All tests passed\./);
  }, 30_000);

  test('repeating the same call warns, vetoes, then breaks the loop', async () => {
    await setToken();
    responder = repeatingTool('run_command', { command: 'echo loop' });
    await runAgentCli(['repeat yourself', '--model', 'styx', '--yes', '--max-turns', '30']);
    expect(stderr()).toMatch(/repeated the same tool call/);
  }, 30_000);

  test('hitting the built-in turn guard renders max_turns and the limit warning', async () => {
    await setToken();
    // Distinct commands every turn: no loop-detector streak, no wandering.
    const turns: Turn[] = [];
    for (let i = 0; i < 25; i += 1) {
      turns.push({ reply: toolBlock('run_command', { command: `echo turn${i}` }) });
    }
    turns.push({ reply: 'Summary done.' });
    responder = scripted(turns);
    await runAgentCli(['many turns', '--model', 'styx', '--yes']);
    expect(stderr()).toMatch(/reached turn limit \(25\)/);
    expect(stderr()).toMatch(/Reached the turn limit \(25\)/);
  }, 60_000);

  test('a token-cap stop renders budget_stop and exits 0', async () => {
    await setToken();
    responder = scripted([
      { reply: toolBlock('write_file', { path: 'x.txt', content: 'hi\n' }), usage: { input: 5000, output: 10 } },
      { reply: 'Done.' },
    ]);
    await runAgentCli(['do a thing', '--model', 'styx', '--yes', '--max-tokens', '100']);
    expect(stderr()).toMatch(/stopped/);
    expect(process.exitCode ?? 0).toBe(0);
  }, 30_000);

  test('an oversized first turn clamps with an explicit marker', async () => {
    await setToken();
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['x'.repeat(40_000), '--model', 'styx']);
    expect(stderr()).toMatch(/message limit/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('--trace records a replayable trace', async () => {
    await setToken();
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do a thing', '--model', 'styx', '--trace']);
    expect(stderr()).toMatch(/Trace: .*replay with/);
  }, 30_000);
});

// ───────────────────── E. resume paths ─────────────────────

describe('agent resume paths', () => {
  test('--resume with an explicit model overrides the session model', async () => {
    await interruptedFirstRun();
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['--resume', '--model', 'hermes']);
    expect(stderr()).toMatch(/Resuming/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('--resume with an unknown model is rejected', async () => {
    await interruptedFirstRun();
    await expect(runAgentCli(['--resume', '--model', 'bogus'])).rejects.toThrow(
      /Unknown model: bogus/,
    );
  }, 30_000);

  test('--resume with a non-slug session model prints it verbatim', async () => {
    await interruptedFirstRun();
    const { listSessions } = await import('../src/lib/agent/checkpoint.js');
    const { getConfigPath } = await import('../src/lib/config.js');
    const { sha256 } = await import('../src/lib/agent/checkpoint.js');
    const session = listSessions(workDir)[0]!;
    const file = join(dirname(getConfigPath()), 'checkpoints', sha256(workDir), `${session.id}.json`);
    const data = JSON.parse(readFileSync(file, 'utf8')) as { resume: { model: string } };
    data.resume.model = 'custom-thing';
    writeFileSync(file, JSON.stringify(data));
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['--resume']);
    expect(stderr()).toMatch(/model custom-thing \(from session\)/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('--resume with a cap below carried-over usage stops immediately', async () => {
    // The interrupted run already spent 30,000 tokens; a 5,000 cap re-applied
    // on resume is already exceeded, so the run stops before its first turn.
    await interruptedFirstRun();
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['--resume', '--max-tokens', '5000']);
    expect(stderr()).toMatch(/stopped/);
    expect(stdout()).toBe('');
  }, 30_000);

  test('drift of one journaled file is named in the singular', async () => {
    await interruptedFirstRun();
    writeFileSync(join(workDir, 'marker.txt'), 'tampered\n');
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['--resume', '--yes']);
    expect(stderr()).toMatch(/1 file modified outside the run/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('drift of two journaled files is named in the plural', async () => {
    await interruptedFirstRun([
      { reply: toolBlock('write_file', { path: 'second.txt', content: 'v1\n' }) },
    ]);
    writeFileSync(join(workDir, 'marker.txt'), 'tampered\n');
    writeFileSync(join(workDir, 'second.txt'), 'tampered\n');
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['--resume', '--yes']);
    expect(stderr()).toMatch(/2 files modified outside the run/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('drift without --yes on a non-TTY refuses to resume', async () => {
    await interruptedFirstRun();
    writeFileSync(join(workDir, 'marker.txt'), 'tampered\n');
    await expect(runAgentCli(['--resume'])).rejects.toThrow(/Workspace changed since the interrupt/);
  }, 30_000);

  test('a moved git HEAD is reported as drift', async () => {
    execFileSync('git', ['init', '-q'], { cwd: workDir });
    execFileSync('git', ['-C', workDir, 'config', 'user.email', 't@t.t']);
    execFileSync('git', ['-C', workDir, 'config', 'user.name', 'T']);
    writeFileSync(join(workDir, 'base.txt'), 'base\n');
    execFileSync('git', ['-C', workDir, 'add', '-A']);
    execFileSync('git', ['-C', workDir, 'commit', '-qm', 'base']);
    await interruptedFirstRun();
    writeFileSync(join(workDir, 'later.txt'), 'later\n');
    execFileSync('git', ['-C', workDir, 'add', '-A']);
    execFileSync('git', ['-C', workDir, 'commit', '-qm', 'later']);
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['--resume', '--yes']);
    expect(stderr()).toMatch(/git HEAD moved/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);
});

// ───────────────────── F. hooks and command rules ─────────────────────

describe('agent hooks and command rules', () => {
  async function configDir(): Promise<string> {
    const { getConfigPath } = await import('../src/lib/config.js');
    return dirname(getConfigPath());
  }

  test('a global session-start hook notice is printed and the bridge is attached', async () => {
    await setToken();
    writeFileSync(
      join(await configDir(), 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'session-start', command: 'echo hookhi' }] }),
    );
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do a thing', '--model', 'styx']);
    expect(stderr()).toMatch(/Hook \(session-start\): hookhi/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('a global post-tool hook notice renders as a hook_notice event', async () => {
    await setToken();
    writeFileSync(
      join(await configDir(), 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'post-tool', command: 'echo posthi' }] }),
    );
    responder = scripted([
      { reply: toolBlock('write_file', { path: 'x.txt', content: 'hi\n' }) },
      { reply: 'Done.' },
    ]);
    await runAgentCli(['write a file', '--model', 'styx', '--yes']);
    expect(stderr()).toMatch(/posthi/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('a blocking prompt-submit hook rejects the run', async () => {
    await setToken();
    // A script file, not `echo nope >&2; exit 2`: `;` is not a command
    // separator under cmd.exe, so `exit 2` never ran and the hook exited 0.
    const script = join(await configDir(), 'block-hook.mjs');
    writeFileSync(script, `process.stderr.write('nope\\n');\nprocess.exit(2);\n`);
    writeFileSync(
      join(await configDir(), 'hooks.json'),
      JSON.stringify({ hooks: [{ event: 'prompt-submit', command: `"${process.execPath}" "${script}"` }] }),
    );
    await expect(runAgentCli(['do a thing', '--model', 'styx'])).rejects.toThrow(
      /Prompt blocked by a user hook/,
    );
  }, 30_000);

  test('a global allow rule auto-approves and announces itself', async () => {
    await setToken();
    writeFileSync(
      join(await configDir(), 'command-rules.json'),
      JSON.stringify({ allow: ['echo'], deny: [] }),
    );
    responder = scripted([
      { reply: toolBlock('run_command', { command: 'echo ruled' }) },
      { reply: 'Done.' },
    ]);
    await runAgentCli(['run a ruled command', '--model', 'styx']);
    expect(stderr()).toMatch(/auto-approved by the user allow rule "echo"/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('a global deny rule beats --yes and announces itself', async () => {
    await setToken();
    writeFileSync(
      join(await configDir(), 'command-rules.json'),
      JSON.stringify({ allow: [], deny: ['echo'] }),
    );
    responder = scripted([
      { reply: toolBlock('run_command', { command: 'echo denied' }) },
      { reply: 'Done.' },
    ]);
    await runAgentCli(['run a denied command', '--model', 'styx', '--yes']);
    expect(stderr()).toMatch(/denied by the user deny rule "echo"/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);

  test('withheld project skills are announced, not silently skipped', async () => {
    await setToken();
    mkdirSync(join(workDir, '.spycore', 'skills', 'demo'), { recursive: true });
    writeFileSync(
      join(workDir, '.spycore', 'skills', 'demo', 'SKILL.md'),
      '# Demo\nA demo skill.\n',
    );
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do a thing', '--model', 'styx']);
    expect(stderr()).toMatch(/Project skills in \.spycore\/skills\/ were skipped/);
    expect(stdout()).toMatch(/Done\./);
  }, 30_000);
});

// ───────────────────── G. JSON summaries and verify ─────────────────────

describe('agent JSON summaries and verify', () => {
  const lastJson = (): Record<string, unknown> => {
    const lines = stdout().trim().split('\n');
    return JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  };

  test('--json plan-only emits the plan summary last', async () => {
    await setToken();
    responder = scripted([
      { reply: 'COMPLEX' },
      { reply: '1. Create PLANMARKER.txt' },
    ]);
    await runAgentCli(['write a marker file', '--json']);
    const summary = lastJson();
    expect(summary).toMatchObject({ planMode: true, executed: false });
    expect(summary.plan).toMatch(/PLANMARKER\.txt/);
  }, 30_000);

  test('--json run with verify and budget fills both summary objects', async () => {
    await setToken();
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do a thing', '--json', '--model', 'styx', '--yes', '--verify', 'true', '--max-tokens', '1000']);
    const summary = lastJson();
    expect(summary).toMatchObject({ executed: true });
    expect(summary.verify).toMatchObject({ command: 'true', passed: true });
    expect(summary.budget).not.toBeNull();
  }, 30_000);

  test('a failing verify with one attempt reports the singular and exits 1', async () => {
    await setToken();
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do a thing', '--model', 'styx', '--yes', '--verify', 'false', '--verify-attempts', '1']);
    expect(stderr()).toMatch(/verification still failing after 1 attempt[^s]/);
    expect(process.exitCode).toBe(1);
  }, 30_000);

  test('a verify without approval is blocked and reported as failing', async () => {
    await setToken();
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do a thing', '--model', 'styx', '--verify', 'true']);
    expect(stderr()).toMatch(/verification still failing/);
    expect(process.exitCode).toBe(1);
  }, 30_000);

  test('a catastrophic verify command is refused, never run', async () => {
    await setToken();
    responder = scripted([{ reply: 'Done.' }]);
    await runAgentCli(['do a thing', '--model', 'styx', '--yes', '--verify', 'rm -rf /']);
    expect(stderr()).toMatch(/verification still failing/);
    expect(process.exitCode).toBe(1);
  }, 30_000);
});
