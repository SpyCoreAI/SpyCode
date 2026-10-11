import { describe, expect, test } from 'vitest';
import {
  formatOutput,
  isOutputFormat,
  OUTPUT_FORMATS,
} from '../src/lib/output-formats/index.js';

describe('output-formats', () => {
  test('OUTPUT_FORMATS contains exactly the documented presets', () => {
    expect([...OUTPUT_FORMATS].sort()).toEqual(
      ['json', 'markdown', 'text', 'yaml'].sort(),
    );
  });

  test('isOutputFormat acts as a type guard', () => {
    expect(isOutputFormat('json')).toBe(true);
    expect(isOutputFormat('xml')).toBe(false);
  });

  test('json format pretty-prints with 2-space indent', () => {
    const out = formatOutput({ a: 1 }, 'json');
    expect(out).toBe('{\n  "a": 1\n}');
  });

  test('markdown format renders array-of-objects as a table', () => {
    const out = formatOutput(
      [
        { id: 'a', n: 1 },
        { id: 'b', n: 2 },
      ],
      'markdown',
    );
    expect(out).toContain('| id | n |');
    expect(out).toContain('| --- | --- |');
    expect(out).toContain('| a | 1 |');
    expect(out).toContain('| b | 2 |');
  });

  test('markdown escapes pipe characters in cells', () => {
    const out = formatOutput([{ name: 'a|b' }], 'markdown');
    expect(out).toContain('a\\|b');
  });

  test('markdown renders single object as a bullet list', () => {
    const out = formatOutput({ id: 'x', plan: 'Pro' }, 'markdown');
    expect(out).toContain('- **id**: x');
    expect(out).toContain('- **plan**: Pro');
  });

  test('yaml emits scalars unquoted when safe', () => {
    expect(formatOutput({ name: 'hermes', count: 7 }, 'yaml')).toBe(
      'name: hermes\ncount: 7',
    );
  });

  test('yaml quotes strings that look like keywords or numbers', () => {
    const out = formatOutput({ active: 'true', id: '42' }, 'yaml');
    expect(out).toContain('active: "true"');
    expect(out).toContain('id: "42"');
  });

  test('yaml handles nested objects and arrays', () => {
    const out = formatOutput(
      {
        models: [
          { slug: 'hermes', tier: 'free' },
          { slug: 'minos', tier: 'pro' },
        ],
      },
      'yaml',
    );
    expect(out).toContain('models:');
    expect(out).toContain('- slug: hermes');
    expect(out).toContain('  tier: free');
    expect(out).toContain('- slug: minos');
  });

  test('yaml renders multiline strings as block-literal scalars', () => {
    const out = formatOutput({ note: 'line1\nline2' }, 'yaml');
    expect(out).toContain('note: |-');
    expect(out).toContain('  line1');
    expect(out).toContain('  line2');
  });

  test('text format passthrough for strings, JSON for objects', () => {
    expect(formatOutput('hello', 'text')).toBe('hello');
    expect(formatOutput({ a: 1 }, 'text')).toBe('{\n  "a": 1\n}');
  });

});

describe('schema command (via direct invocation)', () => {
  /**
   * F-2c-50 - THIS TEST ASSERTED NOTHING, AND IT IS THE SECOND SITE OF THE
   * CLASS `F-N13` NAMED (the first is tests/cli-gates/doc-claims.test.ts).
   *
   * The version it replaces carried this exact title and:
   * · built `const program = new Command()`, called `registerSchemaCommand`
   * onto it, and NEVER READ THE PROGRAM - the schema its own comment said it
   * was rebuilding was never built, let alone inspected;
   * · asserted `for (const name of expectedNames) expect(expectedNames)
   * .toContain(name)` - a list asserted to contain its own elements, which
   * is true of every list.
   *
   * IT WAS STRICTLY WEAKER THAN `F-N13`: that one at least carried a
   * non-vacuity floor (`listed.length > 10`). This one had none, so it also
   * passed over an EMPTY spec - the loop body simply never ran.
   *
   * WHAT IT NOW PINS, and what it deliberately does NOT. The two sides are
   * `COMMAND_SPEC` as data, and the schema the SHIPPED command actually emits
   * after `buildSchema`/`flattenCommands` and JSON serialization. That is a real
   * transform which can regress - dropping the recursion, mis-nesting a path, or
   * truncating the output all turn this red. It does NOT assert that the spec
   * covers the shipped CLI; that stronger property is
   * tests/command-spec-contract.test.ts (F-2c-49), and the two are complementary
   * rather than overlapping.
   */
  test('schema includes every spec command', async () => {
    const { COMMAND_SPEC } = await import('../src/lib/completion/spec.js');

    // ── SIDE 1 - every command in the spec, by full path, walked recursively.
    interface SpecNode {
      name?: string;
      subcommands?: readonly SpecNode[];
    }
    const expectedPaths: string[] = [];
    const walk = (node: SpecNode, prefix: readonly string[]): void => {
      for (const sub of node.subcommands ?? []) {
        const path = [...prefix, sub.name ?? ''];
        expectedPaths.push(path.join(' '));
        walk(sub, path);
      }
    };
    walk(COMMAND_SPEC as SpecNode, []);
    expect(
      expectedPaths.length,
      'FLOOR: the spec walk produced no commands - this test would be vacuous, which is exactly how it used to pass',
    ).toBeGreaterThan(40);

    // ── SIDE 2 - what the SHIPPED command emits, driven rather than reasoned
    // about. `flattenCommands` is not exported, so the only honest way to
    // read the emitter's output is to run it.
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    };

    const { Command } = await import('commander');
    const { configureOutput } = await import('../src/lib/output.js');
    const { registerSchemaCommand } = await import('../src/commands/schema.js');

    const program = new Command();
    program.exitOverride();
    configureOutput({ json: true, color: false });
    registerSchemaCommand(program, '0.0.0');
    try {
      await program.parseAsync(['schema'], { from: 'user' });
    } finally {
      process.stdout.write = origWrite;
      configureOutput({ json: false, color: true });
    }

    const parsed = JSON.parse(writes.join('')) as {
      commands: ReadonlyArray<{ name: string; path: readonly string[] }>;
    };
    const emittedPaths = parsed.commands.map((c) => c.path.join(' '));
    expect(
      emittedPaths.length,
      'FLOOR: the emitted schema carried no commands',
    ).toBeGreaterThan(40);

    // ── the emitter may not DROP a specced command …
    expect(
      expectedPaths.filter((p) => !emittedPaths.includes(p)).sort(),
      'these commands are in COMMAND_SPEC but absent from the emitted schema - `spycore schema` under-reports the CLI',
    ).toEqual([]);

    // … and it may not INVENT one the spec does not carry.
    expect(
      emittedPaths.filter((p) => !expectedPaths.includes(p)).sort(),
      'the emitted schema carries commands COMMAND_SPEC does not declare',
    ).toEqual([]);
  });

  test('schema output passes JSON.parse round-trip', async () => {
    // Capture stdout via process.stdout.write hook.
    const writes: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    (process.stdout.write as unknown) = (chunk: string | Uint8Array): boolean => {
      writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
      return true;
    };

    const { Command } = await import('commander');
    const { configureOutput } = await import('../src/lib/output.js');
    const { registerSchemaCommand } = await import(
      '../src/commands/schema.js'
    );

    const program = new Command();
    program.exitOverride();
    configureOutput({ json: true, color: false });
    registerSchemaCommand(program, '9.9.9');

    try {
      await program.parseAsync(['schema'], { from: 'user' });
    } finally {
      process.stdout.write = origWrite;
      configureOutput({ json: false, color: true });
    }

    const merged = writes.join('');
    expect(merged.length).toBeGreaterThan(0);
    const parsed = JSON.parse(merged) as { version: string; commands: unknown[] };
    expect(parsed.version).toBe('9.9.9');
    expect(Array.isArray(parsed.commands)).toBe(true);
    expect(parsed.commands.length).toBeGreaterThan(10);
  });
});
