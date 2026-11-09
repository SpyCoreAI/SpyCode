import { beforeEach, describe, expect, test, vi } from 'vitest';

// The old test spawned a REAL browser on every run and asserted almost
// nothing (openInBrowser returns true synchronously even when the opener
// binary is missing). The spawn and the platform switch are mocked here,
// so the test proves the exact command/args/flags per platform and no
// browser ever launches.
const { spawnMock, platformMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
  platformMock: vi.fn(() => 'linux'),
}));

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('node:os', () => ({ default: { platform: platformMock } }));

import { openInBrowser } from '../src/lib/browser.js';

const SPAWN_OPTS = { detached: true, stdio: 'ignore', windowsHide: true } as const;

beforeEach(() => {
  vi.clearAllMocks();
  platformMock.mockReturnValue('linux');
});

describe('openInBrowser', () => {
  test('rejects non-http(s) schemes without spawning anything (M1: command injection)', () => {
    // On Windows these would be interpreted by cmd.exe as command separators.
    expect(openInBrowser('javascript:alert(1)')).toBe(false);
    expect(openInBrowser('file:///etc/passwd')).toBe(false);
    expect(openInBrowser('ftp://example.com/x')).toBe(false);
    expect(openInBrowser('data:text/html,<h1>x</h1>')).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('rejects unparseable input without spawning anything', () => {
    expect(openInBrowser('not a url')).toBe(false);
    expect(openInBrowser('')).toBe(false);
    expect(openInBrowser('example.com')).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  test('macOS spawns `open` with the URL as a single argv element', () => {
    platformMock.mockReturnValue('darwin');
    expect(openInBrowser('https://example.com/?a=1&b=2')).toBe(true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      'open',
      ['https://example.com/?a=1&b=2'],
      SPAWN_OPTS,
    );
  });

  test('Windows spawns explorer.exe with the URL as a single argv element (no cmd.exe)', () => {
    // The old shape (cmd.exe /c start "" <url>) was the defect: libuv only
    // quotes argv elements containing space/tab/quote, so the `&` in an
    // OAuth authorize URL reached cmd.exe as a command separator.
    // explorer.exe takes the URL as one argv element with no command-line
    // parsing, so & and %XX ride verbatim.
    platformMock.mockReturnValue('win32');
    expect(openInBrowser('https://example.com/?a=1&b=2')).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      'explorer.exe',
      ['https://example.com/?a=1&b=2'],
      SPAWN_OPTS,
    );
    expect(spawnMock).not.toHaveBeenCalledWith(
      'cmd.exe',
      expect.anything(),
      expect.anything(),
    );
  });

  test('Linux spawns xdg-open with the URL as a single argv element', () => {
    expect(openInBrowser('https://example.com/?a=1&b=2')).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith('xdg-open', ['https://example.com/?a=1&b=2'], SPAWN_OPTS);
  });

  test('a shell metacharacter in an https URL rides the argv verbatim (spawn, not a shell)', () => {
    expect(openInBrowser('https://example.com/x; rm -rf /')).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      'xdg-open',
      ['https://example.com/x; rm -rf /'],
      SPAWN_OPTS,
    );
  });

  test('a spawn that throws synchronously reports false', () => {
    spawnMock.mockImplementationOnce(() => {
      throw new Error('spawn ENOENT');
    });
    expect(openInBrowser('https://example.com/')).toBe(false);
  });

  test('a spawn error AFTER launch is swallowed (true: the call itself succeeded)', () => {
    const handlers: Record<string, () => void> = {};
    spawnMock.mockReturnValueOnce({
      on: vi.fn((event: string, fn: () => void) => {
        handlers[event] = fn;
      }),
      unref: vi.fn(),
    });
    expect(openInBrowser('https://example.com/')).toBe(true);
    expect(handlers['error']).toBeDefined();
    expect(() => handlers['error']?.()).not.toThrow();
  });

  test('the spawned child is detached and unrefed (does not keep the CLI alive)', () => {
    const unref = vi.fn();
    spawnMock.mockReturnValueOnce({ on: vi.fn(), unref });
    expect(openInBrowser('https://example.com/')).toBe(true);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
