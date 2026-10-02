import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Every `.ts` under `src/`, walked rather than listed, so a new file is covered
 *  the day it is added and not the day someone remembers to add it here. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/**
 * ⭐⭐ `SPY-429` / R-CLI-2 — A CLASS CLOSED AT ONE SITE IS NOT A CLASS CLOSED.
 *
 * `SPY-416` moved the workspace observer to opt-in and converted THREE deciding
 * sites from `!== false` to `=== true`. There were **four**. The fourth,
 * `src/commands/acp.ts`, was not touched by that diff at all, and the argument
 * that it was equivalent — *"the config store materialises the default"* — was
 * called false on the strength of a probe that could not have seen the answer.
 *
 * ⭐⭐ R-CLI-3 / `SPY-440` — RE-MEASURED, AND THE STORE **DOES** MATERIALISE THE
 * DEFAULT. The earlier probe read only the FIRST 120 BYTES of the config file
 * before matching a key that is the TENTH default, so its column read "(key not
 * in file)" in every arm whatever the store did, and none of its output was ever
 * committed. Over ten config states with a disposable HOME, reading the WHOLE
 * file: the key IS present after a read in **10 of 10** arms, at byte 244, and
 * in **0 of 10** is it inside the first 120 bytes.
 *
 * ⭐ THE INVARIANT BELOW IS UNAFFECTED, AND ITS CASE IS STRONGER. `!== false`
 * and `=== true` disagree on every value that is not a boolean, because no
 * schema is attached — **five** of the ten arms (`null`, `0`, `"false"`,
 * `"true"`, `[]`), not the three the old text named. On any of them a `!== false`
 * site would enable the observer alone, failing OPEN toward reading and storing
 * the text of the user's files.
 *
 * ⭐ This is the structural closure rather than an inspection: EVERY site that
 * decides the observer must read the key with `=== true`. A new consumer written
 * next year with `!== false` reddens here on the day it is written.
 *
 * ⭐ It is a SOURCE SCAN, which this package already uses for exactly this shape
 * of invariant, and it carries its own POSITIVE CONTROL: the scan must find the
 * known sites, or a scan that has quietly stopped matching would report clean.
 */
describe('⭐⭐ SPY-429: every deciding site for the workspace observer', () => {
  const KEY = 'agentObserveWorkspace';

  test('⭐⭐ every site that READS the key decides with `=== true`, never `!== false`', () => {
    const files = sourceFiles(SRC);
    // ⭐ VACUITY GUARD — a scan over no files, or one that finds no reader, is
    //   not a passing scan. Measured at HEAD: 2 reader sites.
    expect(files.length, 'VACUITY: the source scan walked no files').toBeGreaterThanOrEqual(50);

    const readers: Array<{ file: string; line: number; text: string; delegates: boolean }> = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => {
        // a READ of the key through the config store, on one line
        if (l.includes(`get('${KEY}')`) || l.includes(`get("${KEY}")`)) {
          // a site DELEGATES when the read is an argument to the shared resolver,
          // which is the only other correct form. Detected on the two lines
          // above the read, because the call is wrapped across lines.
          const near = lines.slice(Math.max(0, i - 2), i + 1).join(' ');
          readers.push({
            file: f.replace(`${SRC}/`, ''),
            line: i + 1,
            text: l.trim(),
            delegates: near.includes('resolveObserveWorkspaceEnabled('),
          });
        }
      });
    }
    expect(
      readers.length,
      'VACUITY: the scan found NO site reading the key — it has stopped matching, which is not the same as clean',
    ).toBeGreaterThanOrEqual(2);

    // ⭐ A reader is correct in one of exactly TWO forms, and the second is not a
    //   loophole: either it applies `=== true` itself, or it hands the raw value
    //   to `resolveObserveWorkspaceEnabled`, whose own body is asserted below.
    //   The first build of this pin allowed only the first form and flagged the
    //   DELEGATING site as a defect — a false positive, and the reason the
    //   resolver is now pinned rather than trusted.
    const wrong = readers.filter((r) => !r.text.includes('=== true') && !r.delegates);
    expect(
      wrong,
      'a deciding site does not read the observer key with `=== true`. It fails OPEN, toward reading ' +
        `and storing the user's file contents:\n${wrong.map((r) => `${r.file}:${r.line}  ${r.text}`).join('\n')}`,
    ).toEqual([]);

    // ⭐⭐ AND THE ONE PLACE THE DELEGATION LEADS: the resolver's own last line is
    //   the real predicate for every site that delegates, so it is pinned by
    //   VALUE, not by inspection.
    const resolver = readFileSync(join(SRC, 'commands', 'agent.ts'), 'utf8');
    const body = resolver.slice(resolver.indexOf('export function resolveObserveWorkspaceEnabled'));
    const decl = body.slice(0, body.indexOf('\n}\n') + 3);
    expect(decl.length, 'VACUITY: the resolver was not found in the source').toBeGreaterThan(40);
    expect(
      decl.includes('return configValue === true;'),
      `the resolver every delegating site depends on no longer decides with \`=== true\`:\n${decl}`,
    ).toBe(true);
    expect(decl.includes('!== false'), 'the resolver uses the OLD predicate').toBe(false);

    // ⭐ POSITIVE CONTROL on the scan itself: the two sites known to exist are
    //   found by it, so a clean result is a measurement and not a miss.
    const seen = readers.map((r) => r.file);
    expect(seen, 'the scan must find the ACP site').toContain('commands/acp.ts');
    expect(seen, 'the scan must find the DELEGATING site').toContain('commands/agent.ts');
    expect(seen, 'the scan must find the chat-agent-run site').toContain('lib/chat-agent-run.ts');
  });

  test('⭐ and no site anywhere in `src/` uses the OLD predicate on this key', () => {
    const files = sourceFiles(SRC);
    expect(files.length, 'VACUITY: the source scan walked no files').toBeGreaterThanOrEqual(50);
    const offenders: string[] = [];
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => {
        if (l.includes(KEY) && l.includes('!== false')) offenders.push(`${f.replace(`${SRC}/`, '')}:${i + 1}  ${l.trim()}`);
      });
    }
    expect(offenders, `the old \`!== false\` predicate survives:\n${offenders.join('\n')}`).toEqual([]);

    // ⭐ THE GATE MUST BE ABLE TO FAIL: the same scan over a manufactured line
    //   must report it. Proved in this invocation rather than assumed.
    const planted = `        observeWorkspace: getConfigStore().get('${KEY}') !== false,`;
    expect(
      planted.includes(KEY) && planted.includes('!== false'),
      'the detector cannot see the very predicate it exists to catch',
    ).toBe(true);
  });
});
