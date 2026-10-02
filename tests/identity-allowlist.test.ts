import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMAND_SPEC } from '../src/lib/completion/spec.js';
import { generateBashCompletion } from '../src/lib/completion/bash.js';
import { generateZshCompletion } from '../src/lib/completion/zsh.js';
import { generateFishCompletion } from '../src/lib/completion/fish.js';
import { generatePowerShellCompletion } from '../src/lib/completion/powershell.js';
import { ALLOWED_MODELS, MODEL_DISPLAY } from '../src/lib/models.js';

/**
 * ALLOWLIST identity gate. It names nothing it protects against, so it runs
 * unchanged in every tree this package lives in.
 *
 * Contract: the only model names that may appear on user-facing surfaces
 * (command spec/help, shell completions, README, CHANGELOG, SECURITY) are
 * SpyCore's own models plus the documented BYOK provider types. Any token
 * SHAPED like a model id — letter-led segments joined by `-` or `.` with a
 * digit somewhere (`whatever-4o`, `acme-2.5-coder`) — fails the gate unless
 * it is explicitly allowed below.
 */

/** BYOK provider types documented on the CLI surface. */
const PROVIDER_TYPES = new Set<string>(['spycore', 'openai', 'anthropic', 'google']);

/**
 * Model-shaped tokens that are legitimate non-model terms. Additions need
 * the same scrutiny as a new dependency: anything here is visible to every
 * user of the published package.
 */
const ALLOWED_TOKENS = new Set<string>([
  'apache-2.0', // the license id (README, package metadata)
  'config-0600', // file-permission shorthand (SECURITY.md)
]);

const TOKEN_RE = /\b[a-z][a-z0-9]*(?:[-.][a-z0-9]+)+\b/gi;

/** Every disallowed model-shaped token found in `text`, deduped + sorted. */
function modelShapedViolations(text: string): string[] {
  const bad = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const tok = match[0].toLowerCase();
    if (!/\d/.test(tok)) continue; // model ids carry a version digit somewhere
    if (ALLOWED_TOKENS.has(tok)) continue;
    bad.add(tok);
  }
  return [...bad].sort();
}

function readDoc(name: string): string {
  return readFileSync(resolve(__dirname, '..', name), 'utf8');
}

// Loose structural view of the spec — we only read what we assert on.
interface SpecOption {
  name: string;
  values?: readonly string[];
}
interface SpecNode {
  name: string;
  options?: readonly SpecOption[];
  subcommands?: readonly SpecNode[];
}

function walkSpec(node: SpecNode, visit: (node: SpecNode) => void): void {
  visit(node);
  for (const sub of node.subcommands ?? []) walkSpec(sub, visit);
}

describe('identity allowlist — user-facing surfaces', () => {
  test('every enumerated --model value is a SpyCore model', () => {
    const allowed = new Set<string>(ALLOWED_MODELS);
    walkSpec(COMMAND_SPEC as unknown as SpecNode, (node) => {
      for (const opt of node.options ?? []) {
        if (opt.name !== '--model' && opt.name !== '-m') continue;
        // Free-form model options (BYOK ids) enumerate no values — fine.
        for (const value of opt.values ?? []) {
          expect(allowed, `${node.name} ${opt.name} advertises "${value}"`).toContain(value);
        }
      }
    });
  });

  test('every enumerated provider/type value is a documented BYOK type', () => {
    walkSpec(COMMAND_SPEC as unknown as SpecNode, (node) => {
      for (const opt of node.options ?? []) {
        if (opt.name !== '--provider' && opt.name !== '--type') continue;
        for (const value of opt.values ?? []) {
          expect(
            PROVIDER_TYPES,
            `${node.name} ${opt.name} advertises "${value}"`,
          ).toContain(value);
        }
      }
    });
  });

  test('command spec contains no unknown model-shaped tokens', () => {
    expect(modelShapedViolations(JSON.stringify(COMMAND_SPEC))).toEqual([]);
  });

  test('shell completions contain no unknown model-shaped tokens', () => {
    const generators = {
      bash: generateBashCompletion,
      zsh: generateZshCompletion,
      fish: generateFishCompletion,
      powershell: generatePowerShellCompletion,
    } as const;
    for (const [shell, generate] of Object.entries(generators)) {
      expect(modelShapedViolations(generate()), `${shell} completion`).toEqual([]);
    }
  });

  test('README, CHANGELOG and SECURITY contain no unknown model-shaped tokens', () => {
    for (const doc of ['README.md', 'CHANGELOG.md', 'SECURITY.md']) {
      expect(modelShapedViolations(readDoc(doc)), doc).toEqual([]);
    }
  });

  test('the model registry is SpyCore-branded display names only', () => {
    for (const display of Object.values(MODEL_DISPLAY)) {
      // Brand names: one or two capitalised words, no digits, no separators.
      expect(display).toMatch(/^[A-Z][a-z]+(?: [A-Z][a-z]+)?$/);
    }
  });
});
