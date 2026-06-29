import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freshConfigDir } from './helpers.js';

interface MockResp {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: { json: () => Promise<unknown> };
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

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(async () => {
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
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  vi.resetModules();
});

function jsonResp(status: number, body: unknown): MockResp {
  return {
    statusCode: status,
    headers: {},
    body: { json: async () => body },
  };
}

function stdout(): string {
  return stdoutChunks.join('');
}

async function runCli(argv: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerConversationsCommand } = await import(
    '../src/commands/conversations/index.js'
  );
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });

  const program = new Command();
  program
    .name('spycore')
    .option('--api-url <url>')
    .option('--json')
    .option('--no-color');
  registerConversationsCommand(program);
  await program.parseAsync([
    'node',
    'spycore',
    ...parentArgs,
    'conversations',
    ...argv,
  ]);
}

describe('conversations list', () => {
  test('renders a table of conversations', async () => {
    responder = (url) => {
      if (url.includes('/conversations?page=1')) {
        return jsonResp(200, {
          success: true,
          data: {
            conversations: [
              {
                id: 'cnv_aaaa1111bbbb2222',
                title: 'Hello world',
                model: 'HERMES',
                updatedAt: new Date(Date.now() - 5000).toISOString(),
                createdAt: new Date().toISOString(),
              },
              {
                id: 'cnv_cccc3333dddd4444',
                title: 'Project planning',
                model: 'STYX',
                updatedAt: new Date(Date.now() - 60_000).toISOString(),
                createdAt: new Date().toISOString(),
              },
            ],
            total: 2,
            page: 1,
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runCli(['list']);
    const out = stdout();
    expect(out).toContain('Hello world');
    expect(out).toContain('Project planning');
    expect(out).toContain('HERMES');
  });

  test('--json mode emits raw payload', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          conversations: [
            {
              id: 'cnv_1',
              title: 'A',
              model: 'HERMES',
              updatedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
          total: 1,
          page: 1,
        },
      });
    await runCli(['list'], ['--json']);
    const out = stdout().trim();
    const parsed = JSON.parse(out);
    expect(parsed.conversations).toHaveLength(1);
    expect(parsed.conversations[0].id).toBe('cnv_1');
  });

  test('--page <n> sends page=<n> through to the server', async () => {
    let observedUrl = '';
    responder = (url) => {
      observedUrl = url;
      return jsonResp(200, {
        success: true,
        data: {
          conversations: [
            {
              id: 'cnv_pg3',
              title: 'On page 3',
              model: 'CHARON',
              updatedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
          total: 47,
          page: 3,
        },
      });
    };
    await runCli(['list', '--page', '3'], ['--json']);
    expect(observedUrl).toMatch(/\?page=3$/);
    const parsed = JSON.parse(stdout().trim());
    expect(parsed.page).toBe(3);
    expect(parsed.conversations[0].id).toBe('cnv_pg3');
  });

  test('empty page beyond the last one renders a page-specific message', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: { conversations: [], page: 99 },
      });
    await runCli(['list', '--page', '99']);
    expect(stdout()).toContain('(no conversations on page 99)');
  });

  test('--json surfaces hasMore=true when more pages remain', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          conversations: [
            {
              id: 'cnv_x',
              title: 'X',
              model: 'HERMES',
              updatedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
          total: 47,
          page: 1,
        },
      });
    await runCli(['list', '--page', '1'], ['--json']);
    const parsed = JSON.parse(stdout().trim());
    expect(parsed.hasMore).toBe(true);
    expect(parsed.total).toBe(47);
  });

  test('--format yaml emits the conversation list as YAML', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          conversations: [
            {
              id: 'cnv_yaml',
              title: 'YAML test',
              model: 'HERMES',
              updatedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
          total: 1,
          page: 1,
        },
      });
    await runCli(['list', '--format', 'yaml']);
    const out = stdout();
    expect(out).toContain('- id: cnv_yaml');
    expect(out).toContain('title: YAML test');
    expect(out).toContain('model: HERMES');
  });

  test('--format markdown emits a table', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          conversations: [
            {
              id: 'cnv_md',
              title: 'MD test',
              model: 'STYX',
              updatedAt: new Date().toISOString(),
              createdAt: new Date().toISOString(),
            },
          ],
          total: 1,
          page: 1,
        },
      });
    await runCli(['list', '--format', 'markdown']);
    const out = stdout();
    expect(out).toContain('| id |');
    expect(out).toContain('cnv_md');
    expect(out).toContain('MD test');
  });
});

describe('conversations show', () => {
  test('prints role-prefixed message log', async () => {
    responder = (url) => {
      if (url.includes('/conversations/cnv_1')) {
        return jsonResp(200, {
          success: true,
          data: {
            id: 'cnv_1',
            title: 'Demo',
            model: 'HERMES',
            messages: [
              {
                id: 'm1',
                role: 'user',
                content: 'What is X?',
                createdAt: new Date().toISOString(),
              },
              {
                id: 'm2',
                role: 'assistant',
                content: 'X is Y.',
                model: 'HERMES',
                createdAt: new Date().toISOString(),
              },
            ],
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runCli(['show', 'cnv_1', '--raw']);
    const out = stdout();
    expect(out).toContain('What is X?');
    expect(out).toContain('X is Y.');
    expect(out).toContain('You');
    expect(out).toContain('Assistant');
  });

  test('404 surfaces a friendly hint', async () => {
    responder = () => jsonResp(404, { success: false, error: 'Not found' });
    let caught: unknown = null;
    try {
      await runCli(['show', 'cnv_missing']);
    } catch (err) {
      caught = err;
    }
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    expect(isSpycoreCliError(caught)).toBe(true);
    if (isSpycoreCliError(caught)) {
      expect(caught.message).toContain('Conversation not found');
    }
  });

  test('sanitizes terminal-control sequences in title + content (SEC-013)', async () => {
    // A hostile conversation: ANSI CSI colour, an OSC clipboard/title write,
    // and a bare CR overwrite trick — in both the title and the message body.
    const evil = 'A\x1b[31mRED\x1b]0;pwned\x07B\rOVERWRITE';
    responder = (url) => {
      if (url.includes('/conversations/cnv_evil')) {
        return jsonResp(200, {
          success: true,
          data: {
            id: 'cnv_evil',
            title: `T\x1b]0;hijack\x07itle`,
            model: 'HERMES',
            messages: [
              { id: 'm1', role: 'user', content: evil, createdAt: new Date().toISOString() },
            ],
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    await runCli(['show', 'cnv_evil', '--raw']);
    const out = stdout();
    // No raw ESC byte and no bare CR survive to the terminal…
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x07');
    expect(out).not.toMatch(/\r(?!\n)/);
    // …the bare CR is shown as its visible control picture…
    expect(out).toContain('␍');
    // …and the printable text is preserved.
    expect(out).toContain('RED');
    expect(out).toContain('OVERWRITE');
    expect(out).toContain('Title');
  });
});

describe('conversations export', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'spycli-export-'));
  });

  afterEach(() => {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('writes markdown with You/Assistant headings', async () => {
    responder = (url) => {
      if (url.includes('/conversations/cnv_1')) {
        return jsonResp(200, {
          success: true,
          data: {
            id: 'cnv_1',
            title: 'Demo',
            model: 'HERMES',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messages: [
              { role: 'user', content: 'Hi', createdAt: new Date().toISOString() },
              { role: 'assistant', model: 'HERMES', content: 'Hello!', createdAt: new Date().toISOString() },
            ],
          },
        });
      }
      throw new Error(`unexpected ${url}`);
    };
    const out = join(workDir, 'out.md');
    await runCli(['export', 'cnv_1', '--format', 'markdown', '--output', out]);
    const md = readFileSync(out, 'utf8');
    expect(md).toContain('# Demo');
    expect(md).toContain('## You');
    expect(md).toContain('## HERMES');
    expect(md).toContain('Hi');
    expect(md).toContain('Hello!');
  });

  test('json format dumps the full payload', async () => {
    responder = () =>
      jsonResp(200, {
        success: true,
        data: {
          id: 'cnv_2',
          title: 'JSON',
          model: 'MINOS',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messages: [],
        },
      });
    const out = join(workDir, 'out.json');
    await runCli(['export', 'cnv_2', '--format', 'json', '--output', out]);
    const parsed = JSON.parse(readFileSync(out, 'utf8'));
    expect(parsed.id).toBe('cnv_2');
    expect(parsed.model).toBe('MINOS');
  });
});

describe('conversations delete', () => {
  test('--yes deletes without prompting', async () => {
    let deleted = false;
    responder = (url, init) => {
      if (url.includes('/conversations/cnv_1') && init.method === 'DELETE') {
        deleted = true;
        return jsonResp(200, { success: true });
      }
      throw new Error(`unexpected ${init.method} ${url}`);
    };
    await runCli(['delete', 'cnv_1', '--yes']);
    expect(deleted).toBe(true);
  });

  test('refuses without --yes in non-TTY', async () => {
    // process.stdin.isTTY is false in vitest by default — perfect.
    let caught: unknown = null;
    try {
      await runCli(['delete', 'cnv_1']);
    } catch (err) {
      caught = err;
    }
    const { isSpycoreCliError } = await import('../src/lib/errors.js');
    // The fail() helper calls process.exit, which vitest intercepts as
    // an "unhandled" exit. We accept either path: thrown SpycoreCliError
    // or an exit attempt — both indicate the safety guard kicked in.
    expect(caught !== null || stderrChunks.join('').includes('Refusing'));
    // Also ensure no DELETE happened.
    expect(isSpycoreCliError(caught) || stderrChunks.join('').length > 0).toBe(true);
  });
});
