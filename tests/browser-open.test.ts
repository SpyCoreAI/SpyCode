import { describe, expect, test } from 'vitest';
import { openInBrowser } from '../src/lib/browser.js';

describe('openInBrowser', () => {
  test('rejects non-http(s) schemes without spawning anything (M1: command injection)', () => {
    // On Windows these would be interpreted by cmd.exe as command separators.
    expect(openInBrowser('javascript:alert(1)')).toBe(false);
    expect(openInBrowser('file:///etc/passwd')).toBe(false);
    expect(openInBrowser('ftp://example.com/x')).toBe(false);
    expect(openInBrowser('data:text/html,<h1>x</h1>')).toBe(false);
  });

  test('rejects unparseable input', () => {
    expect(openInBrowser('not a url')).toBe(false);
    expect(openInBrowser('')).toBe(false);
    expect(openInBrowser('example.com')).toBe(false);
  });

  test('a shell metacharacter in an https URL cannot escape the scheme gate', () => {
    expect(openInBrowser('https://example.com/?a=1&b=2')).toBe(true);
    expect(openInBrowser('https://example.com/x; rm -rf /')).toBe(true);
    // Note: the URL is passed as an argv element (spawn, not a shell), so
    // metacharacters ride the argv verbatim - there is no shell to inject.
  });
});
