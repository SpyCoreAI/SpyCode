/**
 * `spycore skills lint` - check installed skills against the authoring
 * standard (H-14): short trigger descriptions, native-tool references, the
 * platforms gate, the standard structure, the name contract.
 *
 * Read-only: reports findings per skill, never modifies anything. `--strict`
 * exits non-zero when any finding exists (for CI).
 */
import { Command, Option } from 'commander';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoverSkills,
  parseSkillFile,
  type DiscoveredSkill,
} from '../../lib/agent/skills.js';
import {
  parseSkillFrontmatter,
  validateSkillAuthoring,
} from '../../lib/agent/skill-standards.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { formatOption, getOutputOptions, info, json, print, resolveFormat } from '../../lib/output.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';

function lintOne(skill: DiscoveredSkill): { name: string; source: string; findings: { rule: string; message: string }[] } {
  let raw: string;
  try {
    raw = readFileSync(skill.path, 'utf8');
  } catch {
    return { name: skill.name, source: skill.source, findings: [{ rule: 'unreadable', message: 'SKILL.md could not be read' }] };
  }
  const parsed = parseSkillFile(raw, skill.name);
  const skillDir = join(skill.path, '..');
  let hasScripts = false;
  try {
    hasScripts = existsSync(join(skillDir, 'scripts')) && statSync(join(skillDir, 'scripts')).isDirectory();
  } catch {
    hasScripts = false;
  }
  const findings = validateSkillAuthoring({
    name: parsed.name,
    description: parsed.description,
    body: parsed.body,
    frontmatter: parseSkillFrontmatter(raw),
    hasScripts,
  });
  return { name: skill.name, source: skill.source, findings };
}

export function registerLint(group: Command): void {
  group
    .command('lint')
    .description('Check installed skills against the authoring standard (read-only)')
    .addOption(formatOption())
    .addOption(new Option('--strict', 'Exit non-zero when any finding exists'))
    .action((opts: { format?: string; strict?: boolean }) => {
      const cwd = process.cwd();
      // Management command: the user explicitly asked, so every skill is
      // visible regardless of workspace trust (the agent run stays gated).
      const skills = discoverSkills(cwd, { includeUntrustedProject: true });
      const results = skills.map(lintOne);
      const total = results.reduce((n, r) => n + r.findings.length, 0);
      if (resolveFormat(opts.format) === 'json' || getOutputOptions().json) {
        json({ skills: results, totalFindings: total });
      } else if (results.length === 0) {
        info('No skills installed - nothing to lint.');
      } else {
        for (const r of results) {
          if (r.findings.length === 0) {
            print(`ok   ${sanitizeForDisplay(r.name)} (${r.source})`);
          } else {
            print(`${r.findings.length} finding${r.findings.length === 1 ? '' : 's'}  ${sanitizeForDisplay(r.name)} (${r.source})`);
            for (const f of r.findings) {
              print(`  [${f.rule}] ${sanitizeForDisplay(f.message)}`);
            }
          }
        }
        print('');
        print(
          total === 0
            ? `All ${results.length} skill${results.length === 1 ? '' : 's'} pass the authoring standard.`
            : `${total} finding${total === 1 ? '' : 's'} across ${results.length} skill${results.length === 1 ? '' : 's'}.`,
        );
      }
      if (opts.strict && total > 0) {
        throw new SpycoreCliError(
          `skills lint: ${total} finding${total === 1 ? '' : 's'}`,
          EXIT_USER_ERROR,
        );
      }
    });
}
