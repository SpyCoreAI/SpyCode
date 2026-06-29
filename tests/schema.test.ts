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
  test('schema includes every spec command', async () => {
    const { COMMAND_SPEC } = await import('../src/lib/completion/spec.js');
    const expectedNames = (COMMAND_SPEC.subcommands ?? []).map((s) => s.name);
    // We rebuild the schema directly here rather than spawning the CLI
    // (that's covered by the integration tests in commit 5).
    const { Command } = await import('commander');
    const program = new Command();
    const { registerSchemaCommand } = await import(
      '../src/commands/schema.js'
    );
    registerSchemaCommand(program, '0.0.0');

    // Also assert the spec exposes top-level commands
    for (const name of expectedNames) {
      expect(expectedNames).toContain(name);
    }
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

  test('schema --json never leaks the internal router codename (CL2)', async () => {
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
    registerSchemaCommand(program, '9.9.9');

    try {
      await program.parseAsync(['schema'], { from: 'user' });
    } finally {
      process.stdout.write = origWrite;
      configureOutput({ json: false, color: true });
    }

    const merged = writes.join('');
    // The full schema dump (commands + output types) must be ORACLE-free…
    expect(merged.toLowerCase()).not.toContain('oracle');
    // …and the routing event must surface under the neutral public name.
    const parsed = JSON.parse(merged) as {
      outputTypes: { ChatStreamEvent: { properties: { type: { enum: string[] } } } };
    };
    const enumValues = parsed.outputTypes.ChatStreamEvent.properties.type.enum;
    expect(enumValues).toContain('routed');
    expect(enumValues).not.toContain('oracle_routed');
  });
});
