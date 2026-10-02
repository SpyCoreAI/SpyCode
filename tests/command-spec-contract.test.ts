/**
 * THE COMMAND-SPEC CONTRACT GATE (F-2c-49, finding `F-N7`).
 *
 * `src/lib/completion/spec.ts` is not documentation. It is a MACHINE-READABLE
 * CONTRACT with two shipped consumers:
 *   1. `spycore schema [--json]` — a published JSON Schema of the CLI surface,
 *      emitted expressly "for machine consumption";
 *   2. the bash / zsh / fish / powershell completion generators.
 * A command or flag missing from it cannot be tab-completed and is absent from
 * the schema a third party reads. So the spec drifting behind the code is a
 * defect in a shipped artefact, not a stale note.
 *
 * ⭐ WHY THIS FILE EXISTS AT ALL. `spec.ts`'s header promised that
 * `tests/completion.test.ts` "enforces this contract programmatically — if you
 * add or remove a real flag without updating this spec, the contract test will
 * fail." Measured at F-2c-49, that test compared a HARDCODED list of 18 command
 * names against the spec with `toContain`: it never read `src/commands/**`, it
 * was one-directional, and it asserted NOTHING about flags. The drift it
 * promised to prevent had reached 14 commands and 43 flags. This file is that
 * promised control, built rather than the sentence softened.
 *
 * ⭐ THE ONE RULE THIS FILE MUST OBEY: the two sides are read INDEPENDENTLY.
 * The registered side is derived by EXECUTING the real `register*` functions
 * onto a fresh commander program, with the call list read out of the shipped
 * `src/index.ts`. The spec side is read from `COMMAND_SPEC`. Deriving either
 * from the other would produce a gate that passes by construction and could
 * never fail — which is precisely the shape that let `F-N7` live.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command, Option } from 'commander';
import { COMMAND_SPEC } from '../src/lib/completion/spec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, '..');
const SRC = join(CLI_ROOT, 'src');

/**
 * DECLARED EXCLUSIONS. Every entry is a deliberate decision with a reason, not
 * a convenience. A silent skip would let this gate hide the very drift it
 * exists to catch, so the exclusions are themselves asserted below: each must
 * still be reachable, or the list has gone stale.
 */
const EXCLUDED_COMMANDS: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: '__ui-preview',
    why: 'hidden dev-only TUI preview; excluded from --help by design, so advertising it in completions would contradict the code',
  },
  {
    path: '__md-preview',
    why: 'hidden dev-only Markdown preview; same reason',
  },
];
const EXCLUDED_PATHS = new Set(EXCLUDED_COMMANDS.map((e) => e.path));

/** Floors, bound to the populations measured at F-2c-49. An enumeration that
 *  silently returns nothing must not be able to pass this file. */
const FLOOR_REGISTER_CALLS = 25;
const FLOOR_REGISTERED_COMMANDS = 60;
const FLOOR_REGISTERED_FLAGS = 100;
const FLOOR_SPEC_COMMANDS = 60;
const FLOOR_SPEC_FLAGS = 100;

interface Node {
  path: string[];
  hidden: boolean;
  flags: string[];
}

/** Build the SHIPPED command tree by executing the real registrations. */
async function buildRegisteredTree(): Promise<Node[]> {
  const indexSrc = readFileSync(join(SRC, 'index.ts'), 'utf8');

  const moduleOf = new Map<string, string>();
  for (const m of indexSrc.matchAll(
    /import\s*\{([^}]+)\}\s*from\s*'(\.\/commands\/[^']+)'/g,
  )) {
    for (const raw of m[1]!.split(',')) {
      const name = raw.trim();
      if (name.startsWith('register')) moduleOf.set(name, m[2]!);
    }
  }

  const calls: string[] = [];
  for (const m of indexSrc.matchAll(/^\s*(register[A-Za-z]+)\s*\(\s*program/gm)) {
    if (!calls.includes(m[1]!)) calls.push(m[1]!);
  }
  expect(
    calls.length,
    'FLOOR: the register* call list was read out of src/index.ts and came back too small — the derivation is broken, not the code',
  ).toBeGreaterThanOrEqual(FLOOR_REGISTER_CALLS);
  for (const c of calls) {
    expect(moduleOf.has(c), `${c} is called in index.ts but never imported there`).toBe(true);
  }

  const pkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  };
  const program = new Command();
  program
    .name('spycore')
    .description('SpyCore AI command-line interface')
    .version(pkg.version, '-v, --version', 'Display CLI version')
    .addOption(new Option('--api-url <url>'))
    .addOption(new Option('--json'))
    .addOption(new Option('--no-color'));

  for (const call of calls) {
    const rel = moduleOf.get(call)!.replace(/^\.\//, '').replace(/\.js$/, '.ts');
    const mod = (await import(/* @vite-ignore */ join(SRC, rel))) as Record<string, unknown>;
    const fn = mod[call];
    expect(typeof fn, `${call} is not exported as a function by ${moduleOf.get(call)}`).toBe(
      'function',
    );
    (fn as (p: Command, v: string) => void)(program, pkg.version);
  }

  const out: Node[] = [];
  const walk = (cmd: Command, path: string[]): void => {
    for (const sub of cmd.commands) {
      const p = [...path, sub.name()];
      // commander AUTO-ADDS a hidden `help` subcommand to any command that has
      // subcommands. It is not authored surface, so it is not spec surface.
      const isAutoHelp = sub.name() === 'help' && Boolean((sub as unknown as { _hidden?: boolean })._hidden);
      if (!isAutoHelp) {
        out.push({
          path: p,
          hidden: Boolean((sub as unknown as { _hidden?: boolean })._hidden),
          flags: sub.options.map((o) => o.long ?? o.short).filter((x): x is string => Boolean(x)),
        });
      }
      walk(sub, p);
    }
  };
  walk(program, []);
  return out;
}

function specNodes(): Node[] {
  const out: Node[] = [];
  const walk = (node: { name?: string; subcommands?: readonly unknown[]; options?: readonly unknown[] }, path: string[]): void => {
    for (const sub of (node.subcommands ?? []) as Array<{
      name: string;
      subcommands?: readonly unknown[];
      options?: ReadonlyArray<{ name: string }>;
    }>) {
      const p = [...path, sub.name];
      out.push({ path: p, hidden: false, flags: (sub.options ?? []).map((o) => o.name) });
      walk(sub, p);
    }
  };
  walk(COMMAND_SPEC as never, []);
  return out;
}

const key = (n: Node): string => n.path.join(' ');

describe('command spec contract — the shipped tree and the shipped spec agree', () => {
  test('both enumerations are non-empty and meet their floors', async () => {
    const registered = await buildRegisteredTree();
    const specced = specNodes();
    expect(
      registered.length,
      'FLOOR: walking the real commander tree produced too few commands',
    ).toBeGreaterThanOrEqual(FLOOR_REGISTERED_COMMANDS);
    expect(
      registered.reduce((a, n) => a + n.flags.length, 0),
      'FLOOR: walking the real commander tree produced too few flags',
    ).toBeGreaterThanOrEqual(FLOOR_REGISTERED_FLAGS);
    expect(specced.length, 'FLOOR: COMMAND_SPEC produced too few commands').toBeGreaterThanOrEqual(
      FLOOR_SPEC_COMMANDS,
    );
    expect(
      specced.reduce((a, n) => a + n.flags.length, 0),
      'FLOOR: COMMAND_SPEC produced too few flags',
    ).toBeGreaterThanOrEqual(FLOOR_SPEC_FLAGS);
  });

  test('every declared exclusion is still real — the list has not gone stale', async () => {
    const registered = await buildRegisteredTree();
    const paths = new Set(registered.map(key));
    expect(EXCLUDED_COMMANDS.length).toBeGreaterThan(0);
    for (const { path, why } of EXCLUDED_COMMANDS) {
      expect(paths.has(path), `excluded "${path}" no longer exists — drop the exclusion (${why})`).toBe(
        true,
      );
      expect(why.length, `exclusion "${path}" carries no reason`).toBeGreaterThan(20);
    }
  });

  // ── DIRECTION B — implemented but NOT specced: an UNDOCUMENTED SURFACE. It
  //    ships, users depend on it, and nothing describes or constrains it.
  test('every registered command has a spec entry', async () => {
    const registered = await buildRegisteredTree();
    const specced = new Set(specNodes().map(key));
    const missing = registered
      .filter((n) => !EXCLUDED_PATHS.has(key(n)))
      .map(key)
      .filter((k) => !specced.has(k))
      .sort();
    expect(
      missing,
      'these commands ship but are absent from COMMAND_SPEC, so `spycore schema` under-reports them and no shell can complete them',
    ).toEqual([]);
  });

  test('every registered flag has a spec entry', async () => {
    const registered = await buildRegisteredTree();
    const specBy = new Map(specNodes().map((n) => [key(n), new Set(n.flags)]));
    const missing: string[] = [];
    for (const node of registered) {
      if (EXCLUDED_PATHS.has(key(node))) continue;
      const known = specBy.get(key(node));
      if (!known) continue; // the command-level test owns this case
      for (const flag of node.flags) if (!known.has(flag)) missing.push(`${key(node)} ${flag}`);
    }
    expect(
      missing.sort(),
      'these flags are accepted by the CLI but absent from COMMAND_SPEC — they cannot be tab-completed and the published schema omits them',
    ).toEqual([]);
  });

  // ── DIRECTION A — specced but NOT implemented: a BROKEN PROMISE. A user
  //    reads it, or tab-completes it, and it is not there.
  test('every specced command is actually registered', async () => {
    const registered = new Set((await buildRegisteredTree()).map(key));
    const orphans = specNodes()
      .map(key)
      .filter((k) => !registered.has(k))
      .sort();
    expect(
      orphans,
      'these commands are advertised by the spec (and so by completions and `spycore schema`) but no command registers them',
    ).toEqual([]);
  });

  test('every specced flag is actually registered', async () => {
    const registered = await buildRegisteredTree();
    const regBy = new Map(registered.map((n) => [key(n), new Set(n.flags)]));
    const orphans: string[] = [];
    for (const node of specNodes()) {
      const real = regBy.get(key(node));
      if (!real) continue; // the command-level test owns this case
      for (const flag of node.flags) if (!real.has(flag)) orphans.push(`${key(node)} ${flag}`);
    }
    expect(
      orphans.sort(),
      'these flags are advertised by the spec but the command does not accept them — tab-completing one produces an error',
    ).toEqual([]);
  });
});
