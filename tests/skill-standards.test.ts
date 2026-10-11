/**
 * H-14 - skill authoring standard: short one-sentence descriptions without
 * marketing words, native-tool references, the platforms gate for scripts/,
 * required sections, and kebab-case names.
 */
import { describe, expect, test } from 'vitest';
import {
  parseSkillFrontmatter,
  validateSkillAuthoring,
} from '../src/lib/agent/skill-standards.js';

const GOOD = {
  name: 'pdf-extract',
  description: 'Extract text from PDF files with `read_file`.',
  body: '## When to Use\n\nWhen the user hands you a PDF, read it with `read_file`.\n\n## Verification\n\nRun the example on the fixture and diff the output.\n',
  frontmatter: {},
  hasScripts: false,
};

describe('validateSkillAuthoring', () => {
  test('a conforming skill has no findings', () => {
    expect(validateSkillAuthoring(GOOD)).toEqual([]);
  });

  test('description: length, one sentence, trailing period', () => {
    const long = validateSkillAuthoring({ ...GOOD, description: 'x'.repeat(61) + '.' });
    expect(long.some((f) => f.rule === 'description-length')).toBe(true);
    const two = validateSkillAuthoring({ ...GOOD, description: 'First. Second.' });
    expect(two.some((f) => f.rule === 'description-sentence')).toBe(true);
    const noperiod = validateSkillAuthoring({ ...GOOD, description: 'No trailing period' });
    expect(noperiod.some((f) => f.rule === 'description-period')).toBe(true);
  });

  test('marketing words are flagged', () => {
    const findings = validateSkillAuthoring({
      ...GOOD,
      description: 'The ultimate revolutionary PDF solution.',
    });
    expect(findings.some((f) => f.rule === 'description-marketing')).toBe(true);
  });

  test('native tools must be named in backticks', () => {
    const findings = validateSkillAuthoring({
      ...GOOD,
      body: '## When to Use\n\nUse the read file tool.\n\n## Verification\n\nRun it.\n',
    });
    expect(findings.some((f) => f.rule === 'native-tool-reference')).toBe(true);
  });

  test('shell utility instead of a native tool is flagged', () => {
    const findings = validateSkillAuthoring({
      ...GOOD,
      body: '## When to Use\n\nRun `sed` to edit files.\n\n## Verification\n\nRun it.\n',
    });
    expect(findings.some((f) => f.rule === 'shell-utility-instead-of-native')).toBe(true);
  });

  test('scripts/ requires the platforms gate', () => {
    const findings = validateSkillAuthoring({ ...GOOD, hasScripts: true });
    expect(findings.some((f) => f.rule === 'platforms-gate')).toBe(true);
    const ok = validateSkillAuthoring({
      ...GOOD,
      hasScripts: true,
      frontmatter: { platforms: 'linux, darwin' },
    });
    expect(ok.some((f) => f.rule === 'platforms-gate')).toBe(false);
  });

  test('required sections are enforced', () => {
    const findings = validateSkillAuthoring({ ...GOOD, body: 'Just some prose.\n' });
    expect(findings.some((f) => f.rule === 'structure-section')).toBe(true);
  });

  test('names must be kebab-case', () => {
    const findings = validateSkillAuthoring({ ...GOOD, name: 'My_Skill' });
    expect(findings.some((f) => f.rule === 'name-shape')).toBe(true);
  });
});

describe('parseSkillFrontmatter', () => {
  test('parses fenced frontmatter with lowercased keys', () => {
    const fm = parseSkillFrontmatter('---\nName: pdf-extract\nDescription: Does things.\n---\nBody here.\n');
    expect(fm).toMatchObject({ name: 'pdf-extract', description: 'Does things.' });
  });

  test('missing fences parse to empty', () => {
    expect(parseSkillFrontmatter('Name: pdf-extract\n')).toEqual({});
  });
});
