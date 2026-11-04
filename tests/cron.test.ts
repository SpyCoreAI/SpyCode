import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { freshConfigDir } from './helpers.js';

let stdoutChunks: string[] = [];
let stderrChunks: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  freshConfigDir();
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
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  vi.resetModules();
});

function stdout(): string {
  return stdoutChunks.join('');
}

async function runCli(argv: string[], parentArgs: string[] = []): Promise<void> {
  const { Command } = await import('commander');
  const { registerCronCommand } = await import('../src/commands/cron/index.js');
  const { configureOutput } = await import('../src/lib/output.js');
  configureOutput({ json: parentArgs.includes('--json'), color: false });

  const program = new Command();
  program.name('spycore').option('--api-url <url>').option('--json').option('--no-color');
  program.exitOverride();
  registerCronCommand(program);
  await program.parseAsync(['node', 'spycore', ...parentArgs, 'cron', ...argv]);
}

describe('cron schedule validation', () => {
  test('accepts common cron expressions', async () => {
    const { validateSchedule } = await import('../src/commands/cron/store.js');
    expect(validateSchedule('*/15 * * * *')).toBe('*/15 * * * *');
    expect(validateSchedule('0 9 * * MON')).toBe('0 9 * * MON');
    expect(validateSchedule('0 0 1 JAN,JUL *')).toBe('0 0 1 JAN,JUL *');
    expect(validateSchedule('30 8-17/2 1-15 * 1-5')).toBe('30 8-17/2 1-15 * 1-5');
    expect(validateSchedule('  0\t9 * * *  ')).toBe('0 9 * * *');
  });

  test('rejects malformed schedules', async () => {
    const { validateSchedule } = await import('../src/commands/cron/store.js');
    for (const bad of [
      '* * * *', // 4 fields
      '* * * * * *', // 6 fields
      '61 * * * *', // minute out of range
      '* 25 * * *', // hour out of range
      '* * 0 * *', // dom out of range
      '* * * 13 *', // month out of range
      '* * * * FOO', // unknown name
      '*/0 * * * *', // invalid step
      '5-2 * * * *', // reversed range
      '* * * * *,', // empty list element
    ]) {
      await expect(async () => validateSchedule(bad)).rejects.toThrow();
    }
  });
});

describe('spycore cron add', () => {
  test('creates an entry and prints its id', async () => {
    await runCli(['add', '--prompt', 'Summarize the news', '--schedule', '0 8 * * *']);
    const out = stdout();
    expect(out).toContain('Scheduled prompt');
    expect(out).toContain('0 8 * * *');
  });

  test('rejects an invalid schedule', async () => {
    await expect(
      runCli(['add', '--prompt', 'x', '--schedule', 'not a schedule']),
    ).rejects.toThrow(/Invalid schedule/);
  });

  test('rejects an unknown model', async () => {
    await expect(
      runCli(['add', '--prompt', 'x', '--schedule', '* * * * *', '--model', 'gpt-99']),
    ).rejects.toThrow(/Unknown model/);
  });

  test('--json emits the created entry', async () => {
    await runCli(
      ['add', '--prompt', 'ping', '--schedule', '*/5 * * * *', '--model', 'minos'],
      ['--json'],
    );
    const payload = JSON.parse(stdout());
    expect(payload.prompt).toBe('ping');
    expect(payload.schedule).toBe('*/5 * * * *');
    expect(payload.model).toBe('MINOS');
    expect(typeof payload.id).toBe('string');
  });
});

describe('spycore cron list', () => {
  test('reports empty state', async () => {
    await runCli(['list']);
    expect(stdout()).toContain('(no scheduled prompts)');
  });

  test('lists added entries', async () => {
    await runCli(['add', '--prompt', 'Morning brief', '--schedule', '0 8 * * *']);
    stdoutChunks = [];
    await runCli(['list']);
    expect(stdout()).toContain('Morning brief');
    expect(stdout()).toContain('0 8 * * *');
  });

  test('--json lists entries as payload', async () => {
    await runCli(['add', '--prompt', 'A', '--schedule', '* * * * *']);
    stdoutChunks = [];
    await runCli(['list'], ['--json']);
    const payload = JSON.parse(stdout());
    expect(payload.prompts).toHaveLength(1);
    expect(payload.prompts[0].prompt).toBe('A');
  });
});

describe('spycore cron remove', () => {
  test('fails for an unknown id', async () => {
    await expect(runCli(['remove', 'no-such-id', '--yes'])).rejects.toThrow(/No scheduled prompt/);
  });

  test('removes an entry by id', async () => {
    await runCli(['add', '--prompt', 'temp', '--schedule', '* * * * *'], ['--json']);
    const id = JSON.parse(stdout()).id as string;
    stdoutChunks = [];
    await runCli(['remove', id, '--yes']);
    expect(stdout()).toContain('Removed scheduled prompt');
    stdoutChunks = [];
    await runCli(['list']);
    expect(stdout()).toContain('(no scheduled prompts)');
  });

  test('--json reports the removed id', async () => {
    await runCli(['add', '--prompt', 'temp', '--schedule', '* * * * *'], ['--json']);
    const id = JSON.parse(stdout()).id as string;
    stdoutChunks = [];
    await runCli(['remove', id, '--yes'], ['--json']);
    expect(JSON.parse(stdout())).toEqual({ removed: id });
  });
});
