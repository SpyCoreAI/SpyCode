import { describe, expect, test } from 'vitest';
import {
  braceCollapsed,
  braceExpansions,
  candidateArgvs,
  effectiveWords,
  parseShell,
} from '../src/lib/agent/shell-parse.js';

describe('brace ranges', () => {
  test('descending char and numeric ranges expand in reverse', () => {
    expect(braceExpansions('{c..a}')).toEqual(['c', 'b', 'a']);
    expect(braceExpansions('{5..1}')).toEqual(['5', '4', '3', '2', '1']);
    // Single digits take the char path; multi-digit ranges take numRange.
    expect(braceExpansions('{10..5}')).toEqual(['10', '9', '8', '7', '6', '5']);
  });

  test('an over-cap char range and a non-finite numeric range are refused, not expanded', () => {
    expect(braceExpansions('{0..z}')).toEqual([]);
    expect(braceCollapsed('{0..z}')).toEqual(['0']);
    expect(braceExpansions(`{1..${'9'.repeat(400)}}`)).toEqual([]);
    expect(braceCollapsed(`{1..${'9'.repeat(400)}}`)).toEqual(['1']);
  });
});

describe('substitution interiors inside ${...}', () => {
  test('backtick interiors are collected', () => {
    expect(parseShell('echo ${x:-`ls`}').substitutions).toContain('ls');
  });

  test('an unterminated single quote stops the scan before the substitution', () => {
    const p = parseShell('echo ${x:-"a\'b"$(ls)}');
    expect(p.substitutions).not.toContain('ls');
  });

  test('an unterminated $() stops the scan', () => {
    const p = parseShell('echo ${x:-$(abc}');
    expect(p.substitutions).toHaveLength(0);
  });

  test('an unterminated backtick stops the scan', () => {
    const p = parseShell('echo ${x:-`ls}');
    expect(p.substitutions).toHaveLength(0);
  });
});

describe('quoting corners', () => {
  test('a backslash at the end of a double-quoted word fails closed', () => {
    const p = parseShell('echo "abc\\');
    expect(p.confident).toBe(false);
  });

  test('ANSI-C escapes resolve \\U and \\c', () => {
    expect(parseShell(String.raw`echo $'\U0001F600'`).commands[0]!.words[1]!.value).toBe('😀');
    expect(parseShell(String.raw`echo $'\cA'`).commands[0]!.words[1]!.value).toBe('\u0001');
  });

  test('an out-of-range $\\U code point stays verbatim instead of throwing', () => {
    // parseShell promises never to throw, but String.fromCodePoint throws
    // past 0x10FFFF - and the screeners call it unguarded, so --verify died
    // after the agent work with a cryptic RangeError. The escape is kept
    // literally, like any unrecognised escape.
    for (const bad of [String.raw`echo $'\U00110000'`, String.raw`echo $'\UFFFFFFFF'`]) {
      // Must not throw: parseShell promises never to throw.
      const parsed = parseShell(bad);
      expect(parsed.commands[0]!.words[1]!.value).toContain('\\U');
    }
    // In-range escapes still resolve (including the top of the range).
    expect(parseShell(String.raw`echo $'\U0010FFFF'`).commands[0]!.words[1]!.value).toBe(
      String.fromCodePoint(0x10ffff),
    );
  });

  test('a $() with an unterminated single quote fails closed', () => {
    expect(parseShell("echo $(echo 'abc)").confident).toBe(false);
  });

  test('a $() with an escaped quote inside double quotes parses', () => {
    const p = parseShell('echo $(grep -c "a\\"b" x)');
    expect(p.confident).toBe(true);
    expect(p.substitutions).toHaveLength(1);
  });
});

describe('depth-cap disambiguation', () => {
  test('a span that closes past the depth cap fails closed via the uncapped scan', () => {
    const deep = 'echo "$(a\'b)c\'d$(e"f\\"g"h$(i$(j$(k$(l$(m$(n$(o)))))))))"';
    expect(parseShell(deep).confident).toBe(false);
  });

  test('a span with an unterminated double quote past the depth cap also fails closed', () => {
    const deep = 'echo "$(a$(b$(c$(d$(e$(f$(g$(h$(i"j)))))))))';
    expect(parseShell(deep).confident).toBe(false);
  });
});

describe('wrapper and candidate readings', () => {
  test('two consecutive wrapper options are both skipped', () => {
    const cmd = parseShell('sudo -a -b ls').commands[0]!;
    expect(effectiveWords(cmd)[0]!.value).toBe('ls');
  });

  test('two stacked wrappers are both stripped', () => {
    const cmd = parseShell('sudo sudo ls').commands[0]!;
    expect(effectiveWords(cmd)[0]!.value).toBe('ls');
  });

  test('a wrapper argument that trims to one token offers no packed reading', () => {
    const cmd = parseShell('sudo " x "').commands[0]!;
    const argvs = candidateArgvs(cmd);
    expect(argvs.length).toBeGreaterThanOrEqual(1);
    expect(argvs.every((a) => a.length >= 1)).toBe(true);
  });
});
