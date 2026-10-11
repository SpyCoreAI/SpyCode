import { describe, expect, test } from 'vitest';
import { createMarkdownRenderer } from '../src/lib/markdown.js';

describe('createMarkdownRenderer (no-color, deterministic output)', () => {
  test('renders headings without ansi when color=false', () => {
    const r = createMarkdownRenderer({ color: false });
    const out = r.write('# Heading\n## Sub\n### Smaller\n') + r.flush();
    expect(out).toContain('Heading');
    expect(out).toContain('Sub');
    expect(out).toContain('Smaller');
    // No ANSI escape sequences when color is off.
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(out)).toBe(false);
  });

  test('preserves inline code spans without colour', () => {
    const r = createMarkdownRenderer({ color: false });
    const out = r.write('Use `npm install` to set up.\n') + r.flush();
    expect(out).toContain('npm install');
  });

  test('renders bullet and numbered lists with prefixes', () => {
    const r = createMarkdownRenderer({ color: false });
    const out = r.write('- one\n- two\n1. first\n2. second\n') + r.flush();
    expect(out).toMatch(/• one/);
    expect(out).toMatch(/• two/);
    expect(out).toMatch(/1\. first/);
    expect(out).toMatch(/2\. second/);
  });

  test('handles fenced code blocks across multiple chunks', () => {
    const r = createMarkdownRenderer({ color: false });
    const part1 = r.write('Here is code:\n```js\nconst x = ');
    const part2 = r.write('1;\nconsole.log(x);\n');
    const part3 = r.write('```\n') + r.flush();
    const full = part1 + part2 + part3;
    expect(full).toContain('const x = 1;');
    expect(full).toContain('console.log(x);');
  });

  test('flush emits trailing buffered text without a newline', () => {
    const r = createMarkdownRenderer({ color: false });
    const a = r.write('partial without newline');
    expect(a).toBe('');
    const b = r.flush();
    expect(b).toContain('partial without newline');
  });

  test('flush completes an unterminated code fence', () => {
    const r = createMarkdownRenderer({ color: false });
    const a = r.write('```py\nprint(1)\n');
    const b = r.flush();
    const full = a + b;
    expect(full).toContain('print(1)');
  });

  test('blockquote rendering preserves content', () => {
    const r = createMarkdownRenderer({ color: false });
    const out = r.write('> hello world\n') + r.flush();
    expect(out).toContain('hello world');
  });

  test('horizontal rule renders as a divider line', () => {
    const r = createMarkdownRenderer({ color: false });
    const out = r.write('top\n---\nbottom\n') + r.flush();
    // We render the rule as a sequence of box-drawing characters; just
    // confirm the surrounding text is preserved and the rule is non-empty.
    expect(out).toContain('top');
    expect(out).toContain('bottom');
    const rule = out.split('\n')[1] ?? '';
    expect(rule.length).toBeGreaterThan(0);
  });

  test('color mode emits ANSI escape sequences', () => {
    const r = createMarkdownRenderer({ color: true });
    const out = r.write('# hello\n') + r.flush();
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(out)).toBe(true);
  });

  test('streamed inline bold completes correctly across chunks', () => {
    const r = createMarkdownRenderer({ color: false });
    // bold opens on one line, content arrives, then a newline closes.
    const a = r.write('this is **very ');
    const b = r.write('important**\nnext line\n');
    const c = r.flush();
    const full = a + b + c;
    expect(full).toContain('very important');
    expect(full).toContain('next line');
  });
});
