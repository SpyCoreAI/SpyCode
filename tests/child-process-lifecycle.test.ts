/**
 * THE CHILD-PROCESS LIFECYCLE CLASS - one guard owning the invariant that no
 * spawn site may hold the CLI open after its work is done.
 *
 * WHY THIS FILE EXISTS. F-2b fixed the hook hang on the PROMISE axis - the wait
 * can no longer outlive the cap - and the hang did not close, it MOVED: the
 * process was still held at natural exit by a descendant that inherited the
 * child's stdio pipes. Measured on the real wiring before the fix: a hook
 * leaving a 3s survivor settled at 206ms and the PROCESS exited at 3,159ms;
 * with a long-lived survivor it never exited at all. `runShellCommand` was
 * worse - it had no `'exit'` handler, so its promise never settled either. And
 * the MCP stdio transport, which every audit had graded correct because it
 * settles on `'exit'` OR `'close'`, held the process for the same reason
 * : correct on the promise axis, defective on the process axis, which
 * nobody had asked it.
 *
 * WHAT THESE PINS ASSERT, AND WHY IT IS THE RIGHT PROPERTY.
 * `process.getActiveResourcesInfo()` reports the resources currently keeping
 * the event loop alive. An unref'd handle DROPS OUT of that list (verified:
 * `["PipeWrap","PipeWrap","Timeout"]` becomes `["Timeout"]`). "No child pipe
 * remains in that list" is therefore not a proxy for "the process can exit" -
 * it is the same fact, read directly, through the real production functions.
 * The out-of-process confirmation was measured separately during F-2c-2: a real
 * node process driving the real `fireHookEvent` exited at 357ms with a 45s
 * pipe-holding survivor, having never exited at all before the fix.
 *
 * It is deliberately NOT a "spawn the CLI and time its exit" test: that shape
 * would need a TypeScript loader this package does not depend on, and its
 * timing margins are exactly what F-2a filed against the tree-kill pin
 * (thin both ways). This asserts the same property deterministically.
 *
 * POSIX only, like the tree-kill pin: these need a shell that can background a
 * descendant which inherits the parent's pipes.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freshConfigDir } from './helpers.js';

let configDir: string;
let cwd: string;

/** Handles of the given type currently keeping the event loop alive. */
function activeCount(type: string): number {
  return process.getActiveResourcesInfo().filter((r) => r === type).length;
}

beforeEach(() => {
  configDir = freshConfigDir();
  cwd = mkdtempSync(join(tmpdir(), 'spycli-lifecycle-'));
});

afterEach(async () => {
  const { __resetConfigForTests } = await import('../src/lib/config.js');
  __resetConfigForTests();
  vi.resetModules();
  try {
    rmSync(cwd, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('a finished child never keeps the CLI alive', () => {
  /**
   * WEAK-PIN FORM (e): the single mechanism this observes is
   * `releaseChildStdio` in `runHookCommand`'s `settle`. The adjacent way the
   * pipe count could fall - the survivor dying and closing the pipes by itself
   * - is defeated by giving it a 30s lifetime and asserting immediately after a
   * settle that happens in ~200ms. So a pass is reachable only through the
   * release, and a mutation removing it alone must turn this red.
   */
  test.skipIf(process.platform === 'win32')(
    'hooks: a pipe-holding survivor leaves NO child pipe holding the event loop',
    async () => {
      writeFileSync(
        join(configDir, 'hooks.json'),
        JSON.stringify({
          // Exits at once; the backgrounded `sleep` inherits the hook's stdout
          // and stderr and holds them for 30s - far longer than this test.
          hooks: [{ event: 'prompt-submit', command: 'sleep 30 & true', timeoutSeconds: 30 }],
        }),
        'utf8',
      );
      const { loadHookSession, fireHookEvent } = await import('../src/lib/hooks.js');
      const s = await loadHookSession(cwd);
      const before = activeCount('PipeWrap');
      const started = Date.now();
      await fireHookEvent(s, 'prompt-submit', { prompt: 'x' });
      // Settled long before the survivor could have exited on its own, so the
      // pipes are still held by a LIVE process at the moment we assert.
      expect(Date.now() - started).toBeLessThan(1_500);
      expect(activeCount('PipeWrap')).toBe(before);
    },
  );

  /**
   * WEAK-PIN FORM (e) again, and here the union is explicit: `done()` is
   * reachable from `'close'`, from `'error'`, and (new) from `'exit'`+drain.
   * The survivor withholds `'close'` for 30s and the command spawns cleanly, so
   * only the `'exit'` arm can settle this - and the release is asserted
   * separately from the settle, so neither can stand in for the other.
   */
  test.skipIf(process.platform === 'win32')(
    'run_command: a pipe-holding survivor neither withholds the result nor holds the loop',
    async () => {
      const { runShellCommand } = await import('../src/lib/agent/tools.js');
      const before = activeCount('PipeWrap');
      const started = Date.now();
      const r = await runShellCommand('echo work-done; sleep 30 &', cwd, 30_000, undefined);
      const elapsed = Date.now() - started;
      // Before this fix the promise settled at the survivor's lifetime - or,
      // for a long-lived one, never at all.
      expect(elapsed).toBeLessThan(1_500);
      expect(r.timedOut).toBe(false);
      // The fast path's output is NOT lost to the drain settle.
      expect(r.combined).toContain('work-done');
      expect(activeCount('PipeWrap')).toBe(before);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'run_command: an ordinary command still returns its COMPLETE output',
    async () => {
      const { runShellCommand } = await import('../src/lib/agent/tools.js');
      // A burst arriving immediately before exit is the shape a drain settle
      // could plausibly truncate. It does not: `'close'` wins whenever it is
      // going to fire at all, and only then is there output still coming.
      const r = await runShellCommand(`head -c 200000 /dev/zero | tr '\\0' a`, cwd, 30_000, undefined);
      expect(r.exitCode).toBe(0);
      expect(r.combined.length).toBe(200_000);
    },
  );
});

/**
 * THE CENSUS - the ratchet as a property of the SHAPE, not of anyone's
 * memory. F-2a's lesson, ratified as landmine 16, is that a control verified
 * only where it is applied has not been verified: count the sites that bypass
 * it. Three of this package's spawn sites were defective and only two had ever
 * been filed, because nobody had enumerated the population.
 *
 * So the population is enumerated HERE, and a new module that creates a child
 * process turns this red until it is classified. That is the whole point: the
 * next author cannot add a holding spawn site silently.
 *
 * LANDMINE 18 (a parser whose input contains commentary) HANDLED EXPLICITLY
 * AND DIRECTIONALLY: this matches the `node:child_process` IMPORT, which is a
 * structural statement - a commented-out import would make the census
 * OVER-count and fail closed, which is the safe direction, whereas stripping
 * comments could hide a real one. Comments cannot create a child process.
 */
describe('the child-process census - no spawn site may be added unclassified', () => {
  /** Every src module allowed to create a child process, and why it is safe. */
  const SANCTIONED: Record<string, string> = {
    'lib/hooks.ts': 'async spawn; releases its stdio at settle',
    'lib/agent/builtin-tools.ts': 'async spawn; releases its stdio at settle',
    'lib/agent/mcp-client.ts': 'async spawn; releases its stdio at teardown',
    // F2 (LSP): the language-server client spawns one long-lived child per
    // language; releases its stdio at teardown, graceful shutdown→exit order.
    'lib/agent/lsp/client.ts': 'async spawn; releases its stdio at teardown',
    'lib/browser.ts': "fire-and-forget: stdio 'ignore' + unref, so it holds nothing",
    'lib/gh.ts': 'execFileSync - synchronous and bounded by its own timeout',
    'lib/git.ts': 'execFileSync - synchronous and bounded by its own timeout',
    'lib/agent/resume.ts': 'execFileSync - synchronous and bounded by its own timeout',
    // Caught by this census on its first run, and classified here rather than
    // filtered out in the matcher: its import is `import type`, erased at
    // compile time, so it cannot create anything. Narrowing the regex to skip
    // type-only imports would also have to keep matching the MIXED form
    // (`import { spawn, type X }`, which mcp-client.ts uses) - and a matcher
    // that can lose a real spawn site is the wrong direction for a control.
    // Over-matching costs one line here; under-matching costs a silent hole.
    'lib/child-stdio.ts': 'type-only import - the release helper itself never spawns',
    // The interactive TUI's spawn sites, classified on arrival (v0.7.5 TUI).
    'ui/tui/attention.ts': "fire-and-forget: stdio 'ignore' + unref, so it holds nothing",
    'ui/tui/clipboard.ts': 'execFileSync - synchronous; bounded by the clipboard write',
    'ui/tui/shell.ts': "async execFile; settles on 'exit'+drain and releases its stdio at settle",
    'ui/tui/TuiApp.tsx': "spawnSync - synchronous; the user's own $EDITOR",
    // B5: OAuth uses child_process for opening the browser (fire-and-forget).
    'lib/oauth.ts': "fire-and-forget: stdio 'ignore' + unref, so it holds nothing",
    // F14: detached runs spawn the child agent (detached, stdio to log file,
    // unref) and use execFileSync for sysctl (boot time, synchronous).
    'commands/runs.ts': "spawn detached + unref for the child agent; execFileSync (sysctl) for boot time",
  };
  /** Of those, the ones that spawn ASYNCHRONOUSLY must route through the helper. */
  const MUST_RELEASE = ['lib/hooks.ts', 'lib/agent/builtin-tools.ts', 'lib/agent/mcp-client.ts', 'lib/agent/lsp/client.ts', 'ui/tui/shell.ts'];

  function walk(dir: string, base = ''): string[] {
    const out: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) out.push(...walk(join(dir, e.name), rel));
      else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) out.push(rel);
    }
    return out;
  }

  test('exactly the sanctioned modules import node:child_process', () => {
    // fileURLToPath, not URL.pathname: on Windows the latter yields `/C:/…`,
    // which readdirSync cannot open - the census would fail for a reason that
    // has nothing to do with the property it guards.
    const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
    const importers = walk(srcRoot)
      .filter((rel) => /^import\s[^;]*from\s'node:child_process'/m.test(readFileSync(join(srcRoot, rel), 'utf8')))
      .sort();
    expect(importers).toEqual(Object.keys(SANCTIONED).sort());
  });

  test('every asynchronous spawn site routes through releaseChildStdio', () => {
    // fileURLToPath, not URL.pathname: on Windows the latter yields `/C:/…`,
    // which readdirSync cannot open - the census would fail for a reason that
    // has nothing to do with the property it guards.
    const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
    for (const rel of MUST_RELEASE) {
      const source = readFileSync(join(srcRoot, rel), 'utf8');
      expect(source, `${rel} must release its child's stdio`).toContain('releaseChildStdio(');
    }
  });

  test('the drain window has exactly ONE definition', () => {
    // fileURLToPath, not URL.pathname: on Windows the latter yields `/C:/…`,
    // which readdirSync cannot open - the census would fail for a reason that
    // has nothing to do with the property it guards.
    const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
    const definers = walk(srcRoot).filter((rel) =>
      /STDIO_DRAIN_MS\s*=/.test(readFileSync(join(srcRoot, rel), 'utf8')),
    );
    // Two copies of a timing constant that must agree is how the halves of a
    // control drift apart - which is the defect this whole batch is closing.
    expect(definers).toEqual(['lib/child-stdio.ts']);
  });
});
