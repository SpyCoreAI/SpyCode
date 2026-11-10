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
 * ALLOWLIST gate for user-facing model names. It runs unchanged in every tree
 * this package lives in.
 *
 * Contract: the only model names that may appear on user-facing surfaces
 * (command spec/help, shell completions, README, CHANGELOG, SECURITY) are
 * SpyCore's own models plus the documented BYOK provider types. Any token
 * SHAPED like a model id - letter-led segments joined by `-` or `.` with a
 * digit somewhere (`whatever-4o`, `acme-2.5-coder`) - fails the gate unless
 * it is explicitly allowed below. A token with NO digit fails it too when
 * its first segment is a known third-party model family (`claude-opus`,
 * `gpt-oss`, `deepseek-chat`): model ids without a version digit exist, so
 * the digit alone cannot be the shape test. Single-segment names (`llama`,
 * `grok`) cannot be shape-gated by TOKEN_RE at all - see the residual note
 * at the bottom of this file's contract.
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
  'claude.md', // the Claude Code project file (README) - not a model id
  'claude-code-class', // the Claude Code product, as a compound noun (CHANGELOG)
  'openai-compatible', // the documented BYOK provider type (README, CHANGELOG, spec)
  's6-envdir', // the s6 supervision-suite utility, named in the 0.9.10 CHANGELOG launcher census - not a model id
  's6-softlimit', // the s6 supervision-suite utility, named in the 0.9.10 CHANGELOG launcher census - not a model id
  'utf-16', // the Unicode encoding, named in the 0.9.10 CHANGELOG surrogate-safe UI bullet - not a model id
]);

/**
 * First segments of known third-party model families. A model-shaped token
 * led by one of these is treated as a model id even with no version digit
 * anywhere (`claude-opus`, `gpt-oss`, `deepseek-chat`, `gemini-pro-vision`).
 * Add a stem here when a new model family ships; anything led by an unknown
 * stem still passes unless it carries a digit, which is the gate's known
 * residual - see the test at the bottom of this file.
 */
const MODEL_FAMILY_STEMS = new Set<string>([
  'anthropic',
  'claude',
  'cohere',
  'deepseek',
  'gemini',
  'glm',
  'google',
  'grok',
  'gpt',
  'kimi',
  'llama',
  'meta',
  'mistral',
  'openai',
  'perplexity',
  'qwen',
]);

const TOKEN_RE = /\b[a-z][a-z0-9]*(?:[-.][a-z0-9]+)+\b/gi;

/** Every disallowed model-shaped token found in `text`, deduped + sorted. */
function modelShapedViolations(text: string): string[] {
  const bad = new Set<string>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const tok = match[0].toLowerCase();
    // Model ids carry a version digit somewhere - OR they are led by a known
    // model-family stem, which catches the digit-less ids (`claude-opus`,
    // `gpt-oss`). A token meeting neither test is ordinary hyphenated prose.
    const hasDigit = /\d/.test(tok);
    const familyLed = MODEL_FAMILY_STEMS.has(tok.split(/[-.]/)[0] as string);
    if (!hasDigit && !familyLed) continue;
    if (ALLOWED_TOKENS.has(tok)) continue;
    bad.add(tok);
  }
  return [...bad].sort();
}

function readDoc(name: string): string {
  return readFileSync(resolve(__dirname, '..', name), 'utf8');
}

// Loose structural view of the spec - we only read what we assert on.
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

describe('identity allowlist - user-facing surfaces', () => {
  test('every enumerated --model value is a SpyCore model', () => {
    const allowed = new Set<string>(ALLOWED_MODELS);
    walkSpec(COMMAND_SPEC as unknown as SpecNode, (node) => {
      for (const opt of node.options ?? []) {
        if (opt.name !== '--model' && opt.name !== '-m') continue;
        // Free-form model options (BYOK ids) enumerate no values - fine.
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

  test('digit-less third-party model ids are flagged, allowlisted terms are not', () => {
    // The old gate skipped every token without a digit, so `claude-opus`
    // sailed through. These ids have no version digit anywhere.
    expect(
      modelShapedViolations(
        'we also support claude-opus, gpt-oss, deepseek-chat, gemini-pro and mistral-large',
      ),
    ).toEqual([
      'claude-opus',
      'deepseek-chat',
      'gemini-pro',
      'gpt-oss',
      'mistral-large',
    ]);
    // A three-segment digit-less id is flagged too (`gemini-pro-vision`).
    expect(modelShapedViolations('try gemini-pro-vision instead')).toEqual([
      'gemini-pro-vision',
    ]);
    // The allowlist still admits the legitimate lookalikes: the Claude Code
    // project file and product name, and the BYOK provider type.
    expect(
      modelShapedViolations('see claude.md and the claude-code-class note; openai-compatible providers'),
    ).toEqual([]);
    // Residual, pinned: a model id from a family this file has never heard
    // of, with no digit, still passes the shape gate - the gate can only
    // enumerate families it knows. Adding the stem is the fix when one ships.
    expect(modelShapedViolations('try futuremodel-turbo instead')).toEqual([]);
    // Same for single-segment names: TOKEN_RE needs two segments, so
    // `llama` and `grok` alone never match. Only the exact-name tests above
    // (spec values, registry) can catch those.
    expect(modelShapedViolations('try llama and grok instead')).toEqual([]);
  });
});
