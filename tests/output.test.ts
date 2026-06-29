import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  configureOutput,
  getOutputOptions,
  info,
  json,
  print,
  success,
  warn,
} from '../src/lib/output.js';

describe('output mode toggles', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    configureOutput({ json: false, color: true });
  });

  test('JSON mode suppresses print/success/info/warn', () => {
    configureOutput({ json: true, color: true });
    print('hi');
    success('done');
    info('thinking');
    warn('careful');
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('JSON mode still emits json() to stdout', () => {
    configureOutput({ json: true, color: true });
    json({ a: 1 });
    expect(stdoutSpy).toHaveBeenCalled();
    const written = String(stdoutSpy.mock.calls[0]?.[0] ?? '');
    expect(written).toContain('"a":1');
  });

  test('warn writes to stderr, success writes to stdout', () => {
    configureOutput({ json: false, color: false });
    success('ok');
    warn('hmm');
    const stdoutWrites = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
    const stderrWrites = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(stdoutWrites).toContain('ok');
    expect(stderrWrites).toContain('hmm');
  });

  test('--no-color disables ANSI codes', () => {
    configureOutput({ json: false, color: false });
    success('plain');
    const written = String(stdoutSpy.mock.calls[0]?.[0] ?? '');
    // No ESC sequence should appear when color is off.
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(written)).toBe(false);
  });

  test('configureOutput is observable via getOutputOptions', () => {
    configureOutput({ json: true, color: false });
    expect(getOutputOptions().json).toBe(true);
    expect(getOutputOptions().color).toBe(false);
  });
});
