import { Command, Option } from 'commander';
import { getOutputOptions, json, print, success } from '../../lib/output.js';
import { sanitizeForDisplay } from '../../lib/sanitize-display.js';
import { EXIT_USER_ERROR, SpycoreCliError } from '../../lib/errors.js';
import { resolveModelSlug } from '../../lib/models.js';
import {
  MAX_PROMPT_LENGTH,
  addCronEntry,
  validateSchedule,
} from './store.js';

export function registerCronAddCommand(program: Command): void {
  program
    .command('add')
    .description('Schedule a prompt to run on a cron schedule')
    .addOption(new Option('--prompt <text>', 'Prompt text to run on schedule').makeOptionMandatory())
    .addOption(
      new Option(
        '--schedule <expr>',
        'Cron schedule: 5 fields "minute hour day-of-month month day-of-week" (e.g. "0 9 * * MON")',
      ).makeOptionMandatory(),
    )
    .addOption(
      new Option(
        '--model <model>',
        'Model used to run the prompt (default: the configured default model)',
      ),
    )
    .action(async (opts: { prompt?: string; schedule?: string; model?: string }) => {
      const prompt = (opts.prompt ?? '').trim();
      if (prompt.length === 0) {
        throw new SpycoreCliError(
          'The prompt is empty.',
          EXIT_USER_ERROR,
          'Pass --prompt "..." with the prompt text.',
        );
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        throw new SpycoreCliError(
          `Prompt exceeds the ${MAX_PROMPT_LENGTH} character limit (got ${prompt.length}).`,
          EXIT_USER_ERROR,
        );
      }
      const schedule = validateSchedule(opts.schedule ?? '');

      // resolveModelSlug validates against the known SpyCore chat labels and
      // throws a friendly error listing them. Stored uppercase like `chat`
      // sends it on the wire.
      const model = opts.model !== undefined ? resolveModelSlug(opts.model).toUpperCase() : null;

      const created = addCronEntry({ prompt, schedule, model });

      if (getOutputOptions().json) {
        json(created);
        return;
      }
      success(
        `Scheduled prompt ${sanitizeForDisplay(created.id)} (${sanitizeForDisplay(schedule)}${model ? `, ${sanitizeForDisplay(model)}` : ''})`,
      );
      // M8: be honest - execution is not yet implemented, only local storage.
      print('Note: scheduled prompts are stored locally; automatic execution is not yet implemented.');
    });
}
