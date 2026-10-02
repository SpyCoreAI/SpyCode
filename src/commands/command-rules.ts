import { Command } from 'commander';
import chalk from 'chalk';
import {
  inspectCommandRules,
  projectCommandRulesPath,
  userCommandRulesPath,
  type RuleInspectionRow,
} from '../lib/agent/command-rules.js';
import { getOutputOptions, json, print } from '../lib/output.js';
import { sanitizeForDisplay } from '../lib/sanitize-display.js';

/**
 * `spycore command-rules` — PHASE-1 1.10 read-only inspection surface for the
 * run_command allow/deny rules: every configured entry with its scope, kind,
 * and effect (active / invalid / unapproved / untrusted). Editing happens in
 * the JSON files themselves (or via the agent TUI's "always allow" option,
 * which appends to the user file); this command never writes and never
 * prompts.
 */
export function registerCommandRulesCommand(program: Command): void {
  program
    .command('command-rules')
    .description('Show the effective run_command allow/deny rules (read-only)')
    .action(() => {
      const cwd = process.cwd();
      const rows = inspectCommandRules(cwd);
      if (getOutputOptions().json) {
        json({
          userFile: userCommandRulesPath(),
          projectFile: projectCommandRulesPath(cwd),
          rules: rows,
        });
        return;
      }
      print(`Command rules for run_command (user: ${userCommandRulesPath()},`);
      print(`project: ${projectCommandRulesPath(cwd)})`);
      print('');
      if (rows.length === 0) {
        print('No rules configured — every command prompts for approval.');
      } else {
        for (const row of rows) {
          print(formatRow(row));
        }
      }
      print('');
      print(chalk.dim('Precedence: built-in catastrophic guard (immutable) > deny > allow > ask.'));
      print(chalk.dim('Commands containing shell metacharacters (; & | < > ( ) { } $ ` \\) are'));
      print(chalk.dim('never auto-approved, regardless of any allow rule. Deny beats --yes and'));
      print(chalk.dim('accept-all. Project entries need workspace trust AND per-entry approval.'));
    });
}

function formatRow(row: RuleInspectionRow): string {
  const kind = row.kind === 'allow' ? chalk.green('allow') : chalk.red('deny ');
  const scope = row.scope === 'user' ? 'user   ' : 'project';
  const entry = sanitizeForDisplay(row.entry);
  const status =
    row.status === 'active'
      ? chalk.green('active')
      : row.status === 'invalid'
        ? chalk.yellow('invalid')
        : row.status === 'unapproved'
          ? chalk.yellow('unapproved')
          : chalk.yellow('untrusted');
  const detail = row.detail ? chalk.dim(` — ${sanitizeForDisplay(row.detail)}`) : '';
  return `  ${scope}  ${kind}  ${entry}  [${status}]${detail}`;
}
