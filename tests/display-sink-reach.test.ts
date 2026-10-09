import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { freshConfigDir } from './helpers.js';

/**
 * F-2c-7 - THE DISPLAY-SINK REACH SUITE.
 *
 * SECURITY.md §2 and README:276 promise that ALL untrusted strings pass
 * through ONE sanitizer before reaching the terminal. F-2c-3 filed that as
 * measurably false at 4 sites . Counted across the package the class
 * is 57 sites in 22 files, of which these are the executable ones: each test
 * below drives the REAL code path with a hostile payload and asserts on what
 * actually reached the terminal, not on what the source looks like.
 *
 * WHY THE FIRST THREE PINS EXIST (§0). A suite like this can go green for
 * three reasons that are not "the sanitizer works":
 * 0a - the harness stopped observing (nothing was written at all);
 * 0b - the sanitizer was applied so widely it now scrubs the USER'S OWN
 * words, which is a defect in the other direction;
 * 0c - a SECOND sanitizer appeared beside the first, so "one mechanism" is
 * a comment rather than a property.
 * Each is pinned explicitly so a green run cannot mean any of them.
 *
 * Colour is OFF for every hostile test (`configureOutput({color:false})` sets
 * chalk.level = 0), so the CLI itself emits no escape bytes. That makes the
 * assertion exact: ANY surviving ESC or C1 in the captured output is the
 * attacker's, never ours. The benign block (§7) turns colour back ON and
 * proves the legitimate escapes still arrive.
 */

// ── the hostile corpus - every construct sanitize-display.ts names ──────────
const ESC = '\x1b';
const BEL = '\x07';
/** OSC 0 - retitle the terminal window. */
const OSC_TITLE = `${ESC}]0;PWNED${BEL}`;
/** OSC 52 - write the user's clipboard. */
const OSC52_CLIPBOARD = `${ESC}]52;c;aGFja2Vk${BEL}`;
/** OSC 8 - hyperlink escape: renders friendly text over a hostile target. */
const OSC8_HYPERLINK = `${ESC}]8;;http://attacker.example${BEL}click me${ESC}]8;;${BEL}`;
/** CSI cursor-up + erase-line - overwrite previously rendered lines. */
const CSI_CURSOR = `${ESC}[2A${ESC}[2K`;
/** CSI SGR - restyle (e.g. paint text the background colour to hide it). */
const CSI_RESTYLE = `${ESC}[31;1m`;
/** CSI ?2004h - bracketed-paste toggle. */
const CSI_BRACKETED_PASTE = `${ESC}[?2004h`;
/** DCS - device control string, body hidden from the user. */
const DCS = `${ESC}P+q544e${ESC}\\`;
/** APC - application program command, another hiding place. */
const APC = `${ESC}_hidden${ESC}\\`;
/** C1 CSI (U+009B) - the single-byte form some terminals honour. */
const C1_CSI = `${String.fromCharCode(0x9b)}31m`;
/** A lone CR - the classic overwrite-the-line trick. */
const CR_OVERWRITE = 'safe text\rEVIL';

/** One string carrying every vector above. */
const POISON = [
  OSC_TITLE,
  OSC52_CLIPBOARD,
  OSC8_HYPERLINK,
  CSI_CURSOR,
  CSI_RESTYLE,
  CSI_BRACKETED_PASTE,
  DCS,
  APC,
  C1_CSI,
  CR_OVERWRITE,
].join('');

/**
 * The assertion. With colour off the CLI emits no escapes of its own, so any
 * ESC (0x1b), any C1 control, or any lone CR in the captured bytes came from
 * the payload and means the sink is unsanitised.
 */
function expectNoTerminalControl(captured: string, what: string): void {
  expect(captured, `${what}: raw ESC survived`).not.toMatch(/\x1b/);
  // Written as a code-point scan rather than a literal range: a source file
  // carrying raw U+0080-U+009F bytes does not survive every editor/transport,
  // and a silently-mangled range would make this assertion vacuous.
  const hasC1 = Array.from(captured).some((ch) => {
    const c = ch.charCodeAt(0);
    return c >= 0x80 && c <= 0x9f;
  });
  expect(hasC1, `${what}: C1 control survived`).toBe(false);
  expect(captured, `${what}: lone CR survived`).not.toMatch(/\r/);
}

/** The payload did reach this sink - otherwise "no control bytes" is vacuous. */
function expectPayloadReached(captured: string, marker: string, what: string): void {
  expect(captured, `${what}: payload never reached the sink - vacuous pass`).toContain(marker);
}

// ── undici mock, shared by every command driven below ───────────────────────
interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
}
let responder: ((url: string, init: { method: string }) => MockResp) | null = null;

vi.mock('undici', () => ({
  request: vi.fn(async (url: string, init: { method?: string } = {}) => {
    if (!responder) throw new Error('test forgot to set responder');
    return responder(url, { method: init.method ?? 'GET' });
  }),
}));

/**
 * The API client unwraps { success, data } and throws otherwise - a bare
 * object comes back as "HTTP 200", which is a harness failure and NOT a
 * measurement. Every payload below therefore goes inside the envelope.
 */
function jsonResp(status: number, body: unknown): MockResp {
  return {
    statusCode: status,
    headers: {},
    body: { json: async () => ({ success: status < 300, data: body }) },
  };
}

/** Registry responses are raw JSON, not the SpyCore envelope. */
function rawResp(status: number, body: unknown): MockResp {
  return { statusCode: status, headers: {}, body: { json: async () => body } };
}

/**
 * Commands read global options off cmd.parent - a bare sub-program leaves
 * them undefined and the command fails for the wrong reason.
 */
async function runProgram(
  register: (p: import('commander').Command) => void,
  argv: string[],
): Promise<void> {
  const { Command } = await import('commander');
  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  register(program);
  await program.parseAsync(['node', 'spycore', ...argv]);
}

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

/**
 * The update check SKIPS ITSELF when `CI=true` or SPYCORE_NO_UPDATE_CHECK=1
 * (version-check.ts shouldSkip). Locally those are unset, so S9 measured the
 * real path; in CI it returned null and the probe rendered "Could not reach the
 * npm registry" - a pass for the ENVIRONMENT's reason, not the sanitizer's.
 * Caught by expectPayloadReached, which is the whole reason that guard exists:
 * without it S9 would have been GREEN in CI having measured nothing.
 */
const savedEnv: Record<string, string | undefined> = {};
beforeEach(async () => {
  savedEnv.CI = process.env.CI;
  savedEnv.SPYCORE_NO_UPDATE_CHECK = process.env.SPYCORE_NO_UPDATE_CHECK;
  delete process.env.CI;
  delete process.env.SPYCORE_NO_UPDATE_CHECK;
  freshConfigDir();
  responder = null;
  stdoutChunks = [];
  stderrChunks = [];
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const { setStoredTokenInFile } = await import('../src/lib/config.js');
  setStoredTokenInFile('spycli_test_token');
});

afterEach(() => {
  if (savedEnv.CI === undefined) delete process.env.CI;
  else process.env.CI = savedEnv.CI;
  if (savedEnv.SPYCORE_NO_UPDATE_CHECK === undefined) delete process.env.SPYCORE_NO_UPDATE_CHECK;
  else process.env.SPYCORE_NO_UPDATE_CHECK = savedEnv.SPYCORE_NO_UPDATE_CHECK;
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  vi.resetModules();
  vi.restoreAllMocks();
});

function out(): string {
  return stdoutChunks.join('') + stderrChunks.join('');
}

// ═══════════════════════════════════════════════════════════════════════════
// §0 - THE PROPERTY BOUNDARY. Green for the right reason, in both directions.
// ═══════════════════════════════════════════════════════════════════════════
describe('§0 property boundary - this suite is not green for the wrong reason', () => {
  test('0a CONTROL: the harness can observe a leak (an unsanitised write DOES trip the assertion)', () => {
    // Writing the payload raw must be VISIBLE to expectNoTerminalControl.
    // Without this, every "no control bytes" result below could equally mean
    // the harness captured nothing.
    process.stderr.write(POISON);
    const captured = out();
    expect(captured).toContain(POISON);
    let tripped = false;
    try {
      expectNoTerminalControl(captured, 'control probe');
    } catch {
      tripped = true;
    }
    expect(tripped, 'the assertion cannot detect a raw payload - the suite is blind').toBe(true);
  });

  test("0b USER-TRUSTED: the user's own live keystrokes are NOT scrubbed", async () => {
    // The register distinguishes UNTRUSTED from USER-TRUSTED. ChatInput renders
    // the user's live keystrokes; sanitising them would mangle the user's own
    // words - a defect in the OPPOSITE direction from the one this batch closes.
    //
    // This pin is lexical, and it is made non-vacuous by the second half:
    // it first proves the sanitiser WOULD alter such text, so "the input path
    // does not call it" is a statement about a real behavioural difference
    // rather than a no-op that could never fail.
    const { readFileSync } = await import('node:fs');
    const { sanitizeForDisplay } = await import('../src/lib/sanitize-display.js');

    const typedByTheUser = 'draft one\rdraft two';
    expect(
      sanitizeForDisplay(typedByTheUser),
      'the sanitiser does not alter this text, so the pin below proves nothing',
    ).not.toBe(typedByTheUser);

    const inputSrc = readFileSync(
      fileURLToPath(new URL('../src/ui/chat/ChatInput.tsx', import.meta.url)),
      'utf8',
    );
    expect(inputSrc.length, 'read no source - vacuous').toBeGreaterThan(200);
    expect(
      inputSrc.includes('sanitizeForDisplay'),
      "the live input line sanitises the user's own typing - USER-TRUSTED text must not be scrubbed",
    ).toBe(false);
  });

  test('0c ONE MECHANISM: sanitize-display.ts is the only display sanitizer in src/', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const SRC = fileURLToPath(new URL('../src', import.meta.url));
    const files: string[] = [];
    (function walk(d: string): void {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e)) files.push(p);
      }
    })(SRC);
    expect(files.length, 'the census read no files - vacuous').toBeGreaterThan(100);
    // Any OTHER module defining an escape-stripping regex over \x1b is a
    // second mechanism. sanitize-display.ts is the only permitted definer.
    const definers = files.filter((f) => {
      if (f.endsWith('sanitize-display.ts')) return false;
      const t = readFileSync(f, 'utf8');
      return /\\x1b(?:\[|\])[^)]*\/[gimsuy]*\s*(?:;|,|\))/.test(t) && /replace\(/.test(t);
    });
    expect(definers, `second sanitizer(s) found: ${definers.join(', ')}`).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §1 - THE GLOBAL ERROR SINK. Inherited by every `fail()` caller.
// ═══════════════════════════════════════════════════════════════════════════
describe('§1 the global error sink (output.ts fail)', () => {
  test('S1 a server/MCP/provider-authored error message cannot drive the terminal', async () => {
    const { configureOutput, fail } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    try {
      fail(new Error(`upstream said: ${POISON}`));
    } catch {
      /* fail() never returns; the spy makes it fall through */
    }
    exit.mockRestore();
    const captured = out();
    expectPayloadReached(captured, 'upstream said:', 'S1 global error sink');
    expectNoTerminalControl(captured, 'S1 global error sink');
  });

  test('S2 the hint arm of the same sink is covered too', async () => {
    const { configureOutput, fail } = await import('../src/lib/output.js');
    const { SpycoreCliError } = await import('../src/lib/errors.js');
    configureOutput({ json: false, color: false });
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    try {
      fail(new SpycoreCliError('boom', 1, `hint marker ${POISON}`));
    } catch {
      /* as above */
    }
    exit.mockRestore();
    const captured = out();
    expectPayloadReached(captured, 'hint marker', 'S2 error hint');
    expectNoTerminalControl(captured, 'S2 error hint');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §2 - SERVER-RETURNED RECORD FIELDS, driven through the real commands.
// ═══════════════════════════════════════════════════════════════════════════
describe('§2 server-returned record fields', () => {
  test('S3 whoami prints five server fields - none may carry terminal control', async () => {
    responder = () =>
      jsonResp(200, {
        email: `user${POISON}@example.com`,
        name: `Name${POISON}`,
        planDisplay: `Pro${POISON}`,
        id: `id${POISON}`,
        tokenId: `tok${POISON}`,
        plan: 'pro',
      });
    const { registerWhoamiCommand } = await import('../src/commands/auth/whoami.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    await runProgram(registerWhoamiCommand, ['whoami']);
    const captured = out();
    expectPayloadReached(captured, 'Logged in as', 'S3 whoami');
    expectNoTerminalControl(captured, 'S3 whoami');
  });

  const poisonedMemory = {
    id: 'mem_1',
    category: `context${POISON}`,
    content: `remembered${POISON}`,
    source: `src${POISON}`,
    createdAt: new Date().toISOString(),
  };

  test('S4 memory show prints id/category/source/content straight from the server', async () => {
    responder = () => jsonResp(200, { memories: [poisonedMemory] });
    const { registerMemoryCommand } = await import('../src/commands/memory/index.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    await runProgram(registerMemoryCommand, ['memory', 'show', 'mem_1']);
    const captured = out();
    expectPayloadReached(captured, 'remembered', 'S4 memory show');
    expectNoTerminalControl(captured, 'S4 memory show');
  });

  test('S5 memory list renders a table row built from the same fields', async () => {
    responder = () => jsonResp(200, { memories: [poisonedMemory] });
    const { registerMemoryCommand } = await import('../src/commands/memory/index.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    await runProgram(registerMemoryCommand, ['memory', 'list']);
    const captured = out();
    expectPayloadReached(captured, 'mem_1', 'S5 memory list');
    expectNoTerminalControl(captured, 'S5 memory list');
  });

  test('S6 conversations list renders title and model from the server', async () => {
    responder = () =>
      jsonResp(200, {
        conversations: [
          {
            id: 'conv_1',
            title: `Title${POISON}`,
            model: `styx${POISON}`,
            updatedAt: new Date().toISOString(),
            createdAt: new Date().toISOString(),
          },
        ],
        page: 1,
        total: 1,
      });
    const { registerConversationsCommand } = await import(
      '../src/commands/conversations/index.js'
    );
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    await runProgram(registerConversationsCommand, ['conversations', 'list']);
    const captured = out();
    expectPayloadReached(captured, 'conv_1', 'S6 conversations list');
    expectNoTerminalControl(captured, 'S6 conversations list');
  });

  test('S7 files list renders the server-supplied filename', async () => {
    responder = () =>
      jsonResp(200, {
        files: [
          {
            id: 'file_1',
            filename: `report${POISON}.pdf`,
            mimeType: 'application/pdf',
            size: 10,
            createdAt: new Date().toISOString(),
          },
        ],
        page: 1,
        total: 1,
      });
    const { registerFilesCommand } = await import('../src/commands/files/index.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    await runProgram(registerFilesCommand, ['files', 'list']);
    const captured = out();
    expectPayloadReached(captured, 'file_1', 'S7 files list');
    expectNoTerminalControl(captured, 'S7 files list');
  });

  test('S8 usage renders per-model rows keyed on server-supplied names', async () => {
    responder = () =>
      jsonResp(200, { perModel: { [`styx${POISON}`]: { fiveHour: 1, weekly: 2 } } });
    const { registerUsageCommand } = await import('../src/commands/usage.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    await runProgram(registerUsageCommand, ['usage']);
    const captured = out();
    /**
     * F-15 - S8 WAS THE ONE MEMBER OF ITS OWN FILE WITHOUT THIS GUARD, AND
     * IT WAS PROVED VACUOUS BY DRIVING IT, NOT BY READING IT.
     *
     * Planting `if (false && keys.length > 0 …)` in `commands/usage.ts` - so the
     * poisoned per-model NAME is never rendered at all - left S8 **GREEN**. The
     * identical class of plant on a guarded sibling (`print(row)` short-circuited
     * for `S5 memory list`) turned that one **RED**. Same plant, one blind, one
     * catching: "no control bytes survived" says nothing when nothing arrived.
     *
     * This file's own §12 header already states the rule - "a mock that
     * swallowed the write would make every assertion below vacuous, which is what
     * expectPayloadReached is here to prevent". S8 was the site that did not
     * follow it. 15 of 16 call sites were guarded; this is the 16th.
     *
     * `styx` is the marker because `displayName()` routes a non-slug key through
     * `sanitizeForDisplay`, which strips the control bytes and keeps the printable
     * prefix - so the marker is present exactly when the row was rendered.
     */
    expectPayloadReached(captured, 'styx', 'S8 usage');
    expectNoTerminalControl(captured, 'S8 usage');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §12 - THE THREE SINK CATEGORIES A COMMAND-KEYED CENSUS COULD NOT SEE.
//
// S7 above pins `files list`. F-2c-7's census keyed on COMMANDS, so the
// three sibling modules in the SAME directory were never swept and nine live
// holes shipped in 0.6.0 . These pins are deliberately keyed on the
// SINK CATEGORY - readline prompt, ora spinner, success line - rather than on
// the command, because the category is what the previous key could not see.
//
// WHY THE MOCKS ARE FAITHFUL RATHER THAN CONVENIENT. `node:readline` writes
// its prompt to the interface's `output` stream, and `ora` writes its `text` to
// its `stream`. Both mocks do exactly that and nothing else, so what these
// tests capture is the bytes those libraries would put on the terminal. A mock
// that swallowed the write would make every assertion below vacuous, which is
// what expectPayloadReached is here to prevent.
// ═══════════════════════════════════════════════════════════════════════════
describe('§12 the sink CATEGORIES - prompt, spinner, completion line', () => {
  /** node:readline writes `prompt` to `output`, then yields the answer. */
  function mockReadline(answer = 'n'): void {
    vi.doMock('node:readline', () => ({
      createInterface: (opts: { output?: NodeJS.WritableStream }) => {
        const iface = {
          on: () => iface,
          close: () => undefined,
          question: (prompt: string, cb: (a: string) => void) => {
            (opts.output ?? process.stderr).write(prompt);
            cb(answer);
          },
        };
        return iface;
      },
    }));
  }

  /** ora writes `text` to `stream` on start / text= / succeed. */
  function mockOra(): void {
    vi.doMock('ora', () => {
      const make = (arg: unknown) => {
        const o = (typeof arg === 'object' && arg !== null ? arg : {}) as {
          text?: string;
          stream?: NodeJS.WritableStream;
        };
        const stream = o.stream ?? process.stderr;
        let text = typeof arg === 'string' ? arg : (o.text ?? '');
        const sp = {
          get text(): string {
            return text;
          },
          set text(v: string) {
            text = v;
            stream.write(v);
          },
          start: () => {
            stream.write(text);
            return sp;
          },
          succeed: (t?: string) => {
            stream.write(t ?? text);
            return sp;
          },
          fail: (t?: string) => {
            stream.write(t ?? text);
            return sp;
          },
          warn: () => sp,
          info: () => sp,
          stop: () => sp,
        };
        return sp;
      };
      return { default: make };
    });
  }

  const savedStdinTTY = process.stdin.isTTY;
  const savedStdoutTTY = process.stdout.isTTY;
  afterEach(() => {
    process.stdin.isTTY = savedStdinTTY;
    process.stdout.isTTY = savedStdoutTTY;
  });

  test('S12 `files delete` - the APPROVAL PROMPT cannot be driven by the server filename', async () => {
    // This is the site that sat one line above an already-sanitized twin.
    // SECURITY.md §2 names "restyled or overwritten approval prompts" as the
    // threat, and the approval gate is described as the primary control.
    responder = () => jsonResp(200, { id: 'file_1', filename: `report${POISON}.pdf` });
    process.stdin.isTTY = true;
    mockReadline('n');
    const { registerFilesCommand } = await import('../src/commands/files/index.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    await runProgram(registerFilesCommand, ['files', 'delete', 'file_1']);
    const captured = out();
    expectPayloadReached(captured, 'Delete file', 'S12 files delete prompt');
    expectPayloadReached(captured, 'report', 'S12 files delete prompt');
    expectNoTerminalControl(captured, 'S12 files delete prompt');
  });

  test('S13 `files download` - the ora SPINNER text cannot be driven by the server filename', async () => {
    responder = (url: string) =>
      url.includes('/api/files/')
        ? jsonResp(200, {
            id: 'file_1',
            filename: `report${POISON}.bin`,
            mimeType: 'application/octet-stream',
            size: 4,
            url: 'https://cdn.example/x',
            createdAt: new Date().toISOString(),
          })
        : { statusCode: 500, headers: {}, body: { json: async () => ({}) } };
    process.stdout.isTTY = true;
    mockOra();
    const { registerFilesCommand } = await import('../src/commands/files/index.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    // The download itself fails (the mocked transport returns 500 for the CDN
    // URL) - deliberately. The spinner text is written by .start() BEFORE any
    // byte moves, which is the site under test.
    await runProgram(registerFilesCommand, ['files', 'download', 'file_1']).catch(() => undefined);
    const captured = out();
    expectPayloadReached(captured, 'Downloading', 'S13 files download spinner');
    expectNoTerminalControl(captured, 'S13 files download spinner');
  });

  test('S14 `files upload` - the completion line renders the server-returned filename and id', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'sink-upload-'));
    const local = join(dir, 'benign.txt');
    writeFileSync(local, 'hello');

    responder = () => jsonResp(200, { id: 'user_1', plan: 'PRO' });
    // `uploadFile` is the wire origin for the completion line: its result is
    // the server's own response body, not anything the user typed.
    vi.doMock('../src/lib/upload.js', () => ({
      uploadFile: async () => ({
        id: `file${POISON}`,
        filename: `stored${POISON}.txt`,
        size: 5,
        mime: 'text/plain',
        url: null,
        expiresAt: null,
      }),
    }));
    process.stdout.isTTY = false; // force the non-spinner success() arm
    const { registerFilesCommand } = await import('../src/commands/files/index.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    await runProgram(registerFilesCommand, ['files', 'upload', local]);
    const captured = out();
    expectPayloadReached(captured, 'Uploaded', 'S14 files upload');
    expectPayloadReached(captured, 'stored', 'S14 files upload');
    expectNoTerminalControl(captured, 'S14 files upload');
  });

  test('B15 BENIGN: an ordinary filename survives the prompt BYTE-IDENTICALLY', async () => {
    // The direction that decides whether the control is usable. A sanitizer
    // that mangles ordinary names gets switched off by whoever hits it first,
    // and F-2c-7 measured over-blocking as a real failure mode (M12: 94 RED).
    responder = () => jsonResp(200, { id: 'file_1', filename: 'Q3 report (final) - v2.pdf' });
    process.stdin.isTTY = true;
    mockReadline('n');
    const { registerFilesCommand } = await import('../src/commands/files/index.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    await runProgram(registerFilesCommand, ['files', 'delete', 'file_1']);
    const captured = out();
    expect(
      captured,
      'an ordinary filename was altered on its way to the approval prompt',
    ).toContain('Delete file file_1 (Q3 report (final) - v2.pdf)? (y/N):');
  });

  /**
   * P1 - THE PROPERTY GATE. This is the pin that closes the CLASS rather
   * than the nine instances.
   *
   * S12–S14 above prove three sink categories are closed BY EXECUTION. They
   * cannot prove the fourth sibling added next month is closed. A pin that
   * enumerated today's sites would have exactly the blind spot that produced
   * this batch - F-2c-7 pinned `files list` as S7 and three sibling modules in
   * the same directory went unswept for a whole release.
   *
   * So this asserts the PROPERTY at current state: no value that arrived over
   * the wire reaches a rendering surface without crossing the sanitizer. A new
   * command, a new sink alias, a new server field - all are covered without
   * anyone remembering to add a pin.
   *
   * WHAT IT CANNOT SEE is stated in tests/wire-sink-census.ts's header and
   * each limit is PROVEN by a plant, not asserted. The load-bearing one: taint
   * stops at any call the census does not classify, so wrapping an untrusted
   * value in an unrecognised helper hides it. A zero here means "zero under
   * that", never "zero".
   */
  /**
   * F-14 - AN EXPLICIT DEADLINE. THE WORST CAP BREACH MEASURED ANYWHERE IN
   * THIS SUITE HAPPENED HERE.
   *
   * Measured from the `CLI Build` job logs across four shas: 2 023-4 281 ms on
   * the four supported legs, 4 936 ms on windows/Node 22 - and **13 532 ms on
   * windows/Node 20 at `d8ce83f8`, 135 % of the 10 000 ms global cap**, where it
   * timed out and failed. Same class as `portable-paths.test.ts` W1 and
   * `portable-line-endings.test.ts` L1; which of the three goes red on a given
   * run is decided by contention, not by any change to the test.
   *
   * 60 000 ms is derived: worst same-leg run-to-run swing in this suite is
   * 7.39x, and 7.39 x 4 936 = 36 477 ms. What it stops catching is a slowdown of
   * under ~12x in the census itself.
   *
   * THIS IS A DEADLINE, NOT A CONTROL - not one assertion below changes.
   */
  test('P1 THE PROPERTY: no wire-origin value reaches a rendering surface unsanitized', { timeout: 60_000 }, async () => {
    const { censusWireSinks, KNOWN_DEFECT_PROBE, KNOWN_DEFECT_PROBE_PATH } = await import(
      './wire-sink-census.js'
    );

    // THE INSTRUMENT IS PROVED BEFORE ITS ZERO IS BELIEVED. F-2c-8's fourth
    // pin-sweep instrument reported a 0.00 % residual and was blind to the one
    // defect known to be real; the finding was right and the instrument was
    // wrong. A census that cannot re-find a known-real instance makes every
    // zero it reports a non-result.
    const probed = censusWireSinks({
      extraFiles: { [KNOWN_DEFECT_PROBE_PATH]: KNOWN_DEFECT_PROBE },
    });
    expect(
      probed.findings.filter((f) => f.file === KNOWN_DEFECT_PROBE_PATH).length,
      'the census cannot see a known-real defect - its zero is worthless',
    ).toBe(1);

    const real = censusWireSinks();
    expect(real.filesScanned, 'the census scanned almost nothing - vacuous').toBeGreaterThan(150);
    expect(
      real.aliases.size,
      'sink-alias discovery found nothing - the census has degraded to the name-keyed ' +
        'shape that missed six sites in F-2c-7 and nine in 0.6.0',
    ).toBeGreaterThanOrEqual(10);

    expect(
      real.findings.map((f) => `${f.file}:${f.line} [${f.sink}] ${f.snippet}`),
      'a wire-origin value reaches a rendering surface without the sanitizer',
    ).toEqual([]);
  });

  test('B16 the `display` contract, measured in BOTH positions - and its ONE cost', async () => {
    // THE CONTRACT, PINNED RATHER THAN DESCRIBED. Literal chunks are
    // CLI-authored and pass through VERBATIM; every interpolation is sanitized.
    //
    // AND THE COST IS REAL, so it is pinned rather than glossed: an
    // interpolation is sanitized EVEN WHEN THE CLI AUTHORED IT. `display`
    // cannot tell `${chalk.bold('[a]')}` from `${file.filename}` - both are
    // just values - so a call site that interpolates chalk would be flattened
    // by it. That is why the conversion was applied to the nine counted sites
    // and to nothing else. The first draft of this very pin asserted the
    // opposite and was corrected by measurement.
    const chalk = (await import('chalk')).default;
    const { display, sanitizeForDisplay } = await import('../src/lib/sanitize-display.js');
    const prev = chalk.level;
    chalk.level = 1;
    const bold = chalk.bold('[a]');
    chalk.level = prev;
    expect(bold, 'chalk emitted no escape - this pin proves nothing').toMatch(/\x1b/);
    expect(sanitizeForDisplay(bold), 'the sanitizer does not strip colour - vacuous').not.toMatch(
      /\x1b/,
    );

    // LITERAL position - verbatim, escapes and all.
    const litter = display`\x1b[1mCLI-authored\x1b[22m ${'plain'}`;
    expect(litter, 'a CLI-authored LITERAL chunk was altered').toContain('\x1b[1mCLI-authored');

    // INTERPOLATED position - sanitized, hostile or not.
    const line = display`menu ${bold} ${`evil${POISON}`}`;
    expect(line, 'an interpolated hostile value was not sanitized').not.toMatch(/\x1b/);
    expect(line, 'the interpolated text itself was dropped').toContain('evil');
    expect(line, 'the CLI-authored interpolation kept its escape - the cost is not what is claimed')
      .toContain('[a]');

    // THE STRUCTURAL CONSEQUENCE, PINNED - AND ITS REASON HAS CHANGED, so
    // the reason is rewritten rather than left to rot.
    //
    // WHEN F-2c-9 WROTE THIS the argument was: `skills/create.ts` must not be
    // `display`-tagged, because that would flatten its emphasis and no ruling
    // sanctioned a user-visible change. F-2c-10's ruling 1 sanctions exactly
    // that flattening, and the PROMPT BOUNDARY (`lib/prompt.ts`) now applies it
    // to every prompt regardless of tagging - so the emphasis IS flat today and
    // B17 below measures it.
    //
    // The ASSERTION still stands and is kept, for a different reason: tagging
    // this line would move its sanitization from the sink to the composition
    // boundary and quietly make B17's cost measurement read zero styled sites
    // while the user still sees flat text. The cost must stay VISIBLE at the
    // site that pays it.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(fileURLToPath(new URL('../src/commands/skills/create.ts', import.meta.url)), 'utf8')
      .replace(/\r\n/g, '\n');
    expect(src.length, 'read no source - vacuous').toBeGreaterThan(500);
    const promptLine = src
      .split('\n')
      .find((l) => l.includes('readSingleLineInput(') && l.includes('chalk.bold'));
    expect(promptLine, 'the chalk-interpolating prompt moved - re-measure the cost').toBeDefined();
    expect(
      (promptLine ?? '').includes('display`'),
      'the chalk-interpolating prompt was display-tagged - the cost moved off the site that pays it',
    ).toBe(false);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // F-2c-10 §F2 - THE COST OF EACH SINK-SIDE BOUNDARY, PINNED AT WHAT WAS
  // MEASURED SO IT CANNOT SPREAD.
  //
  // Ruling 1 accepted a specific, measured price: three bold markers in one
  // prompt flow, and nothing else. An accepted cost that can silently grow is
  // not an accepted cost - it is an open tab. These two pins are the tab's
  // credit limit.
  // ═════════════════════════════════════════════════════════════════════════

  test('B17 THE PROMPT BOUNDARY COSTS EXACTLY ONE SITE, and that site is named', async () => {
    const { censusPromptSites } = await import('./wire-sink-census.js');
    const census = censusPromptSites();

    // Reached-assertions: a census that walked nothing, or found no prompts,
    // would report "0 styled" for the wrong reason.
    expect(census.filesScanned, 'scanned almost no files - vacuous').toBeGreaterThan(150);
    expect(census.sites.length, 'found no prompt sites at all - this pin measures nothing')
      .toBeGreaterThan(15);

    // PROVE THE INSTRUMENT BEFORE BELIEVING ITS COUNT (digest 27 / #108).
    // A styling detector that never fires would report "1 styled" only because
    // it happens to be looking at the one known site.
    const planted = censusPromptSites({
      extraFiles: {
        'src/commands/__cost_probe.ts':
          "import chalk from 'chalk';\n" +
          "import { readSingleLineInput } from '../lib/prompt.js';\n" +
          'export const p = () => readSingleLineInput(`${chalk.bold("[x]")} go `);\n',
      },
    });
    expect(
      planted.styled.map((s) => s.file),
      'the styling detector cannot see a freshly planted chalked prompt - it is blind',
    ).toContain('src/commands/__cost_probe.ts');

    // THE COST ITSELF.
    expect(
      census.styled.map((s) => `${s.file}:${s.line}`),
      'the prompt boundary now flattens a DIFFERENT number of sites than ruling 1 priced.\n' +
        'Adding a chalked prompt means a user loses styling somewhere nobody measured.',
    ).toEqual(['src/commands/skills/create.ts:221']);
  });

  test('B18 THE SPINNER BOUNDARY IS FREE - zero of its text sites carry styling', async () => {
    const { censusSpinnerSites } = await import('./wire-sink-census.js');
    const census = censusSpinnerSites();

    expect(census.filesScanned, 'scanned almost no files - vacuous').toBeGreaterThan(150);
    // Reached-assertion: the whole claim is "0 of N", and N must be real.
    expect(census.sites.length, 'found no text-bearing spinner sites - "0 styled" is vacuous')
      .toBeGreaterThan(15);

    // Same instrument proof, on the spinner half.
    const planted = censusSpinnerSites({
      extraFiles: {
        'src/commands/__spin_probe.ts':
          "import chalk from 'chalk';\n" +
          "import { createSpinner } from '../lib/spinner.js';\n" +
          'export const s = createSpinner({ text: `${chalk.cyan("go")}`, stream: process.stderr });\n',
      },
    });
    expect(
      planted.styled.map((s) => s.file),
      'the styling detector cannot see a freshly planted chalked spinner label - it is blind',
    ).toContain('src/commands/__spin_probe.ts');

    expect(
      census.styled.map((s) => `${s.file}:${s.line} ${s.styling.join('|')}`),
      'a spinner label now composes CLI-authored styling, which this boundary flattens.\n' +
        'Ruling 1 priced the spinner boundary at ZERO. Compose the styling outside the label.',
    ).toEqual([]);
  });

  // ═════════════════════════════════════════════════════════════════════════
  // F-2c-10 §F3 - DEFENCE IN DEPTH, PROVED LAYER BY LAYER.
  //
  // A DEFENCE-IN-DEPTH CLAIM WITH ONLY AN END-TO-END PIN IS ONE LAYER
  // WEARING THREE NAMES. `files download` crosses all three layers, so a pin
  // driving it stays green when any two are removed and proves nothing about
  // depth. Each pin below drives ONE layer with a value that does not cross
  // the other two, so the mutation table can show each layer reddening alone.
  // ═════════════════════════════════════════════════════════════════════════

  test('D1 LAYER 1 - the COMPOSITION boundary blocks on its own', async () => {
    const { display } = await import('../src/lib/sanitize-display.js');
    // No prompt, no spinner anywhere on this path - only `display`.
    const line = display`file ${`report${POISON}.pdf`} ready`;
    expectPayloadReached(line, 'report', 'D1 display');
    expectNoTerminalControl(line, 'D1 display');
  });

  test('D2 LAYER 2 - the PROMPT boundary blocks a value that never met `display`', async () => {
    // The hostile string is handed to the prompt helper RAW. If the prompt
    // boundary were removed, layer 1 could not save this - nothing on this path
    // is `display`-composed. That is what makes it a depth measurement.
    const captured: string[] = [];
    vi.doMock('node:readline', () => ({
      createInterface: () => {
        const iface = {
          on: () => iface,
          close: () => undefined,
          question: (prompt: string, cb: (a: string) => void) => {
            // Faithful: node:readline writes the prompt to `output` verbatim.
            captured.push(prompt);
            cb('n');
          },
        };
        return iface;
      },
    }));
    vi.resetModules();
    const { readSingleLineInput } = await import('../src/lib/prompt.js');
    const answer = await readSingleLineInput(`Delete report${POISON}.pdf? (y/N): `);
    const out = captured.join('');
    expectPayloadReached(out, 'Delete report', 'D2 prompt');
    expectNoTerminalControl(out, 'D2 prompt');
    // …and the USER'S answer is returned untouched (pin 0b, at this boundary).
    expect(answer, "the user's own answer was altered").toBe('n');
    vi.doUnmock('node:readline');
    vi.resetModules();
  });

  test('D3 LAYER 3 - the SPINNER boundary blocks a value that never met `display`', async () => {
    // Same shape on the spinner half: raw hostile text, no `display` in sight.
    // A real (unmocked) ora writing to a captured stream, so what is asserted
    // is the bytes ora would put on the terminal.
    const { Writable } = await import('node:stream');
    const chunks: string[] = [];
    class Capture extends Writable {
      isTTY = true;
      columns = 120;
      cursorTo(): boolean { return true; }
      clearLine(): boolean { return true; }
      moveCursor(): boolean { return true; }
      override _write(c: unknown, _e: unknown, cb: () => void): void {
        chunks.push(String(c));
        cb();
      }
    }
    const cap = new Capture();
    // REAL ora - §12's `mockOra()` registration is still live at this point
    // and `resetModules()` does not clear it. The boundary sanitizes before ora
    // sees anything, so this pin would pass against the mock too; it uses the
    // real library anyway, because a pin that CAN be satisfied by a stub is one
    // refactor away from being satisfied only by the stub.
    vi.doUnmock('ora');
    vi.resetModules();
    const { createSpinner } = await import('../src/lib/spinner.js');
    const spinner = createSpinner({
      text: `Downloading report${POISON}.pdf`,
      stream: cap as unknown as NodeJS.WritableStream,
      isEnabled: true,
    });
    spinner.start();
    spinner.text = `Saving report${POISON}.pdf`;
    spinner.succeed(`Saved report${POISON}.pdf`);
    spinner.stop();

    const out = chunks.join('');
    expectPayloadReached(out, 'report', 'D3 spinner');
    // ora authors its OWN escapes (cursor hide/show, line rewrite). Assert on
    // the TEXT ora holds and on the payload's vectors, not on "no ESC at all",
    // which would fail for ora's legitimate control bytes and would in fact be
    // the T2 defect (a sanitized stream) rather than a pass.
    expect(spinner.text, 'the spinner label kept an ESC from the payload').not.toMatch(/\x1b/);
    expect(out, 'the payload OSC reached the spinner stream').not.toContain('PWNED');
    expect(out, 'the payload clipboard OSC reached the spinner stream').not.toContain('aGFja2Vk');
    expect(out, 'the payload lone-CR reached the spinner stream').not.toContain('safe text\rEVIL');
    vi.resetModules();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §3 - THE npm REGISTRY. SECURITY.md names this string explicitly.
// ═══════════════════════════════════════════════════════════════════════════
describe('§3 the registry-controlled version string', () => {
  test('S9 `spycore update` prints body.version straight from the registry', async () => {
    const { __resetUpdateCache } = await import('../src/lib/version-check.js');
    __resetUpdateCache();
    responder = () => rawResp(200, { version: `9.9.9${POISON}` });
    const { registerUpdateCommand } = await import('../src/commands/update.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    await runProgram((prog) => registerUpdateCommand(prog, '0.6.0'), ['update']);
    const captured = out();
    expectPayloadReached(captured, '9.9.9', 'S9 update');
    expectNoTerminalControl(captured, 'S9 update');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §7 - THE BENIGN CORPUS. A sanitiser that breaks the interface gets disabled.
// ═══════════════════════════════════════════════════════════════════════════
describe('§7 benign corpus - the direction that decides whether the control is usable', () => {
  test('B1 legitimate colour still reaches the terminal', async () => {
    const chalk = (await import('chalk')).default;
    const { configureOutput, success } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: true });
    chalk.level = 1;
    success('all good');
    const captured = out();
    expect(captured, 'colour was stripped - the CLI would render flat').toMatch(/\x1b\[/);
    expect(captured).toContain('all good');
    chalk.level = 0;
  });

  test('B2 an error keeps its colour while its TEXT is sanitised', async () => {
    const chalk = (await import('chalk')).default;
    const { configureOutput, fail } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: true });
    chalk.level = 1;
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      fail(new Error('plain failure'));
    } catch {
      /* fail() never returns */
    }
    exit.mockRestore();
    const captured = out();
    expect(captured, 'the error glyph lost its colour').toMatch(/\x1b\[/);
    expect(captured).toContain('plain failure');
    chalk.level = 0;
  });

  test('B3 multi-line output keeps its newlines and tabs', async () => {
    const { sanitizeForDisplay } = await import('../src/lib/sanitize-display.js');
    expect(sanitizeForDisplay('line one\nline two\n\tindented')).toBe(
      'line one\nline two\n\tindented',
    );
  });

  test('B4 ordinary record fields render unchanged', async () => {
    responder = () =>
      jsonResp(200, {
        email: 'person@example.com',
        name: 'Ada Lovelace',
        planDisplay: 'Pro',
        id: 'usr_123',
        tokenId: 'tok_456',
        plan: 'pro',
      });
    const { registerWhoamiCommand } = await import('../src/commands/auth/whoami.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: false, color: false });
    await runProgram(registerWhoamiCommand, ['whoami']);
    const captured = out();
    expect(captured).toContain('person@example.com');
    expect(captured).toContain('Ada Lovelace');
    expect(captured).toContain('usr_123');
    expect(captured).toContain('tok_456');
  });

  test('B5 a legitimate CRLF collapses to a newline rather than becoming visible', async () => {
    const { sanitizeForDisplay } = await import('../src/lib/sanitize-display.js');
    expect(sanitizeForDisplay('windows\r\nline')).toBe('windows\nline');
  });

  test('B6 --json output is NOT sanitised (the machine path relies on JSON escaping)', async () => {
    responder = () =>
      jsonResp(200, {
        email: `raw${POISON}`,
        name: 'x',
        planDisplay: 'p',
        id: 'i',
        tokenId: 't',
        plan: 'pro',
      });
    const { registerWhoamiCommand } = await import('../src/commands/auth/whoami.js');
    const { configureOutput } = await import('../src/lib/output.js');
    configureOutput({ json: true, color: false });
    await runProgram(registerWhoamiCommand, ['--json', 'whoami']);
    const captured = stdoutChunks.join('');
    // JSON.stringify escapes C0 as \u00XX: safe when parsed, and the VALUE
    // must survive intact for machine consumers. Sanitising here would be a
    // defect in the other direction - it would corrupt the data.
    expect(captured, 'the JSON path lost the raw value').toContain('u001b');
    configureOutput({ json: false, color: false });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 - REPOSITORY-AUTHORED TEXT. A hostile clone drives these, not a server.
// ═══════════════════════════════════════════════════════════════════════════
describe('§4 repository-authored text reaching a notice sink', () => {
  test('S10 a slash-command file whose NAME is hostile cannot drive the terminal', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const ws = mkdtempSync(join(tmpdir(), 'spy-sink-'));
    mkdirSync(join(ws, '.spycore', 'commands'), { recursive: true });
    // The name fails NAME_RE, so the loader echoes it back in a notice - the
    // one path on which an arbitrary repository filename reaches a sink.
    // A filename cannot contain '/', so this probe uses the path-safe subset
    // of the corpus. Using POISON verbatim made writeFileSync throw - a
    // harness failure, not a measurement.
    const FS_SAFE = `${OSC_TITLE}${CSI_CURSOR}${C1_CSI}${CR_OVERWRITE}`;
    writeFileSync(join(ws, '.spycore', 'commands', `bad ${FS_SAFE} name.md`), 'body');
    // Project commands load ONLY in a TRUSTED workspace. Without this the
    // scan never runs and the probe passes for the trust gate's reason rather
    // than the sanitizer's - the same non-result F-2c-6 recorded at its S11.
    const { trustWorkspace } = await import('../src/lib/config.js');
    trustWorkspace(ws);
    const { loadUserCommands } = await import('../src/lib/slash/user-commands.js');
    const res = loadUserCommands(ws);
    const joined = res.notices.join('\n');
    expectPayloadReached(joined, 'Skipped', 'S10 user-command notice');
    expectNoTerminalControl(joined, 'S10 user-command notice');
  });

  test('S11 the sanitizer is IDEMPOTENT - sink-side application cannot double-mangle', async () => {
    // This is the pin that makes applying the sanitizer AT THE SINK correct.
    // Notice producers are inconsistent: hooks.ts shortCmd() and
    // command-rules.ts shortEntry() already sanitize at construction, while
    // user-commands.ts did not. Applying it again at the display sink makes the
    // property hold whichever producer is added later - but only because a
    // second pass is a no-op. If that ever stopped being true, sink-side
    // application would start corrupting already-clean text.
    const { sanitizeForDisplay } = await import('../src/lib/sanitize-display.js');
    const once = sanitizeForDisplay(POISON);
    const twice = sanitizeForDisplay(once);
    expect(once, 'the corpus was not altered at all - the pin proves nothing').not.toBe(POISON);
    expect(twice, 'a second pass changed the text - sink-side application is unsafe').toBe(once);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §8 - THE SECOND BENIGN DIRECTION: features that ARE terminal control.
// ═══════════════════════════════════════════════════════════════════════════
describe('§8 legitimate terminal control must keep working', () => {
  test('B7 /clear still emits the CLI\'s OWN clear-screen sequence', async () => {
    // The trap this pin exists for: `renderOneShot` routes its stderr writes
    // through one sanitizing boundary, and `/clear`'s whole job is to WRITE an
    // escape. Sanitizing it would silently break the feature - a sanitiser that
    // breaks the interface is one users disable.
    const { handleSlashCommand } = await import('../src/commands/chat.js');
    expect(typeof handleSlashCommand).toBe('function');
    const { readFileSync } = await import('node:fs');
    // CRLF-normalised at the READ. Git checks this repository out with CRLF
    // on Windows, so the pattern below - which spans a line break - cannot match
    // the raw bytes. Normalising here is the form the repository already uses
    // (`scripts/gen-third-party-licenses.mjs:90`), and it is a no-op on LF.
    const src = readFileSync(
      fileURLToPath(new URL('../src/commands/chat.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(src.length, 'read no source - vacuous').toBeGreaterThan(1000);
    // The clear case writes to STDOUT, deliberately outside the stderr boundary.
    expect(
      src.includes("case 'clear':\n      process.stdout.write("),
      '/clear no longer writes its own escape directly - the feature is broken',
    ).toBe(true);
  });

  /**
   * B8 WAS FALSE-LABELLED AND F-2c-7b RENAMED IT RATHER THAN DELETING IT.
   *
   * Its title used to read "the spinner/progress helpers still emit their
   * control sequences". Its body reads `src/lib/output.ts` and asserts a regex
   * over `print()`. **`output.ts` contains no progress rendering at all** -
   * every `ora` construction lives in five command modules, and B8's body
   * mentioned `ora` zero times. That is finding #40's class (a test whose TITLE
   * asserts a binding its BODY never reads) sitting inside the corpus built to
   * close the sink class.
   *
   * The assertion itself was always correct and is kept verbatim. Only the name
   * changed, so it now says what it observes. The spinner property it *claimed*
   * to cover is pinned separately, by T2 below, where it is actually measured.
   */
  test('B8 the plain display primitives stay UNsanitized so callers\' chalk survives', async () => {
    const { readFileSync } = await import('node:fs');
    // CRLF-normalised at the READ - see B7. The regex below spans three
    // source lines, so on a CRLF checkout it matches nothing.
    const src = readFileSync(
      fileURLToPath(new URL('../src/lib/output.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(src.length, 'read no source - vacuous').toBeGreaterThan(1000);
    // print/success/info/warn stay UNsanitized: their callers compose chalk,
    // and sanitizing at the primitive would strip every colour in the CLI.
    expect(src).toMatch(/export function print\(msg: string\): void \{\n  if \(current\.json\) return;\n  process\.stdout\.write\(`\$\{msg\}\\n`\);/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §11 - THE TERMINAL-CONTROL FEATURE CLASS (F-2c-7b, ruling 4).
//
// The mirror image of the sink class. Some features exist PRECISELY to emit
// control bytes; sanitizing them would not harden anything, it would break
// them. `/clear` is the instance M13 proved load-bearing - it is not the class.
//
// COUNTED MECHANICALLY over 158 source files (method and blind spots recorded
// (see measurement notes §4):
// T1  screen clear            literal \x1b[2J\x1b[H        1 site   (B7)
// T2  spinners / progress     ora                          6 sites / 5 files
// + 1 local alias startSpinner()
// T3  interactive UI draw     ink render()                 2 launches
// + 20 component modules, 3 @inkjs/ui widgets
// T4  colour, intentional     chalk / new Chalk()        125 sites / 11 files
// T5  markdown + highlight    cli-highlight, markdown.ts   2 + 3 sites
// T6  TTY gates               isInteractive / isTTY       47 sites / 24 files
// MEASURED ZERO, each asked for by name: alternate screen (?1049), bracketed
// paste (?2004), OSC 8 hyperlinks, setRawMode, console.clear, bare BEL.
//
// These pins exist BEFORE the byte-keyed sink gate, so that gate is designed
// AGAINST this class rather than into it.
// ═══════════════════════════════════════════════════════════════════════════
describe('§11 the terminal-control feature class', () => {
  test('T2 every spinner writes to a RAW std stream, never through a sanitizing boundary', async () => {
    // The property B8's old title claimed and never measured. A spinner's
    // control bytes (cursor hide/show, line rewrite) come from ora itself, so
    // the way this feature breaks is not "someone sanitizes the label" - it is
    // "someone points ora's STREAM at a wrapper that scrubs escapes".
    //
    // F-2c-10 RATCHETED THIS TIGHTER RATHER THAN LETTING IT WEAKEN.
    // All ora construction now lives behind `lib/spinner.ts`, so the previous
    // form - "for each file importing ora, the construction region names a raw
    // process stream" - would have kept passing while measuring ONE site in ONE
    // file instead of six across five. A pin whose coverage silently collapses
    // is worse than one that fails. The property is therefore asserted in three
    // strictly stronger ways:
    // (a) ora is imported AS A VALUE in exactly one module - the boundary.
    // This is new: previously any module could construct a spinner.
    // (b) every CALL SITE of the boundary still names a raw process stream,
    // which is the original regex property, applied where the sites now
    // live, with the original site count preserved as a reached-assertion.
    // (c) the stream survives the boundary, proven BY EXECUTION rather than by
    // reading source: ora's OWN escapes must arrive on the caller's
    // stream. (a) and (b) are static and blind to implementation; (c) is
    // executable and blind to coverage - digest 28 / register #109 says a
    // class is gated only when both kinds exist.
    const { readdirSync, statSync, readFileSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = fileURLToPath(new URL('../src', import.meta.url));
    // SEPARATOR-NORMALISED, AND THIS PIN IS WHY THE RULE EXISTS.
    // Its first form used `f.split('/src/')[1]`, inherited from the version
    // before it. On Windows the path is `…\packages\cli\src\lib\spinner.ts`, so
    // that split never matches and the FULL absolute path fell through - which
    // turned clause (a)'s exact-match assertion RED on the Windows leg for a
    // reason that has nothing to do with spinners. The old form got away with
    // it because it only ever built a message string; making the value
    // load-bearing exposed it. Same class F-2c-10 §2 closed, re-introduced by
    // this batch's own new pin and caught by the leg §2 made readable again.
    const relOf = (abs: string): string => relative(root, abs).replace(/\\/g, '/');
    const walk = (d: string, acc: string[] = []): string[] => {
      for (const e of readdirSync(d)) {
        const abs = join(d, e);
        if (statSync(abs).isDirectory()) walk(abs, acc);
        else if (abs.endsWith('.ts') || abs.endsWith('.tsx')) acc.push(abs);
      }
      return acc;
    };
    const files = walk(root);
    expect(files.length, 'walked no source - vacuous').toBeGreaterThan(100);

    // ── (a) ora is constructible in exactly ONE module. ────────────────────
    const valueImporters: string[] = [];
    const sites: string[] = [];
    const bad: string[] = [];
    for (const f of files) {
      const body = readFileSync(f, 'utf8');
      const rel = relOf(f);
      // `import type { Ora } from 'ora'` is a TYPE-only import and constructs
      // nothing; only a value import can build a spinner.
      if (/^import\s+(?!type\b)[^;]*from\s+'ora'/m.test(body)) valueImporters.push(rel);

      // ── (b) every boundary CALL SITE names a raw process stream. ─────────
      // The boundary MODULE is skipped here and only here: it DEFINES
      // `createSpinner`, so its own declaration and the doc-comment reference
      // match the same pattern a call site does. It is still covered by (a)
      // above - which is the assertion that actually constrains it - and by (c)
      // by execution. Skipping it for (a) as well would let the boundary import
      // ora freely, which is the one thing (a) exists to forbid.
      if (rel === 'lib/spinner.ts') continue;
      for (const m of body.matchAll(/\bcreateSpinner\(/g)) {
        const from = m.index as number;
        const rest = body.slice(from, from + 400);
        // Delimited by the `.start()` that follows - NOT by the first `}`,
        // which a template literal's own `${…}` closes early. (That bug made
        // this pin's first form report a false RED on all four multi-line
        // sites; the shape is kept because the failure looked exactly like a
        // real finding.)
        const stop = rest.indexOf('.start(');
        const region = stop === -1 ? rest.slice(0, 200) : rest.slice(0, stop);
        sites.push(`${rel}: ${region.slice(0, 60).replace(/\s+/g, ' ')}`);
        if (!/stream:\s*process\.(stderr|stdout)/.test(region))
          bad.push(`${rel}: ${region.replace(/\s+/g, ' ').slice(0, 140)}`);
      }
    }
    expect(
      valueImporters,
      `ora is constructed outside the spinner boundary - that spinner's text never crosses the sanitizer:\n${valueImporters.join('\n')}`,
    ).toEqual(['lib/spinner.ts']);

    // Reached-assertion, FLOORED AT THE MEASURED POPULATION rather than at
    // "more than none".
    //
    // WHY THE FLOOR IS 6 AND NOT `> 0`. Mutation S-M8 renamed ONE site's
    // `createSpinner(` call and this pin stayed GREEN: the site simply vanished
    // from the scan, 6 became 5, and a floor of "more than four" was still
    // satisfied. That is the same shape F-2c-9 recorded from the other
    // direction - renaming a barrier does not remove it, it makes it
    // unrecognised - and here it makes a SITE unrecognised instead. The only
    // thing that stopped that mutation being exploitable is that the renamed
    // symbol does not exist, so `tsc` goes red; i.e. TYPE-CHECKING IS
    // LOAD-BEARING FOR THIS PIN'S COVERAGE, which is worth saying out loud
    // rather than relying on silently. The floor below makes the count itself
    // the assertion: 6 construction sites across 5 command modules, measured.
    expect(
      sites.length,
      'fewer spinner construction sites than the measured population (6 across 5 modules).\n' +
        'Either a spinner was deleted, or one stopped going through the boundary under another name.',
    ).toBeGreaterThanOrEqual(6);
    expect(
      bad,
      `a spinner no longer writes to a raw std stream - progress rendering is being routed through something:\n${bad.join('\n')}`,
    ).toEqual([]);

    // ── (c) THE STREAM SURVIVES THE BOUNDARY - measured by EXECUTION. ──────
    const { Writable } = await import('node:stream');
    const seen: string[] = [];
    class Probe extends Writable {
      isTTY = true;
      columns = 120;
      cursorTo(): boolean { return true; }
      clearLine(): boolean { return true; }
      moveCursor(): boolean { return true; }
      override _write(c: unknown, _e: unknown, cb: () => void): void {
        seen.push(String(c));
        cb();
      }
    }
    const probe = new Probe();
    // REAL ora, NOT §12's mock. §12 registers `vi.doMock('ora')` and that
    // registration is still live here - the first form of this assertion was
    // measuring the MOCK's `stream.write(text)` and would have reported "no
    // control bytes" no matter what the boundary did. `resetModules()` alone
    // does NOT clear a doMock. This assertion is the one place in the suite
    // that genuinely needs the real library, because the property is that
    // ORA'S OWN escapes survive.
    vi.doUnmock('ora');
    vi.resetModules();
    const { createSpinner } = await import('../src/lib/spinner.js');
    // Force colour ON, exactly as T5 does. Under vitest there is no TTY, so
    // chalk.level is 0 and ora's frame carries no escapes at all - the first
    // form of this assertion failed for that reason and not for the property
    // it guards, which is the same failure mode this whole §2 batch is about.
    const chalkForColour = (await import('chalk')).default;
    const prevLevel = chalkForColour.level;
    chalkForColour.level = 1;
    try {
      createSpinner({
        text: 'progress',
        stream: probe as unknown as NodeJS.WritableStream,
        isEnabled: true,
      }).start().stop();
    } finally {
      chalkForColour.level = prevLevel;
    }
    const written = seen.join('');
    expect(written.length, 'the boundary wrote nothing to the stream it was given - vacuous')
      .toBeGreaterThan(0);
    expect(written, 'the spinner label never reached the caller-supplied stream').toContain('progress');
    expect(
      written,
      "ora's OWN control bytes did not survive the boundary - the stream is being scrubbed and progress rendering is broken",
    ).toMatch(/\x1b\[/);
    vi.resetModules();
  });

  test('T3/T6 the Ink draw path refuses to emit control bytes into a non-terminal sink', async () => {
    // Ink's entire output is terminal control. The thing that keeps it honest
    // is the TTY gate - launch it into a pipe, a file or CI and it writes
    // escape sequences into a sink that is not a terminal. Measured by
    // EXECUTION, not by reading the comment that says so.
    const { isInteractive, guardedRender } = await import('../src/ui/lib/render.js');
    expect(isInteractive({ isTTY: true }), 'a real TTY must be interactive').toBe(true);
    expect(isInteractive({ isTTY: false }), 'a pipe must NOT be interactive').toBe(false);
    expect(isInteractive({}), 'an absent isTTY must NOT be interactive').toBe(false);

    // guardedRender must refuse rather than render. Force the non-TTY arm.
    const prev = process.stdout.isTTY;
    try {
      Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
      const instance = await guardedRender(null);
      expect(instance, 'guardedRender rendered into a non-TTY - Ink is writing escapes into a pipe').toBeNull();
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: prev, configurable: true });
    }

    // …and both full-screen app launches must sit behind the same gate.
    const { readFileSync } = await import('node:fs');
    for (const rel of ['../src/ui/chat/run.ts', '../src/ui/agent/run.ts']) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(src.length, `read no source for ${rel} - vacuous`).toBeGreaterThan(500);
      expect(src, `${rel} renders Ink without importing the TTY gate`).toContain('isInteractive');
      expect(
        /if \(!isInteractive\(\)\) return;/.test(src),
        `${rel} lost its early return - Ink can now launch into a non-terminal sink`,
      ).toBe(true);
    }
  });

  test('T5 sanitization runs BEFORE the markdown renderer, and the order is load-bearing', async () => {
    // The M13 shape for the renderer. `renderer.write(sanitize(x))` keeps the
    // CLI's OWN colour and kills the attacker's. `sanitize(renderer.write(x))`
    // - one swap - strips every escape the renderer just authored and renders
    // the CLI flat. Nothing turned red on that swap before this pin.
    const { createMarkdownRenderer } = await import('../src/lib/markdown.js');
    const { sanitizeForDisplay } = await import('../src/lib/sanitize-display.js');
    const chalk = (await import('chalk')).default;
    const prevLevel = chalk.level;
    chalk.level = 1; // force colour on regardless of the runner's TTY
    try {
      const hostile = '# Title\n\nhello \x1b]0;PWNED\x07 world **bold**\n';

      const right = createMarkdownRenderer({ color: true });
      const correct = right.write(sanitizeForDisplay(hostile)) + right.flush();
      // Reached-assertion: the renderer actually rendered something.
      expect(correct.length, 'renderer produced nothing - vacuous').toBeGreaterThan(10);
      // (a) the CLI's own colour survives …
      expect(correct, 'the renderer emitted no ANSI - this pin proves nothing').toMatch(/\x1b\[/);
      // (b) … and the attacker's OSC does not.
      expect(correct, 'a hostile OSC survived the correct order').not.toContain('PWNED');
      expect(correct, 'a raw BEL survived the correct order').not.toContain('\x07');

      const wrong = createMarkdownRenderer({ color: true });
      const swapped = sanitizeForDisplay(wrong.write(hostile) + wrong.flush());
      // The swap is safe for the attacker's bytes too - which is exactly why it
      // looks harmless in review. What it destroys is the CLI's own rendering.
      expect(swapped, 'the swapped order kept ANSI - the orders are indistinguishable and this pin is vacuous').not.toMatch(/\x1b\[/);
    } finally {
      chalk.level = prevLevel;
    }

    // …and both plain-path consumers must use the correct order at the call site.
    const { readFileSync } = await import('node:fs');
    for (const rel of ['../src/commands/chat.ts', '../src/commands/conversations/show.ts']) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(src.length, `read no source for ${rel} - vacuous`).toBeGreaterThan(500);
      expect(
        /sanitizeForDisplay\([\s\S]{0,80}?\)\s*\)/.test(src) && !/sanitizeForDisplay\(\s*renderer\.(write|flush)/.test(src),
        `${rel} sanitizes AFTER rendering - the CLI's own markdown colour is being stripped`,
      ).toBe(true);
    }
  });

  /**
   * T-CLASS - THE SHIPPED ENUMERATION MUST EQUAL THE COUNTED CLASS.
   *
   * SECURITY.md used to disclose the terminal-control exclusion as "a handful
   * of surfaces … `/clear`, progress rendering, colour". Re-derived at
   * ced82e46 from the package's OWN dependency list plus a from-scratch
   * literal-escape sweep - deliberately NOT inheriting F-2c-7b's groups - the
   * class is SIX, not three. The three the sentence omitted:
   *
   * · the markdown + syntax-highlight renderers (cli-highlight, markdown.ts)
   * · the interactive full-screen UI (ink, reached by DYNAMIC import - which
   * is why a static `import { render } from 'ink'` probe finds zero)
   * ·  the LINE EDITOR: `node:readline` created with `terminal: isTTY`
   * emits its own cursor/line-clear sequences. F-2c-7b's census keyed on
   * five npm libraries and a literal-escape sweep, and Node's own built-in
   * is neither - so this member was invisible to it. A census that keys on
   * names cannot see a mechanism that has no name in package.json.
   *
   * This pin re-counts the class from source and fails when the document and
   * the tree disagree in EITHER direction: a seventh mechanism appearing, or a
   * documented one disappearing (which would make the sentence over-claim).
   *
   * WHAT IT CANNOT SEE: control bytes from a transitive dependency
   * (commander's help output, conf, undici) - the census keys on direct
   * imports; runtime-conditional emission (`chalk.level` 0 vs 1) - it counts
   * SITES, not executions; and whether the CONTENT interpolated into these
   * surfaces was sanitized first, which is a sink question, not a feature one.
   */
  test('T-CLASS the SECURITY.md terminal-control enumeration equals the counted class', async () => {
    const { readdirSync, statSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
    const files: string[] = [];
    (function walk(d: string): void {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(p)) files.push(p);
      }
    })(join(pkgRoot, 'src'));
    // Reached-assertion: a zero-file census proves nothing about anything.
    expect(files.length, 'no source files walked - this census is vacuous').toBeGreaterThan(100);
    const corpus = files.map((f) => readFileSync(f, 'utf8'));
    const sites = (re: RegExp): number =>
      corpus.reduce((n, s) => n + (s.match(re) ?? []).length, 0);

    // The seven mechanisms that DO emit terminal control, each counted. Raw
    // mode joined the class with the interactive TUI: the theme probe and
    // the external-editor handoff toggle it briefly, and Ink owns stdin
    // while mounted.
    const CLASS: Record<string, number> = {
      'screen clear': sites(/process\.stdout\.write\('\\x1b\[2J/g),
      'progress spinners': sites(/\bora\(/g),
      colour: sites(/\bchalk\.[a-zA-Z]|new Chalk\(/g),
      'markdown + highlight': sites(/\bhighlight\(|createMarkdownRenderer/g),
      'interactive full-screen UI': sites(/await import\('ink'\)|\{ render \}/g),
      'line editor': sites(/createInterface\(/g),
      'raw mode': sites(/setRawMode/g),
    };
    // Reached-assertion: every documented member must actually be PRESENT. If a
    // count silently fell to zero the enumeration would be over-claiming, and a
    // census of zeroes would otherwise "agree" with any document at all.
    for (const [name, n] of Object.entries(CLASS)) {
      expect(n, `documented terminal-control member "${name}" has ZERO sites`).toBeGreaterThan(0);
    }

    // The mechanisms the document asserts are absent. A new one appearing is
    // exactly the "seventh member" case, and it reddens here.
    const ZERO: Record<string, RegExp> = {
      'alternate screen': /\?1049/g,
      'bracketed paste': /\?2004/g,
      'OSC 8 hyperlink': /\\x1b\]8/g,
      'terminal title (OSC 0/2)': /\\x1b\]0;|\\x1b\]2;/g,
      'console.clear': /console\.clear/g,
      'cursor addressing': /\bcursorTo\(|\bmoveCursor\(|\bclearLine\(/g,
      'cursor hide/show': /\?25[lh]/g,
    };
    const appeared = Object.entries(ZERO)
      .filter(([, re]) => sites(re) > 0)
      .map(([n]) => n);
    expect(
      appeared,
      `a terminal-control mechanism SECURITY.md declares absent is now present: ${appeared.join(', ')}`,
    ).toEqual([]);

    // …and the shipped sentence must name exactly this set. Whitespace-
    // normalised: the document is hard-wrapped, and T-USER's first form went
    // red on a line break rather than a dropped disclosure.
    const raw = readFileSync(join(pkgRoot, 'SECURITY.md'), 'utf8');
    expect(raw.length, 'read no document - vacuous').toBeGreaterThan(500);
    const sec = raw.replace(/\s+/g, ' ');
    expect(sec, 'the enumeration is no longer stated as a closed count').toMatch(
      /There are \*\*seven\*\*/i,
    );
    expect(Object.keys(CLASS).length, 'the counted class is no longer seven').toBe(7);
    for (const phrase of [
      '`/clear`',
      'progress spinners',
      'colour',
      'markdown and syntax-highlight',
      'interactive full-screen UI',
      'line editor',
      'raw mode',
    ]) {
      expect(sec, `SECURITY.md no longer names "${phrase}" in the enumeration`).toContain(phrase);
    }
    // The word that made the old sentence unfalsifiable.
    expect(sec, 'the enumeration went back to being a vague "handful"').not.toMatch(
      /a handful of surfaces whose whole\s+job is terminal control/i,
    );
  });

  test('T-USER the two USER-TRUSTED boundaries are DISCLOSED, not merely implemented', async () => {
    // Ruling 4d. Live keystrokes are never scrubbed and `--json` stays raw.
    // 0b and B6 pin the BEHAVIOUR; this pins that both are stated in the
    // shipped document, so a future sanitizer batch cannot cross them and leave
    // the promise reading as though it had not.
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(fileURLToPath(new URL('../SECURITY.md', import.meta.url)), 'utf8');
    expect(doc.length, 'read no document - vacuous').toBeGreaterThan(500);
    // The document is hard-wrapped, so every phrase below is matched against a
    // whitespace-normalised copy - a sentence must not slip past this pin just
    // because a reflow moved a line break. (The first form of this pin asserted
    // against the raw text and went red on `whose whole\n   job is terminal
    // control`, which is a wrapping artefact, not a dropped disclosure.)
    const flat = doc.replace(/\s+/g, ' ');
    expect(flat.length, 'normalised to nothing - vacuous').toBeGreaterThan(500);
    for (const [phrase, why] of [
      ['Your own typed input is never sanitized', 'the typed-input exclusion was dropped'],
      ['from the server', 'the transport-is-the-boundary reasoning was dropped'],
      ['--json', 'the machine-path exclusion was dropped'],
      // F-2c-8 §2 widened this from "a handful of surfaces whose whole job is
      // terminal control - /clear, progress rendering, colour" to the full
      // counted class of six. The phrase pinned here moved with it; T-CLASS
      // pins the enumeration's CONTENTS against a live census of the source.
      ['surfaces whose job IS terminal control', 'the terminal-control exclusion was dropped'],
    ] as const) {
      expect(flat, `${why} from SECURITY.md's disclosure`).toContain(phrase);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §9 - THE SHIPPED CLAIM, BOUND TO THIS CORPUS.
// ═══════════════════════════════════════════════════════════════════════════
describe('§9 the shipped promise cannot be quietly weakened to match the code', () => {
  /**
   * WHY THIS PIN EXISTS, AND WHAT IT IS NOT.
   *
   * It does NOT prove the sanitizer works - §1–§4 do that, by execution. It
   * closes the OTHER repair path.  was filed precisely because the
   * honest fix was to raise the code to the promise, and the dishonest one was
   * to soften the promise until it matched. `doc-claims.test.ts` cannot see
   * this: it binds documented NUMBERS and FLAGS to the code, not whether a
   * control is applied at every sink.
   *
   * So this asserts the promise is still AS STRONG AS IT WAS - including the
   * parenthetical that names the update-check version string, which was one of
   * the four originally-measured false sites and is now covered by S9.
   */
  test('B9 SECURITY.md still promises ALL untrusted strings cross ONE sanitizer', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(fileURLToPath(new URL('../SECURITY.md', import.meta.url)), 'utf8');
    expect(doc.length, 'read no document - vacuous').toBeGreaterThan(500);
    expect(doc, 'the universal quantifier was dropped from the promise').toContain(
      'All untrusted strings',
    );
    expect(doc, 'the single-sanitizer claim was dropped').toContain('a single sanitizer');
    // The parenthetical names the exact string `spycore update` prints; S9 is
    // the probe that makes it true. If the sentence loses it, S9 stops being
    // load-bearing and a reader would not know.
    expect(doc, 'the update-check parenthetical was dropped from the promise').toContain(
      'update-check',
    );
    expect(doc, 'the sanitizer module reference was dropped').toContain(
      'src/lib/sanitize-display.ts',
    );
  });

  test('B10 README still makes the sanitization promise to users', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
    expect(doc.length, 'read no document - vacuous').toBeGreaterThan(500);
    expect(doc, 'the README promise was weakened').toContain(
      'everything a model or MCP server prints is sanitized',
    );
  });

  /**
   * B14 - THE DOCUMENT MUST SAY ON ITS FACE WHEN IT IS WRONG.
   *
   * B9 closes the "soften the prose until the code passes" repair path. It does
   * NOT close the one F-2c-8 walked into: §2's claim was measurably FALSE while
   * the surrounding text read as authoritative, and a reader had no way to tell.
   * A document that is right in one place and silently wrong in another reads as
   * authoritative in both.
   *
   * This pin has a FIXED POINT and cannot be satisfied by writing prose. The
   * count is re-measured mechanically at current state, and the notice is
   * required to be present for exactly as long as the count is non-zero - so
   * the notice cannot be forgotten while the defect stands, and cannot be left
   * behind once it is closed. Both directions are asserted.
   */
  test('B14 §2 is accurate, or SAYS ON ITS FACE that it is not - both directions', async () => {
    const { readFileSync } = await import('node:fs');
    const { censusWireSinks, KNOWN_DEFECT_PROBE, KNOWN_DEFECT_PROBE_PATH } = await import(
      './wire-sink-census.js'
    );

    // ── Reached-assertion 1: the census really read the package.
    const real = censusWireSinks();
    expect(real.filesScanned, 'the census scanned almost nothing - vacuous').toBeGreaterThan(150);
    // ── Reached-assertion 2: the sink set was DISCOVERED, not just listed. If
    // alias discovery silently produced nothing, the census degrades to the
    // name-keyed shape that missed six sites in F-2c-7 and nine here.
    expect(real.aliases.size, 'sink-alias discovery found nothing - the census is name-keyed again')
      .toBeGreaterThanOrEqual(10);
    // ── Reached-assertion 3  THE CENSUS CAN STILL SEE A KNOWN-REAL DEFECT.
    // A residual of zero from an instrument that cannot re-find a real
    // instance is a NON-RESULT, not a clean corpus (F-2c-8 §3a: the v4
    // detector reported 0.00 % and was blind). Proven before it is believed.
    const probed = censusWireSinks({ extraFiles: { [KNOWN_DEFECT_PROBE_PATH]: KNOWN_DEFECT_PROBE } });
    expect(
      probed.findings.filter((f) => f.file === KNOWN_DEFECT_PROBE_PATH).length,
      'the census cannot see a known-real defect - every zero it reports is worthless',
    ).toBe(1);

    const NOTICE = 'KNOWN INACCURACY';
    const doc = readFileSync(fileURLToPath(new URL('../SECURITY.md', import.meta.url)), 'utf8');
    expect(doc.length, 'read no document - vacuous').toBeGreaterThan(500);

    if (real.findings.length > 0) {
      expect(
        doc,
        `${real.findings.length} counted site(s) render a wire value unsanitized ` +
          `(${real.findings.map((f) => `${f.file}:${f.line}`).join(', ')}) - ` +
          'SECURITY.md §2 must say so on its face while that is true',
      ).toContain(NOTICE);
    } else {
      expect(
        doc,
        'the counted class is empty, so the KNOWN INACCURACY notice is now itself ' +
          'inaccurate and must be removed',
      ).not.toContain(NOTICE);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §10 - THE PRECONDITION THAT MAKES chat.ts's WRITE BOUNDARY SAFE.
// ═══════════════════════════════════════════════════════════════════════════
describe('§10 the renderOneShot write boundary cannot silently swallow colour', () => {
  test('B11 every helper feeding the boundary emits NO escape sequences', async () => {
    // renderOneShot routes its stderr writes through one sanitizing helper.
    // That is safe only while the strings handed to it carry no colour of their
    // own - and several come from OTHER functions (formatHelpText,
    // formatInitRow). If either ever starts using chalk, the boundary would
    // strip it and the CLI would quietly render flat.
    //
    // Non-vacuous by construction: the first assertion proves the sanitizer
    // DOES destroy chalk output, so "these helpers emit none" is a statement
    // about a real behavioural risk rather than a definitional one.
    const chalk = (await import('chalk')).default;
    const { sanitizeForDisplay } = await import('../src/lib/sanitize-display.js');
    const prevLevel = chalk.level;
    chalk.level = 1;
    const coloured = chalk.red('x');
    chalk.level = prevLevel;
    expect(coloured, 'chalk emitted no escape - this pin proves nothing').toMatch(/\x1b/);
    expect(
      sanitizeForDisplay(coloured),
      'the sanitizer does not strip colour, so the boundary carries no risk',
    ).not.toMatch(/\x1b/);

    const { readFileSync } = await import('node:fs');
    const src = readFileSync(fileURLToPath(new URL('../src/commands/chat.ts', import.meta.url)), 'utf8');
    const helpers = src.slice(
      src.indexOf('function formatHelpText'),
      src.indexOf('function renderOneShot'),
    );
    expect(helpers.length, 'read no helper source - vacuous').toBeGreaterThan(200);
    expect(
      helpers.includes('chalk.'),
      'a boundary helper gained colour - w() will silently strip it',
    ).toBe(false);
  });
});
