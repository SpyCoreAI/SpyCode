import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Readable } from 'node:stream';
import { freshConfigDir } from './helpers.js';

/**
 * Coverage for the graduated reasoning-"effort" feature in the CLI:
 *   1. the pure effort engine (lib/effort.ts) — supported-levels map + clamp;
 *   2. config validation of the `defaultEffort` key;
 *   3. `chat --effort` flag parsing + threading into the /api/chat/stream body
 *      (mock undici, inspect the body), including step-down clamping + notice;
 *   4. the in-session `/effort` slash command (legacy handler) set/clamp/list.
 */

// ── 1. Pure engine ──────────────────────────────────────────────────────────
describe('effort engine (lib/effort.ts)', () => {
  test('SUPPORTED_EFFORT_BY_MODEL mirrors the server set exactly', async () => {
    const { SUPPORTED_EFFORT_BY_MODEL } = await import('../src/lib/effort.js');
    expect(SUPPORTED_EFFORT_BY_MODEL.hermes).toEqual(['auto']);
    expect(SUPPORTED_EFFORT_BY_MODEL.styx).toEqual(['auto']);
    expect(SUPPORTED_EFFORT_BY_MODEL.styx_max).toEqual(['auto']);
    expect(SUPPORTED_EFFORT_BY_MODEL.hephaestus).toEqual(['auto']);
    expect(SUPPORTED_EFFORT_BY_MODEL.minos).toEqual(['auto', 'low', 'high']);
    expect(SUPPORTED_EFFORT_BY_MODEL.charon).toEqual([
      'auto',
      'low',
      'medium',
      'high',
      'max',
    ]);
  });

  test('descriptors mirror the SpyCore product copy verbatim (no numbers, no vendor terms)', async () => {
    const { EFFORT_DESCRIPTION } = await import('../src/lib/effort.js');
    expect(EFFORT_DESCRIPTION).toEqual({
      auto: 'balanced — adapts to the task',
      low: 'fastest, lightest reasoning',
      medium: 'moderate reasoning',
      high: 'deeper reasoning, a bit slower',
      max: 'deepest reasoning, slowest',
    });
    for (const desc of Object.values(EFFORT_DESCRIPTION)) {
      expect(desc).not.toMatch(/\d/); // never a credit/price number
    }
  });

  test('isEffortLevel + supportedEffortFor + modelSupportsGraduatedEffort', async () => {
    const {
      isEffortLevel,
      supportedEffortFor,
      modelSupportsGraduatedEffort,
    } = await import('../src/lib/effort.js');
    expect(isEffortLevel('high')).toBe(true);
    expect(isEffortLevel('ultra')).toBe(false);
    expect(isEffortLevel(3)).toBe(false);
    expect(supportedEffortFor('charon')).toContain('max');
    expect(modelSupportsGraduatedEffort('charon')).toBe(true);
    expect(modelSupportsGraduatedEffort('minos')).toBe(true);
    expect(modelSupportsGraduatedEffort('hermes')).toBe(false);
    expect(modelSupportsGraduatedEffort('styx')).toBe(false);
  });

  test('clampEffortForModel steps DOWN to the nearest supported level (never up)', async () => {
    const { clampEffortForModel } = await import('../src/lib/effort.js');

    // Exact-supported requests never clamp.
    expect(clampEffortForModel('charon', 'max')).toEqual({
      level: 'max',
      clamped: false,
      requested: 'max',
    });
    expect(clampEffortForModel('charon', 'medium')).toEqual({
      level: 'medium',
      clamped: false,
      requested: 'medium',
    });
    expect(clampEffortForModel('minos', 'high').level).toBe('high');
    expect(clampEffortForModel('minos', 'low').clamped).toBe(false);

    // auto is supported by every model → never clamps.
    for (const m of ['hermes', 'minos', 'styx', 'styx_max', 'charon', 'hephaestus'] as const) {
      expect(clampEffortForModel(m, 'auto')).toEqual({
        level: 'auto',
        clamped: false,
        requested: 'auto',
      });
    }

    // Minos has no 'medium'/'max' → step DOWN, never to a higher tier.
    expect(clampEffortForModel('minos', 'max')).toEqual({
      level: 'high',
      clamped: true,
      requested: 'max',
    });
    expect(clampEffortForModel('minos', 'medium')).toEqual({
      level: 'low',
      clamped: true,
      requested: 'medium',
    });

    // Auto-only models fall back to auto for any graduated request.
    expect(clampEffortForModel('hermes', 'high')).toEqual({
      level: 'auto',
      clamped: true,
      requested: 'high',
    });
    expect(clampEffortForModel('styx', 'low').level).toBe('auto');
    expect(clampEffortForModel('styx_max', 'max').level).toBe('auto');
  });
});

// ── 2. Config validation ────────────────────────────────────────────────────
describe('defaultEffort config key', () => {
  beforeEach(() => {
    freshConfigDir();
  });

  test('isKnownKey accepts defaultEffort; coerceValue validates the enum', async () => {
    const { isKnownKey, coerceValue } = await import('../src/lib/config.js');
    expect(isKnownKey('defaultEffort')).toBe(true);
    expect(coerceValue('defaultEffort', 'high')).toBe('high');
    expect(coerceValue('defaultEffort', 'AUTO')).toBe('auto'); // case-insensitive
    expect(() => coerceValue('defaultEffort', 'ultra')).toThrow();
  });

  test('defaults to auto', async () => {
    const { getConfigStore } = await import('../src/lib/config.js');
    expect(getConfigStore().get('defaultEffort')).toBe('auto');
  });
});

// ── 3 + 4. Flag threading + slash command (need the undici mock) ─────────────
type MockBody =
  | (AsyncIterable<Buffer> & { json?: () => Promise<unknown> })
  | { json: () => Promise<unknown> };

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: MockBody;
}

let responder:
  | ((
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string | Buffer },
    ) => MockResp)
  | null = null;

/** Captured JSON bodies of every POST /api/chat/stream request. */
let streamBodies: Array<Record<string, unknown>> = [];

vi.mock('undici', () => ({
  request: vi.fn(
    async (
      url: string,
      init: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
    ) => {
      if (!responder) throw new Error('test forgot to set responder');
      if (url.endsWith('/api/chat/stream') && typeof init.body === 'string') {
        try {
          streamBodies.push(JSON.parse(init.body) as Record<string, unknown>);
        } catch {
          /* ignore non-JSON bodies */
        }
      }
      return responder(url, {
        method: init.method ?? 'GET',
        headers: init.headers ?? {},
        body: init.body,
      });
    },
  ),
}));

let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(async () => {
  freshConfigDir();
  responder = null;
  streamBodies = [];
  stderrChunks = [];
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  vi.resetModules();
});

function jsonResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

function sseResp(chunks: string[]): MockResp {
  const buffers = chunks.map((c) => Buffer.from(c, 'utf8'));
  return {
    statusCode: 200,
    headers: {},
    body: Readable.from(buffers) as unknown as MockBody,
  };
}

function stderr(): string {
  return stderrChunks.join('');
}

async function runChat(argv: string[]): Promise<void> {
  const { Command } = await import('commander');
  const { registerChatCommand } = await import('../src/commands/chat.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: argv.includes('--json'), color: false });

  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  registerChatCommand(program);
  await program.parseAsync(['node', 'spycore', ...argv]);
}

/** Standard responder: create a conversation (echoing model) then stream a reply. */
function wireConversation(model: string): void {
  responder = (url, init) => {
    if (url.endsWith('/conversations') && init.method === 'POST') {
      return jsonResp(201, {
        success: true,
        data: { id: 'cnv_1', title: 'New', model },
      });
    }
    if (url.endsWith('/api/chat/stream')) {
      return sseResp([
        `data: {"type":"text","content":"ok"}\n\n`,
        `data: {"type":"done"}\n\n`,
      ]);
    }
    throw new Error(`unexpected ${init.method} ${url}`);
  };
}

describe('chat --effort flag', () => {
  test('absent flag defaults effort to auto in the stream body', async () => {
    wireConversation('HERMES');
    await runChat(['--no-color', 'chat', '--raw', 'hi']);
    expect(streamBodies).toHaveLength(1);
    expect(streamBodies[0]?.effort).toBe('auto');
    expect(streamBodies[0]?.model).toBe('HERMES');
  });

  test('a supported level is sent verbatim', async () => {
    wireConversation('CHARON');
    await runChat(['--no-color', 'chat', '--model', 'charon', '--effort', 'high', '--raw', 'hi']);
    expect(streamBodies[0]?.effort).toBe('high');
    expect(streamBodies[0]?.model).toBe('CHARON');
  });

  test('an unsupported level is step-DOWN clamped and a notice is printed', async () => {
    wireConversation('MINOS');
    await runChat(['--no-color', 'chat', '--model', 'minos', '--effort', 'max', '--raw', 'hi']);
    expect(streamBodies[0]?.effort).toBe('high'); // max → high for Minos
    expect(stderr()).toContain("isn't supported by Minos");
    expect(stderr()).toContain("using 'high'");
  });

  test('auto-only model clamps any graduated level to auto', async () => {
    wireConversation('HERMES');
    await runChat(['--no-color', 'chat', '--model', 'hermes', '--effort', 'high', '--raw', 'hi']);
    expect(streamBodies[0]?.effort).toBe('auto');
    expect(stderr()).toContain("isn't supported by Hermes");
  });

  test('an invalid level is rejected with a friendly error', async () => {
    let caught: unknown = null;
    try {
      await runChat(['chat', '--model', 'charon', '--effort', 'ultra', 'hi']);
    } catch (err) {
      caught = err;
    }
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toContain('Unknown effort');
    }
  });

  test('the configured defaultEffort is used when no flag is passed', async () => {
    const { getConfigStore } = await import('../src/lib/config.js');
    getConfigStore().set('defaultEffort', 'medium');
    wireConversation('CHARON');
    await runChat(['--no-color', 'chat', '--model', 'charon', '--raw', 'hi']);
    expect(streamBodies[0]?.effort).toBe('medium');
  });
});

describe('/effort slash command (in-session)', () => {
  const baseCtx = {
    json: false,
    color: false,
    currentConvo: 'cnv_x',
    apiUrl: undefined as string | undefined,
  };

  test('sets a supported level and returns it', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/effort high', { ...baseCtx, model: 'minos' });
    expect(r.consumed).toBe(true);
    expect(r.newEffort).toBe('high');
    expect(stderr()).toContain('Effort set to high');
  });

  test('clamps an unsupported level and notes it', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/effort max', { ...baseCtx, model: 'minos' });
    expect(r.newEffort).toBe('high');
    expect(stderr()).toContain("isn't supported by Minos");
  });

  test('rejects an unknown level without setting state', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/effort bogus', { ...baseCtx, model: 'charon' });
    expect(r.consumed).toBe(true);
    expect(r.newEffort).toBeUndefined();
    expect(stderr()).toContain('Unknown effort');
  });

  test('no arg lists the current model supported levels', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    const r = await handleSlashCommand('/effort', { ...baseCtx, model: 'charon' });
    expect(r.consumed).toBe(true);
    expect(r.newEffort).toBeUndefined();
    expect(stderr()).toContain('Effort levels for Charon');
    expect(stderr()).toContain('deepest reasoning, slowest'); // the max descriptor
  });

  test('/help lists the /effort command', async () => {
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    await handleSlashCommand('/help', baseCtx);
    expect(stderr()).toContain('/effort');
  });
});
