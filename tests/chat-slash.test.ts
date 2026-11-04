import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { freshConfigDir } from './helpers.js';

// Direct unit tests of the one-shot slash renderer: handleSlashCommand
// parses, runs the shared slash core, and renders to stderr (stdout only
// for /clear). No network except /save, which uses the mocked undici.

type MockBody = (AsyncIterable<Buffer> & { json?: () => Promise<unknown> })
  | { json: () => Promise<unknown> };
interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: MockBody;
}
let responder:
  | ((url: string, init: { method: string }) => MockResp)
  | null = null;

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

beforeEach(() => {
  freshConfigDir();
  responder = null;
  origCwd = process.cwd();
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'spycli-slash-')));
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
  process.chdir(workDir);
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
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

async function slash(
  raw: string,
  over: { json?: boolean; model?: string; resolveUserCommand?: (name: string, args: string[]) => unknown } = {},
): Promise<Record<string, unknown>> {
  const { handleSlashCommand } = await import('../src/commands/chat.js');
  const result = await handleSlashCommand(raw, {
    json: over.json ?? false,
    color: false,
    currentConvo: 'cnv_x',
    apiUrl: undefined,
    ...(over.model ? { model: over.model as never } : {}),
    ...(over.resolveUserCommand
      ? { resolveUserCommand: over.resolveUserCommand as never }
      : {}),
  });
  return result as unknown as Record<string, unknown>;
}

describe('slash passthrough and help', () => {
  test('non-slash input is not consumed', async () => {
    expect(await slash('hello')).toEqual({ consumed: false });
  });

  test('/help renders the command list, silent in JSON mode', async () => {
    const r = await slash('/help');
    expect(r.consumed).toBe(true);
    expect(stderr()).toContain('/model');
    stderrChunks = [];
    await slash('/help', { json: true });
    expect(stderr()).toBe('');
  });

  test('/exit and /quit exit', async () => {
    expect(await slash('/exit')).toMatchObject({ consumed: true, exit: true });
    expect(await slash('/quit')).toMatchObject({ consumed: true, exit: true });
  });

  test('an unknown command names itself', async () => {
    await slash('/frobnicate');
    expect(stderr()).toContain('Unknown command: /frobnicate');
  });

  test('/clear writes the clear sequence to stdout', async () => {
    const r = await slash('/clear');
    expect(r.consumed).toBe(true);
    expect(stdout()).toBe('\x1b[2J\x1b[H');
  });

  test('/new starts a new conversation', async () => {
    const r = await slash('/new');
    expect(r).toMatchObject({ consumed: true, newConvo: true });
    expect(stderr()).toContain('Starting a new conversation');
  });

  test('/commit and /compact point at their real surfaces', async () => {
    await slash('/commit');
    expect(stderr()).toContain('spycore commit');
    stderrChunks = [];
    await slash('/compact');
    expect(stderr()).toContain('/compact runs inside the interactive session');
  });
});

describe('slash model and effort', () => {
  test('/model with no arg shows usage', async () => {
    await slash('/model');
    expect(stderr()).toContain('Usage: /model');
  });

  test('/model with an unknown slug reports it', async () => {
    await slash('/model bogus');
    expect(stderr()).toMatch(/!/);
  });

  test('/model switches and reports the new model', async () => {
    const r = await slash('/model hermes');
    expect(r).toMatchObject({ consumed: true, newModel: 'hermes' });
    expect(stderr()).toContain('Model set to hermes');
  });

  test('/effort with no arg lists levels, silent in JSON mode', async () => {
    await slash('/effort');
    expect(stderr()).toContain('Effort levels for');
    stderrChunks = [];
    await slash('/effort', { json: true });
    expect(stderr()).toBe('');
  });

  test('/effort with an unknown level reports it', async () => {
    await slash('/effort bogus');
    expect(stderr()).toContain('Unknown effort: bogus');
  });

  test('/effort sets a supported level, clamps an unsupported one', async () => {
    const r = await slash('/effort high', { model: 'charon' });
    expect(r).toMatchObject({ consumed: true, newEffort: 'high' });
    expect(stderr()).toContain('Effort set to high');
    stderrChunks = [];
    // Hermes is auto-only: 'high' clamps to 'auto'.
    const c = await slash('/effort high', { model: 'hermes' });
    expect(c).toMatchObject({ consumed: true, newEffort: 'auto' });
    expect(stderr()).toMatch(/isn't supported/);
  });
});

describe('slash memory, guide, changelog', () => {
  test('/remember creates then updates SPYCODE.md', async () => {
    const r1 = await slash('/remember first note');
    expect(stderr()).toContain('Created');
    expect(existsSync(join(workDir, 'SPYCODE.md'))).toBe(true);
    expect(r1.consumed).toBe(true);
    stderrChunks = [];
    await slash('/remember second note');
    expect(stderr()).toContain('Updated');
    expect(readFileSync(join(workDir, 'SPYCODE.md'), 'utf8')).toContain('second note');
  });

  test('/remember with no text shows usage', async () => {
    await slash('/remember');
    expect(stderr()).toContain('Usage: /remember');
  });

  test('/remember failing to write reports the error', async () => {
    // A dangling symlink whose target parent does not exist: the write
    // follows it and fails ENOENT, while existsSync stays false.
    symlinkSync(join(workDir, 'no-such-dir', 'SPYCODE.md'), join(workDir, 'SPYCODE.md'));
    await slash('/remember boom');
    expect(stderr()).toContain('/remember failed');
  });

  test('/memory renders the current injection', async () => {
    writeFileSync(join(workDir, 'SPYCODE.md'), '# Notes\nhello\n');
    await slash('/memory');
    expect(stderr()).toContain('SPYCODE.md');
    expect(stderr()).toContain('1 part');
  });

  test('/guide status: missing, one line, several lines', async () => {
    await slash('/guide');
    expect(stderr()).toContain('No CODEBASE_GUIDE.md');
    stderrChunks = [];
    writeFileSync(join(workDir, 'CODEBASE_GUIDE.md'), 'one line\n');
    await slash('/guide');
    expect(stderr()).toMatch(/1 line\./);
    stderrChunks = [];
    writeFileSync(join(workDir, 'CODEBASE_GUIDE.md'), 'a\nb\nc\n');
    await slash('/guide');
    expect(stderr()).toMatch(/3 lines\./);
  });

  test('/guide with an unknown subcommand reports it', async () => {
    await slash('/guide frobnicate');
    expect(stderr()).toContain('Unknown /guide subcommand: frobnicate');
  });

  test('/guide refresh regenerates, preserving manual notes', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'x\n');
    await slash('/guide refresh');
    expect(stderr()).toContain('Regenerated CODEBASE_GUIDE.md');
    expect(existsSync(join(workDir, 'CODEBASE_GUIDE.md'))).toBe(true);
    const withNotes = `${readFileSync(join(workDir, 'CODEBASE_GUIDE.md'), 'utf8')}\n## Notes (manual)\nmy hand note\n`;
    writeFileSync(join(workDir, 'CODEBASE_GUIDE.md'), withNotes);
    stderrChunks = [];
    await slash('/guide refresh');
    expect(stderr()).toContain('preserved');
    expect(readFileSync(join(workDir, 'CODEBASE_GUIDE.md'), 'utf8')).toContain('my hand note');
  });

  test('/guide refresh failing reports the error', async () => {
    symlinkSync(join(workDir, 'no-such-dir', 'CODEBASE_GUIDE.md'), join(workDir, 'CODEBASE_GUIDE.md'));
    await slash('/guide refresh');
    expect(stderr()).toContain('/guide refresh failed');
  });

  test('/changelog: missing, no entries, one entry, several entries', async () => {
    await slash('/changelog');
    expect(stderr()).toContain('No CODEBASE_CHANGELOG.md');
    stderrChunks = [];
    writeFileSync(join(workDir, 'CODEBASE_CHANGELOG.md'), 'preamble only\n');
    await slash('/changelog');
    expect(stderr()).toContain('no entries yet');
    stderrChunks = [];
    writeFileSync(join(workDir, 'CODEBASE_CHANGELOG.md'), '## 2026-01-01\n- one\n');
    await slash('/changelog');
    expect(stderr()).toContain('1 entry');
    stderrChunks = [];
    writeFileSync(
      join(workDir, 'CODEBASE_CHANGELOG.md'),
      '## 2026-01-02\n- two\n\n## 2026-01-01\n- one\n',
    );
    await slash('/changelog');
    expect(stderr()).toContain('entries');
  });

  test('/init reports per-file errors when every write fails', async () => {
    for (const name of ['SPYCODE.md', 'CODEBASE_GUIDE.md', 'CODEBASE_CHANGELOG.md']) {
      symlinkSync(join(workDir, 'no-such-dir', name), join(workDir, name));
    }
    await slash('/init');
    const err = stderr();
    expect(err).toContain('/init (SPYCODE.md) failed');
    expect(err).toContain('/init (CODEBASE_GUIDE.md) failed');
    expect(err).toContain('/init (CODEBASE_CHANGELOG.md) failed');
  });

  test('/init creates the three files when absent', async () => {
    await slash('/init');
    for (const name of ['SPYCODE.md', 'CODEBASE_GUIDE.md', 'CODEBASE_CHANGELOG.md']) {
      expect(existsSync(join(workDir, name))).toBe(true);
    }
  });
});

describe('slash attach, save, mode, user commands', () => {
  test('/attach with no arg shows usage; a missing file errors; a real file attaches', async () => {
    await slash('/attach');
    expect(stderr()).toContain('Usage: /attach');
    stderrChunks = [];
    await slash('/attach nope.txt');
    expect(stderr()).toContain('/attach failed');
    stderrChunks = [];
    writeFileSync(join(workDir, 'note.txt'), 'hi\n');
    const r = await slash('/attach note.txt');
    expect(r.consumed).toBe(true);
    expect(r.attachment).toBeDefined();
    expect(stderr()).toContain('Attached');
  });

  test('/save with no arg shows usage', async () => {
    await slash('/save');
    expect(stderr()).toContain('Usage: /save');
  });

  test('/save writes a markdown transcript; a failed fetch errors', async () => {
    responder = (url, init) => {
      if (url.includes('/conversations/cnv_x') && init.method === 'GET') {
        return {
          statusCode: 200,
          headers: {},
          body: {
            json: async () => ({
              success: true,
              data: {
                id: 'cnv_x',
                messages: [{ role: 'user', content: 'hi' }],
              },
            }),
          },
        };
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    const r = await slash('/save out.md');
    expect(r.consumed).toBe(true);
    expect(existsSync(join(workDir, 'out.md'))).toBe(true);
    stderrChunks = [];
    responder = () => {
      throw new Error('network down');
    };
    await slash('/save out2.md');
    expect(stderr()).toContain('Save failed');
  });

  test('/mode reports, rejects unknown modes, and points headless equivalents', async () => {
    await slash('/mode');
    expect(stderr()).toContain('Headless equivalents');
    stderrChunks = [];
    await slash('/mode bogus');
    expect(stderr()).toContain('Unknown mode: bogus');
    stderrChunks = [];
    await slash('/mode agent');
    expect(stderr()).toContain('Headless equivalents');
  });

  test('a user command expands through the resolver; an error outcome reports', async () => {
    const r = await slash('/demo hello', {
      resolveUserCommand: (name: string) => {
        if (name !== 'demo') return null;
        return { kind: 'user-command', name, source: 'user', message: 'expanded prompt', notices: [] };
      },
    });
    expect(r).toMatchObject({ consumed: true, userPrompt: 'expanded prompt' });
    expect(stderr()).toContain('expanded (15 chars)');
    stderrChunks = [];
    await slash('/demo', {
      resolveUserCommand: (name: string) => {
        if (name !== 'demo') return null;
        return { kind: 'user-command-error', name, message: 'missing $ARG' };
      },
    });
    expect(stderr()).toContain('missing $ARG');
  });
});
